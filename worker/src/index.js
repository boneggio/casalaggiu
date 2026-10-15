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
// periodi con "dal" e "al" inclusi (date delle notti); prezzo a notte o a settimana.
// Con "prezzi in base agli ospiti" attivo, per_ospiti contiene {"1":..,"2":..,"3":..,"4":..}:
// se manca il prezzo per quel numero di ospiti si usa quello del numero superiore, poi dell'inferiore.
function prezzoPer(p, ospiti, perOspiti) {
  let v = p.prezzo;
  if (perOspiti && p.per_ospiti) {
    let m = null;
    try { m = JSON.parse(p.per_ospiti); } catch (e) { m = null; }
    if (m) {
      let f = null;
      for (let g = ospiti; g <= MAX_OSPITI && f == null; g++) if (m[g] > 0) f = m[g];
      for (let g = ospiti - 1; g >= 1 && f == null; g--) if (m[g] > 0) f = m[g];
      if (f != null) v = f;
    }
  }
  return p.tipo === "settimana" ? v / 7 : v;
}
// notti minime: quelle del periodo in cui cade il giorno di arrivo, altrimenti il minimo di base (impostazioni)
async function minNottiBase(env) { const v = parseInt(await getSet(env, "min_notti"), 10); return v >= 1 && v <= 30 ? v : MIN_NOTTI; }
async function minNotti(env, arrivo) {
  const p = await env.DB.prepare("SELECT min_notti FROM prezzi WHERE dal <= ? AND al >= ? AND min_notti IS NOT NULL LIMIT 1").bind(arrivo, arrivo).first();
  return p && p.min_notti ? p.min_notti : await minNottiBase(env);
}
// supplemento per soggiorni brevi (1, 2 o 3 notti), fisso per soggiorno, dal periodo in cui cade l'arrivo
async function supBreve(env, arrivo, n) {
  if (n > 3) return 0;
  const p = await env.DB.prepare("SELECT sup_brevi FROM prezzi WHERE dal <= ? AND al >= ? AND sup_brevi IS NOT NULL LIMIT 1").bind(arrivo, arrivo).first();
  if (!p) return 0;
  try { return Number(JSON.parse(p.sup_brevi)[n]) || 0; } catch (e) { return 0; }
}
function supValido(x) {
  if (!x || typeof x !== "object") return null;
  const m = {};
  for (const n of [1, 2, 3]) {
    if (x[n] === "" || x[n] == null) continue;
    const v = Math.round(Number(x[n]) * 100) / 100;
    if (!(v >= 0 && v <= 2000)) return undefined;
    if (v > 0) m[n] = v;
  }
  return Object.keys(m).length ? JSON.stringify(m) : null;
}
const minValido = (x) => { if (x === "" || x == null) return null; const v = parseInt(x, 10); return v >= 1 && v <= 30 ? v : undefined; };
async function stima(env, arrivo, partenza, ospiti = MAX_OSPITI) {
  const r = await env.DB.prepare("SELECT dal, al, prezzo, tipo, per_ospiti FROM prezzi WHERE dal < ? AND al >= ?").bind(partenza, arrivo).all();
  const periodi = r.results || [];
  const perOspiti = (await getSet(env, "prezzi_ospiti")) === "1";
  let totale = 0, mancanti = 0;
  for (let d = new Date(arrivo + "T00:00:00Z"); d.toISOString().slice(0, 10) < partenza; d.setUTCDate(d.getUTCDate() + 1)) {
    const g = d.toISOString().slice(0, 10);
    const p = periodi.find((x) => x.dal <= g && g <= x.al);
    if (p) totale += prezzoPer(p, ospiti, perOspiti); else mancanti++;
  }
  return { totale: Math.round(totale), completa: mancanti === 0 };
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


// ---------- check-in online, Alloggiati Web e ISTAT (DMS Puglia / SPOT) ----------
// Le tabelle ufficiali (comuni, stati, documenti) vengono scaricate dal portale Alloggiati
// della Polizia di Stato e tenute in cache nel database per 30 giorni.
const tabUrl = (env) => env.ALLOGGIATI_TAB || "https://alloggiatiweb.poliziadistato.it/PortaleAlloggiati/ashx/Download.ashx";
const ITALIA = "100000100";
const TAB_ID = { COMUNI: 0, STATI: 1, DOCUMENTI: 2 };
async function tabella(env, nome) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS tabelle (k TEXT PRIMARY KEY, v TEXT NOT NULL, agg TEXT NOT NULL)").run();
  const c = await env.DB.prepare("SELECT v, agg FROM tabelle WHERE k=?").bind(nome).first();
  if (c && Date.now() - Date.parse(c.agg) < 30 * 864e5) return c.v;
  try {
    const r = await fetch(`${tabUrl(env)}?ID=${TAB_ID[nome]}&N=${nome}`, { headers: { "User-Agent": "Mozilla/5.0 Casalaggiu" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const testo = new TextDecoder("latin1").decode(await r.arrayBuffer());
    const righe = testo.split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(","));
    let v;
    if (nome === "DOCUMENTI") v = righe.map((x) => x[0] + "|" + x.slice(1).join(",")).join("\n");
    else v = righe.filter((x) => !x[x.length - 1]).map((x) => x[0] + "|" + x.slice(1, x.length - 2).join(",") + "|" + x[x.length - 2]).join("\n");
    if (v.split("\n").length < (nome === "COMUNI" ? 5000 : nome === "STATI" ? 150 : 10)) throw new Error("tabella incompleta");
    await env.DB.prepare("INSERT OR REPLACE INTO tabelle (k,v,agg) VALUES (?,?,?)").bind(nome, v, new Date().toISOString()).run();
    return v;
  } catch (e) {
    if (c) return c.v; // meglio una tabella vecchia che niente
    throw new Error("tabelle_non_disponibili");
  }
}
async function mappa(env, nome) {
  const m = new Map();
  for (const l of (await tabella(env, nome)).split("\n")) { const [k, n, p] = l.split("|"); m.set(k, { n, p }); }
  return m;
}
async function tabellaCheckin(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS checkin (richiesta_id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, creato TEXT NOT NULL, arrivo TEXT, partenza TEXT, compilato TEXT, dati TEXT, istat TEXT, cancellato TEXT)").run();
  // privacy: i dati personali si cancellano 7 giorni dopo la partenza; restano solo i dati anonimi per l'ISTAT
  const limite = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  await env.DB.prepare("UPDATE checkin SET dati=NULL, cancellato=? WHERE dati IS NOT NULL AND partenza < ?").bind(new Date().toISOString(), limite).run();
}
async function creaCheckin(env, r) {
  await tabellaCheckin(env);
  const tok = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await env.DB.prepare("INSERT OR IGNORE INTO checkin (richiesta_id,token,creato,arrivo,partenza) VALUES (?,?,?,?,?)").bind(r.id, tok, new Date().toISOString(), r.arrivo, r.partenza).run();
  await env.DB.prepare("UPDATE checkin SET arrivo=?, partenza=? WHERE richiesta_id=?").bind(r.arrivo, r.partenza, r.id).run();
  return (await env.DB.prepare("SELECT token FROM checkin WHERE richiesta_id=?").bind(r.id).first()).token;
}
const etaA = (nascita, data) => { const a = new Date(nascita + "T12:00:00Z"), b = new Date(data + "T12:00:00Z"); let e = b.getUTCFullYear() - a.getUTCFullYear(); if (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) e--; return e; };
const soloLettere = (s, n) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z' -]/g, "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, n);
async function validaCheckin(env, body, ric) {
  const stati = await mappa(env, "STATI"), comuni = await mappa(env, "COMUNI"), docs = await mappa(env, "DOCUMENTI");
  const L = Array.isArray(body.ospiti) ? body.ospiti.slice(0, MAX_OSPITI) : [];
  if (!L.length) return { errore: "ospiti" };
  const tipo = L.length === 1 ? "singolo" : body.tipo === "gruppo" ? "gruppo" : "famiglia";
  const oggi = new Date().toISOString().slice(0, 10), out = [], istat = [];
  for (let i = 0; i < L.length; i++) {
    const o = L[i] || {}, e = (campo) => ({ errore: "campo", ospite: i, campo });
    const g = {
      cognome: soloLettere(o.cognome, 50), nome: soloLettere(o.nome, 30), sesso: o.sesso === "F" ? "F" : o.sesso === "M" ? "M" : "",
      nascita: String(o.nascita || ""), statoNascita: String(o.statoNascita || ""), comuneNascita: String(o.comuneNascita || ""),
      cittadinanza: String(o.cittadinanza || ""), statoRes: String(o.statoRes || ""), comuneRes: String(o.comuneRes || ""),
    };
    if (!g.cognome) return e("cognome");
    if (!g.nome) return e("nome");
    if (!g.sesso) return e("sesso");
    if (!DATE.test(g.nascita) || g.nascita > oggi || g.nascita < "1900-01-01") return e("nascita");
    if (!stati.has(g.statoNascita)) return e("statoNascita");
    if (g.statoNascita === ITALIA) { if (!comuni.has(g.comuneNascita)) return e("comuneNascita"); } else g.comuneNascita = "";
    if (!stati.has(g.cittadinanza)) return e("cittadinanza");
    if (!stati.has(g.statoRes)) return e("statoRes");
    if (g.statoRes === ITALIA) { if (!comuni.has(g.comuneRes)) return e("comuneRes"); } else g.comuneRes = "";
    if (i === 0) {
      g.docTipo = String(o.docTipo || ""); g.docNumero = String(o.docNumero || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
      g.docStato = String(o.docStato || ""); g.docComune = String(o.docComune || "");
      if (!docs.has(g.docTipo)) return e("docTipo");
      if (g.docNumero.length < 4) return e("docNumero");
      if (!stati.has(g.docStato)) return e("docStato");
      if (g.docStato === ITALIA) { if (!comuni.has(g.docComune)) return e("docComune"); } else g.docComune = "";
      if (etaA(g.nascita, ric.arrivo) < 18) return e("maggiorenne");
    }
    out.push(g);
    istat.push({ sesso: g.sesso, eta: etaA(g.nascita, ric.arrivo), cittadinanza: g.cittadinanza, statoRes: g.statoRes, comuneRes: g.comuneRes });
  }
  return { tipo, ospiti: out, istat: { tipo, ospiti: istat } };
}
const pad = (s, n) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().padEnd(n, " ").slice(0, n);
const dmy = (d) => d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4);
async function fileAlloggiati(env, ck) {
  const comuni = await mappa(env, "COMUNI");
  const D = JSON.parse(ck.dati), giorni = String(Math.min(30, Math.max(1, notti(ck.arrivo, ck.partenza)))).padStart(2, "0");
  const righe = D.ospiti.map((g, i) => {
    const t = D.tipo === "singolo" ? "16" : i === 0 ? (D.tipo === "gruppo" ? "18" : "17") : (D.tipo === "gruppo" ? "20" : "19");
    let r = t + dmy(ck.arrivo) + giorni + pad(g.cognome, 50) + pad(g.nome, 30) + (g.sesso === "F" ? "2" : "1") + dmy(g.nascita)
      + pad(g.comuneNascita, 9) + pad(g.comuneNascita ? (comuni.get(g.comuneNascita) || {}).p : "", 2) + pad(g.statoNascita, 9) + pad(g.cittadinanza, 9);
    r += i === 0 ? pad(g.docTipo, 5) + pad(g.docNumero, 20) + pad(g.docStato === ITALIA ? g.docComune : g.docStato, 9) : " ".repeat(34);
    return r;
  });
  return righe.join("\r\n");
}
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function residenza(o) { return o.statoRes === ITALIA && o.comuneRes ? `<comuneresidenza>${o.comuneRes}</comuneresidenza>` : `<paeseresidenza>${o.statoRes}</paeseresidenza>`; }
async function spotMese(env, mese) {
  await tabellaCheckin(env);
  const [y, m] = mese.split("-").map(Number), ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const da = `${mese}-01`, a = `${mese}-${String(ultimo).padStart(2, "0")}`;
  const rows = (await env.DB.prepare("SELECT richiesta_id, arrivo, partenza, istat FROM checkin WHERE istat IS NOT NULL AND arrivo <= ? AND partenza >= ?").bind(a, da).all()).results || [];
  const C = rows.map((r) => ({ ...r, I: JSON.parse(r.istat) }));
  const cod = (r, i) => (r.richiesta_id + i).replace(/[^a-z0-9]/gi, "").toUpperCase();
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n<movimenti vendor="Casalaggiu" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="movimentogiornaliero-0.6.xsd">\n`;
  const riep = { arrivi: 0, presenze: 0, provenienze: {} };
  for (let d = 1; d <= ultimo; d++) {
    const g = `${mese}-${String(d).padStart(2, "0")}`;
    const arr = C.filter((r) => r.arrivo === g), par = C.filter((r) => r.partenza === g), occ = C.some((r) => r.arrivo <= g && g < r.partenza);
    const ds = `<datistruttura><cameredisponibili>1</cameredisponibili><postilettodisponibili>${MAX_OSPITI}</postilettodisponibili><camereoccupate>${occ ? 1 : 0}</camereoccupate></datistruttura>`;
    if (!arr.length && !par.length) { x += `  <movimento type="NM" data="${g}">${ds}</movimento>\n`; continue; }
    x += `  <movimento type="MP" data="${g}">\n`;
    if (arr.length) {
      x += "    <arrivi>\n";
      for (const r of arr) {
        const O = r.I.ospiti, t = r.I.tipo === "singolo" ? "16" : r.I.tipo === "gruppo" ? "18" : "17";
        x += `      <arrivo><codiceclientesr>${cod(r, 0)}</codiceclientesr><sesso>${O[0].sesso}</sesso><cittadinanza>${O[0].cittadinanza}</cittadinanza>${residenza(O[0])}<occupazionepostoletto>si</occupazionepostoletto><dayuse>no</dayuse><tipologiaalloggiato>${t}</tipologiaalloggiato><eta>${O[0].eta}</eta>`;
        if (O.length > 1) x += "<componenti>" + O.slice(1).map((o, i) => `<componente><codiceclientesr>${cod(r, i + 1)}</codiceclientesr><sesso>${o.sesso}</sesso><cittadinanza>${o.cittadinanza}</cittadinanza>${residenza(o)}<occupazionepostoletto>si</occupazionepostoletto><eta>${o.eta}</eta></componente>`).join("") + "</componenti>";
        x += "</arrivo>\n";
      }
      x += "    </arrivi>\n";
    }
    if (par.length) x += "    <partenze>" + par.map((r) => `<codiceclientesr>${cod(r, 0)}</codiceclientesr>`).join("") + "</partenze>\n";
    x += `    ${ds}\n  </movimento>\n`;
  }
  x += "</movimenti>\n";
  // riepilogo per chi compila SPOT Easy a mano: arrivi nel mese e presenze (notti) nel mese per provenienza
  const stati = await mappa(env, "STATI"), comuni = await mappa(env, "COMUNI");
  for (const r of C) {
    const notteDa = r.arrivo > da ? r.arrivo : da, notteA = r.partenza <= a ? r.partenza : new Date(Date.parse(a) + 864e5).toISOString().slice(0, 10);
    const pres = Math.max(0, notti(notteDa, notteA));
    for (const o of r.I.ospiti) {
      const k = o.statoRes === ITALIA ? "Italia · provincia " + ((comuni.get(o.comuneRes) || {}).p || "?") : ((stati.get(o.statoRes) || {}).n || o.statoRes);
      const v = riep.provenienze[k] || (riep.provenienze[k] = { arrivi: 0, presenze: 0 });
      if (r.arrivo >= da && r.arrivo <= a) { v.arrivi++; riep.arrivi++; }
      v.presenze += pres; riep.presenze += pres;
    }
  }
  return { xml: x, riepilogo: riep, soggiorni: C.length };
}

// ---------- SumUp ----------
// Il link mandato all'ospite punta a paga.html sul nostro sito: a ogni apertura il Worker crea
// (o riusa) un checkout SumUp, perché le pagine di pagamento SumUp scadono dopo 30 minuti.
const SITO = "https://casalaggiu.it";
const sumupApi = (env) => env.SUMUP_API || "https://api.sumup.com";
let pagamentiPronta = false;
async function tabellaPagamenti(env) {
  if (pagamentiPronta) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS pagamenti (id TEXT PRIMARY KEY, creato TEXT NOT NULL, richiesta_id TEXT, descrizione TEXT NOT NULL, importo REAL NOT NULL, stato TEXT NOT NULL, checkout_id TEXT, checkout_url TEXT, checkout_creato TEXT, pagato_il TEXT, metodo TEXT)").run();
  try { await env.DB.prepare("ALTER TABLE pagamenti ADD COLUMN metodo TEXT").run(); } catch (e) { /* colonna già presente */ }
  try { await env.DB.prepare("ALTER TABLE pagamenti ADD COLUMN transazione TEXT").run(); } catch (e) { /* colonna già presente */ }
  try { await env.DB.prepare("ALTER TABLE pagamenti ADD COLUMN rimborsato REAL").run(); } catch (e) { /* colonna già presente */ }
  pagamentiPronta = true;
}
// controllo IBAN (mod 97)
function ibanValido(iban) {
  const s = String(iban || "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const ch of r) m = (m * 10 + Number(ch)) % 97;
  return m === 1;
}
const causaleDi = (p) => `Casalaggiu ${p.id.slice(0, 6).toUpperCase()} ${p.descrizione}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 \/\-?:().,'+]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
// id della transazione riuscita di un checkout (serve per i rimborsi)
const transazioneDi = (c) => ((c.transactions || []).find((t) => t.status === "SUCCESSFUL") || {}).id || c.transaction_id || null;
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
    if (u.meta && u.meta.changes) {
      await env.DB.prepare("UPDATE pagamenti SET metodo='carta', transazione=? WHERE id=?").bind(transazioneDi(c), p.id).run();
      ctx.waitUntil(telegram(env, `💳 Pagamento ricevuto con SumUp\n${p.descrizione}\n💶 ${Number(p.importo).toFixed(2)} €`));
    }
    return "pagato";
  }
  return p.stato;
}
// ---------- servizi extra (spuntati dall'ospite nel modulo) ----------
// tipo: soggiorno | notte | persona | persona_notte ; nomi: {"it":..,"en":..,...}
const TIPI_SERVIZIO = ["soggiorno", "notte", "persona", "persona_notte"];
async function serviziAttivi(env) {
  try { return (await env.DB.prepare("SELECT id, nomi, prezzo, tipo FROM servizi WHERE attivo=1 ORDER BY ordine, rowid").all()).results || []; } catch (e) { return []; }
}
const nomeServizio = (sv, l = "it") => { let m = {}; try { m = JSON.parse(sv.nomi || "{}"); } catch (e) { m = {}; } return m[l] || m.en || m.it || "Servizio"; };
const costoServizio = (sv, n, g) => Math.round(sv.prezzo * (sv.tipo === "notte" ? n : sv.tipo === "persona" ? g : sv.tipo === "persona_notte" ? n * g : 1) * 100) / 100;

// ---------- sconti (soggiorno lungo, last minute, codici) ----------
// Si applica solo il più alto tra gli sconti validi, sul solo soggiorno (non su animali e servizi).
async function regoleSconti(env) {
  const n = async (k) => Number(await getSet(env, k)) || 0;
  return { lungo: { pct: await n("sc_lungo_pct"), notti: await n("sc_lungo_notti") }, lm: { pct: await n("sc_lm_pct"), giorni: await n("sc_lm_giorni") } };
}
async function codiceValido(env, c) {
  c = String(c || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,20}$/.test(c)) return null;
  const r = await env.DB.prepare("SELECT codice, pct, scade FROM codici WHERE codice=? AND attivo=1").bind(c).first();
  if (!r) return null;
  if (r.scade && r.scade < new Date().toISOString().slice(0, 10)) return null;
  return r;
}
async function calcolaSconto(env, arrivo, partenza, codice) {
  const R = await regoleSconti(env), n = notti(arrivo, partenza);
  const giorni = Math.round((Date.parse(arrivo) - Date.parse(new Date().toISOString().slice(0, 10))) / 864e5);
  const cand = [];
  if (R.lungo.pct > 0 && R.lungo.notti > 0 && n >= R.lungo.notti) cand.push({ tipo: "lungo", pct: R.lungo.pct });
  if (R.lm.pct > 0 && R.lm.giorni > 0 && giorni >= 0 && giorni <= R.lm.giorni) cand.push({ tipo: "lastminute", pct: R.lm.pct });
  const c = codice ? await codiceValido(env, codice) : null;
  if (c) cand.push({ tipo: "codice", pct: c.pct, codice: c.codice });
  return cand.sort((a, b) => b.pct - a.pct)[0] || null;
}

