// Casalaggiù – backend prenotazioni (Cloudflare Worker + D1)
// GET  /api?action=occupato           -> date occupate (pubblico)
// POST /api  {action:"richiesta",...} -> nuova richiesta + avviso Telegram
// POST /api  {action:"setup"|"login"|"admin_*", password,...} -> pannello proprietario
// Il corpo POST arriva come text/plain con JSON dentro (niente preflight CORS).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OSPITI = 4;
const MIN_NOTTI = 2;

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const notti = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);

async function getSet(env, k) {
  const r = await env.DB.prepare("SELECT valore FROM impostazioni WHERE chiave=?").bind(k).first();
  return r ? r.valore : null;
}
async function putSet(env, k, v) {
  if (v === null) return env.DB.prepare("DELETE FROM impostazioni WHERE chiave=?").bind(k).run();
  return env.DB.prepare("INSERT INTO impostazioni (chiave,valore) VALUES (?,?) ON CONFLICT(chiave) DO UPDATE SET valore=excluded.valore").bind(k, v).run();
}

async function sovrapposto(env, arrivo, partenza, escludiId = null) {
  const r = await env.DB.prepare("SELECT id FROM occupato WHERE arrivo < ? AND partenza > ? AND (? IS NULL OR id != ?) LIMIT 1")
    .bind(partenza, arrivo, escludiId, escludiId).first();
  return !!r;
}

// ---------- prezzi ----------
// periodi con "dal" e "al" inclusi (date delle notti), prezzo per notte in euro
async function stima(env, arrivo, partenza) {
  const r = await env.DB.prepare("SELECT dal, al, prezzo, tipo FROM prezzi WHERE dal < ? AND al >= ?").bind(partenza, arrivo).all();
  const periodi = r.results || [];
  let totale = 0, mancanti = 0;
  for (let d = new Date(arrivo + "T00:00:00Z"); d.toISOString().slice(0, 10) < partenza; d.setUTCDate(d.getUTCDate() + 1)) {
    const g = d.toISOString().slice(0, 10);
    const p = periodi.find((x) => x.dal <= g && g <= x.al);
    if (p) totale += p.tipo === "settimana" ? p.prezzo / 7 : p.prezzo; else mancanti++;
  }
  return { totale: Math.round(totale * 100) / 100, completa: mancanti === 0 };
}

// ---------- Telegram ----------
async function telegram(env, testo) {
  const token = await getSet(env, "tg_token");
  const chat = await getSet(env, "tg_chat");
  if (!token || !chat) { await putSet(env, "tg_last_error", "Bot o gruppo non configurati"); return false; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: testo, disable_web_page_preview: true }),
    });
    const d = await r.json();
    if (!d.ok) { await putSet(env, "tg_last_error", `${new Date().toISOString()} ${d.description || r.status}`); return false; }
    await putSet(env, "tg_last_error", null);
    return true;
  } catch (e) {
    await putSet(env, "tg_last_error", `${new Date().toISOString()} ${e.message}`);
    return false;
  }
}

