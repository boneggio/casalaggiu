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
  const r = await env.DB.prepare("SELECT dal, al, prezzo FROM prezzi WHERE dal < ? AND al >= ?").bind(partenza, arrivo).all();
  const periodi = r.results || [];
  let totale = 0, mancanti = 0;
  for (let d = new Date(arrivo + "T00:00:00Z"); d.toISOString().slice(0, 10) < partenza; d.setUTCDate(d.getUTCDate() + 1)) {
    const g = d.toISOString().slice(0, 10);
    const p = periodi.find((x) => x.dal <= g && g <= x.al);
    if (p) totale += p.prezzo; else mancanti++;
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
    if (!(prezzo > 0 && prezzo < 10000)) return json({ ok: false, errore: "prezzo" }, 400);
    const c = await env.DB.prepare("SELECT dal, al FROM prezzi WHERE dal <= ? AND al >= ? LIMIT 1").bind(al, dal).first();
    if (c) return json({ ok: false, errore: "periodo_sovrapposto", con: c }, 409);
    await env.DB.prepare("INSERT INTO prezzi (id,dal,al,prezzo,nota) VALUES (?,?,?,?,?)").bind("p_" + uid(), dal, al, prezzo, clean(body.nota, 80)).run();
    return json({ ok: true });
  }

  if (a === "admin_prezzo_elimina") {
    await env.DB.prepare("DELETE FROM prezzi WHERE id=?").bind(clean(body.id, 20)).run();
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
          const r = await env.DB.prepare("SELECT dal, al, prezzo, nota FROM prezzi WHERE al >= ? ORDER BY dal").bind(oggi).all();
          return json({ ok: true, prezzi: r.results });
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