// ---------- email agli ospiti (Resend) ----------
const resendApi = (env) => env.RESEND_API || "https://api.resend.com";
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;
const escH = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function htmlMail(testo) {
  const corpo = escH(testo).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#138a86">$1</a>').replace(/\n/g, "<br>");
  return `<!doctype html><html><body style="margin:0;background:#f6f5f1;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#14233a"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dfe1dc;border-radius:14px;padding:26px 24px"><div style="font-family:Georgia,'Times New Roman',serif;font-size:26px">Casalaggiù</div><div style="font-size:10px;letter-spacing:3px;color:#c66a3d;margin:4px 0 20px">CUTROFIANO · SALENTO</div><div style="font-size:15px;line-height:1.6">${corpo}</div></div><div style="max-width:560px;margin:10px auto 0;font-size:11px;color:#5b6676;text-align:center">Casa laggiù · Via Roma 13, 73020 Cutrofiano (LE) · CIN IT075026C200122953</div></body></html>`;
}
async function inviaEmail(env, to, oggetto, testo) {
  const key = await getSet(env, "resend_key"), da = await getSet(env, "mail_from"), rispondi = await getSet(env, "mail_reply");
  if (!key || !da) return { ok: false, errore: "email_non_configurata" };
  if (!EMAIL_RE.test(to)) return { ok: false, errore: "email_destinatario" };
  const r = await fetch(resendApi(env) + "/emails", {
    method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `Casalaggiù <${da}>`, to: [to], reply_to: rispondi || undefined, subject: oggetto, text: testo, html: htmlMail(testo) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const err = d.message || d.name || "HTTP " + r.status; await putSet(env, "mail_last_error", `${new Date().toISOString().slice(0, 16)} ${err}`); return { ok: false, errore: "resend", dettaglio: err }; }
  await putSet(env, "mail_last_error", null);
  return { ok: true, id: d.id };
}
// conferma di ricezione automatica all'ospite (se ha lasciato un'email)
const RICEVUTA_RICHIESTA = {
  it: { sub: "Abbiamo ricevuto la tua richiesta – Casalaggiù", hi: "Ciao", t1: "grazie per la tua richiesta per Casalaggiù.", d: "Date", n: ["notte", "notti"], o: ["ospite", "ospiti"], tot: "Totale indicativo", t2: "Ti rispondiamo al più presto per confermare la disponibilità. Questa email non è ancora una conferma di prenotazione.", t3: "Per qualsiasi domanda puoi rispondere a questa email." },
  en: { sub: "We received your request – Casalaggiù", hi: "Hi", t1: "thank you for your request for Casalaggiù.", d: "Dates", n: ["night", "nights"], o: ["guest", "guests"], tot: "Estimated total", t2: "We will get back to you shortly to confirm availability. This email is not yet a booking confirmation.", t3: "If you have any questions, just reply to this email." },
  de: { sub: "Wir haben deine Anfrage erhalten – Casalaggiù", hi: "Hallo", t1: "danke für deine Anfrage für die Casalaggiù.", d: "Daten", n: ["Nacht", "Nächte"], o: ["Gast", "Gäste"], tot: "Voraussichtlicher Gesamtpreis", t2: "Wir melden uns so bald wie möglich, um die Verfügbarkeit zu bestätigen. Diese E-Mail ist noch keine Buchungsbestätigung.", t3: "Bei Fragen antworte einfach auf diese E-Mail." },
  nl: { sub: "We hebben je aanvraag ontvangen – Casalaggiù", hi: "Hoi", t1: "bedankt voor je aanvraag voor Casalaggiù.", d: "Data", n: ["nacht", "nachten"], o: ["gast", "gasten"], tot: "Geschat totaal", t2: "We nemen zo snel mogelijk contact op om de beschikbaarheid te bevestigen. Deze e-mail is nog geen boekingsbevestiging.", t3: "Vragen? Beantwoord gewoon deze e-mail." },
  es: { sub: "Hemos recibido tu solicitud – Casalaggiù", hi: "Hola", t1: "gracias por tu solicitud para Casalaggiù.", d: "Fechas", n: ["noche", "noches"], o: ["huésped", "huéspedes"], tot: "Total orientativo", t2: "Te responderemos lo antes posible para confirmar la disponibilidad. Este correo todavía no es una confirmación de reserva.", t3: "Si tienes cualquier duda, responde a este correo." },
  fr: { sub: "Nous avons bien reçu votre demande – Casalaggiù", hi: "Bonjour", t1: "merci pour votre demande pour Casalaggiù.", d: "Dates", n: ["nuit", "nuits"], o: ["personne", "personnes"], tot: "Total indicatif", t2: "Nous vous répondrons au plus vite pour confirmer la disponibilité. Cet e-mail n'est pas encore une confirmation de réservation.", t3: "Pour toute question, répondez simplement à cet e-mail." },
};
async function emailRicezione(env, r, tot) {
  if ((await getSet(env, "mail_auto")) !== "1" || !EMAIL_RE.test(r.contatto)) return;
  const L = RICEVUTA_RICHIESTA[r.lingua] ? r.lingua : "it", t = RICEVUTA_RICHIESTA[L];
  const loc = L === "en" ? "en-GB" : L;
  const fd = (x) => new Date(x + "T12:00:00Z").toLocaleDateString(loc, { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const n = notti(r.arrivo, r.partenza), nome = String(r.nome).trim().split(/\s+/)[0];
  const righe = [`${t.hi} ${nome},`, "", t.t1, "", `${t.d}: ${fd(r.arrivo)} → ${fd(r.partenza)} (${n} ${t.n[n === 1 ? 0 : 1]}, ${r.ospiti} ${t.o[r.ospiti === 1 ? 0 : 1]})`];
  if (tot) righe.push(`${t.tot}: ${new Intl.NumberFormat(loc, { style: "currency", currency: "EUR" }).format(tot)}`);
  righe.push("", t.t2, t.t3, "", "Casalaggiù · " + SITO);
  await inviaEmail(env, r.contatto, t.sub, righe.join("\n"));
}

// ---------- ricevute ----------
// Ricevuta per locazione turistica: numero progressivo per anno, link pubblico ricevuta.html?k=<id>.
let ricevutePronta = false;
async function tabellaRicevute(env) {
  if (ricevutePronta) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS ricevute (id TEXT PRIMARY KEY, anno INTEGER NOT NULL, numero INTEGER NOT NULL, creata TEXT NOT NULL, pagamento_id TEXT, intestatario TEXT NOT NULL, cf TEXT, indirizzo TEXT, descrizione TEXT NOT NULL, arrivo TEXT, partenza TEXT, ospiti INTEGER, importo REAL NOT NULL, metodo TEXT, pagato_il TEXT, lingua TEXT, locatore TEXT, annullata INTEGER NOT NULL DEFAULT 0, UNIQUE(anno, numero))").run();
  ricevutePronta = true;
}
async function locatore(env) {
  return { nome: (await getSet(env, "loc_nome")) || "", cf: (await getSet(env, "loc_cf")) || "", indirizzo: (await getSet(env, "loc_indirizzo")) || "" };
}

async function paga(env, id, ctx) {
  await tabellaPagamenti(env);
  const p = await env.DB.prepare("SELECT * FROM pagamenti WHERE id=?").bind(id).first();
  if (!p) return json({ ok: false, errore: "non_trovato" }, 404);
  const pub = { descrizione: p.descrizione, importo: p.importo };
  let stato = await verificaPagamento(env, p, ctx);
  if (stato !== "da_pagare") return json({ ok: true, stato, ...pub });
  const iban = await getSet(env, "iban"), benef = await getSet(env, "beneficiario");
  if (iban && benef) pub.bonifico = { iban, beneficiario: benef, causale: causaleDi(p) };
  const key = await getSet(env, "sumup_key"), merchant = await getSet(env, "sumup_merchant");
  if (!key || !merchant) return pub.bonifico ? json({ ok: true, stato, ...pub }) : json({ ok: false, errore: "non_configurato" }, 503);
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
  if (!r.ok || !c.hosted_checkout_url) {
    if (pub.bonifico) return json({ ok: true, stato, carta_errore: true, ...pub });
    return json({ ok: false, errore: "sumup_errore", dettaglio: c.message || c.error_code || r.status }, 502);
  }
  await env.DB.prepare("UPDATE pagamenti SET checkout_id=?, checkout_url=?, checkout_creato=? WHERE id=?").bind(c.id, c.hosted_checkout_url, new Date().toISOString(), p.id).run();
  return json({ ok: true, stato, url: c.hosted_checkout_url, ...pub });
}

// ---------- calendario per iPhone / Mac (iCalendar) ----------
async function icalToken(env) {
  let k = await getSet(env, "ical_k");
  if (!k) { k = crypto.randomUUID().replace(/-/g, ""); await putSet(env, "ical_k", k); }
  return k;
}
const icEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icData = (d) => d.replace(/-/g, "");
function icPiega(riga) {
  // righe di massimo 75 byte, come vuole lo standard
  const out = []; let cur = "", n = 0;
  for (const ch of riga) {
    const b = new TextEncoder().encode(ch).length;
    if (n + b > 74) { out.push(cur); cur = " "; n = 1; }
    cur += ch; n += b;
  }
  out.push(cur); return out.join("\r\n");
}
async function calendario(env) {
  const occ = (await env.DB.prepare("SELECT o.*, r.ospiti, r.nome, r.contatto, r.telefono, r.messaggio, r.animale FROM occupato o LEFT JOIN richieste r ON r.id = o.richiesta_id ORDER BY o.arrivo").all()).results || [];
  const nuove = (await env.DB.prepare("SELECT * FROM richieste WHERE stato='nuova' ORDER BY arrivo").all()).results || [];
  const ora = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Casalaggiu//Prenotazioni//IT", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Casalaggiù", "X-WR-TIMEZONE:Europe/Rome", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  const ev = (uid, dal, al, titolo, desc, prov) => {
    L.push("BEGIN:VEVENT", `UID:${uid}@casalaggiu.boneggio.it`, `DTSTAMP:${ora}`, `DTSTART;VALUE=DATE:${icData(dal)}`, `DTEND;VALUE=DATE:${icData(al)}`,
      icPiega(`SUMMARY:${icEsc(titolo)}`), icPiega(`DESCRIPTION:${icEsc(desc)}`), "TRANSP:OPAQUE", prov ? "STATUS:TENTATIVE" : "STATUS:CONFIRMED", "END:VEVENT");
  };
  for (const o of occ) {
    if (o.richiesta_id) ev(o.id, o.arrivo, o.partenza, `🏠 ${o.nome || "Ospite"} (${o.ospiti || "?"})${o.animale ? " 🐾" : ""}`, [`Arrivo ${o.arrivo} dalle 14:00, partenza ${o.partenza} entro le 10:00`, o.contatto ? `Contatto: ${o.contatto}${o.telefono ? " · tel. " + o.telefono : ""}` : "", o.messaggio ? `Messaggio: ${o.messaggio}` : ""].filter(Boolean).join("\n"));
    else ev(o.id, o.arrivo, o.partenza, `⛔ ${o.nota || "Date bloccate"}`, `Date bloccate dall'area proprietario. Partenza ${o.partenza}.`);
  }
  for (const r of nuove) ev("q_" + r.id, r.arrivo, r.partenza, `❓ Richiesta: ${r.nome} (${r.ospiti})${r.animale ? " 🐾" : ""}`, `Da confermare nell'area proprietario.\nContatto: ${r.contatto}${r.telefono ? " · tel. " + r.telefono : ""}${r.messaggio ? "\nMessaggio: " + r.messaggio : ""}`, true);
  L.push("END:VCALENDAR");
  return new Response(L.join("\r\n") + "\r\n", { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store", ...CORS } });
}

// ---------- autenticazione proprietario ----------
async function isAdmin(env, password) {
  const sha = await getSet(env, "admin_sha");
  if (!sha || !password) return false;
  return (await sha256(String(password))) === sha;
}

// aggiornamenti del database fatti in automatico (una volta per istanza)
let migrato = false;
async function migra(env) {
  if (migrato) return;
  try { await env.DB.prepare("ALTER TABLE richieste ADD COLUMN animale INTEGER NOT NULL DEFAULT 0").run(); } catch (e) { /* già presente */ }
  try { await env.DB.prepare("ALTER TABLE richieste ADD COLUMN totale REAL").run(); } catch (e) { /* già presente */ }
  try { await env.DB.prepare("ALTER TABLE prezzi ADD COLUMN per_ospiti TEXT").run(); } catch (e) { /* già presente */ }
  try { await env.DB.prepare("ALTER TABLE richieste ADD COLUMN email_inviata TEXT").run(); } catch (e) { /* già presente */ }
  try { await env.DB.prepare("ALTER TABLE richieste ADD COLUMN servizi TEXT").run(); } catch (e) { /* già presente */ }
  try { await env.DB.prepare("ALTER TABLE richieste ADD COLUMN sconto TEXT").run(); } catch (e) { /* già presente */ }
  try { await env.DB.prepare("ALTER TABLE prezzi ADD COLUMN min_notti INTEGER").run(); } catch (e) { /* già presente */ }
  try { await env.DB.prepare("ALTER TABLE prezzi ADD COLUMN sup_brevi TEXT").run(); } catch (e) { /* già presente */ }
  try { await env.DB.prepare("ALTER TABLE richieste ADD COLUMN supplemento REAL").run(); } catch (e) { /* già presente */ }
  try { await env.DB.prepare("ALTER TABLE richieste ADD COLUMN telefono TEXT").run(); } catch (e) { /* già presente */ }
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS codici (codice TEXT PRIMARY KEY, pct REAL NOT NULL, attivo INTEGER NOT NULL DEFAULT 1, scade TEXT, nota TEXT, creato TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS servizi (id TEXT PRIMARY KEY, nomi TEXT NOT NULL, prezzo REAL NOT NULL, tipo TEXT NOT NULL, attivo INTEGER NOT NULL DEFAULT 1, ordine INTEGER NOT NULL DEFAULT 0)").run();
  migrato = true;
}

async function handlePost(body, env, ctx) {
  const a = body.action;
  await migra(env);

  if (a === "richiesta") {
    if (body.sito) return json({ ok: true }); // campo trappola anti-spam compilato: ignora
    const arrivo = String(body.arrivo || ""), partenza = String(body.partenza || "");
    const ospiti = parseInt(body.ospiti, 10);
    const nome = clean(body.nome, 120), contatto = clean(body.contatto, 160);
    const messaggio = clean(body.messaggio, 800), lingua = clean(body.lingua, 5);
    const animale = body.animale ? 1 : 0;
    const oggi = new Date().toISOString().slice(0, 10);
    if (!DATE.test(arrivo) || !DATE.test(partenza) || arrivo < oggi || partenza <= arrivo) return json({ ok: false, errore: "date" }, 400);
    const minimo = await minNotti(env, arrivo);
    if (notti(arrivo, partenza) < minimo || notti(arrivo, partenza) > 90) return json({ ok: false, errore: "notti", min: minimo }, 400);
    if (!(ospiti >= 1 && ospiti <= MAX_OSPITI)) return json({ ok: false, errore: "ospiti" }, 400);
    if (!nome || !contatto) return json({ ok: false, errore: "campi" }, 400);
    if (!EMAIL_RE.test(contatto)) return json({ ok: false, errore: "email" }, 400);
    const telefono = clean(body.telefono, 30).replace(/[^\d+ ]/g, "").trim();
    if (telefono && telefono.replace(/\D/g, "").length < 6) return json({ ok: false, errore: "telefono" }, 400);
    if (await sovrapposto(env, arrivo, partenza)) return json({ ok: false, errore: "occupato" }, 409);
    // limite semplice: massimo 20 richieste nell'ultima ora
    const recenti = await env.DB.prepare("SELECT COUNT(*) n FROM richieste WHERE creata > ?").bind(new Date(Date.now() - 3600e3).toISOString()).first();
    if (recenti && recenti.n > 20) return json({ ok: false, errore: "troppe" }, 429);

    const id = uid();
    const creata = new Date().toISOString();
    try {
      await env.DB.prepare("INSERT INTO richieste (id,creata,arrivo,partenza,ospiti,nome,contatto,messaggio,lingua,stato,animale) VALUES (?,?,?,?,?,?,?,?,?, 'nuova', ?)")
        .bind(id, creata, arrivo, partenza, ospiti, nome, contatto, messaggio, lingua, animale).run();
    } catch (e) {
      // se la colonna "animale" non esiste ancora, salva comunque la richiesta
      await env.DB.prepare("INSERT INTO richieste (id,creata,arrivo,partenza,ospiti,nome,contatto,messaggio,lingua,stato) VALUES (?,?,?,?,?,?,?,?,?, 'nuova')")
        .bind(id, creata, arrivo, partenza, ospiti, nome, contatto, messaggio + (animale ? " [con animale]" : ""), lingua).run();
    }
    if (telefono) { try { await env.DB.prepare("UPDATE richieste SET telefono=? WHERE id=?").bind(telefono, id).run(); } catch (e) { /* colonna non ancora pronta */ } }
    const supPet = Number(await getSet(env, "supplemento_pet")) || 0;
    // servizi extra scelti dall'ospite (solo quelli attivi, prezzo calcolato qui)
    const scelti = Array.isArray(body.servizi) ? body.servizi.map(String) : [];
    const nN = notti(arrivo, partenza);
    const extra = (await serviziAttivi(env)).filter((sv) => scelti.includes(sv.id)).map((sv) => ({ id: sv.id, nome: nomeServizio(sv, "it"), importo: costoServizio(sv, nN, ospiti) }));
    const totExtra = extra.reduce((a, x) => a + x.importo, 0);
    if (extra.length) { try { await env.DB.prepare("UPDATE richieste SET servizi=? WHERE id=?").bind(JSON.stringify(extra), id).run(); } catch (e) { /* colonna non ancora pronta */ } }
    const st = await stima(env, arrivo, partenza, ospiti);
    const sc = await calcolaSconto(env, arrivo, partenza, body.codice);
    let scImp = 0;
    if (sc) {
      // con stima parziale lo sconto si calcola sulle notti che hanno già un prezzo
      if (st.totale) scImp = Math.round(st.totale * sc.pct) / 100;
      try { await env.DB.prepare("UPDATE richieste SET sconto=? WHERE id=?").bind(JSON.stringify({ ...sc, importo: scImp, parziale: !st.completa }), id).run(); } catch (e) { /* colonna non ancora pronta */ }
    }
    const sb = await supBreve(env, arrivo, nN);
    if (sb) { try { await env.DB.prepare("UPDATE richieste SET supplemento=? WHERE id=?").bind(sb, id).run(); } catch (e) { /* colonna non ancora pronta */ } }
    const tot = st.totale && st.completa ? Math.round((st.totale - scImp + sb + (animale ? supPet : 0) + totExtra) * 100) / 100 : null;
    if (tot) { try { await env.DB.prepare("UPDATE richieste SET totale=? WHERE id=?").bind(tot, id).run(); } catch (e) { /* colonna non ancora pronta */ } }
    const prezzo = (tot ? `\n💶 totale: ${tot} €${animale && supPet ? ` (di cui ${supPet} € pulizia animale)` : ""}` : st.totale ? `\n💶 stima parziale: ${st.totale} € (alcune notti senza prezzo)` : "") + (sb ? `\n⏱️ supplemento soggiorno breve (${nN} ${nN === 1 ? "notte" : "notti"}): ${sb} €` : "") + (extra.length ? "\n➕ " + extra.map((x) => `${x.nome} ${x.importo} €`).join(", ") : "") + (sc ? `\n🏷️ sconto ${sc.tipo === "codice" ? "codice " + sc.codice : sc.tipo === "lungo" ? "soggiorno lungo" : "last minute"} -${sc.pct}%${scImp ? ` (-${scImp} €${st.completa ? "" : " sulle notti con prezzo"})` : ""}` : "");
    const testo = `🏠 Nuova richiesta Casalaggiù\n📅 ${arrivo} → ${partenza} (${notti(arrivo, partenza)} notti)\n👥 ${ospiti} ospiti\n👤 ${nome}\n📧 ${contatto}${telefono ? `\n📞 ${telefono}` : ""}\n🌍 lingua: ${lingua.toUpperCase()}` + prezzo + (animale ? `\n🐾 con animale${supPet && !tot ? ` (+${supPet} € pulizia)` : ""}` : "") + (messaggio ? `\n💬 ${messaggio}` : "");
    ctx.waitUntil(telegram(env, testo));
    ctx.waitUntil(emailRicezione(env, { arrivo, partenza, ospiti, nome, contatto, lingua }, tot).catch(() => {}));
    return json({ ok: true, id });
  }

  if (a === "checkin_invia") {
    const t = String(body.t || "");
    if (!/^[a-f0-9]{16}$/.test(t)) return json({ ok: false, errore: "non_trovato" }, 404);
    await tabellaCheckin(env);
    const ck = await env.DB.prepare("SELECT * FROM checkin WHERE token=?").bind(t).first();
    if (!ck) return json({ ok: false, errore: "non_trovato" }, 404);
    const ric = await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(ck.richiesta_id).first();
    if (!ric || ric.stato !== "confermata") return json({ ok: false, errore: "non_trovato" }, 404);
    if (ck.partenza < new Date().toISOString().slice(0, 10)) return json({ ok: false, errore: "scaduto" }, 410);
    let v;
    try { v = await validaCheckin(env, body, ric); } catch (e) { return json({ ok: false, errore: "tabelle" }, 503); }
    if (v.errore) return json({ ok: false, ...v }, 400);
    const prima = !ck.compilato;
    await env.DB.prepare("UPDATE checkin SET compilato=?, dati=?, istat=?, cancellato=NULL WHERE token=?").bind(new Date().toISOString(), JSON.stringify({ tipo: v.tipo, ospiti: v.ospiti }), JSON.stringify(v.istat), t).run();
    ctx.waitUntil(telegram(env, `🪪 Check-in ${prima ? "compilato" : "aggiornato"}: ${ric.nome}, ${ric.arrivo} → ${ric.partenza}, ${v.ospiti.length} ${v.ospiti.length === 1 ? "ospite" : "ospiti"}. I dati sono nel pannello admin.`));
    return json({ ok: true });
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
    await tabellaCheckin(env);
    const ck = await env.DB.prepare("SELECT richiesta_id, token, compilato, cancellato, CASE WHEN dati IS NULL THEN 0 ELSE 1 END AS ha_dati FROM checkin").all();
    return json({
      ok: true, richieste: r.results, occupato: o.results, prezzi: pz.results, checkin: ck.results,
      telegram: { token: !!(await getSet(env, "tg_token")), gruppo: await getSet(env, "tg_chat"), errore: await getSet(env, "tg_last_error") },
      sumup: { merchant: await getSet(env, "sumup_merchant") },
      email: { attiva: !!(await getSet(env, "resend_key")), mittente: await getSet(env, "mail_from"), rispondi: await getSet(env, "mail_reply"), auto: (await getSet(env, "mail_auto")) === "1", errore: await getSet(env, "mail_last_error") },
      impostazioni: { iban: await getSet(env, "iban"), beneficiario: await getSet(env, "beneficiario"), supplemento_pet: Number(await getSet(env, "supplemento_pet")) || 0, prezzi_ospiti: (await getSet(env, "prezzi_ospiti")) === "1", min_notti: await minNottiBase(env), ical: await icalToken(env), locatore: await locatore(env), whatsapp: await getSet(env, "whatsapp") },
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
      await creaCheckin(env, r);
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
    await tabellaCheckin(env);
    await env.DB.prepare("DELETE FROM checkin WHERE richiesta_id=?").bind(id).run();
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
    let prezzo = Math.round(Number(body.prezzo) * 100) / 100;
    if (!DATE.test(dal) || !DATE.test(al) || al < dal) return json({ ok: false, errore: "date" }, 400);
    const tipo = body.tipo === "settimana" ? "settimana" : "notte";
    let perOsp = null;
    if (body.per_ospiti && typeof body.per_ospiti === "object") {
      const m = {};
      for (let g = 1; g <= MAX_OSPITI; g++) {
        const v = Math.round(Number(body.per_ospiti[g]) * 100) / 100;
        if (body.per_ospiti[g] !== "" && body.per_ospiti[g] != null && !(v > 0 && v < 50000)) return json({ ok: false, errore: "prezzo" }, 400);
        if (v > 0) m[g] = v;
      }
      if (!Object.keys(m).length) return json({ ok: false, errore: "prezzo" }, 400);
      perOsp = JSON.stringify(m);
      prezzo = Math.max(...Object.values(m)); // prezzo "pieno" usato se la funzione viene disattivata
    }
    if (!(prezzo > 0 && prezzo < 50000)) return json({ ok: false, errore: "prezzo" }, 400);
    const c = await env.DB.prepare("SELECT dal, al FROM prezzi WHERE dal <= ? AND al >= ? LIMIT 1").bind(al, dal).first();
    if (c) return json({ ok: false, errore: "periodo_sovrapposto", con: c }, 409);
    const mn = minValido(body.min_notti);
    if (mn === undefined) return json({ ok: false, errore: "min_notti" }, 400);
    const sv = supValido(body.sup_brevi);
    if (sv === undefined) return json({ ok: false, errore: "sup_brevi" }, 400);
    await env.DB.prepare("INSERT INTO prezzi (id,dal,al,prezzo,nota,tipo,per_ospiti,min_notti,sup_brevi) VALUES (?,?,?,?,?,?,?,?,?)").bind("p_" + uid(), dal, al, prezzo, clean(body.nota, 80), tipo, perOsp, mn, sv).run();
    return json({ ok: true });
  }
  if (a === "admin_prezzo_sup") {
    const sv = supValido(body.sup_brevi);
    if (sv === undefined) return json({ ok: false, errore: "sup_brevi" }, 400);
    await env.DB.prepare("UPDATE prezzi SET sup_brevi=? WHERE id=?").bind(sv, clean(body.id, 30)).run();
    return json({ ok: true });
  }
  if (a === "admin_prezzo_min") {
    const mn = minValido(body.min_notti);
    if (mn === undefined) return json({ ok: false, errore: "min_notti" }, 400);
    await env.DB.prepare("UPDATE prezzi SET min_notti=? WHERE id=?").bind(mn, clean(body.id, 30)).run();
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
  if (a.startsWith("admin_pagament") || a.startsWith("admin_ricevut")) { await tabellaPagamenti(env); await tabellaRicevute(env); }
  if (a === "admin_pagamenti") {
    const r = await env.DB.prepare("SELECT id,creato,richiesta_id,descrizione,importo,stato,pagato_il,metodo,rimborsato FROM pagamenti ORDER BY creato DESC LIMIT 500").all();
    const rc = await env.DB.prepare("SELECT id,anno,numero,pagamento_id,intestatario,cf,indirizzo,descrizione,arrivo,partenza,ospiti,lingua FROM ricevute WHERE annullata=0").all();
    return json({ ok: true, pagamenti: r.results, ricevute: rc.results, sumup: { merchant: await getSet(env, "sumup_merchant") } });
  }
  if (a === "admin_ricevuta_crea") {
    // crea la ricevuta di un pagamento incassato (o la aggiorna mantenendo lo stesso numero)
    const p = await env.DB.prepare("SELECT * FROM pagamenti WHERE id=?").bind(clean(body.pagamento_id, 20)).first();
    if (!p) return json({ ok: false, errore: "non_trovato" }, 404);
    if (p.stato !== "pagato") return json({ ok: false, errore: "non_pagato" }, 400);
    const loc = await locatore(env);
    if (!loc.nome || !loc.cf) return json({ ok: false, errore: "locatore" }, 400);
    const intestatario = clean(body.intestatario, 120);
    if (intestatario.length < 2) return json({ ok: false, errore: "intestatario" }, 400);
    const arrivo = DATE.test(body.arrivo || "") ? body.arrivo : null, partenza = DATE.test(body.partenza || "") ? body.partenza : null;
    if (arrivo && partenza && partenza <= arrivo) return json({ ok: false, errore: "date" }, 400);
    const ospiti = parseInt(body.ospiti, 10);
    const lingue = ["it", "en", "de", "nl", "es", "fr"];
    const campi = [intestatario, clean(body.cf, 40) || null, clean(body.indirizzo, 160) || null, clean(body.descrizione, 120) || p.descrizione, arrivo, partenza, ospiti >= 1 && ospiti <= MAX_OSPITI ? ospiti : null, lingue.includes(body.lingua) ? body.lingua : "it", JSON.stringify(loc)];
    const esiste = await env.DB.prepare("SELECT id FROM ricevute WHERE pagamento_id=? AND annullata=0").bind(p.id).first();
    if (esiste) {
      await env.DB.prepare("UPDATE ricevute SET intestatario=?, cf=?, indirizzo=?, descrizione=?, arrivo=?, partenza=?, ospiti=?, lingua=?, locatore=? WHERE id=?").bind(...campi, esiste.id).run();
      return json({ ok: true, id: esiste.id });
    }
    const pagato = p.pagato_il || new Date().toISOString();
    const anno = Number(pagato.slice(0, 4));
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    for (let t = 0; t < 3; t++) {
      const m = await env.DB.prepare("SELECT COALESCE(MAX(numero),0) n FROM ricevute WHERE anno=?").bind(anno).first();
      try {
        await env.DB.prepare("INSERT INTO ricevute (id,anno,numero,creata,pagamento_id,intestatario,cf,indirizzo,descrizione,arrivo,partenza,ospiti,lingua,locatore,importo,metodo,pagato_il) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(id, anno, m.n + 1, new Date().toISOString(), p.id, ...campi, Math.round((p.importo - (p.rimborsato || 0)) * 100) / 100, p.metodo || "carta", pagato).run();
        return json({ ok: true, id, numero: `${m.n + 1}/${anno}` });
      } catch (e) { /* numero preso nel frattempo: riprova */ }
    }
    return json({ ok: false, errore: "server" }, 500);
  }
  if (a === "admin_pagamento_rimborsa") {
    // rimborso (totale o parziale) di un pagamento con carta, tramite SumUp
    const p = await env.DB.prepare("SELECT * FROM pagamenti WHERE id=?").bind(clean(body.id, 20)).first();
    if (!p) return json({ ok: false, errore: "non_trovato" }, 404);
    if (p.stato !== "pagato" || p.metodo !== "carta" || !p.checkout_id) return json({ ok: false, errore: "non_rimborsabile" }, 400);
    const resto = Math.round((p.importo - (p.rimborsato || 0)) * 100) / 100;
    const imp = body.importo === undefined || body.importo === "" ? resto : Math.round(Number(body.importo) * 100) / 100;
    if (!(imp > 0 && imp <= resto)) return json({ ok: false, errore: "importo_rimborso", massimo: resto }, 400);
    const key = await getSet(env, "sumup_key");
    if (!key) return json({ ok: false, errore: "non_configurato" }, 400);
    let tx = p.transazione;
    if (!tx) {
      const r = await fetch(`${sumupApi(env)}/v0.1/checkouts/${encodeURIComponent(p.checkout_id)}`, { headers: { Authorization: "Bearer " + key } });
      if (r.ok) tx = transazioneDi(await r.json());
      if (!tx) return json({ ok: false, errore: "transazione" }, 400);
      await env.DB.prepare("UPDATE pagamenti SET transazione=? WHERE id=?").bind(tx, p.id).run();
    }
    const r = await fetch(`${sumupApi(env)}/v0.1/me/refund/${encodeURIComponent(tx)}`, {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ amount: imp }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      return json({ ok: false, errore: "sumup_rimborso", dettaglio: e.message || e.error_code || r.status }, 502);
    }
    const tot = Math.round(((p.rimborsato || 0) + imp) * 100) / 100;
    await env.DB.prepare("UPDATE pagamenti SET rimborsato=?, stato=? WHERE id=?").bind(tot, tot >= p.importo ? "rimborsato" : "pagato", p.id).run();
    // la ricevuta emessa per questo pagamento non è più valida: si annulla (per un rimborso parziale se ne fa una nuova sull'importo trattenuto)
    const ric = await env.DB.prepare("SELECT id, numero, anno FROM ricevute WHERE pagamento_id=? AND annullata=0").bind(p.id).first();
    if (ric) await env.DB.prepare("UPDATE ricevute SET annullata=1 WHERE id=?").bind(ric.id).run();
    ctx.waitUntil(telegram(env, `↩️ Rimborso SumUp: ${imp.toFixed(2)} €\n${p.descrizione}${ric ? `\nRicevuta n. ${ric.numero}/${ric.anno} annullata` : ""}`));
    return json({ ok: true, rimborsato: tot, totale: tot >= p.importo, trattenuto: Math.round((p.importo - tot) * 100) / 100, ricevuta_annullata: ric ? `${ric.numero}/${ric.anno}` : null });
  }
  if (a === "admin_email_imposta") {
    if (body.chiave) {
      const k = String(body.chiave).trim();
      if (!/^re_[A-Za-z0-9_]{16,}$/.test(k)) return json({ ok: false, errore: "chiave_resend" }, 400);
      await putSet(env, "resend_key", k);
    }
    if (body.rimuovi) { await putSet(env, "resend_key", null); return json({ ok: true }); }
    const da = clean(body.mittente, 120).toLowerCase(), risp = clean(body.rispondi, 120);
    if (!EMAIL_RE.test(da)) return json({ ok: false, errore: "email_mittente" }, 400);
    if (risp && !EMAIL_RE.test(risp)) return json({ ok: false, errore: "email_rispondi" }, 400);
    await putSet(env, "mail_from", da); await putSet(env, "mail_reply", risp || null);
    await putSet(env, "mail_auto", body.auto ? "1" : null);
    return json({ ok: true });
  }
  if (a === "admin_email_prova") {
    const to = clean(body.to, 120) || (await getSet(env, "mail_reply"));
    if (!to || !EMAIL_RE.test(to)) return json({ ok: false, errore: "email_prova" }, 400);
    const r = await inviaEmail(env, to, "Prova email – Casalaggiù", "Ciao!\n\nQuesta è un'email di prova dal sito di Casalaggiù: se la leggi, l'invio agli ospiti funziona.\n\n" + SITO);
    return json(r, r.ok ? 200 : 400);
  }
  if (a === "admin_email_invia") {
    const rq = await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(clean(body.richiesta_id, 20)).first();
    const to = rq ? rq.contatto : clean(body.to, 120);
    const oggetto = clean(body.oggetto, 160), testo = String(body.testo || "").slice(0, 8000);
    if (!oggetto || testo.length < 5) return json({ ok: false, errore: "campi" }, 400);
    const r = await inviaEmail(env, to, oggetto, testo);
    if (r.ok && rq) await env.DB.prepare("UPDATE richieste SET email_inviata=? WHERE id=?").bind(new Date().toISOString(), rq.id).run();
    return json(r, r.ok ? 200 : 400);
  }
  if (a === "admin_checkin_link") {
    const r = await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(clean(body.id, 20)).first();
    if (!r) return json({ ok: false, errore: "non_trovata" }, 404);
    return json({ ok: true, token: await creaCheckin(env, r) });
  }
  if (a === "admin_checkin_dati") {
    await tabellaCheckin(env);
    const ck = await env.DB.prepare("SELECT * FROM checkin WHERE richiesta_id=?").bind(clean(body.id, 20)).first();
    if (!ck || !ck.dati) return json({ ok: false, errore: "checkin_vuoto" }, 404);
    let stati, comuni, docs;
    try { stati = await mappa(env, "STATI"); comuni = await mappa(env, "COMUNI"); docs = await mappa(env, "DOCUMENTI"); } catch (e) { return json({ ok: false, errore: "tabelle" }, 503); }
    const D = JSON.parse(ck.dati), nS = (c) => (stati.get(c) || {}).n || c, nC = (c) => { const x = comuni.get(c); return x ? `${x.n} (${x.p})` : c; };
    const ospiti = D.ospiti.map((g) => ({ ...g, statoNascitaN: nS(g.statoNascita), comuneNascitaN: g.comuneNascita ? nC(g.comuneNascita) : "", cittadinanzaN: nS(g.cittadinanza), statoResN: nS(g.statoRes), comuneResN: g.comuneRes ? nC(g.comuneRes) : "", docTipoN: g.docTipo ? (docs.get(g.docTipo) || {}).n : "", docLuogoN: g.docStato ? (g.docStato === ITALIA ? nC(g.docComune) : nS(g.docStato)) : "" }));
    return json({ ok: true, tipo: D.tipo, ospiti, compilato: ck.compilato, arrivo: ck.arrivo, partenza: ck.partenza });
  }
  if (a === "admin_alloggiati") {
    await tabellaCheckin(env);
    const ck = await env.DB.prepare("SELECT * FROM checkin WHERE richiesta_id=?").bind(clean(body.id, 20)).first();
    if (!ck || !ck.dati) return json({ ok: false, errore: "checkin_vuoto" }, 404);
    try { return json({ ok: true, testo: await fileAlloggiati(env, ck), arrivo: ck.arrivo }); } catch (e) { return json({ ok: false, errore: "tabelle" }, 503); }
  }
  if (a === "admin_spot") {
    const mese = String(body.mese || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mese)) return json({ ok: false, errore: "date" }, 400);
    try { return json({ ok: true, ...(await spotMese(env, mese)) }); } catch (e) { return json({ ok: false, errore: "tabelle" }, 503); }
  }
  if (a === "admin_sconti") {
    return json({ ok: true, regole: await regoleSconti(env), codici: (await env.DB.prepare("SELECT * FROM codici ORDER BY creato DESC").all()).results || [] });
  }
  if (a === "admin_sconti_regole") {
    const v = (x, max) => { const n = Math.round(Number(x) || 0); return n >= 0 && n <= max ? n : null; };
    const vals = { sc_lungo_pct: v(body.lungo_pct, 90), sc_lungo_notti: v(body.lungo_notti, 90), sc_lm_pct: v(body.lm_pct, 90), sc_lm_giorni: v(body.lm_giorni, 120) };
    if (Object.values(vals).some((x) => x === null)) return json({ ok: false, errore: "sconto" }, 400);
    for (const k in vals) await putSet(env, k, vals[k] ? String(vals[k]) : null);
    return json({ ok: true });
  }
  if (a === "admin_codice_salva") {
    const c = String(body.codice || "").trim().toUpperCase(), pct = Math.round(Number(body.pct) || 0);
    if (!/^[A-Z0-9_-]{3,20}$/.test(c)) return json({ ok: false, errore: "codice_formato" }, 400);
    if (!(pct >= 1 && pct <= 90)) return json({ ok: false, errore: "sconto" }, 400);
    const scade = DATE.test(body.scade || "") ? body.scade : null;
    await env.DB.prepare("INSERT INTO codici (codice,pct,attivo,scade,nota,creato) VALUES (?,?,1,?,?,?) ON CONFLICT(codice) DO UPDATE SET pct=excluded.pct, scade=excluded.scade, nota=excluded.nota, attivo=1").bind(c, pct, scade, clean(body.nota, 80) || null, new Date().toISOString()).run();
    return json({ ok: true });
  }
  if (a === "admin_codice_stato") {
    await env.DB.prepare("UPDATE codici SET attivo=? WHERE codice=?").bind(body.attivo ? 1 : 0, String(body.codice || "").toUpperCase()).run();
    return json({ ok: true });
  }
  if (a === "admin_codice_elimina") {
    await env.DB.prepare("DELETE FROM codici WHERE codice=?").bind(String(body.codice || "").toUpperCase()).run();
    return json({ ok: true });
  }
  if (a === "admin_servizi") {
    return json({ ok: true, servizi: (await env.DB.prepare("SELECT * FROM servizi ORDER BY ordine, rowid").all()).results || [] });
  }
  if (a === "admin_servizio_salva") {
    const nomi = {};
    for (const l of ["it", "en", "de", "nl", "es", "fr"]) { const v = clean(body.nomi && body.nomi[l], 80); if (v) nomi[l] = v; }
    if (!nomi.it) return json({ ok: false, errore: "nome_servizio" }, 400);
    const prezzo = Math.round(Number(body.prezzo) * 100) / 100;
    if (!(prezzo >= 0 && prezzo <= 5000)) return json({ ok: false, errore: "prezzo" }, 400);
    const tipo = TIPI_SERVIZIO.includes(body.tipo) ? body.tipo : "soggiorno";
    const id = /^s_[a-f0-9]{12}$/.test(body.id || "") ? body.id : null;
    if (id) await env.DB.prepare("UPDATE servizi SET nomi=?, prezzo=?, tipo=? WHERE id=?").bind(JSON.stringify(nomi), prezzo, tipo, id).run();
    else {
      const m = await env.DB.prepare("SELECT COALESCE(MAX(ordine),0) o FROM servizi").first();
      await env.DB.prepare("INSERT INTO servizi (id,nomi,prezzo,tipo,attivo,ordine) VALUES (?,?,?,?,1,?)").bind("s_" + uid(), JSON.stringify(nomi), prezzo, tipo, (m ? m.o : 0) + 1).run();
    }
    return json({ ok: true });
  }
  if (a === "admin_servizio_stato") {
    await env.DB.prepare("UPDATE servizi SET attivo=? WHERE id=?").bind(body.attivo ? 1 : 0, clean(body.id, 20)).run();
    return json({ ok: true });
  }
  if (a === "admin_servizio_elimina") {
    await env.DB.prepare("DELETE FROM servizi WHERE id=?").bind(clean(body.id, 20)).run();
    return json({ ok: true });
  }
  if (a === "admin_ricevuta_annulla") {
    await env.DB.prepare("UPDATE ricevute SET annullata=1 WHERE id=?").bind(clean(body.id, 20)).run();
    return json({ ok: true });
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
  if (a === "admin_pagamento_segna") {
    // pagamento ricevuto con bonifico o in contanti: lo segna il proprietario
    const metodo = body.metodo === "contanti" ? "contanti" : "bonifico";
    const u = await env.DB.prepare("UPDATE pagamenti SET stato='pagato', pagato_il=?, metodo=? WHERE id=? AND stato='da_pagare'").bind(new Date().toISOString(), metodo, clean(body.id, 20)).run();
    return json({ ok: !!(u.meta && u.meta.changes) });
  }
  if (a === "admin_impostazioni") {
    if ("iban" in body || "beneficiario" in body) {
      const iban = String(body.iban || "").replace(/\s+/g, "").toUpperCase(), ben = clean(body.beneficiario, 70);
      if (!iban && !ben) { await putSet(env, "iban", null); await putSet(env, "beneficiario", null); }
      else {
        if (!ibanValido(iban)) return json({ ok: false, errore: "iban" }, 400);
        if (ben.length < 3) return json({ ok: false, errore: "beneficiario" }, 400);
        await putSet(env, "iban", iban); await putSet(env, "beneficiario", ben);
      }
    }
    if ("loc_nome" in body) {
      const n = clean(body.loc_nome, 100), cf = clean(body.loc_cf, 20).toUpperCase().replace(/\s+/g, ""), ind = clean(body.loc_indirizzo, 160);
      if (cf && !/^[A-Z0-9]{11,16}$/.test(cf)) return json({ ok: false, errore: "cf" }, 400);
      await putSet(env, "loc_nome", n || null); await putSet(env, "loc_cf", cf || null); await putSet(env, "loc_indirizzo", ind || null);
    }
    if ("whatsapp" in body) {
      const w = String(body.whatsapp || "").replace(/[^\d]/g, "").replace(/^00/, "");
      if (w && !(w.length >= 8 && w.length <= 15)) return json({ ok: false, errore: "whatsapp" }, 400);
      await putSet(env, "whatsapp", w || null);
    }
    if ("prezzi_ospiti" in body) await putSet(env, "prezzi_ospiti", body.prezzi_ospiti ? "1" : null);
    if ("min_notti" in body) {
      const mn = minValido(body.min_notti);
      if (!mn) return json({ ok: false, errore: "min_notti" }, 400);
      await putSet(env, "min_notti", String(mn));
    }
    if ("supplemento_pet" in body) {
      const v = Math.round(Number(body.supplemento_pet) * 100) / 100;
      if (!(v >= 0 && v <= 500)) return json({ ok: false, errore: "prezzo" }, 400);
      await putSet(env, "supplemento_pet", v ? String(v) : null);
    }
    return json({ ok: true });
  }
  if (a === "admin_ical_rigenera") {
    await putSet(env, "ical_k", null);
    return json({ ok: true, ical: await icalToken(env) });
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
          await migra(env);
          const r = await env.DB.prepare("SELECT dal, al, prezzo, nota, tipo, per_ospiti, min_notti, sup_brevi FROM prezzi WHERE al >= ? ORDER BY dal").bind(oggi).all();
          return json({ ok: true, prezzi: r.results, supplemento_pet: Number(await getSet(env, "supplemento_pet")) || 0, prezzi_ospiti: (await getSet(env, "prezzi_ospiti")) === "1", servizi: await serviziAttivi(env), sconti: await regoleSconti(env), whatsapp: await getSet(env, "whatsapp"), min_notti: await minNottiBase(env) });
        }
        if (action === "ical") {
          await migra(env);
          const k = String(url.searchParams.get("k") || "");
          const tok = await getSet(env, "ical_k");
          if (!tok || k !== tok) return new Response("non autorizzato", { status: 403, headers: CORS });
          return await calendario(env);
        }
        if (action === "paga") {
          const t = String(url.searchParams.get("t") || "");
          if (!/^[a-f0-9]{16}$/.test(t)) return json({ ok: false, errore: "non_trovato" }, 404);
          return await paga(env, t, ctx);
        }
        if (action === "checkin") {
          const t = String(url.searchParams.get("t") || "");
          if (!/^[a-f0-9]{16}$/.test(t)) return json({ ok: false, errore: "non_trovato" }, 404);
          await migra(env);
          await tabellaCheckin(env);
          const ck = await env.DB.prepare("SELECT * FROM checkin WHERE token=?").bind(t).first();
          const ric = ck && await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(ck.richiesta_id).first();
          if (!ck || !ric || ric.stato !== "confermata") return json({ ok: false, errore: "non_trovato" }, 404);
          return json({ ok: true, arrivo: ck.arrivo, partenza: ck.partenza, ospiti: ric.ospiti, lingua: ric.lingua, nome: String(ric.nome || "").split(/\s+/)[0], compilato: !!ck.compilato, scaduto: ck.partenza < new Date().toISOString().slice(0, 10) });
        }
        if (action === "tabelle") {
          try {
            const st = (await tabella(env, "STATI")).split("\n").map((l) => l.split("|").slice(0, 2));
            const dc = (await tabella(env, "DOCUMENTI")).split("\n").map((l) => l.split("|"));
            return new Response(JSON.stringify({ ok: true, stati: st, documenti: dc }), { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
          } catch (e) { return json({ ok: false, errore: "tabelle" }, 503); }
        }
        if (action === "comuni") {
          try {
            return new Response(await tabella(env, "COMUNI"), { headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=604800" } });
          } catch (e) { return new Response("", { status: 503, headers: CORS }); }
        }
        if (action === "codice") {
          await migra(env);
          const c = await codiceValido(env, url.searchParams.get("c"));
          return json(c ? { ok: true, codice: c.codice, pct: c.pct } : { ok: false });
        }
        if (action === "ricevuta") {
          const k = String(url.searchParams.get("k") || "");
          if (!/^[a-f0-9]{16}$/.test(k)) return json({ ok: false, errore: "non_trovato" }, 404);
          await tabellaRicevute(env);
          const r = await env.DB.prepare("SELECT anno,numero,creata,intestatario,cf,indirizzo,descrizione,arrivo,partenza,ospiti,importo,metodo,pagato_il,lingua,locatore,annullata FROM ricevute WHERE id=?").bind(k).first();
          if (!r) return json({ ok: false, errore: "non_trovato" }, 404);
          let loc = {};
          try { loc = JSON.parse(r.locatore || "{}"); } catch (e) { loc = {}; }
          return json({ ok: true, ricevuta: { ...r, locatore: loc } });
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