// ---------- SumUp ----------
// Il link mandato all'ospite punta a paga.html sul nostro sito: a ogni apertura il Worker crea
// (o riusa) un checkout SumUp, perché le pagine di pagamento SumUp scadono dopo 30 minuti.
const SITO = "https://casalaggiu.boneggio.it";
const sumupApi = (env) => env.SUMUP_API || "https://api.sumup.com";
async function tabellaPagamenti(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS pagamenti (id TEXT PRIMARY KEY, creato TEXT NOT NULL, richiesta_id TEXT, descrizione TEXT NOT NULL, importo REAL NOT NULL, stato TEXT NOT NULL, checkout_id TEXT, checkout_url TEXT, checkout_creato TEXT, pagato_il TEXT)").run();
}
async function verificaPagamento(env, p, ctx) {
  if (p.stato !== "da_pagare" || !p.checkout_id) return p.stato;
  const key = await getSet(env, "sumup_key");
  if (!key) return p.stato;
  const r = await fetch(`${sumupApi(env)}/v0.1/checkouts/${encodeURIComponent(p.checkout_id)}`, { headers: { Authorization: "Bearer " + key } });
  if (!r.ok) return p.stato;
  const c = await r.json();
  if (c.status === "PAID") {
    const ora = new Date().toISOString();
    const u = await env.DB.prepare("UPDATE pagamenti SET stato='pagato', pagato_il=? WHERE id=? AND stato='da_pagare'").bind(ora, p.id).run();
    if (u.meta && u.meta.changes) ctx.waitUntil(telegram(env, `💳 Pagamento ricevuto con SumUp\n${p.descrizione}\n💶 ${Number(p.importo).toFixed(2)} €`));
    return "pagato";
  }
  return p.stato;
}
async function paga(env, id, ctx) {
  await tabellaPagamenti(env);
  const p = await env.DB.prepare("SELECT * FROM pagamenti WHERE id=?").bind(id).first();
  if (!p) return json({ ok: false, errore: "non_trovato" }, 404);
  const pub = { descrizione: p.descrizione, importo: p.importo };
  let stato = await verificaPagamento(env, p, ctx);
  if (stato !== "da_pagare") return json({ ok: true, stato, ...pub });
  const key = await getSet(env, "sumup_key"), merchant = await getSet(env, "sumup_merchant");
  if (!key || !merchant) return json({ ok: false, errore: "sumup_non_configurato" }, 503);
  // riusa il checkout se ha meno di 25 minuti
  if (p.checkout_url && p.checkout_creato && Date.now() - Date.parse(p.checkout_creato) < 25 * 60e3) return json({ ok: true, stato, url: p.checkout_url, ...pub });
  const r = await fetch(sumupApi(env) + "/v0.1/checkouts", {
    method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      checkout_reference: `${p.id}-${Date.now()}`, amount: p.importo, currency: "EUR", merchant_code: merchant,
      description: p.descrizione, hosted_checkout: { enabled: true }, redirect_url: `${SITO}/paga.html?t=${p.id}&fatto=1`,
    }),
  });
  const c = await r.json().catch(() => ({}));
  if (!r.ok || !c.hosted_checkout_url) return json({ ok: false, errore: "sumup_errore", dettaglio: c.message || c.error_code || r.status }, 502);
  await env.DB.prepare("UPDATE pagamenti SET checkout_id=?, checkout_url=?, checkout_creato=? WHERE id=?").bind(c.id, c.hosted_checkout_url, new Date().toISOString(), p.id).run();
  return json({ ok: true, stato, url: c.hosted_checkout_url, ...pub });
}

// ---------- autenticazione proprietario ----------
async function isAdmin(env, password) {
  const sha = await getSet(env, "admin_sha");
  if (!sha || !password) return false;
  return (await sha256(String(password))) === sha;
}

async function handlePost(body, env, ctx) {
  const a = body.action;

  if (a === "richiesta") {
    if (body.sito) return json({ ok: true }); // campo trappola anti-spam compilato: ignora
    const arrivo = String(body.arrivo || ""), partenza = String(body.partenza || "");
    const ospiti = parseInt(body.ospiti, 10);
    const nome = clean(body.nome, 120), contatto = clean(body.contatto, 160);
    const messaggio = clean(body.messaggio, 800), lingua = clean(body.lingua, 5);
    const oggi = new Date().toISOString().slice(0, 10);
    if (!DATE.test(arrivo) || !DATE.test(partenza) || arrivo < oggi || partenza <= arrivo) return json({ ok: false, errore: "date" }, 400);
    if (notti(arrivo, partenza) < MIN_NOTTI || notti(arrivo, partenza) > 90) return json({ ok: false, errore: "notti" }, 400);
    if (!(ospiti >= 1 && ospiti <= MAX_OSPITI)) return json({ ok: false, errore: "ospiti" }, 400);
    if (!nome || !contatto) return json({ ok: false, errore: "campi" }, 400);
    if (await sovrapposto(env, arrivo, partenza)) return json({ ok: false, errore: "occupato" }, 409);
    // limite semplice: massimo 20 richieste nell'ultima ora
    const recenti = await env.DB.prepare("SELECT COUNT(*) n FROM richieste WHERE creata > ?").bind(new Date(Date.now() - 3600e3).toISOString()).first();
    if (recenti && recenti.n > 20) return json({ ok: false, errore: "troppe" }, 429);

    const id = uid();
    await env.DB.prepare("INSERT INTO richieste (id,creata,arrivo,partenza,ospiti,nome,contatto,messaggio,lingua,stato) VALUES (?,?,?,?,?,?,?,?,?, 'nuova')")
      .bind(id, new Date().toISOString(), arrivo, partenza, ospiti, nome, contatto, messaggio, lingua).run();
    const st = await stima(env, arrivo, partenza);
    const prezzo = st.totale ? `\n💶 stima: ${st.totale.toFixed(2)} €${st.completa ? "" : " (alcune notti senza prezzo)"}` : "";
    const testo = `🏠 Nuova richiesta Casalaggiù\n📅 ${arrivo} → ${partenza} (${notti(arrivo, partenza)} notti)\n👥 ${ospiti} ospiti\n👤 ${nome}\n📞 ${contatto}\n🌍 lingua: ${lingua.toUpperCase()}` + prezzo + (messaggio ? `\n💬 ${messaggio}` : "");
    ctx.waitUntil(telegram(env, testo));
    return json({ ok: true, id });
  }

  if (a === "setup") {
    // primo accesso: codice di attivazione monouso -> sceglie la password
    const setup = await getSet(env, "setup_sha");
    if (!setup || (await getSet(env, "admin_sha"))) return json({ ok: false, errore: "gia_attivato" }, 400);
    if ((await sha256(String(body.codice || "").trim())) !== setup) return json({ ok: false, errore: "codice" }, 403);
    const pw = String(body.password || "");
    if (pw.length < 8) return json({ ok: false, errore: "password_corta" }, 400);
    await putSet(env, "admin_sha", await sha256(pw));
    await putSet(env, "setup_sha", null);
    return json({ ok: true });
  }

  // da qui in poi: solo proprietario
  if (!(await isAdmin(env, body.password))) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ ok: false, errore: "password" }, 403);
  }

  if (a === "login") return json({ ok: true });

  if (a === "admin_dati") {
    const r = await env.DB.prepare("SELECT * FROM richieste ORDER BY creata DESC LIMIT 200").all();
    const o = await env.DB.prepare("SELECT * FROM occupato ORDER BY arrivo").all();
    const pz = await env.DB.prepare("SELECT * FROM prezzi ORDER BY dal").all();
    return json({
      ok: true, richieste: r.results, occupato: o.results, prezzi: pz.results,
      telegram: { token: !!(await getSet(env, "tg_token")), gruppo: await getSet(env, "tg_chat"), errore: await getSet(env, "tg_last_error") },
      sumup: { merchant: await getSet(env, "sumup_merchant") },
    });
  }

  if (a === "admin_stato") {
    const id = clean(body.id, 20), stato = body.stato;
    if (!["confermata", "rifiutata", "nuova"].includes(stato)) return json({ ok: false, errore: "stato" }, 400);
    const r = await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(id).first();
    if (!r) return json({ ok: false, errore: "non_trovata" }, 404);
    if (stato === "confermata") {
      if (await sovrapposto(env, r.arrivo, r.partenza, "r_" + id)) return json({ ok: false, errore: "occupato" }, 409);
      await env.DB.prepare("INSERT OR REPLACE INTO occupato (id,arrivo,partenza,nota,richiesta_id) VALUES (?,?,?,?,?)")
        .bind("r_" + id, r.arrivo, r.partenza, `${r.nome} (${r.ospiti} ospiti)`, id).run();
    } else {
      await env.DB.prepare("DELETE FROM occupato WHERE id=?").bind("r_" + id).run();
    }
    await env.DB.prepare("UPDATE richieste SET stato=? WHERE id=?").bind(stato, id).run();
    return json({ ok: true });
  }

  if (a === "admin_elimina_richiesta") {
    const id = clean(body.id, 20);
    await env.DB.prepare("DELETE FROM occupato WHERE id=?").bind("r_" + id).run();
    await env.DB.prepare("DELETE FROM richieste WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  if (a === "admin_blocca") {
    const arrivo = String(body.arrivo || ""), partenza = String(body.partenza || "");
    if (!DATE.test(arrivo) || !DATE.test(partenza) || partenza <= arrivo) return json({ ok: false, errore: "date" }, 400);
    await env.DB.prepare("INSERT INTO occupato (id,arrivo,partenza,nota) VALUES (?,?,?,?)").bind("b_" + uid(), arrivo, partenza, clean(body.nota, 120)).run();
    return json({ ok: true });
  }

  if (a === "admin_libera") {
    const id = clean(body.id, 20);
    const r = await env.DB.prepare("SELECT richiesta_id FROM occupato WHERE id=?").bind(id).first();
    await env.DB.prepare("DELETE FROM occupato WHERE id=?").bind(id).run();
    if (r && r.richiesta_id) await env.DB.prepare("UPDATE richieste SET stato='nuova' WHERE id=?").bind(r.richiesta_id).run();
    return json({ ok: true });
  }

  if (a === "admin_prezzo_aggiungi") {
    const dal = String(body.dal || ""), al = String(body.al || "");
    const prezzo = Math.round(Number(body.prezzo) * 100) / 100;
    if (!DATE.test(dal) || !DATE.test(al) || al < dal) return json({ ok: false, errore: "date" }, 400);
    const tipo = body.tipo === "settimana" ? "settimana" : "notte";
    if (!(prezzo > 0 && prezzo < 50000)) return json({ ok: false, errore: "prezzo" }, 400);
    const c = await env.DB.prepare("SELECT dal, al FROM prezzi WHERE dal <= ? AND al >= ? LIMIT 1").bind(al, dal).first();
    if (c) return json({ ok: false, errore: "periodo_sovrapposto", con: c }, 409);
    await env.DB.prepare("INSERT INTO prezzi (id,dal,al,prezzo,nota,tipo) VALUES (?,?,?,?,?,?)").bind("p_" + uid(), dal, al, prezzo, clean(body.nota, 80), tipo).run();
    return json({ ok: true });
  }

  if (a === "admin_prezzo_elimina") {
    await env.DB.prepare("DELETE FROM prezzi WHERE id=?").bind(clean(body.id, 20)).run();
    return json({ ok: true });
  }

  // ---------- confronto prezzi della zona (annunci Booking/Airbnb inseriti a mano) ----------
  if (a.startsWith("admin_mercato")) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS mercato (id TEXT PRIMARY KEY, creato TEXT NOT NULL, dal TEXT NOT NULL, al TEXT NOT NULL, piattaforma TEXT NOT NULL, nome TEXT, ospiti INTEGER NOT NULL, totale REAL NOT NULL, link TEXT)").run();
  }
  if (a === "admin_mercato_lista") {
    const r = await env.DB.prepare("SELECT * FROM mercato ORDER BY dal, totale").all();
    return json({ ok: true, mercato: r.results });
  }
  if (a === "admin_mercato_aggiungi") {
    const dal = String(body.dal || ""), al = String(body.al || "");
    if (!DATE.test(dal) || !DATE.test(al) || al <= dal || notti(dal, al) > 60) return json({ ok: false, errore: "date" }, 400);
    const ospiti = parseInt(body.ospiti, 10);
    if (!(ospiti >= 1 && ospiti <= 20)) return json({ ok: false, errore: "ospiti" }, 400);
    const totale = Math.round(Number(body.totale) * 100) / 100;
    if (!(totale > 0 && totale < 100000)) return json({ ok: false, errore: "prezzo" }, 400);
    const piattaforma = ["booking", "airbnb", "altro"].includes(body.piattaforma) ? body.piattaforma : "altro";
    let link = clean(body.link, 400);
    if (link && !/^https:\/\//.test(link)) link = "";
    await env.DB.prepare("INSERT INTO mercato (id,creato,dal,al,piattaforma,nome,ospiti,totale,link) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind("m_" + uid(), new Date().toISOString(), dal, al, piattaforma, clean(body.nome, 100), ospiti, totale, link).run();
    return json({ ok: true });
  }
  if (a === "admin_mercato_elimina") {
    await env.DB.prepare("DELETE FROM mercato WHERE id=?").bind(clean(body.id, 20)).run();
    return json({ ok: true });
  }

  // ---------- pagamenti con SumUp ----------
  if (a === "admin_sumup_chiave") {
    const k = String(body.chiave || "").trim();
    if (!/^[A-Za-z0-9_.\-]{20,400}$/.test(k)) return json({ ok: false, errore: "chiave" }, 400);
    const r = await fetch(sumupApi(env) + "/v0.1/me", { headers: { Authorization: "Bearer " + k } });
    if (!r.ok) return json({ ok: false, errore: "sumup_rifiuta", stato: r.status }, 400);
    const me = await r.json();
    const mc = me && me.merchant_profile && me.merchant_profile.merchant_code;
    if (!mc) return json({ ok: false, errore: "sumup_merchant" }, 400);
    await putSet(env, "sumup_key", k);
    await putSet(env, "sumup_merchant", mc);
    return json({ ok: true, merchant: mc, nome: (me.merchant_profile.business_name || "") });
  }
  if (a.startsWith("admin_pagament")) await tabellaPagamenti(env);
  if (a === "admin_pagamenti") {
    const r = await env.DB.prepare("SELECT id,creato,richiesta_id,descrizione,importo,stato,pagato_il FROM pagamenti ORDER BY creato DESC LIMIT 200").all();
    return json({ ok: true, pagamenti: r.results, sumup: { merchant: await getSet(env, "sumup_merchant") } });
  }
  if (a === "admin_pagamento_crea") {
    const importo = Math.round(Number(body.importo) * 100) / 100;
    if (!(importo >= 1 && importo <= 20000)) return json({ ok: false, errore: "prezzo" }, 400);
    const descrizione = clean(body.descrizione, 120) || "Soggiorno Casalaggiù";
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.DB.prepare("INSERT INTO pagamenti (id,creato,richiesta_id,descrizione,importo,stato) VALUES (?,?,?,?,?, 'da_pagare')")
      .bind(id, new Date().toISOString(), clean(body.richiesta_id, 20) || null, descrizione, importo).run();
    return json({ ok: true, id });
  }
  if (a === "admin_pagamento_verifica") {
    const p = await env.DB.prepare("SELECT * FROM pagamenti WHERE id=?").bind(clean(body.id, 20)).first();
    if (!p) return json({ ok: false, errore: "non_trovato" }, 404);
    return json({ ok: true, stato: await verificaPagamento(env, p, ctx) });
  }
  if (a === "admin_pagamento_annulla") {
    await env.DB.prepare("UPDATE pagamenti SET stato='annullato' WHERE id=? AND stato!='pagato'").bind(clean(body.id, 20)).run();
    return json({ ok: true });
  }

  if (a === "admin_tg_token") {
    const t = String(body.token || "").trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(t)) return json({ ok: false, errore: "token" }, 400);
    await putSet(env, "tg_token", t);
    return json({ ok: true });
  }

  if (a === "admin_tg_ricollega") {
    const token = await getSet(env, "tg_token");
    if (!token) return json({ ok: false, errore: "token_mancante" }, 400);
    let d = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates?allowed_updates=${encodeURIComponent('["message","my_chat_member","channel_post"]')}`)).json();
    if (!d.ok && /webhook/i.test(d.description || "")) {
      // un webhook impedisce getUpdates: lo togliamo e riproviamo
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
      d = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
    }
    if (!d.ok) return json({ ok: false, errore: "telegram: " + (d.description || "errore") }, 400);
    let gruppo = null, privata = null;
    const visti = [];
    for (const u of d.result || []) {
      const m = u.message || u.my_chat_member || u.channel_post;
      const c = m && m.chat;
      if (!c) continue;
      visti.push(`${c.type}${c.title ? " " + c.title : ""}`);
      if (c.type === "group" || c.type === "supergroup") gruppo = { id: String(c.id), titolo: c.title };
      else if (c.type === "private") privata = { id: String(c.id), titolo: "chat privata con " + (c.first_name || "te") };
    }
    const scelta = gruppo || privata; // preferisce il gruppo, altrimenti la chat privata con il bot
    if (!scelta) return json({ ok: false, errore: "nessun_gruppo", aggiornamenti: (d.result || []).length, visti }, 404);
    await putSet(env, "tg_chat", scelta.id);
    await putSet(env, "tg_last_error", null);
    return json({ ok: true, gruppo: scelta.id, titolo: scelta.titolo });
  }

  if (a === "admin_tg_prova") {
    const ok = await telegram(env, "✅ Prova da Casalaggiù: gli avvisi delle prenotazioni arriveranno qui.");
    return json({ ok, errore: ok ? null : await getSet(env, "tg_last_error") });
  }

  if (a === "admin_password") {
    const pw = String(body.nuova || "");
    if (pw.length < 8) return json({ ok: false, errore: "password_corta" }, 400);
    await putSet(env, "admin_sha", await sha256(pw));
    return json({ ok: true });
  }

  return json({ ok: false, errore: "azione" }, 400);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (request.method === "GET") {
        const action = url.searchParams.get("action");
        if (action === "occupato") {
          const oggi = new Date().toISOString().slice(0, 10);
          const r = await env.DB.prepare("SELECT arrivo, partenza FROM occupato WHERE partenza >= ? ORDER BY arrivo").bind(oggi).all();
          return json({ ok: true, occupato: r.results });
        }
        if (action === "prezzi") {
          const oggi = new Date().toISOString().slice(0, 10);
          const r = await env.DB.prepare("SELECT dal, al, prezzo, nota, tipo FROM prezzi WHERE al >= ? ORDER BY dal").bind(oggi).all();
          return json({ ok: true, prezzi: r.results });
        }
        if (action === "paga") {
          const t = String(url.searchParams.get("t") || "");
          if (!/^[a-f0-9]{16}$/.test(t)) return json({ ok: false, errore: "non_trovato" }, 404);
          return await paga(env, t, ctx);
        }
        if (action === "stato") {
          return json({ ok: true, attivato: !!(await getSet(env, "admin_sha")) });
        }
        return json({ ok: true, servizio: "Casalaggiù API" });
      }
      if (request.method === "POST") {
        const text = await request.text();
        if (text.length > 20000) return json({ ok: false, errore: "troppo_grande" }, 413);
        let body;
        try { body = JSON.parse(text); } catch { return json({ ok: false, errore: "json" }, 400); }
        return await handlePost(body || {}, env, ctx);
      }
      return json({ ok: false, errore: "metodo" }, 405);
    } catch (e) {
      return json({ ok: false, errore: "server", dettaglio: e.message }, 500);
    }
  },
};
