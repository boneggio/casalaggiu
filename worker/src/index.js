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
// orari di check-in / check-out (modificabili dall'admin); {IN} e {OUT} nei testi
async function orari(env) { return { in: (await getSet(env, "ora_in")) || "16:00", out: (await getSet(env, "ora_out")) || "10:00" }; }
function oraF(L, h) {
  const [H, M] = String(h).split(":").map(Number), mm = String(M || 0).padStart(2, "0");
  if (L === "en") return (H % 12 || 12) + (M ? ":" + mm : "") + (H < 12 ? " am" : " pm");
  if (L === "fr") return H + "h" + (M ? mm : "");
  return String(H).padStart(2, "0") + ":" + mm + (L === "de" ? " Uhr" : "");
}
const OR = (s, L, o) => String(s).replaceAll("{IN}", oraF(L, o.in)).replaceAll("{OUT}", oraF(L, o.out));
let ORA_CAL = { in: "16:00", out: "10:00" };
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
  const p = await env.DB.prepare("SELECT min_notti, tipo FROM prezzi WHERE dal <= ? AND al > ? LIMIT 1").bind(arrivo, arrivo).first();
  if (p && p.min_notti) return p.min_notti;
  if (p && p.tipo === "settimana") return 7; // prezzo a settimana: minimo una settimana, se non indicato diversamente
  return await minNottiBase(env);
}
// supplemento per soggiorni brevi (1, 2 o 3 notti), fisso per soggiorno, dal periodo in cui cade l'arrivo
async function supBreve(env, arrivo, n) {
  if (n > 3) return 0;
  const p = await env.DB.prepare("SELECT sup_brevi FROM prezzi WHERE dal <= ? AND al > ? AND sup_brevi IS NOT NULL LIMIT 1").bind(arrivo, arrivo).first();
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
  const r = await env.DB.prepare("SELECT dal, al, prezzo, tipo, per_ospiti FROM prezzi WHERE dal < ? AND al > ?").bind(partenza, arrivo).all();
  const periodi = r.results || [];
  const perOspiti = (await getSet(env, "prezzi_ospiti")) === "1";
  let totale = 0, mancanti = 0;
  for (let d = new Date(arrivo + "T00:00:00Z"); d.toISOString().slice(0, 10) < partenza; d.setUTCDate(d.getUTCDate() + 1)) {
    const g = d.toISOString().slice(0, 10);
    const p = periodi.find((x) => x.dal <= g && g < x.al); // periodo: dal = primo giorno, al = giorno di partenza (escluso)
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
// ---------- guida digitale per gli ospiti ----------
// Contenuti in impostazioni "guida" (JSON): { pubblicata, sezioni:[{id, ico, t:{it,en,..}, x:{it,en,..}, tr:{en:hash,..}}] }
// tr[lingua] = impronta del testo italiano usato per quella traduzione: se l'italiano cambia, si ritraduce.
// Accesso ospite: link personale (token del check-in, attivo da 7 giorni prima dell'arrivo a 2 giorni dopo la partenza)
// oppure QR in casa + PIN (chiave "guida_k", rigenerata quando cambia il PIN). Anteprima admin: chiave "guida_ak".
const LINGUE_GUIDA = { en: "English", de: "German", nl: "Dutch", es: "Spanish", fr: "French" };
const GUIDA_BASE = [
  { id: "arrivo", ico: "🔑", t: "Arrivo e partenza", x: "**Check-in** dalle 16:00, in autonomia (self check-in).\n**Check-out** entro le 10:00.\n\nCome entrare: [scrivi qui dove trovi le chiavi o il codice della cassetta]\n\nIndirizzo: Via Roma 13, 73020 Cutrofiano (LE)\nParcheggio gratuito nelle vie e nella piazza vicino alla casa.\n\nPrima di partire: [es. lascia le chiavi sul tavolo, spegni l'aria condizionata, chiudi le finestre]" },
  { id: "casa", ico: "🏠", t: "La casa", x: "- Aria condizionata: [come si accende, dov'è il telecomando]\n- Acqua calda: [...]\n- Cucina: [cosa trovi: caffettiera, olio, sale...]\n- Lenzuola e asciugamani sono inclusi.\n\nRegole della casa: in casa non si fuma (in terrazza sì), niente feste. Gli animali di piccola taglia sono benvenuti." },
  { id: "rifiuti", ico: "♻️", t: "Raccolta differenziata", x: "[giorni e orari di ritiro: organico, plastica, carta, vetro, indifferenziato]\n\nDove lasciare i sacchetti: [...]" },
  { id: "servizi", ico: "🏥", t: "Servizi e numeri utili", x: "- Emergenze: 112\n- Guardia medica: [numero]\n- Farmacia più vicina: [nome e indirizzo]\n- Supermercato: [nome, indirizzo, orari]\n- Bancomat: [...]" },
  { id: "dintorni", ico: "🍝", t: "I nostri consigli", x: "[i tuoi ristoranti, pizzerie, bar e mercati preferiti]\n\nSul sito trovi ogni giorno quale mare scegliere in base al vento, spiagge, borghi ed eventi." },
];
async function guidaDati(env) {
  let g = null;
  try { g = JSON.parse((await getSet(env, "guida")) || "null"); } catch (e) { g = null; }
  if (!g || !Array.isArray(g.sezioni)) g = { pubblicata: false, sezioni: GUIDA_BASE.map((s) => ({ id: s.id, ico: s.ico, t: { it: s.t }, x: { it: s.x }, tr: {} })) };
  return g;
}
async function guidaChiave(env, nome) {
  let k = await getSet(env, nome);
  if (!k) { k = crypto.randomUUID().replace(/-/g, ""); await putSet(env, nome, k); }
  return k;
}
const impronta = async (s) => (await sha256((s.t.it || "") + "\n" + (s.x.it || ""))).slice(0, 12);
function pulisciSezioni(L) {
  const out = [], visti = new Set();
  for (const s of (Array.isArray(L) ? L : []).slice(0, 15)) {
    let id = String(s && s.id || "").replace(/[^a-z0-9_]/g, "").slice(0, 20) || uid();
    while (visti.has(id)) id += "x";
    visti.add(id);
    const t = {}, x = {}, tr = {};
    for (const l of ["it", ...Object.keys(LINGUE_GUIDA)]) {
      const tt = String((s.t || {})[l] || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
      const xx = String((s.x || {})[l] || "").replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").slice(0, 4000);
      if (tt) t[l] = tt;
      if (xx.trim()) x[l] = xx;
      if (l !== "it" && s.tr && typeof s.tr[l] === "string") tr[l] = s.tr[l].slice(0, 12);
    }
    if (!t.it && !x.it) continue;
    out.push({ id, ico: Array.from(String(s.ico || "").trim()).slice(0, 4).join("") || "📌", t, x, tr });
  }
  return out;
}
// traduzione automatica con Workers AI (in prova locale: AI_TEST_URL)
async function traduciBlocco(env, lingua, items) {
  const nome = LINGUE_GUIDA[lingua];
  const sys = `You translate a holiday home guest guide from Italian to ${nome}. Keep exactly the same line breaks, "- " bullets, **bold** markers, URLs, phone numbers, times, emojis and proper names (Casalaggiù, Cutrofiano, street and place names). Address the guest informally${lingua === "fr" ? ", but use \"vous\"" : ""}. Text in square brackets is translated too. Reply with JSON only, in the form {"items":[{"id":"...","t":"translated title","x":"translated text"}]}, with the same ids.`;
  const user = JSON.stringify({ items: items.map((s) => ({ id: s.id, t: s.t.it || "", x: s.x.it || "" })) });
  let raw;
  if (env.AI_TEST_URL) {
    raw = await (await fetch(env.AI_TEST_URL, { method: "POST", body: JSON.stringify({ lingua, sys, user }) })).text();
  } else {
    if (!env.AI) throw new Error("ai_assente");
    const r = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: [{ role: "system", content: sys }, { role: "user", content: user }], max_tokens: 6000, temperature: 0.2 });
    raw = r && r.response;
  }
  let o = raw;
  if (typeof raw === "string") { const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); o = JSON.parse(raw.slice(a, b + 1)); }
  const m = new Map();
  for (const it of (o && o.items) || []) if (it && it.id) m.set(String(it.id), it);
  return m;
}
// box «Perché prenotare qui» del sito: testo italiano dall'admin, tradotto in automatico (impostazione "perche")
async function percheDati(env) { try { return JSON.parse((await getSet(env, "perche")) || "null"); } catch (e) { return null; } }
async function traduciGuida(env, sezioni, tutto) {
  const errori = [];
  for (const s of sezioni) s._h = await impronta(s);
  await Promise.all(Object.keys(LINGUE_GUIDA).map(async (l) => {
    const da = sezioni.filter((s) => tutto || s.tr[l] !== s._h || !(s.t[l] || s.x[l]));
    if (!da.length) return;
    try {
      const m = await traduciBlocco(env, l, da);
      for (const s of da) {
        const r = m.get(s.id);
        if (!r) { errori.push(l); continue; }
        if (s.t.it) s.t[l] = String(r.t || "").slice(0, 80); else delete s.t[l];
        if (s.x.it) s.x[l] = String(r.x || "").slice(0, 4000); else delete s.x[l];
        s.tr[l] = s._h;
      }
    } catch (e) { errori.push(l); }
  }));
  for (const s of sezioni) delete s._h;
  return [...new Set(errori)];
}
async function guidaPerOspite(env, extra) {
  const g = await guidaDati(env);
  return {
    ok: true, ...extra,
    sezioni: g.sezioni.map((s) => ({ id: s.id, ico: s.ico, t: s.t, x: s.x })),
    wifi: { rete: await getSet(env, "guida_wifi_rete"), pass: await getSet(env, "guida_wifi_pass") },
    whatsapp: await getSet(env, "whatsapp"),
    telegram: await getSet(env, "gb_user"),
  };
}
// da quando si apre il link personale della guida: 0 = subito dopo la conferma, altrimenti N giorni prima dell'arrivo
async function guidaDal(env, arrivo) {
  const v = parseInt(await getSet(env, "guida_dal"), 10), n = v >= 0 && v <= 60 ? v : 7;
  return n === 0 ? "2000-01-01" : piuGiorni(arrivo, -n);
}
const piuGiorni = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// ---------- etichette in casa (QR / NFC): pagina /i/?t=<id> per ogni oggetto ----------
// impostazione "etichette" = [{ id, ico, t:{it,..}, x:{it,..}, tr:{}, links:[{u, n:{it,..}, tr:{}}], rifiuti:0|1, agg }]
// impostazione "rifiuti" = { sere: {"0".."6": [tipi da esporre quella sera]}, eccezioni: [{ d, tipi:[], nota }] }
const TIPI_RIFIUTI = ["organico", "plastica", "carta", "vetro", "secco", "altro"];
async function etichetteDati(env) { try { const L = JSON.parse((await getSet(env, "etichette")) || "[]"); return Array.isArray(L) ? L : []; } catch (e) { return []; } }
async function rifiutiDati(env) { try { return JSON.parse((await getSet(env, "rifiuti")) || "null") || { sere: {}, eccezioni: [] }; } catch (e) { return { sere: {}, eccezioni: [] }; } }
const slugEt = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
function pulisciEtichetta(e, vecchia) {
  const testo = (v, n) => String(v || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
  const lungo = (v) => String(v || "").replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").slice(0, 4000);
  const t = {}, x = {};
  for (const l of ["it", ...Object.keys(LINGUE_GUIDA)]) {
    const tt = testo((e.t || {})[l], 60), xx = lungo((e.x || {})[l]);
    if (tt) t[l] = tt;
    if (xx.trim()) x[l] = xx;
  }
  // lingue non inviate (es. dall'app, che manda solo l'italiano): restano quelle già salvate se l'italiano non è cambiato
  const stesso = vecchia && vecchia.t.it === t.it && (vecchia.x.it || "") === (x.it || "");
  if (stesso) for (const l of Object.keys(LINGUE_GUIDA)) {
    if (!(e.t || {})[l] && vecchia.t[l]) t[l] = vecchia.t[l];
    if (!(e.x || {})[l] && vecchia.x[l]) x[l] = vecchia.x[l];
  }
  const links = [];
  for (const k of (Array.isArray(e.links) ? e.links : []).slice(0, 8)) {
    const u = String(k && k.u || "").trim().slice(0, 500);
    if (!/^https:\/\/[^\s"<>]+$/.test(u)) continue;
    const n = {};
    for (const l of ["it", ...Object.keys(LINGUE_GUIDA)]) { const v = testo((k.n || {})[l], 60); if (v) n[l] = v; }
    const vk = vecchia && (vecchia.links || []).find((z) => z.u === u);
    const ok = vk && vk.n && vk.n.it === n.it;
    if (ok) for (const l of Object.keys(LINGUE_GUIDA)) if (!n[l] && vk.n[l]) n[l] = vk.n[l];
    links.push({ u, n, tr: (ok && vk.tr) || {} });
  }
  return { ico: Array.from(String(e.ico || "").trim()).slice(0, 4).join("") || "📌", t, x, tr: (stesso && vecchia.tr) || {}, links, rifiuti: e.rifiuti ? 1 : 0 };
}
// traduce nome, consigli e nomi dei link (solo quello che è cambiato, se l'italiano manca nelle altre lingue o se forzato)
async function traduciEtichetta(env, e, forza) {
  const items = [{ id: "m", t: e.t, x: e.x, tr: e.tr }, ...e.links.map((k, i) => ({ id: "l" + i, t: k.n, x: {}, tr: k.tr }))];
  for (const it of items) for (const l of Object.keys(LINGUE_GUIDA)) if (forza) it.tr[l] = "";
  const errori = await traduciGuida(env, items, false);
  e.t = items[0].t; e.x = items[0].x; e.tr = items[0].tr;
  e.links.forEach((k, i) => { k.n = items[i + 1].t; k.tr = items[i + 1].tr; });
  return errori;
}
const etichettaPubblica = (e) => ({ id: e.id, ico: e.ico, t: e.t, x: e.x, links: e.links.map((k) => ({ u: k.u, n: k.n })), rifiuti: e.rifiuti ? 1 : 0 });
function pulisciRifiuti(r) {
  const sere = {};
  for (let g = 0; g < 7; g++) sere[g] = [...new Set(((r && r.sere && r.sere[g]) || []).filter((x) => TIPI_RIFIUTI.includes(x)))];
  const eccezioni = (Array.isArray(r && r.eccezioni) ? r.eccezioni : []).filter((z) => z && DATE.test(z.d || "")).slice(0, 60)
    .map((z) => ({ d: z.d, tipi: [...new Set((z.tipi || []).filter((x) => TIPI_RIFIUTI.includes(x)))], nota: String(z.nota || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) }))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  return { sere, eccezioni };
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
// sconti automatici: ognuno si accende/spegne (sc_lungo_on / sc_lm_on = "0" spento); spento = percentuale 0 per sito e calcoli
async function regoleSconti(env, grezze) {
  const n = async (k) => Number(await getSet(env, k)) || 0;
  const lon = (await getSet(env, "sc_lungo_on")) !== "0", mon = (await getSet(env, "sc_lm_on")) !== "0";
  const lp = await n("sc_lungo_pct"), mp = await n("sc_lm_pct");
  return { lungo: { pct: grezze || lon ? lp : 0, notti: await n("sc_lungo_notti"), on: lon }, lm: { pct: grezze || mon ? mp : 0, giorni: await n("sc_lm_giorni"), on: mon } };
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
  return `<!doctype html><html><body style="margin:0;background:#f6f5f1;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#14233a"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dfe1dc;border-radius:14px;padding:26px 24px"><img src="https://casalaggiu.it/img/logo-mail.png" width="221" height="60" alt="Casalaggiù · Cutrofiano · Salento" style="display:block;border:0;outline:none;width:221px;max-width:100%;height:auto;margin:0 0 20px -4px;font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#14233a"><div style="font-size:15px;line-height:1.6">${corpo}</div></div><div style="max-width:560px;margin:10px auto 0;font-size:11px;color:#5b6676;text-align:center">Casa laggiù · Via Roma 13, 73020 Cutrofiano (LE) · CIN IT075026C200122953</div></body></html>`;
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

// email automatica qualche giorno prima dell'arrivo con il link alla guida (cron giornaliero)
const GUIDA_MAIL = {
  it: { tg: "Il nostro assistente su Telegram risponde subito (Wi-Fi, check-in, mare di oggi, eventi):", sub: "Il tuo arrivo a Casalaggiù · guida della casa", hi: "Ciao", t1: (d) => `manca poco: ti aspettiamo ${d}!`, g: "Qui trovi la guida della casa, con le istruzioni per entrare, il Wi-Fi, la raccolta differenziata e i nostri consigli sui dintorni:", ck: "Ricordati di compilare il check-in online (2 minuti, lo chiede la legge):", inout: "Check-in dalle {IN} · check-out entro le {OUT}.", wa: "Per domande veloci scrivici su WhatsApp:", rep: "Oppure rispondi pure a questa email: ti rispondiamo il prima possibile.", bye: "Buon viaggio e a presto!" },
  en: { tg: "Our Telegram assistant answers right away (Wi-Fi, check-in, today’s sea, events):", sub: "Your arrival at Casalaggiù · house guide", hi: "Hi", t1: (d) => `not long now: we're expecting you on ${d}!`, g: "Here is the house guide, with instructions to get in, the Wi-Fi, waste sorting and our tips on the area:", ck: "Please remember to fill in the online check-in (2 minutes, required by law):", inout: "Check-in from {IN} · check-out by {OUT}.", wa: "For quick questions, message us on WhatsApp:", rep: "Or just reply to this email: we'll get back to you as soon as possible.", bye: "Have a good trip, see you soon!" },
  de: { tg: "Unser Telegram-Assistent antwortet sofort (WLAN, Check-in, Meer heute, Events):", sub: "Deine Ankunft in der Casalaggiù · Hausführer", hi: "Hallo", t1: (d) => `bald ist es so weit: wir erwarten dich am ${d}!`, g: "Hier ist der Hausführer mit der Anleitung für den Zugang, dem WLAN, der Mülltrennung und unseren Tipps für die Umgebung:", ck: "Denk bitte an den Online-Check-in (2 Minuten, gesetzlich vorgeschrieben):", inout: "Check-in ab {IN} · Check-out bis {OUT}.", wa: "Für schnelle Fragen schreib uns auf WhatsApp:", rep: "Oder antworte einfach auf diese E-Mail: wir melden uns so schnell wie möglich.", bye: "Gute Reise und bis bald!" },
  nl: { tg: "Onze Telegram-assistent antwoordt meteen (wifi, inchecken, de zee van vandaag, evenementen):", sub: "Je aankomst in Casalaggiù · huisgids", hi: "Hoi", t1: (d) => `het is bijna zover: we verwachten je op ${d}!`, g: "Hier is de huisgids, met de instructies om binnen te komen, de wifi, het afval scheiden en onze tips voor de omgeving:", ck: "Vergeet niet online in te checken (2 minuten, wettelijk verplicht):", inout: "Inchecken vanaf {IN} · uitchecken vóór {OUT}.", wa: "Voor snelle vragen kun je ons een WhatsApp sturen:", rep: "Of beantwoord gewoon deze e-mail: we reageren zo snel mogelijk.", bye: "Goede reis en tot snel!" },
  es: { tg: "Nuestro asistente de Telegram responde al momento (Wi-Fi, check-in, el mar de hoy, eventos):", sub: "Tu llegada a Casalaggiù · guía de la casa", hi: "Hola", t1: (d) => `¡ya queda poco: te esperamos el ${d}!`, g: "Aquí tienes la guía de la casa, con las instrucciones para entrar, el Wi-Fi, el reciclaje y nuestros consejos sobre la zona:", ck: "Recuerda rellenar el check-in online (2 minutos, lo exige la ley):", inout: "Entrada desde las {IN} · salida antes de las {OUT}.", wa: "Para preguntas rápidas, escríbenos por WhatsApp:", rep: "O responde a este correo: te contestaremos lo antes posible.", bye: "¡Buen viaje y hasta pronto!" },
  fr: { tg: "Notre assistant Telegram répond tout de suite (Wi-Fi, check-in, la mer du jour, événements) :", sub: "Votre arrivée à Casalaggiù · guide de la maison", hi: "Bonjour", t1: (d) => `c'est bientôt : nous vous attendons le ${d} !`, g: "Voici le guide de la maison, avec les instructions pour entrer, le Wi-Fi, le tri des déchets et nos conseils sur les environs :", ck: "Pensez à remplir le check-in en ligne (2 minutes, exigé par la loi) :", inout: "Arrivée à partir de {IN} · départ avant {OUT}.", wa: "Pour une question rapide, écrivez-nous sur WhatsApp :", rep: "Ou répondez simplement à cet e-mail : nous vous répondrons au plus vite.", bye: "Bon voyage et à bientôt !" },
};
async function emailGuida(env, r) {
  if (!EMAIL_RE.test(r.contatto || "")) return { ok: false, errore: "email_destinatario" };
  const tok = await creaCheckin(env, r);
  const ck = await env.DB.prepare("SELECT compilato FROM checkin WHERE token=?").bind(tok).first();
  const L = GUIDA_MAIL[r.lingua] ? r.lingua : "it", t = GUIDA_MAIL[L], loc = L === "en" ? "en-GB" : L;
  const d = new Date(r.arrivo + "T12:00:00Z").toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const wa = String((await getSet(env, "whatsapp")) || "").replace(/\D/g, "");
  const righe = [`${t.hi} ${String(r.nome || "").trim().split(/\s+/)[0]},`, "", t.t1(d), "", t.g, `${SITO}/guida.html?t=${tok}`];
  if (!(ck && ck.compilato)) righe.push("", t.ck, `${SITO}/checkin.html?t=${tok}`);
  righe.push("", OR(t.inout, L, await orari(env)), "Via Roma 13, 73020 Cutrofiano (LE) · https://maps.google.com/?q=Via+Roma+13,+73020+Cutrofiano+LE", "");
  const tgu = await getSet(env, "gb_user");
  if (tgu) righe.push(t.tg, `https://t.me/${tgu}?start=${tok}`);
  if (wa.length >= 8) righe.push(t.wa, `https://wa.me/${wa}`);
  righe.push(t.rep, "", t.bye, "Casalaggiù · " + SITO);
  const x = await inviaEmail(env, r.contatto, t.sub, righe.join("\n"));
  if (x.ok) await env.DB.prepare("UPDATE richieste SET guida_inviata=? WHERE id=?").bind(new Date().toISOString(), r.id).run();
  return x;
}
async function invioGuideAutomatico(env) {
  await migra(env);
  if ((await getSet(env, "guida_auto")) === "0") return;
  if (!(await guidaDati(env)).pubblicata || !(await getSet(env, "resend_key"))) return;
  const giorni = Math.min(7, Math.max(1, parseInt(await getSet(env, "guida_giorni"), 10) || 3));
  const oggi = new Date().toISOString().slice(0, 10), fino = piuGiorni(oggi, giorni);
  const L = await env.DB.prepare("SELECT * FROM richieste WHERE stato='confermata' AND guida_inviata IS NULL AND arrivo >= ? AND arrivo <= ?").bind(oggi, fino).all();
  for (const r of L.results || []) {
    const x = await emailGuida(env, r);
    await telegram(env, x.ok ? `📖 Guida della casa inviata a ${r.nome} (${r.contatto}), arrivo ${r.arrivo}.` : `⚠️ Non sono riuscito a inviare la guida a ${r.nome} (${r.contatto}): ${x.dettaglio || x.errore}. Mandala dal pannello admin.`);
  }
}

// ---------- recensioni: email il giorno dopo la partenza, pagina recensione.html?t=<token check-in>, approvazione in admin ----------
const REC_MAIL = {
  it: { sub: "Com'è andata a Casalaggiù?", hi: "Ciao", t1: "grazie per aver scelto Casalaggiù: speriamo che il Salento ti abbia lasciato un bel ricordo.", t2: "Ci aiuteresti con una breve recensione? Bastano un paio di minuti:", t3: "La tua opinione aiuta i prossimi ospiti a scegliere e noi a migliorare.", bye: "A presto,\nMomo" },
  en: { sub: "How was your stay at Casalaggiù?", hi: "Hi", t1: "thank you for choosing Casalaggiù – we hope Salento left you with great memories.", t2: "Would you help us with a short review? It only takes a couple of minutes:", t3: "Your feedback helps future guests choose and helps us improve.", bye: "See you soon,\nMomo" },
  de: { sub: "Wie war dein Aufenthalt in der Casalaggiù?", hi: "Hallo", t1: "danke, dass du dich für die Casalaggiù entschieden hast – wir hoffen, das Salento bleibt dir in schöner Erinnerung.", t2: "Hilfst du uns mit einer kurzen Bewertung? Es dauert nur ein paar Minuten:", t3: "Deine Meinung hilft künftigen Gästen bei der Wahl und uns, besser zu werden.", bye: "Bis bald,\nMomo" },
  nl: { sub: "Hoe was je verblijf in Casalaggiù?", hi: "Hoi", t1: "bedankt dat je voor Casalaggiù hebt gekozen – we hopen dat de Salento je mooie herinneringen heeft gegeven.", t2: "Wil je ons helpen met een korte review? Het duurt maar een paar minuten:", t3: "Jouw mening helpt toekomstige gasten bij hun keuze en ons om beter te worden.", bye: "Tot snel,\nMomo" },
  es: { sub: "¿Qué tal tu estancia en Casalaggiù?", hi: "Hola", t1: "gracias por elegir Casalaggiù: esperamos que el Salento te haya dejado un gran recuerdo.", t2: "¿Nos ayudas con una breve reseña? Solo son un par de minutos:", t3: "Tu opinión ayuda a los próximos huéspedes a elegir y a nosotros a mejorar.", bye: "Hasta pronto,\nMomo" },
  fr: { sub: "Comment s'est passé votre séjour à Casalaggiù ?", hi: "Bonjour", t1: "merci d'avoir choisi Casalaggiù : nous espérons que le Salento vous a laissé un beau souvenir.", t2: "Pourriez-vous nous laisser un court avis ? Cela ne prend que deux minutes :", t3: "Votre avis aide les prochains voyageurs à choisir et nous aide à nous améliorer.", bye: "À bientôt,\nMomo" },
};
async function tabellaRecensioni(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS recensioni (id TEXT PRIMARY KEY, richiesta_id TEXT UNIQUE NOT NULL, creata TEXT NOT NULL, nome TEXT NOT NULL, stelle INTEGER NOT NULL, testo TEXT NOT NULL, lingua TEXT, mese TEXT, stato TEXT NOT NULL DEFAULT 'attesa')").run();
  try { await env.DB.prepare("ALTER TABLE richieste ADD COLUMN rec_inviata TEXT").run(); } catch (e) { /* già presente */ }
}
const testoRec = (s, n) => String(s ?? "").replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);
async function emailRecensione(env, r) {
  if (!EMAIL_RE.test(r.contatto || "")) return { ok: false, errore: "email_destinatario" };
  await tabellaRecensioni(env);
  const tok = await creaCheckin(env, r);
  const L = REC_MAIL[r.lingua] ? r.lingua : "it", t = REC_MAIL[L];
  const righe = [`${t.hi} ${String(r.nome || "").trim().split(/\s+/)[0]},`, "", t.t1, "", t.t2, `${SITO}/recensione.html?t=${tok}`, "", t.t3, "", t.bye];
  const x = await inviaEmail(env, r.contatto, t.sub, righe.join("\n"));
  if (x.ok) await env.DB.prepare("UPDATE richieste SET rec_inviata=? WHERE id=?").bind(new Date().toISOString(), r.id).run();
  return x;
}
async function invioRecensioniAuto(env) {
  await migra(env);
  await tabellaRecensioni(env);
  if ((await getSet(env, "rec_auto")) === "0" || !(await getSet(env, "resend_key"))) return;
  const oggi = new Date().toISOString().slice(0, 10), ieri = piuGiorni(oggi, -1), da = piuGiorni(oggi, -4);
  const L = await env.DB.prepare("SELECT * FROM richieste WHERE stato='confermata' AND rec_inviata IS NULL AND partenza >= ? AND partenza <= ? AND id NOT IN (SELECT richiesta_id FROM recensioni)").bind(da, ieri).all();
  for (const r of L.results || []) {
    if (!EMAIL_RE.test(r.contatto || "")) continue;
    const x = await emailRecensione(env, r);
    await telegram(env, x.ok ? `⭐ Richiesta di recensione inviata a ${r.nome} (${r.contatto}), partito il ${r.partenza}.` : `⚠️ Non sono riuscito a chiedere la recensione a ${r.nome} (${r.contatto}): ${x.dettaglio || x.errore}.`);
  }
}
async function recensionePerToken(env, t) {
  if (!/^[a-f0-9]{16}$/.test(String(t || ""))) return null;
  await tabellaCheckin(env);
  await tabellaRecensioni(env);
  const ck = await env.DB.prepare("SELECT * FROM checkin WHERE token=?").bind(t).first();
  const ric = ck && await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(ck.richiesta_id).first();
  if (!ck || !ric || ric.stato !== "confermata") return null;
  const gia = await env.DB.prepare("SELECT stelle, testo, nome FROM recensioni WHERE richiesta_id=?").bind(ric.id).first();
  const oggi = new Date().toISOString().slice(0, 10);
  return { ric, gia, presto: oggi < piuGiorni(ric.partenza, -1), scaduto: oggi > piuGiorni(ric.partenza, 120) };
}

// ---------- assistente Telegram per gli ospiti (bot separato da quello degli avvisi) ----------
// Webhook POST /tg (header segreto). Menu con risposte pronte, domande libere con Workers AI limitato ai fatti noti,
// altrimenti inoltro a Momo (gb_owner): Momo risponde al messaggio inoltrato e l'ospite riceve la risposta.
// Dati da index.html (FAQ, condizioni, come arrivare, eventi, testi del vento) copiati qui sotto.
const BOT_KB = {"KB":{"it":{"arr":[["✈️","Aeroporto di Brindisi","Circa 70 km, meno di un'ora in auto. È l'aeroporto più comodo."],["✈️","Aeroporto di Bari","Circa 205 km, poco più di 2 ore in auto."],["🚆","Treno","Stazione di Lecce (Trenitalia), a circa 30 km: da lì 35 minuti in auto o in taxi."],["🚌","Autobus","Da Lecce c'è la linea Ferrovie del Sud Est per Cutrofiano, circa un'ora (orari su fseonline.it)."],["🚗","Auto","Consigliata: lo Ionio è a 25 minuti, l'Adriatico a 35–40. Parcheggio gratuito nelle vie vicine."]],"pol":["Alla conferma si versa un acconto del 30%.","Cancellazione gratuita fino a 10 giorni prima dell'arrivo: l'acconto viene rimborsato. Dopo, l'acconto resta trattenuto.","Il saldo si paga 7 giorni prima dell'arrivo, con carta o bonifico."],"faq":[["A che ora sono check-in e check-out?","Check-in dalle {IN} con self check-in: qualche giorno prima ti mandiamo le istruzioni. Check-out entro le {OUT}."],["Quante persone e quante notti?","Fino a 4 ospiti: camera con letto alla francese e 2 posti letto nel soppalco. Soggiorno minimo 2 notti."],["Biancheria e asciugamani sono inclusi?","Sì, lenzuola e asciugamani sono inclusi e pronti al tuo arrivo."],["Dove si parcheggia?","Gratuitamente nelle vie e nella piazza vicino alla casa."],["Come si paga?","Con carta tramite un link di pagamento sicuro (SumUp) oppure con bonifico. Ricevi sempre la ricevuta."],["Posso portare il mio animale?","Sì, gli animali di piccola taglia sono benvenuti, con un supplemento per la pulizia."],["Si può fumare? E fare feste?","In casa no, in terrazza sì. Niente feste, ma gli amici in visita sono benvenuti."],["C'è il Wi-Fi? E l'aria condizionata?","Sì, Wi-Fi in fibra e aria condizionata."],["C'è la tassa di soggiorno?","No, a Cutrofiano non è prevista."],["Serve l'auto?","È consigliata per le spiagge e i paesi del Salento. Il centro di Cutrofiano si gira a piedi."]]},"en":{"arr":[["✈️","Brindisi Airport","About 70 km, under an hour by car. The most convenient airport."],["✈️","Bari Airport","About 205 km, just over 2 hours by car."],["🚆","Train","Lecce station (Trenitalia), about 30 km away: 35 minutes from there by car or taxi."],["🚌","Bus","Ferrovie del Sud Est runs a bus from Lecce to Cutrofiano, about one hour (timetables on fseonline.it)."],["🚗","Car","Recommended: the Ionian Sea is 25 minutes away, the Adriatic 35–40. Free parking in nearby streets."]],"pol":["A 30% deposit is paid when the booking is confirmed.","Free cancellation up to 10 days before arrival: the deposit is refunded. After that, the deposit is kept.","The balance is due 7 days before arrival, by card or bank transfer."],"faq":[["What are check-in and check-out times?","Check-in from {IN} with self check-in: we send you the instructions a few days before. Check-out by {OUT}."],["How many guests and nights?","Up to 4 guests: a bedroom with a double bed and 2 beds in the loft. Minimum stay 2 nights."],["Are bed linen and towels included?","Yes, bed linen and towels are included and ready when you arrive."],["Where can I park?","For free in the streets and the square near the house."],["How do I pay?","By card through a secure payment link (SumUp) or by bank transfer. You always get a receipt."],["Can I bring my pet?","Yes, small pets are welcome, with a cleaning surcharge."],["Is smoking allowed? Parties?","Not inside, but you can smoke on the terrace. No parties, but friends visiting are welcome."],["Is there Wi-Fi? Air conditioning?","Yes, fibre Wi-Fi and air conditioning."],["Is there a tourist tax?","No, there is none in Cutrofiano."],["Do I need a car?","It is recommended for the beaches and the towns of Salento. You can walk around Cutrofiano's centre."]]},"de":{"arr":[["✈️","Flughafen Brindisi","Etwa 70 km, unter einer Stunde mit dem Auto. Der günstigste Flughafen."],["✈️","Flughafen Bari","Etwa 205 km, gut 2 Stunden mit dem Auto."],["🚆","Zug","Bahnhof Lecce (Trenitalia), etwa 30 km entfernt: von dort 35 Minuten mit Auto oder Taxi."],["🚌","Bus","Ferrovie del Sud Est fährt von Lecce nach Cutrofiano, etwa eine Stunde (Fahrplan auf fseonline.it)."],["🚗","Auto","Empfohlen: das Ionische Meer ist 25 Minuten entfernt, die Adria 35–40. Kostenlos parken in den Straßen nebenan."]],"pol":["Bei der Bestätigung wird eine Anzahlung von 30 % fällig.","Kostenlose Stornierung bis 10 Tage vor Anreise: Die Anzahlung wird erstattet. Danach wird sie einbehalten.","Der Restbetrag ist 7 Tage vor Anreise fällig, per Karte oder Überweisung."],"faq":[["Wann sind Check-in und Check-out?","Check-in ab {IN} per Self-Check-in: Wir schicken dir die Anleitung ein paar Tage vorher. Check-out bis {OUT}."],["Wie viele Personen und Nächte?","Bis zu 4 Gäste: ein Schlafzimmer mit Doppelbett und 2 Schlafplätze auf der Galerie. Mindestaufenthalt 2 Nächte."],["Sind Bettwäsche und Handtücher inklusive?","Ja, Bettwäsche und Handtücher sind inklusive und liegen bei Ankunft bereit."],["Wo kann man parken?","Kostenlos in den Straßen und auf dem Platz nahe dem Haus."],["Wie bezahle ich?","Per Karte über einen sicheren Zahlungslink (SumUp) oder per Überweisung. Du bekommst immer eine Quittung."],["Darf ich mein Haustier mitbringen?","Ja, kleine Haustiere sind willkommen, gegen einen Reinigungszuschlag."],["Darf man rauchen? Partys?","Im Haus nicht, auf der Terrasse schon. Keine Partys, Besuch von Freunden ist willkommen."],["Gibt es WLAN und Klimaanlage?","Ja, Glasfaser-WLAN und Klimaanlage."],["Gibt es eine Kurtaxe?","Nein, in Cutrofiano nicht."],["Brauche ich ein Auto?","Für die Strände und die Orte im Salento empfohlen. Das Zentrum von Cutrofiano erreichst du zu Fuß."]]},"nl":{"arr":[["✈️","Luchthaven Brindisi","Ongeveer 70 km, minder dan een uur met de auto. De handigste luchthaven."],["✈️","Luchthaven Bari","Ongeveer 205 km, iets meer dan 2 uur met de auto."],["🚆","Trein","Station Lecce (Trenitalia), op ongeveer 30 km: vandaar 35 minuten met auto of taxi."],["🚌","Bus","Ferrovie del Sud Est rijdt van Lecce naar Cutrofiano, ongeveer een uur (dienstregeling op fseonline.it)."],["🚗","Auto","Aanbevolen: de Ionische Zee ligt op 25 minuten, de Adriatische op 35–40. Gratis parkeren in de straten in de buurt."]],"pol":["Bij de bevestiging betaal je een aanbetaling van 30%.","Gratis annuleren tot 10 dagen voor aankomst: de aanbetaling wordt terugbetaald. Daarna blijft ze ingehouden.","Het restbedrag betaal je 7 dagen voor aankomst, met kaart of overschrijving."],"faq":[["Hoe laat zijn inchecken en uitchecken?","Inchecken vanaf {IN} met self check-in: we sturen je de instructies een paar dagen vooraf. Uitchecken vóór {OUT}."],["Hoeveel personen en nachten?","Tot 4 gasten: een slaapkamer met tweepersoonsbed en 2 slaapplaatsen op de vide. Minimaal 2 nachten."],["Zijn beddengoed en handdoeken inbegrepen?","Ja, beddengoed en handdoeken zijn inbegrepen en liggen klaar bij aankomst."],["Waar kan ik parkeren?","Gratis in de straten en op het plein bij het huis."],["Hoe betaal ik?","Met kaart via een veilige betaallink (SumUp) of per overschrijving. Je krijgt altijd een betalingsbewijs."],["Mag mijn huisdier mee?","Ja, kleine huisdieren zijn welkom, met een toeslag voor de schoonmaak."],["Mag je roken? Feesten?","Binnen niet, op het terras wel. Geen feesten, vrienden op bezoek zijn welkom."],["Is er wifi en airco?","Ja, glasvezel-wifi en airconditioning."],["Is er toeristenbelasting?","Nee, in Cutrofiano niet."],["Heb ik een auto nodig?","Aanbevolen voor de stranden en de dorpen van de Salento. Het centrum van Cutrofiano doe je te voet."]]},"es":{"arr":[["✈️","Aeropuerto de Brindisi","Unos 70 km, menos de una hora en coche. Es el aeropuerto más cómodo."],["✈️","Aeropuerto de Bari","Unos 205 km, algo más de 2 horas en coche."],["🚆","Tren","Estación de Lecce (Trenitalia), a unos 30 km: desde allí 35 minutos en coche o taxi."],["🚌","Autobús","Ferrovie del Sud Est tiene un autobús de Lecce a Cutrofiano, aproximadamente una hora (horarios en fseonline.it)."],["🚗","Coche","Recomendado: el mar Jónico está a 25 minutos y el Adriático a 35–40. Aparcamiento gratuito en las calles cercanas."]],"pol":["Al confirmar se paga un anticipo del 30%.","Cancelación gratuita hasta 10 días antes de la llegada: se reembolsa el anticipo. Después, el anticipo no se devuelve.","El resto se paga 7 días antes de la llegada, con tarjeta o transferencia."],"faq":[["¿A qué hora son la entrada y la salida?","Entrada desde las {IN} con self check-in: unos días antes te enviamos las instrucciones. Salida antes de las {OUT}."],["¿Cuántas personas y cuántas noches?","Hasta 4 huéspedes: un dormitorio con cama de matrimonio y 2 camas en el altillo. Estancia mínima de 2 noches."],["¿Están incluidas la ropa de cama y las toallas?","Sí, la ropa de cama y las toallas están incluidas y listas a tu llegada."],["¿Dónde se aparca?","Gratis en las calles y en la plaza cerca de la casa."],["¿Cómo se paga?","Con tarjeta mediante un enlace de pago seguro (SumUp) o por transferencia. Siempre recibes el recibo."],["¿Puedo llevar a mi mascota?","Sí, las mascotas pequeñas son bienvenidas, con un suplemento de limpieza."],["¿Se puede fumar? ¿Y hacer fiestas?","Dentro no, en la terraza sí. No se permiten fiestas, pero los amigos de visita son bienvenidos."],["¿Hay wifi? ¿Y aire acondicionado?","Sí, wifi de fibra y aire acondicionado."],["¿Hay tasa turística?","No, en Cutrofiano no hay."],["¿Necesito coche?","Es recomendable para las playas y los pueblos del Salento. El centro de Cutrofiano se recorre a pie."]]},"fr":{"arr":[["✈️","Aéroport de Brindisi","Environ 70 km, moins d'une heure en voiture. C'est l'aéroport le plus pratique."],["✈️","Aéroport de Bari","Environ 205 km, un peu plus de 2 heures en voiture."],["🚆","Train","Gare de Lecce (Trenitalia), à environ 30 km : de là, 35 minutes en voiture ou en taxi."],["🚌","Bus","Ferrovie del Sud Est assure une ligne de bus Lecce–Cutrofiano, environ une heure (horaires sur fseonline.it)."],["🚗","Voiture","Conseillée : la mer Ionienne est à 25 minutes, l'Adriatique à 35–40. Stationnement gratuit dans les rues voisines."]],"pol":["Un acompte de 30 % est versé à la confirmation.","Annulation gratuite jusqu'à 10 jours avant l'arrivée : l'acompte est remboursé. Ensuite, l'acompte est conservé.","Le solde est à régler 7 jours avant l'arrivée, par carte ou virement."],"faq":[["À quelle heure sont l'arrivée et le départ ?","Arrivée à partir de {IN} en self check-in : nous vous envoyons les instructions quelques jours avant. Départ avant {OUT}."],["Combien de personnes et de nuits ?","Jusqu'à 4 personnes : une chambre avec lit double et 2 couchages en mezzanine. Séjour minimum 2 nuits."],["Le linge de lit et les serviettes sont-ils inclus ?","Oui, le linge de lit et les serviettes sont inclus et prêts à votre arrivée."],["Où se garer ?","Gratuitement dans les rues et sur la place près de la maison."],["Comment payer ?","Par carte via un lien de paiement sécurisé (SumUp) ou par virement. Vous recevez toujours un reçu."],["Puis-je venir avec mon animal ?","Oui, les petits animaux sont les bienvenus, avec un supplément ménage."],["Peut-on fumer ? Faire la fête ?","Pas à l'intérieur, mais sur la terrasse oui. Pas de fêtes, les amis de passage sont les bienvenus."],["Y a-t-il le Wi-Fi ? La climatisation ?","Oui, Wi-Fi fibre et climatisation."],["Y a-t-il une taxe de séjour ?","Non, il n'y en a pas à Cutrofiano."],["Faut-il une voiture ?","Elle est conseillée pour les plages et les villages du Salento. Le centre de Cutrofiano se visite à pied."]]}},"EV":[{"n":"La Notte della Taranta","w":{"it":"agosto","en":"August","de":"August","nl":"augustus","es":"agosto","fr":"août"},"d":{"it":"Festival di pizzica itinerante nelle piazze della Grecìa Salentina, poi il Concertone finale a Melpignano, a 10 km da casa.","en":"A travelling pizzica festival in the squares of Grecìa Salentina, ending with the big final concert in Melpignano, 10 km from the house.","de":"Wanderndes Pizzica-Festival auf den Plätzen der Grecìa Salentina, mit dem großen Abschlusskonzert in Melpignano, 10 km vom Haus.","nl":"Rondtrekkend pizzicafestival op de pleinen van de Grecìa Salentina, met het slotconcert in Melpignano, op 10 km van het huis.","es":"Festival itinerante de pizzica en las plazas de la Grecìa Salentina, con el gran concierto final en Melpignano, a 10 km de casa.","fr":"Festival itinérant de pizzica sur les places de la Grecìa Salentina, puis le grand concert final à Melpignano, à 10 km de la maison."},"km":10,"min":12},{"n":"Santi Pietro e Paolo · Galatina","w":{"it":"28–29 giugno","en":"28–29 June","de":"28.–29. Juni","nl":"28–29 juni","es":"28–29 junio","fr":"28–29 juin"},"d":{"it":"Festa patronale legata alla tradizione del tarantismo, con luminarie, bande e pizzica.","en":"Patron saints' feast linked to the tarantism tradition, with lights, bands and pizzica.","de":"Patronatsfest mit Bezug zur Tarantismus-Tradition, mit Lichtern, Kapellen und Pizzica.","nl":"Patroonsfeest verbonden met de traditie van het tarantisme, met verlichting, fanfares en pizzica.","es":"Fiesta patronal ligada a la tradición del tarantismo, con luminarias, bandas y pizzica.","fr":"Fête patronale liée à la tradition du tarentisme, avec illuminations, fanfares et pizzica."},"km":7,"min":10},{"n":"Santa Cristina · Gallipoli","w":{"it":"fine luglio","en":"late July","de":"Ende Juli","nl":"eind juli","es":"finales de julio","fr":"fin juillet"},"d":{"it":"La patrona di Gallipoli: processione in mare con le barche e fuochi d'artificio.","en":"Gallipoli's patron saint: a boat procession at sea and fireworks.","de":"Die Schutzheilige Gallipolis: Bootsprozession auf dem Meer und Feuerwerk.","nl":"De patrones van Gallipoli: processie met boten op zee en vuurwerk.","es":"La patrona de Gallipoli: procesión de barcas en el mar y fuegos artificiales.","fr":"La patronne de Gallipoli : procession en mer avec les bateaux et feux d'artifice."},"km":26,"min":25},{"n":"Santi Martiri · Otranto","w":{"it":"13–14 agosto","en":"13–14 August","de":"13.–14. August","nl":"13–14 augustus","es":"13–14 agosto","fr":"13–14 août"},"d":{"it":"Festa dei Martiri di Otranto con processione e luminarie; dopo la mezzanotte del 14 agosto i fuochi d'artificio sulla banchina del porto.","en":"Feast of the Martyrs of Otranto with a procession and lights; after midnight on 14 August, fireworks on the harbour quay.","de":"Fest der Märtyrer von Otranto mit Prozession und Lichtern; nach Mitternacht am 14. August Feuerwerk am Hafenkai.","nl":"Feest van de Martelaren van Otranto met processie en verlichting; na middernacht op 14 augustus vuurwerk op de havenkade.","es":"Fiesta de los Mártires de Otranto con procesión y luminarias; pasada la medianoche del 14 de agosto, fuegos artificiales en el muelle del puerto.","fr":"Fête des Martyrs d'Otrante avec procession et illuminations ; après minuit le 14 août, feu d'artifice sur le quai du port."},"km":38,"min":40},{"n":"Sant'Oronzo · Lecce","w":{"it":"24–26 agosto","en":"24–26 August","de":"24.–26. August","nl":"24–26 augustus","es":"24–26 agosto","fr":"24–26 août"},"d":{"it":"Tre giorni di festa per il patrono di Lecce: luminarie in centro, bancarelle e concerti.","en":"Three days for Lecce's patron saint: lights in the centre, stalls and concerts.","de":"Drei Festtage für den Schutzpatron von Lecce: Lichter, Stände und Konzerte.","nl":"Drie feestdagen voor de patroon van Lecce: verlichting, kraampjes en concerten.","es":"Tres días de fiesta por el patrón de Lecce: luminarias, puestos y conciertos.","fr":"Trois jours de fête pour le patron de Lecce : illuminations, stands et concerts."},"km":32,"min":30},{"n":"Sagre di paese","w":{"it":"giugno–settembre","en":"June–September","de":"Juni–September","nl":"juni–september","es":"junio–septiembre","fr":"juin–septembre"},"d":{"it":"Ogni weekend un paese vicino festeggia un piatto: pesce, pittule, pasta fatta in casa. A Cutrofiano la sagra della pitta di patate.","en":"Every weekend a nearby village celebrates a dish: fish, pittule, homemade pasta. In Cutrofiano, the potato pitta festival.","de":"Jedes Wochenende feiert ein Nachbarort ein Gericht: Fisch, Pittule, hausgemachte Pasta. In Cutrofiano das Fest der Kartoffel-Pitta.","nl":"Elk weekend viert een dorp in de buurt een gerecht: vis, pittule, zelfgemaakte pasta. In Cutrofiano het feest van de aardappelpitta.","es":"Cada fin de semana un pueblo cercano celebra un plato: pescado, pittule, pasta casera. En Cutrofiano, la fiesta de la pitta de patatas.","fr":"Chaque week-end, un village voisin fête un plat : poisson, pittule, pâtes maison. À Cutrofiano, la fête de la pitta de pommes de terre."},"km":0,"min":0},{"n":"Focara · Novoli","w":{"it":"16–17 gennaio","en":"16–17 January","de":"16.–17. Januar","nl":"16–17 januari","es":"16–17 enero","fr":"16–17 janvier"},"d":{"it":"Il più grande falò del Mediterraneo per Sant'Antonio Abate. Per chi ama il Salento d'inverno.","en":"The largest bonfire in the Mediterranean, for Saint Anthony the Abbot. For winter visitors.","de":"Das größte Feuer des Mittelmeers zu Ehren des hl. Antonius. Für Wintergäste.","nl":"Het grootste vreugdevuur van de Middellandse Zee, voor Sint-Antonius. Voor wintergasten.","es":"La mayor hoguera del Mediterráneo, por San Antonio Abad. Para quien visita en invierno.","fr":"Le plus grand feu de joie de Méditerranée, pour saint Antoine. Pour les visiteurs d'hiver."},"km":45,"min":40},{"n":"Festa del Mare · Castro","w":{"it":"12–13 agosto","en":"12–13 August","de":"12.–13. August","nl":"12–13 augustus","es":"12–13 agosto","fr":"12–13 août"},"d":{"it":"Processione a mare con le barche dei pescatori e le lampare accese, poi la gara di fuochi d'artificio che si riflette nella baia.","en":"A sea procession with fishing boats and lanterns, then a fireworks contest reflected in the bay.","de":"Bootsprozession der Fischer mit Laternen, danach ein Feuerwerkswettbewerb, der sich in der Bucht spiegelt.","nl":"Processie op zee met vissersboten en lampen, daarna een vuurwerkwedstrijd die weerspiegelt in de baai.","es":"Procesión en el mar con barcas de pescadores y lámparas encendidas, y luego un concurso de fuegos artificiales sobre la bahía.","fr":"Procession en mer avec les barques et leurs lamparos, puis un concours de feux d'artifice qui se reflète dans la baie."},"km":36,"min":40},{"n":"Luci sul mare · Otranto","w":{"it":"fine agosto – inizio settembre","en":"late August – early September","de":"Ende August – Anfang September","nl":"eind augustus – begin september","es":"finales de agosto – principios de septiembre","fr":"fin août – début septembre"},"d":{"it":"Festa della Madonna dell'Altomare: fuochi d'artificio sul mare la sera della vigilia e processione in barca con la benedizione del mare.","en":"Feast of the Madonna dell'Altomare: fireworks over the sea on the eve and a boat procession with the blessing of the sea.","de":"Fest der Madonna dell'Altomare: Feuerwerk über dem Meer am Vorabend und Bootsprozession mit Segnung des Meeres.","nl":"Feest van de Madonna dell'Altomare: vuurwerk boven zee op de vooravond en een bootprocessie met zegening van de zee.","es":"Fiesta de la Madonna dell'Altomare: fuegos artificiales sobre el mar la víspera y procesión en barca con la bendición del mar.","fr":"Fête de la Madonna dell'Altomare : feux d'artifice sur la mer la veille et procession en bateau avec bénédiction de la mer."},"km":38,"min":40},{"n":"Annunziata · Castro","w":{"it":"24–25 aprile","en":"24–25 April","de":"24.–25. April","nl":"24–25 april","es":"24–25 abril","fr":"24–25 avril"},"d":{"it":"La festa patronale di primavera con la sagra del pesce e la gara pirotecnica: ideale per un soggiorno fuori stagione.","en":"The spring patron saint's feast with a fish festival and a fireworks contest: ideal for an off-season stay.","de":"Das Patronatsfest im Frühling mit Fischfest und Feuerwerkswettbewerb: ideal für einen Aufenthalt in der Nebensaison.","nl":"Het patroonsfeest in het voorjaar met visfeest en vuurwerkwedstrijd: ideaal voor een verblijf buiten het seizoen.","es":"La fiesta patronal de primavera con fiesta del pescado y concurso de fuegos artificiales: ideal fuera de temporada.","fr":"La fête patronale de printemps avec fête du poisson et concours de feux d'artifice : idéale hors saison."},"km":36,"min":40}]};
const MARE_TXT = {"it": {"w_tram_d": "Vento da nord: l'Adriatico si increspa e l'acqua si raffredda.", "w_tram_go": "Vai sullo Ionio: Gallipoli, Porto Selvaggio, Punta Prosciutto", "w_sci_d": "Vento caldo da sud-est: onde e alghe sulla costa ionica.", "w_sci_go": "Vai sull'Adriatico: Otranto, Torre dell'Orso, Castro", "w_pon_d": "Vento da ovest e sud-ovest: mareggiate verso Gallipoli e Porto Cesareo.", "w_pon_go": "Vai sull'Adriatico: Baia dei Turchi, Roca, Porto Badisco", "w_tram": "Tramontana", "w_sci": "Scirocco", "w_pon": "Ponente e libeccio"}, "en": {"w_tram_d": "North wind: the Adriatic gets choppy and the water turns cooler.", "w_tram_go": "Go Ionian: Gallipoli, Porto Selvaggio, Punta Prosciutto", "w_sci_d": "Warm south-east wind: waves and seaweed on the Ionian coast.", "w_sci_go": "Go Adriatic: Otranto, Torre dell'Orso, Castro", "w_pon_d": "West and south-west winds: rough sea towards Gallipoli and Porto Cesareo.", "w_pon_go": "Go Adriatic: Baia dei Turchi, Roca, Porto Badisco", "w_tram": "Tramontana", "w_sci": "Scirocco", "w_pon": "Ponente & Libeccio"}, "de": {"w_tram_d": "Nordwind: Die Adria wird unruhig, das Wasser kühler.", "w_tram_go": "Ab ans Ionische Meer: Gallipoli, Porto Selvaggio, Punta Prosciutto", "w_sci_d": "Warmer Südostwind: Wellen und Seegras an der ionischen Küste.", "w_sci_go": "Ab an die Adria: Otranto, Torre dell'Orso, Castro", "w_pon_d": "West- und Südwestwind: raue See bei Gallipoli und Porto Cesareo.", "w_pon_go": "Ab an die Adria: Baia dei Turchi, Roca, Porto Badisco", "w_tram": "Tramontana", "w_sci": "Scirocco", "w_pon": "Ponente & Libeccio"}, "nl": {"w_tram_d": "Noordenwind: de Adriatische Zee wordt woelig en het water kouder.", "w_tram_go": "Ga naar de Ionische kust: Gallipoli, Porto Selvaggio, Punta Prosciutto", "w_sci_d": "Warme zuidoostenwind: golven en zeewier aan de Ionische kust.", "w_sci_go": "Ga naar de Adriatische kust: Otranto, Torre dell'Orso, Castro", "w_pon_d": "West- en zuidwestenwind: ruwe zee bij Gallipoli en Porto Cesareo.", "w_pon_go": "Ga naar de Adriatische kust: Baia dei Turchi, Roca, Porto Badisco", "w_tram": "Tramontana", "w_sci": "Scirocco", "w_pon": "Ponente & Libeccio"}, "es": {"w_tram_d": "Viento del norte: el Adriático se pica y el agua se enfría.", "w_tram_go": "Ve al Jónico: Gallipoli, Porto Selvaggio, Punta Prosciutto", "w_sci_d": "Viento cálido del sureste: olas y algas en la costa jónica.", "w_sci_go": "Ve al Adriático: Otranto, Torre dell'Orso, Castro", "w_pon_d": "Vientos del oeste y suroeste: mar agitado hacia Gallipoli y Porto Cesareo.", "w_pon_go": "Ve al Adriático: Baia dei Turchi, Roca, Porto Badisco", "w_tram": "Tramontana", "w_sci": "Siroco", "w_pon": "Poniente y lebeche"}, "fr": {"w_tram_d": "Vent du nord : l'Adriatique s'agite et l'eau se rafraîchit.", "w_tram_go": "Côté ionien : Gallipoli, Porto Selvaggio, Punta Prosciutto", "w_sci_d": "Vent chaud du sud-est : vagues et algues sur la côte ionienne.", "w_sci_go": "Côté adriatique : Otrante, Torre dell'Orso, Castro", "w_pon_d": "Vents d'ouest et de sud-ouest : mer agitée vers Gallipoli et Porto Cesareo.", "w_pon_go": "Côté adriatique : Baia dei Turchi, Roca, Porto Badisco", "w_tram": "Tramontane", "w_sci": "Sirocco", "w_pon": "Ponant et labech"}};
const BT = {
  it: { lang: "Italiano", ai: "Italian",
    hi: (n) => `Ciao${n ? " " + n : ""}! Sono l'assistente di Casalaggiù 🏠\nScegli un argomento qui sotto oppure scrivimi la tua domanda: rispondo subito, e se non so qualcosa la giro a Momo.`,
    hiG: (n, a, p) => `Ciao ${n}! Ti ho riconosciuto: soggiorno dal ${a} al ${p} 🏠\nQui trovi Wi-Fi, istruzioni, check-in e pagamenti. Scegli un argomento o scrivimi.`,
    m: { date: "📅 Date e prezzi", orari: "🕑 Check-in e check-out", arrivo: "🚗 Come arrivare", pag: "💳 Pagamenti e condizioni", faq: "❓ Domande frequenti", mare: "🌊 Quale mare oggi", eventi: "🎉 Eventi", consigli: "🍝 Consigli", host: "💬 Scrivi a Momo", guida: "📖 Guida della casa", wifi: "📶 Wi-Fi", ck: "🪪 Check-in online", saldo: "💶 Pagamenti", lingua: "🌍 Lingua", menu: "☰ Menu" },
    dateAsk: "Scrivimi le date e quanti siete, per esempio: «dal 10 al 17 agosto, 2 persone».",
    free: "✅ Libero!", nights: (n) => (n === 1 ? "1 notte" : n + " notti"), guests: (g) => (g === 1 ? "1 ospite" : g + " ospiti"),
    stay: "Soggiorno", disc: "Sconto", short: "Supplemento soggiorno breve", tot: "Totale", book: "Per prenotare (le date sono già selezionate):",
    noPrice: "Per queste date il prezzo è su richiesta: manda la richiesta dal sito e Momo ti prepara il preventivo.",
    busy: "😕 In quelle date la casa è già occupata.", alt: "Prossime date libere con le stesse notti:", noAlt: "Guarda il calendario sul sito per altre date:",
    minN: (m) => `Il soggiorno minimo per quell'arrivo è di ${m} notti.`, past: "Queste date sono già passate: scrivimi date future.", maxG: "La casa ospita al massimo 4 persone.",
    dateBad: "Non ho capito bene le date. Prova così: «dal 10 al 17 agosto, 2 persone».",
    hostAsk: "Scrivi qui il tuo messaggio: lo giro subito a Momo, che ti risponde in questa chat.", hostSent: "📨 Inviato! Momo ti risponde qui appena può.",
    fwd: "Su questo preferisco non tirare a indovinare: ho girato la tua domanda a Momo, ti risponde qui appena può.", hostReply: "💬 Momo:",
    noHost: "In questo momento non riesco a inoltrare il messaggio. Scrivici su WhatsApp o rispondi all'email di conferma.",
    wind: (d, k) => `🌬️ Adesso a Cutrofiano: vento da ${d}, ${k} km/h.`, calm: "Vento debole: oggi vanno bene sia lo Ionio sia l'Adriatico! 🌊", mareErr: "Non riesco a leggere il vento in questo momento. Il trucco: con vento da nord vai sullo Ionio, con vento da sud o da ovest sull'Adriatico.",
    dirs: ["nord", "nord-est", "est", "sud-est", "sud", "sud-ovest", "ovest", "nord-ovest"],
    evT: "🎉 Feste ed eventi nei dintorni:", more: "Tutto il resto sul sito:", consNone: "I consigli di Momo su ristoranti e posti da vedere sono nella guida del sito:",
    wifiPub: "Sì, c'è il Wi-Fi in fibra e l'aria condizionata. Nome della rete e password li trovi nella guida della casa, che ricevi qualche giorno prima dell'arrivo.",
    wifiG: (r, p) => `📶 Rete: ${r}\n🔑 Password: ${p}`, wifiNone: "Il Wi-Fi c'è: chiedi a Momo nome e password (tasto «Scrivi a Momo»).",
    ckDone: "✅ Check-in online già compilato, grazie!", ckTodo: "Manca il check-in online: servono i dati degli ospiti (lo chiede la legge). Ci vogliono 2 minuti:",
    payNone: "Nessun pagamento in sospeso 👍", payTodo: "Pagamenti da fare (carta o bonifico):",
    guide: "La tua guida della casa (Wi-Fi, come entrare, raccolta differenziata, consigli):", guideNot: (d) => `La guida della casa sarà disponibile dal ${d}: te la mandiamo anche per email.`,
    langAsk: "Scegli la lingua:", langOk: "Ok, parliamo in italiano 🇮🇹", many: "Hai scritto tanti messaggi: riprova tra un po', oppure usa «Scrivi a Momo».",
    faqT: "❓ Domande frequenti", polT: "💳 Condizioni di prenotazione", addr: "📍 Via Roma 13, 73020 Cutrofiano (LE)", map: "Mappa:", arrT: "🚗 Come arrivare",
    ownOk: "Fatto! Sei collegato come proprietario: qui riceverai le domande degli ospiti. Per rispondere, rispondi al messaggio inoltrato.", ownHint: "Per scrivere a un ospite rispondi (swipe → Rispondi) a una delle sue domande inoltrate. Per provare il bot come un ospite scrivi /prova.", ownSent: "✓ Risposta inviata all'ospite." },
  en: { lang: "English", ai: "English",
    hi: (n) => `Hi${n ? " " + n : ""}! I'm the Casalaggiù assistant 🏠\nPick a topic below or just type your question: I'll answer right away, and if I don't know something I'll pass it on to Momo.`,
    hiG: (n, a, p) => `Hi ${n}! I recognised you: stay from ${a} to ${p} 🏠\nHere you'll find the Wi-Fi, instructions, check-in and payments. Pick a topic or type your question.`,
    m: { date: "📅 Dates and prices", orari: "🕑 Check-in and check-out", arrivo: "🚗 Getting here", pag: "💳 Payments and terms", faq: "❓ FAQ", mare: "🌊 Which sea today", eventi: "🎉 Events", consigli: "🍝 Tips", host: "💬 Message Momo", guida: "📖 House guide", wifi: "📶 Wi-Fi", ck: "🪪 Online check-in", saldo: "💶 Payments", lingua: "🌍 Language", menu: "☰ Menu" },
    dateAsk: "Type your dates and how many you are, for example: “10 to 17 August, 2 people”.",
    free: "✅ Available!", nights: (n) => (n === 1 ? "1 night" : n + " nights"), guests: (g) => (g === 1 ? "1 guest" : g + " guests"),
    stay: "Stay", disc: "Discount", short: "Short-stay surcharge", tot: "Total", book: "To book (dates already selected):",
    noPrice: "For these dates the price is on request: send a request from the website and Momo will prepare a quote for you.",
    busy: "😕 The house is already booked on those dates.", alt: "Next available dates with the same number of nights:", noAlt: "Check the calendar on the website for other dates:",
    minN: (m) => `The minimum stay for that arrival date is ${m} nights.`, past: "These dates are in the past: please send me future dates.", maxG: "The house sleeps up to 4 people.",
    dateBad: "I didn't quite get the dates. Try like this: “10 to 17 August, 2 people”.",
    hostAsk: "Type your message here: I'll pass it straight to Momo, who will reply in this chat.", hostSent: "📨 Sent! Momo will reply here as soon as possible.",
    fwd: "I'd rather not guess on this one: I've passed your question to Momo, who will reply here as soon as possible.", hostReply: "💬 Momo:",
    noHost: "I can't forward your message right now. Please message us on WhatsApp or reply to the confirmation email.",
    wind: (d, k) => `🌬️ Right now in Cutrofiano: wind from the ${d}, ${k} km/h.`, calm: "Light wind: both the Ionian and the Adriatic are good today! 🌊", mareErr: "I can't read the wind right now. The trick: with a north wind go to the Ionian, with a south or west wind go to the Adriatic.",
    dirs: ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"],
    evT: "🎉 Festivals and events nearby:", more: "Everything else on the website:", consNone: "Momo's tips on restaurants and places to see are in the guide on the website:",
    wifiPub: "Yes, there's fibre Wi-Fi and air conditioning. You'll find the network name and password in the house guide, which you receive a few days before arrival.",
    wifiG: (r, p) => `📶 Network: ${r}\n🔑 Password: ${p}`, wifiNone: "There is Wi-Fi: ask Momo for the network and password (“Message Momo” button).",
    ckDone: "✅ Online check-in already done, thank you!", ckTodo: "The online check-in is still missing: we need your guests' details (required by law). It takes 2 minutes:",
    payNone: "No pending payments 👍", payTodo: "Payments due (card or bank transfer):",
    guide: "Your house guide (Wi-Fi, how to get in, waste sorting, tips):", guideNot: (d) => `The house guide will be available from ${d}: we'll also send it to you by email.`,
    langAsk: "Choose your language:", langOk: "OK, let's talk in English 🇬🇧", many: "You've sent a lot of messages: try again in a while, or use “Message Momo”.",
    faqT: "❓ Frequently asked questions", polT: "💳 Booking terms", addr: "📍 Via Roma 13, 73020 Cutrofiano (LE), Italy", map: "Map:", arrT: "🚗 Getting here" },
  de: { lang: "Deutsch", ai: "German",
    hi: (n) => `Hallo${n ? " " + n : ""}! Ich bin der Assistent der Casalaggiù 🏠\nWähl unten ein Thema oder schreib mir deine Frage: Ich antworte sofort, und wenn ich etwas nicht weiß, gebe ich es an Momo weiter.`,
    hiG: (n, a, p) => `Hallo ${n}! Ich habe dich erkannt: Aufenthalt vom ${a} bis ${p} 🏠\nHier findest du WLAN, Hinweise, Check-in und Zahlungen. Wähl ein Thema oder schreib mir.`,
    m: { date: "📅 Termine und Preise", orari: "🕑 Check-in und Check-out", arrivo: "🚗 Anreise", pag: "💳 Zahlung und Bedingungen", faq: "❓ Häufige Fragen", mare: "🌊 Welches Meer heute", eventi: "🎉 Events", consigli: "🍝 Tipps", host: "💬 Momo schreiben", guida: "📖 Hausführer", wifi: "📶 WLAN", ck: "🪪 Online-Check-in", saldo: "💶 Zahlungen", lingua: "🌍 Sprache", menu: "☰ Menü" },
    dateAsk: "Schreib mir die Daten und wie viele ihr seid, zum Beispiel: „10. bis 17. August, 2 Personen“.",
    free: "✅ Frei!", nights: (n) => (n === 1 ? "1 Nacht" : n + " Nächte"), guests: (g) => (g === 1 ? "1 Gast" : g + " Gäste"),
    stay: "Aufenthalt", disc: "Rabatt", short: "Zuschlag Kurzaufenthalt", tot: "Gesamt", book: "Zum Buchen (Daten schon ausgewählt):",
    noPrice: "Für diese Daten gibt es den Preis auf Anfrage: schick die Anfrage über die Website und Momo macht dir ein Angebot.",
    busy: "😕 An diesen Tagen ist das Haus leider schon belegt.", alt: "Nächste freie Termine mit gleich vielen Nächten:", noAlt: "Schau im Kalender auf der Website nach anderen Terminen:",
    minN: (m) => `Der Mindestaufenthalt für diese Anreise beträgt ${m} Nächte.`, past: "Diese Daten liegen in der Vergangenheit: schreib mir zukünftige Daten.", maxG: "Das Haus bietet Platz für höchstens 4 Personen.",
    dateBad: "Ich habe die Daten nicht ganz verstanden. Versuch es so: „10. bis 17. August, 2 Personen“.",
    hostAsk: "Schreib hier deine Nachricht: ich leite sie sofort an Momo weiter, der dir in diesem Chat antwortet.", hostSent: "📨 Gesendet! Momo antwortet dir hier so bald wie möglich.",
    fwd: "Da möchte ich nicht raten: ich habe deine Frage an Momo weitergeleitet, er antwortet dir hier so bald wie möglich.", hostReply: "💬 Momo:",
    noHost: "Ich kann die Nachricht gerade nicht weiterleiten. Schreib uns auf WhatsApp oder antworte auf die Bestätigungs-E-Mail.",
    wind: (d, k) => `🌬️ Gerade in Cutrofiano: Wind aus ${d}, ${k} km/h.`, calm: "Schwacher Wind: heute sind sowohl das Ionische Meer als auch die Adria gut! 🌊", mareErr: "Ich kann den Wind gerade nicht abrufen. Der Trick: bei Nordwind ans Ionische Meer, bei Süd- oder Westwind an die Adria.",
    dirs: ["Norden", "Nordosten", "Osten", "Südosten", "Süden", "Südwesten", "Westen", "Nordwesten"],
    evT: "🎉 Feste und Events in der Nähe:", more: "Alles Weitere auf der Website:", consNone: "Momos Tipps zu Restaurants und Ausflügen stehen im Reiseführer auf der Website:",
    wifiPub: "Ja, es gibt Glasfaser-WLAN und eine Klimaanlage. Netzwerkname und Passwort stehen im Hausführer, den du ein paar Tage vor der Ankunft bekommst.",
    wifiG: (r, p) => `📶 Netzwerk: ${r}\n🔑 Passwort: ${p}`, wifiNone: "WLAN gibt es: frag Momo nach Netzwerk und Passwort (Taste „Momo schreiben“).",
    ckDone: "✅ Online-Check-in schon ausgefüllt, danke!", ckTodo: "Der Online-Check-in fehlt noch: wir brauchen die Daten der Gäste (gesetzlich vorgeschrieben). Dauert 2 Minuten:",
    payNone: "Keine offenen Zahlungen 👍", payTodo: "Offene Zahlungen (Karte oder Überweisung):",
    guide: "Dein Hausführer (WLAN, Zugang, Mülltrennung, Tipps):", guideNot: (d) => `Der Hausführer ist ab ${d} verfügbar: wir schicken ihn dir auch per E-Mail.`,
    langAsk: "Wähl deine Sprache:", langOk: "Okay, wir sprechen Deutsch 🇩🇪", many: "Du hast viele Nachrichten geschrieben: probier es später nochmal oder nutze „Momo schreiben“.",
    faqT: "❓ Häufige Fragen", polT: "💳 Buchungsbedingungen", addr: "📍 Via Roma 13, 73020 Cutrofiano (LE), Italien", map: "Karte:", arrT: "🚗 Anreise" },
  nl: { lang: "Nederlands", ai: "Dutch",
    hi: (n) => `Hoi${n ? " " + n : ""}! Ik ben de assistent van Casalaggiù 🏠\nKies hieronder een onderwerp of typ je vraag: ik antwoord meteen, en als ik iets niet weet, stuur ik het door naar Momo.`,
    hiG: (n, a, p) => `Hoi ${n}! Ik heb je herkend: verblijf van ${a} tot ${p} 🏠\nHier vind je de wifi, instructies, het inchecken en betalingen. Kies een onderwerp of typ je vraag.`,
    m: { date: "📅 Data en prijzen", orari: "🕑 In- en uitchecken", arrivo: "🚗 Bereikbaarheid", pag: "💳 Betaling en voorwaarden", faq: "❓ Veelgestelde vragen", mare: "🌊 Welke zee vandaag", eventi: "🎉 Evenementen", consigli: "🍝 Tips", host: "💬 Bericht aan Momo", guida: "📖 Huisgids", wifi: "📶 Wifi", ck: "🪪 Online inchecken", saldo: "💶 Betalingen", lingua: "🌍 Taal", menu: "☰ Menu" },
    dateAsk: "Typ je data en met hoeveel je bent, bijvoorbeeld: „10 tot 17 augustus, 2 personen”.",
    free: "✅ Beschikbaar!", nights: (n) => (n === 1 ? "1 nacht" : n + " nachten"), guests: (g) => (g === 1 ? "1 gast" : g + " gasten"),
    stay: "Verblijf", disc: "Korting", short: "Toeslag kort verblijf", tot: "Totaal", book: "Om te boeken (data al geselecteerd):",
    noPrice: "Voor deze data is de prijs op aanvraag: stuur een aanvraag via de website en Momo maakt een offerte voor je.",
    busy: "😕 Op die data is het huis al bezet.", alt: "Eerstvolgende vrije data met hetzelfde aantal nachten:", noAlt: "Bekijk de kalender op de website voor andere data:",
    minN: (m) => `Het minimumverblijf voor die aankomstdatum is ${m} nachten.`, past: "Deze data liggen in het verleden: stuur me toekomstige data.", maxG: "Het huis biedt plaats aan maximaal 4 personen.",
    dateBad: "Ik begreep de data niet helemaal. Probeer het zo: „10 tot 17 augustus, 2 personen”.",
    hostAsk: "Typ hier je bericht: ik stuur het meteen door naar Momo, die je in deze chat antwoordt.", hostSent: "📨 Verstuurd! Momo antwoordt je hier zo snel mogelijk.",
    fwd: "Hier wil ik liever niet naar gissen: ik heb je vraag doorgestuurd naar Momo, die je hier zo snel mogelijk antwoordt.", hostReply: "💬 Momo:",
    noHost: "Ik kan je bericht nu niet doorsturen. Stuur ons een WhatsApp of beantwoord de bevestigingsmail.",
    wind: (d, k) => `🌬️ Nu in Cutrofiano: wind uit het ${d}, ${k} km/u.`, calm: "Weinig wind: vandaag zijn zowel de Ionische als de Adriatische Zee goed! 🌊", mareErr: "Ik kan de wind nu niet ophalen. De truc: bij noordenwind naar de Ionische Zee, bij zuiden- of westenwind naar de Adriatische.",
    dirs: ["noorden", "noordoosten", "oosten", "zuidoosten", "zuiden", "zuidwesten", "westen", "noordwesten"],
    evT: "🎉 Feesten en evenementen in de buurt:", more: "Al het andere op de website:", consNone: "De tips van Momo over restaurants en bezienswaardigheden staan in de gids op de website:",
    wifiPub: "Ja, er is glasvezel-wifi en airco. De netwerknaam en het wachtwoord staan in de huisgids, die je een paar dagen voor aankomst krijgt.",
    wifiG: (r, p) => `📶 Netwerk: ${r}\n🔑 Wachtwoord: ${p}`, wifiNone: "Er is wifi: vraag Momo om netwerk en wachtwoord (knop „Bericht aan Momo”).",
    ckDone: "✅ Online inchecken al gedaan, bedankt!", ckTodo: "Het online inchecken ontbreekt nog: we hebben de gegevens van de gasten nodig (wettelijk verplicht). Het duurt 2 minuten:",
    payNone: "Geen openstaande betalingen 👍", payTodo: "Openstaande betalingen (kaart of overschrijving):",
    guide: "Je huisgids (wifi, binnenkomen, afval scheiden, tips):", guideNot: (d) => `De huisgids is beschikbaar vanaf ${d}: we sturen hem je ook per e-mail.`,
    langAsk: "Kies je taal:", langOk: "Oké, we praten Nederlands 🇳🇱", many: "Je hebt veel berichten gestuurd: probeer het straks opnieuw of gebruik „Bericht aan Momo”.",
    faqT: "❓ Veelgestelde vragen", polT: "💳 Boekingsvoorwaarden", addr: "📍 Via Roma 13, 73020 Cutrofiano (LE), Italië", map: "Kaart:", arrT: "🚗 Bereikbaarheid" },
  es: { lang: "Español", ai: "Spanish",
    hi: (n) => `¡Hola${n ? " " + n : ""}! Soy el asistente de Casalaggiù 🏠\nElige un tema aquí abajo o escríbeme tu pregunta: contesto al momento, y si no sé algo se lo paso a Momo.`,
    hiG: (n, a, p) => `¡Hola ${n}! Te he reconocido: estancia del ${a} al ${p} 🏠\nAquí tienes el Wi-Fi, las instrucciones, el check-in y los pagos. Elige un tema o escríbeme.`,
    m: { date: "📅 Fechas y precios", orari: "🕑 Entrada y salida", arrivo: "🚗 Cómo llegar", pag: "💳 Pagos y condiciones", faq: "❓ Preguntas frecuentes", mare: "🌊 Qué mar hoy", eventi: "🎉 Eventos", consigli: "🍝 Consejos", host: "💬 Escribir a Momo", guida: "📖 Guía de la casa", wifi: "📶 Wi-Fi", ck: "🪪 Check-in online", saldo: "💶 Pagos", lingua: "🌍 Idioma", menu: "☰ Menú" },
    dateAsk: "Escríbeme las fechas y cuántos sois, por ejemplo: «del 10 al 17 de agosto, 2 personas».",
    free: "✅ ¡Libre!", nights: (n) => (n === 1 ? "1 noche" : n + " noches"), guests: (g) => (g === 1 ? "1 huésped" : g + " huéspedes"),
    stay: "Estancia", disc: "Descuento", short: "Suplemento estancia corta", tot: "Total", book: "Para reservar (fechas ya seleccionadas):",
    noPrice: "Para estas fechas el precio es bajo petición: envía la solicitud desde la web y Momo te prepara el presupuesto.",
    busy: "😕 En esas fechas la casa ya está ocupada.", alt: "Próximas fechas libres con las mismas noches:", noAlt: "Mira el calendario de la web para otras fechas:",
    minN: (m) => `La estancia mínima para esa llegada es de ${m} noches.`, past: "Esas fechas ya han pasado: escríbeme fechas futuras.", maxG: "La casa admite como máximo 4 personas.",
    dateBad: "No he entendido bien las fechas. Prueba así: «del 10 al 17 de agosto, 2 personas».",
    hostAsk: "Escribe aquí tu mensaje: se lo paso enseguida a Momo, que te responde en este chat.", hostSent: "📨 ¡Enviado! Momo te responde aquí lo antes posible.",
    fwd: "Prefiero no adivinar: le he pasado tu pregunta a Momo, que te responde aquí lo antes posible.", hostReply: "💬 Momo:",
    noHost: "Ahora mismo no puedo reenviar el mensaje. Escríbenos por WhatsApp o responde al correo de confirmación.",
    wind: (d, k) => `🌬️ Ahora en Cutrofiano: viento del ${d}, ${k} km/h.`, calm: "Viento flojo: ¡hoy van bien tanto el Jónico como el Adriático! 🌊", mareErr: "Ahora no puedo leer el viento. El truco: con viento del norte ve al Jónico, con viento del sur o del oeste al Adriático.",
    dirs: ["norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"],
    evT: "🎉 Fiestas y eventos cerca:", more: "Todo lo demás en la web:", consNone: "Los consejos de Momo sobre restaurantes y sitios que ver están en la guía de la web:",
    wifiPub: "Sí, hay Wi-Fi de fibra y aire acondicionado. El nombre de la red y la contraseña están en la guía de la casa, que recibes unos días antes de llegar.",
    wifiG: (r, p) => `📶 Red: ${r}\n🔑 Contraseña: ${p}`, wifiNone: "Hay Wi-Fi: pide a Momo la red y la contraseña (botón «Escribir a Momo»).",
    ckDone: "✅ Check-in online ya rellenado, ¡gracias!", ckTodo: "Falta el check-in online: necesitamos los datos de los huéspedes (lo exige la ley). Son 2 minutos:",
    payNone: "No hay pagos pendientes 👍", payTodo: "Pagos pendientes (tarjeta o transferencia):",
    guide: "Tu guía de la casa (Wi-Fi, cómo entrar, reciclaje, consejos):", guideNot: (d) => `La guía de la casa estará disponible a partir del ${d}: también te la enviamos por correo.`,
    langAsk: "Elige el idioma:", langOk: "Vale, hablamos en español 🇪🇸", many: "Has escrito muchos mensajes: vuelve a probar dentro de un rato o usa «Escribir a Momo».",
    faqT: "❓ Preguntas frecuentes", polT: "💳 Condiciones de reserva", addr: "📍 Via Roma 13, 73020 Cutrofiano (LE), Italia", map: "Mapa:", arrT: "🚗 Cómo llegar" },
  fr: { lang: "Français", ai: "French",
    hi: (n) => `Bonjour${n ? " " + n : ""} ! Je suis l'assistant de Casalaggiù 🏠\nChoisissez un sujet ci-dessous ou écrivez-moi votre question : je réponds tout de suite, et si je ne sais pas, je transmets à Momo.`,
    hiG: (n, a, p) => `Bonjour ${n} ! Je vous ai reconnu : séjour du ${a} au ${p} 🏠\nVous trouverez ici le Wi-Fi, les instructions, le check-in et les paiements. Choisissez un sujet ou écrivez-moi.`,
    m: { date: "📅 Dates et prix", orari: "🕑 Arrivée et départ", arrivo: "🚗 Comment venir", pag: "💳 Paiement et conditions", faq: "❓ Questions fréquentes", mare: "🌊 Quelle mer aujourd'hui", eventi: "🎉 Événements", consigli: "🍝 Conseils", host: "💬 Écrire à Momo", guida: "📖 Guide de la maison", wifi: "📶 Wi-Fi", ck: "🪪 Check-in en ligne", saldo: "💶 Paiements", lingua: "🌍 Langue", menu: "☰ Menu" },
    dateAsk: "Écrivez-moi les dates et combien vous êtes, par exemple : « du 10 au 17 août, 2 personnes ».",
    free: "✅ Disponible !", nights: (n) => (n === 1 ? "1 nuit" : n + " nuits"), guests: (g) => (g === 1 ? "1 personne" : g + " personnes"),
    stay: "Séjour", disc: "Réduction", short: "Supplément court séjour", tot: "Total", book: "Pour réserver (dates déjà sélectionnées) :",
    noPrice: "Pour ces dates, le prix est sur demande : envoyez une demande depuis le site et Momo vous préparera un devis.",
    busy: "😕 La maison est déjà réservée à ces dates.", alt: "Prochaines dates libres avec le même nombre de nuits :", noAlt: "Consultez le calendrier du site pour d'autres dates :",
    minN: (m) => `Le séjour minimum pour cette date d'arrivée est de ${m} nuits.`, past: "Ces dates sont déjà passées : envoyez-moi des dates futures.", maxG: "La maison accueille au maximum 4 personnes.",
    dateBad: "Je n'ai pas bien compris les dates. Essayez ainsi : « du 10 au 17 août, 2 personnes ».",
    hostAsk: "Écrivez votre message ici : je le transmets tout de suite à Momo, qui vous répondra dans ce chat.", hostSent: "📨 Envoyé ! Momo vous répondra ici dès que possible.",
    fwd: "Je préfère ne pas deviner : j'ai transmis votre question à Momo, qui vous répondra ici dès que possible.", hostReply: "💬 Momo :",
    noHost: "Je ne peux pas transmettre le message pour le moment. Écrivez-nous sur WhatsApp ou répondez à l'e-mail de confirmation.",
    wind: (d, k) => `🌬️ En ce moment à Cutrofiano : vent du ${d}, ${k} km/h.`, calm: "Vent faible : aujourd'hui la mer Ionienne comme l'Adriatique sont parfaites ! 🌊", mareErr: "Je ne peux pas lire le vent pour le moment. L'astuce : vent du nord, côté ionien ; vent du sud ou d'ouest, côté adriatique.",
    dirs: ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"],
    evT: "🎉 Fêtes et événements aux alentours :", more: "Tout le reste sur le site :", consNone: "Les conseils de Momo sur les restaurants et les lieux à voir sont dans le guide du site :",
    wifiPub: "Oui, il y a le Wi-Fi fibre et la climatisation. Le nom du réseau et le mot de passe sont dans le guide de la maison, que vous recevez quelques jours avant l'arrivée.",
    wifiG: (r, p) => `📶 Réseau : ${r}\n🔑 Mot de passe : ${p}`, wifiNone: "Il y a le Wi-Fi : demandez à Momo le réseau et le mot de passe (bouton « Écrire à Momo »).",
    ckDone: "✅ Check-in en ligne déjà rempli, merci !", ckTodo: "Il manque le check-in en ligne : nous avons besoin des données des voyageurs (exigé par la loi). Cela prend 2 minutes :",
    payNone: "Aucun paiement en attente 👍", payTodo: "Paiements à effectuer (carte ou virement) :",
    guide: "Votre guide de la maison (Wi-Fi, accès, tri des déchets, conseils) :", guideNot: (d) => `Le guide de la maison sera disponible à partir du ${d} : nous vous l'enverrons aussi par e-mail.`,
    langAsk: "Choisissez la langue :", langOk: "D'accord, parlons français 🇫🇷", many: "Vous avez envoyé beaucoup de messages : réessayez dans un moment ou utilisez « Écrire à Momo ».",
    faqT: "❓ Questions fréquentes", polT: "💳 Conditions de réservation", addr: "📍 Via Roma 13, 73020 Cutrofiano (LE), Italie", map: "Carte :", arrT: "🚗 Comment venir" },
};
const BL = ["it", "en", "de", "nl", "es", "fr"];
const MAPPA = "https://maps.google.com/?q=Via+Roma+13,+73020+Cutrofiano+LE";
async function tabelleBot(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS bot_chat (chat_id TEXT PRIMARY KEY, lingua TEXT, richiesta_id TEXT, nome TEXT, stato TEXT, n INTEGER NOT NULL DEFAULT 0, finestra TEXT, creato TEXT, agg TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS bot_fw (msg_id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, creato TEXT NOT NULL)").run();
}
async function tgBot(env, metodo, dati) {
  const token = await getSet(env, "gb_token");
  if (!token) return { ok: false, description: "token mancante" };
  const url = (env.TG_API || "https://api.telegram.org") + `/bot${token}/${metodo}`;
  try { return await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dati || {}) })).json(); }
  catch (e) { return { ok: false, description: e.message }; }
}
const fdBot = (d, L) => new Date(d + "T12:00:00Z").toLocaleDateString(L === "en" ? "en-GB" : L, { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
const eurBot = (v, L) => new Intl.NumberFormat(L === "en" ? "en-GB" : L, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
// prenotazione collegata alla chat (confermata e non ancora passata da più di 2 giorni)
async function ricBot(env, c) {
  if (!c || !c.richiesta_id) return null;
  const r = await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(c.richiesta_id).first();
  if (!r || r.stato !== "confermata" || piuGiorni(r.partenza, 2) < new Date().toISOString().slice(0, 10)) return null;
  return r;
}
// ospite = prenotazione collegata, oppure il proprietario in modalità prova (/prova)
async function ospiteBot(env, c) {
  if (await ricBot(env, c)) return true;
  const own = await getSet(env, "gb_owner");
  return !!(own && c && String(c.chat_id) === String(own) && (await getSet(env, "gb_prova")) === "1");
}
// sezioni della guida da mostrare nel menu: agli ospiti tutte, agli altri solo casa e servizi; mai quelle con [da completare]
async function sezioniBot(env, L, ospite) {
  const g = await guidaDati(env);
  if (!g.pubblicata) return [];
  return g.sezioni.filter((s) => s.id !== "dintorni" && (ospite || ["casa", "servizi"].includes(s.id)) && !/\[[^\]]{3,}\]/.test((s.x.it || "") + (s.x[L] || "")))
    .map((s) => ({ id: s.id, text: `${s.ico} ${s.t[L] || s.t.it}`.slice(0, 40) }));
}
function tastiBot(L, ospite, sez) {
  const m = BT[L].m, b = (k) => ({ text: m[k], callback_data: k }), gs = [];
  for (let i = 0; i < (sez || []).length; i += 2) gs.push(sez.slice(i, i + 2).map((x) => ({ text: x.text, callback_data: "g_" + x.id })));
  const righe = ospite
    ? [[b("guida"), b("wifi")], [b("ck"), b("saldo")], ...gs, [b("mare"), b("eventi")], [b("consigli"), b("orari")], [b("host"), b("lingua")]]
    : [[b("date")], [b("orari"), b("arrivo")], [b("pag"), b("faq")], ...gs, [b("mare"), b("eventi")], [b("consigli"), b("host")], [b("lingua")]];
  return { inline_keyboard: righe };
}
async function menuBot(env, c, L) {
  const o = await ospiteBot(env, c);
  return tastiBot(L, o, await sezioniBot(env, L, o));
}
const inviaBot = (env, chat, text, tastiera) => tgBot(env, "sendMessage", { chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...(tastiera ? { reply_markup: tastiera } : {}) });
// vento attuale a Cutrofiano (Open-Meteo, senza chiave)
async function mareBot(env, L) {
  const t = BT[L], w = MARE_TXT[L];
  try {
    const d = await (await fetch((env.METEO_API || "https://api.open-meteo.com") + "/v1/forecast?latitude=40.13&longitude=18.20&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh&timezone=Europe%2FRome")).json();
    const v = Math.round(d.current.wind_speed_10m), g = d.current.wind_direction_10m;
    const dir = t.dirs[Math.round(g / 45) % 8];
    let k = null;
    if (v >= 12) k = (g >= 315 || g < 112.5) ? "tram" : (g < 202.5 ? "sci" : "pon");
    return [t.wind(dir, v), "", k ? `${w["w_" + k]}: ${w["w_" + k + "_d"]}\n👉 ${w["w_" + k + "_go"]}` : t.calm, "", `${SITO}/#mare`].join("\n");
  } catch (e) { return t.mareErr + `\n${SITO}/#mare`; }
}
function eventiBot(L) {
  const t = BT[L];
  return [t.evT, "", ...BOT_KB.EV.map((e) => `• ${e.n} — ${e.w[L] || e.w.it}${e.km ? ` (${e.km} km)` : ""}\n  ${e.d[L] || e.d.it}`), "", t.more, `${SITO}/#eventi`].join("\n");
}
async function sezioneGuida(env, id, L) {
  const g = await guidaDati(env);
  if (!g.pubblicata) return null;
  const s = g.sezioni.find((x) => x.id === id);
  if (!s) return null;
  const x = (s.x[L] || s.x.it || "").replace(/\*\*/g, "");
  return x && !/\[[^\]]{3,}\]/.test(x) ? `${s.ico} ${s.t[L] || s.t.it}\n\n${x}` : null;
}
// preventivo: disponibilità, notti minime, prezzo con sconti e supplementi, link al sito con le date già scelte
async function preventivoBot(env, L, arrivo, partenza, ospiti) {
  const t = BT[L], oggi = new Date().toISOString().slice(0, 10);
  if (!DATE.test(arrivo) || !DATE.test(partenza) || partenza <= arrivo || notti(arrivo, partenza) > 90) return t.dateBad;
  if (arrivo <= oggi) return t.past;
  const g = Math.min(Math.max(parseInt(ospiti, 10) || 2, 1), 99);
  if (g > MAX_OSPITI) return t.maxG;
  const n = notti(arrivo, partenza);
  const link = `${SITO}/?ci=${arrivo}&co=${partenza}&g=${g}&l=${L}#prenota`;
  const righe = [`📅 ${fdBot(arrivo, L)} → ${fdBot(partenza, L)} · ${t.nights(n)} · ${t.guests(g)}`, ""];
  if (await sovrapposto(env, arrivo, partenza)) {
    righe.push(t.busy);
    const occ = (await env.DB.prepare("SELECT arrivo, partenza FROM occupato WHERE partenza > ?").bind(oggi).all()).results || [];
    const libera = (a, b) => !occ.some((o) => o.arrivo < b && o.partenza > a);
    const alt = [];
    for (let i = -14; i <= 120 && alt.length < 3; i++) {
      const a = piuGiorni(arrivo, i), b = piuGiorni(a, n);
      if (a <= oggi || !libera(a, b) || n < (await minNotti(env, a))) continue;
      alt.push(`• ${fdBot(a, L)} → ${fdBot(b, L)}\n  ${SITO}/?ci=${a}&co=${b}&g=${g}&l=${L}#prenota`);
      i += n;
    }
    righe.push("", alt.length ? t.alt : t.noAlt, ...(alt.length ? alt : [`${SITO}/#prenota`]));
    return righe.join("\n");
  }
  const min = await minNotti(env, arrivo);
  if (n < min) return [...righe, t.minN(min), "", `${SITO}/#prenota`].join("\n");
  const st = await stima(env, arrivo, partenza, g);
  if (!st.totale || !st.completa) return [...righe, t.free, "", t.noPrice, "", link].join("\n");
  const sc = await calcolaSconto(env, arrivo, partenza, null), scImp = sc ? Math.round(st.totale * sc.pct) / 100 : 0, sb = await supBreve(env, arrivo, n);
  righe.push(t.free, "", `${t.stay}: ${eurBot(st.totale, L)}`);
  if (scImp) righe.push(`${t.disc} -${sc.pct}%: -${eurBot(scImp, L)}`);
  if (sb) righe.push(`${t.short}: +${eurBot(sb, L)}`);
  righe.push(`${t.tot}: ${eurBot(st.totale - scImp + sb, L)}`, "", t.book, link);
  return righe.join("\n");
}
// risposta di una voce del menu
async function voceBot(env, c, L, k) { return OR(await voceBot0(env, c, L, k), L, await orari(env)); }
async function voceBot0(env, c, L, k) {
  const t = BT[L], kb = BOT_KB.KB[L], r = await ricBot(env, c);
  if (k === "date") return t.dateAsk;
  if (k === "orari") return [kb.faq[0][1], "", t.addr, `${t.map} ${MAPPA}`].join("\n");
  if (k === "arrivo") return [t.arrT, "", ...kb.arr.map((a) => `${a[0]} ${a[1]}: ${a[2]}`), "", t.addr, `${t.map} ${MAPPA}`].join("\n");
  if (k === "pag") return [t.polT, "", ...kb.pol.map((x) => "• " + x), "", kb.faq[4][1]].join("\n");
  if (k === "faq") return [t.faqT, "", ...kb.faq.map((f) => `• ${f[0]}\n${f[1]}`)].join("\n\n").replace(/\n\n\n/g, "\n\n");
  if (k === "mare") return await mareBot(env, L);
  if (k === "eventi") return eventiBot(L);
  if (k === "consigli") return (await sezioneGuida(env, "dintorni", L)) ? (await sezioneGuida(env, "dintorni", L)) + `\n\n${SITO}/#guida` : `${t.consNone}\n${SITO}/#guida`;
  if (k === "host") { await env.DB.prepare("UPDATE bot_chat SET stato='host' WHERE chat_id=?").bind(String(c.chat_id)).run(); return t.hostAsk; }
  if (k === "wifi") {
    if (!r && !(await ospiteBot(env, c))) return t.wifiPub;
    const rete = await getSet(env, "guida_wifi_rete"), pass = await getSet(env, "guida_wifi_pass");
    return rete ? t.wifiG(rete, pass || "—") : t.wifiNone;
  }
  if (!r) return (await ospiteBot(env, c)) ? "🧪 (prova) Questa voce mostra i dati di una prenotazione vera: guida personale, check-in e pagamenti. Per vederla apri il bot dal pulsante Telegram nella guida di una prenotazione confermata." : t.hi("");
  const ck = await env.DB.prepare("SELECT token, compilato FROM checkin WHERE richiesta_id=?").bind(r.id).first();
  const tok = ck ? ck.token : await creaCheckin(env, r);
  if (k === "guida") {
    const dal = await guidaDal(env, r.arrivo);
    return new Date().toISOString().slice(0, 10) < dal ? t.guideNot(fdBot(dal, L)) : `${t.guide}\n${SITO}/guida.html?t=${tok}&l=${L}`;
  }
  if (k === "ck") return ck && ck.compilato ? t.ckDone : `${t.ckTodo}\n${SITO}/checkin.html?t=${tok}&l=${L}`;
  if (k === "saldo") {
    await tabellaPagamenti(env);
    const P = (await env.DB.prepare("SELECT id, importo, descrizione FROM pagamenti WHERE richiesta_id=? AND stato='da_pagare' ORDER BY creato").bind(r.id).all()).results || [];
    return P.length ? [t.payTodo, ...P.map((p) => `• ${p.descrizione}: ${eurBot(p.importo, L)}\n  ${SITO}/paga.html?t=${p.id}`)].join("\n") : t.payNone;
  }
  return t.hi("");
}
// domande scritte: l'AI risponde solo con i fatti noti, altrimenti si inoltra a Momo
async function aiBot(env, c, L, testo) {
  const r = await ricBot(env, c), kb = BOT_KB.KB.it, g = await guidaDati(env), ora = await orari(env);
  const fatti = [
    "Casalaggiù: casa vacanze a Cutrofiano (Lecce, Salento), Via Roma 13, primo piano. Fino a 4 ospiti: camera con letto alla francese e 2 posti letto nel soppalco. Terrazza. Proprietario/host: Momo.",
    "FAQ:", ...kb.faq.map((f) => `- ${f[0]} ${OR(f[1], "it", ora)}`),
    "Condizioni:", ...kb.pol.map((x) => "- " + x),
    "Come arrivare:", ...kb.arr.map((a) => `- ${a[1]}: ${a[2]}`),
    `Notti minime di base: ${await minNottiBase(env)} (possono cambiare in alcuni periodi).`,
  ];
  const cons = g.pubblicata && g.sezioni.find((s) => s.id === "dintorni");
  if (cons) fatti.push("Consigli dell'host:", cons.x.it || "");
  if (g.pubblicata) for (const s of g.sezioni.filter((x) => ["casa", "servizi"].includes(x.id) && !/\[[^\]]{3,}\]/.test(x.x.it || ""))) fatti.push(`[${s.t.it || ""}] ${s.x.it || ""}`);
  if ((r || (await ospiteBot(env, c))) && g.pubblicata) {
    fatti.push(r ? `L'utente è un ospite con prenotazione confermata dal ${r.arrivo} al ${r.partenza}, ${r.ospiti} ospiti.` : "L'utente è un ospite.", "Guida della casa:");
    for (const s of g.sezioni) fatti.push(`[${s.t.it || ""}] ${s.x.it || ""}`);
    const rete = await getSet(env, "guida_wifi_rete");
    if (rete) fatti.push(`Wi-Fi: rete "${rete}", password "${(await getSet(env, "guida_wifi_pass")) || ""}".`);
  }
  const wa = await getSet(env, "whatsapp");
  if (wa) fatti.push(`WhatsApp dell'host: +${wa}. Sito: ${SITO}`);
  const sys = `You are the friendly assistant of the holiday home Casalaggiù in Salento, chatting on Telegram. Today is ${new Date().toISOString().slice(0, 10)}. Reply in the language of the user's last message (default ${BT[L].ai}). Use ONLY the facts below; never invent prices, availability, codes, passwords, phone numbers or opening hours. Text in square brackets in the facts is a placeholder: treat it as unknown.
Reply with JSON only, one of:
{"tipo":"date","arrivo":"YYYY-MM-DD","partenza":"YYYY-MM-DD","ospiti":2} when the user asks about availability or prices for dates (compute departure from nights if needed; if the year is missing use the next future occurrence; ospiti null if unknown)
{"tipo":"date_chiedi"} when the user asks about availability or prices but gives no usable dates
{"tipo":"mare"} for which sea or beach to choose today, wind, weather at the sea
{"tipo":"eventi"} for festivals, events, sagre
{"tipo":"host"} if the user explicitly wants to talk to the owner or a person
{"tipo":"risposta","testo":"..."} a short, warm answer (max 500 characters, plain text, no markdown) fully supported by the facts
{"tipo":"inoltra"} if the facts don't answer the question, or for complaints, problems in the house, special requests, changes to a booking or anything uncertain.
FACTS:
${fatti.join("\n")}`;
  let raw;
  if (env.AI_TEST_URL) raw = await (await fetch(env.AI_TEST_URL + "/bot", { method: "POST", body: JSON.stringify({ sys, testo }) })).text();
  else {
    if (!env.AI) throw new Error("ai_assente");
    const x = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: [{ role: "system", content: sys }, { role: "user", content: testo.slice(0, 1000) }], max_tokens: 700, temperature: 0.2 });
    raw = x && x.response;
  }
  if (typeof raw !== "string") return raw || { tipo: "inoltra" };
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  return JSON.parse(raw.slice(a, b + 1));
}
async function inoltraBot(env, c, L, msg, testo) {
  const own = await getSet(env, "gb_owner");
  if (!own) return false;
  const r = await ricBot(env, c), f = msg.from || {};
  const chi = [f.first_name, f.last_name].filter(Boolean).join(" ") + (f.username ? ` (@${f.username})` : "");
  const info = r ? `ospite ${r.nome}, ${r.arrivo} → ${r.partenza}` : "non ancora prenotato";
  const x = await inviaBot(env, own, `❓ Domanda da ${chi} · ${info} · lingua ${L.toUpperCase()}\n\n${testo}\n\n↩️ Rispondi a questo messaggio per scrivergli.`);
  if (!x.ok || !x.result) return false;
  await env.DB.prepare("INSERT OR REPLACE INTO bot_fw (msg_id, chat_id, creato) VALUES (?,?,?)").bind(x.result.message_id, String(c.chat_id), new Date().toISOString()).run();
  return true;
}
async function chatBot(env, chatId, from) {
  let c = await env.DB.prepare("SELECT * FROM bot_chat WHERE chat_id=?").bind(String(chatId)).first();
  if (!c) {
    const lc = String((from && from.language_code) || "").slice(0, 2);
    c = { chat_id: String(chatId), lingua: BL.includes(lc) ? lc : "en", richiesta_id: null, nome: (from && from.first_name) || "", stato: null, n: 0, finestra: null };
    await env.DB.prepare("INSERT INTO bot_chat (chat_id, lingua, nome, n, creato, agg) VALUES (?,?,?,0,?,?)").bind(c.chat_id, c.lingua, String(c.nome).slice(0, 60), new Date().toISOString(), new Date().toISOString()).run();
  }
  return c;
}
async function aggiornaBot(env, u) {
  await migra(env);
  await tabelleBot(env);
  const own = await getSet(env, "gb_owner");
  if (u.callback_query) {
    const q = u.callback_query, chat = q.message && q.message.chat.id;
    await tgBot(env, "answerCallbackQuery", { callback_query_id: q.id });
    if (!chat) return;
    const c = await chatBot(env, chat, q.from);
    const d = String(q.data || "");
    if (d.startsWith("lang_") && BL.includes(d.slice(5))) {
      const L = d.slice(5);
      await env.DB.prepare("UPDATE bot_chat SET lingua=?, agg=? WHERE chat_id=?").bind(L, new Date().toISOString(), c.chat_id).run();
      return inviaBot(env, chat, BT[L].langOk, (await menuBot(env, c, L)));
    }
    const L = BL.includes(c.lingua) ? c.lingua : "en";
    if (d === "lingua") return inviaBot(env, chat, BT[L].langAsk, { inline_keyboard: [BL.slice(0, 3).map((l) => ({ text: BT[l].lang, callback_data: "lang_" + l })), BL.slice(3).map((l) => ({ text: BT[l].lang, callback_data: "lang_" + l }))] });
    if (d === "menu") return inviaBot(env, chat, BT[L].hi(c.nome), (await menuBot(env, c, L)));
    if (d.startsWith("g_")) {
      const o = await ospiteBot(env, c), id = d.slice(2);
      const txt = (await sezioniBot(env, L, o)).some((x) => x.id === id) ? await sezioneGuida(env, id, L) : null;
      return inviaBot(env, chat, txt || BT[L].hi(""), { inline_keyboard: [[{ text: BT[L].m.menu, callback_data: "menu" }]] });
    }
    if (!(d in BT.it.m)) return;
    const txt = await voceBot(env, c, L, d);
    return inviaBot(env, chat, txt, d === "host" || d === "date" ? null : { inline_keyboard: [[{ text: BT[L].m.menu, callback_data: "menu" }]] });
  }
  const m = u.message;
  if (!m || !m.chat || m.chat.type !== "private") return;
  const chat = m.chat.id, testo = String(m.text || "").trim();
  // proprietario: le risposte ai messaggi inoltrati vanno all'ospite. /prova = il bot risponde come a un ospite, /fine = torna proprietario
  const isOwn = own && String(chat) === String(own);
  if (isOwn && testo === "/prova") {
    await putSet(env, "gb_prova", "1");
    await inviaBot(env, chat, "🧪 Modalità prova: da ora ti rispondo come a un ospite (menu, domande, preventivi). Le domande che non so risolvere ti arrivano qui come inoltro. Scrivi /fine per tornare proprietario.");
  } else if (isOwn && testo === "/fine") {
    await putSet(env, "gb_prova", null);
    await env.DB.prepare("UPDATE bot_chat SET richiesta_id=NULL, stato=NULL WHERE chat_id=?").bind(String(chat)).run();
    return inviaBot(env, chat, "✓ Modalità prova finita: sei di nuovo il proprietario.");
  }
  if (isOwn && (m.reply_to_message || (await getSet(env, "gb_prova")) !== "1")) {
    if (m.reply_to_message && testo) {
      const fw = await env.DB.prepare("SELECT chat_id FROM bot_fw WHERE msg_id=?").bind(m.reply_to_message.message_id).first();
      if (fw) {
        const g = await env.DB.prepare("SELECT lingua FROM bot_chat WHERE chat_id=?").bind(fw.chat_id).first();
        const L = g && BL.includes(g.lingua) ? g.lingua : "en";
        const x = await inviaBot(env, fw.chat_id, `${BT[L].hostReply} ${testo}`);
        return inviaBot(env, chat, x.ok ? BT.it.ownSent : "⚠️ Non riesco a consegnare il messaggio: " + (x.description || ""));
      }
    }
    if (!testo.startsWith("/start")) return inviaBot(env, chat, BT.it.ownHint);
  }
  const c = await chatBot(env, chat, m.from);
  let L = BL.includes(c.lingua) ? c.lingua : "en";
  if (testo.startsWith("/start")) {
    const p = testo.split(/\s+/)[1] || "";
    const code = await getSet(env, "gb_own_code");
    if (p.startsWith("own_") && code && p === "own_" + code) {
      await putSet(env, "gb_owner", String(chat));
      await putSet(env, "gb_own_code", crypto.randomUUID().replace(/-/g, "").slice(0, 16));
      await env.DB.prepare("UPDATE bot_chat SET lingua='it' WHERE chat_id=?").bind(c.chat_id).run();
      return inviaBot(env, chat, BT.it.ownOk);
    }
    if (/^[a-f0-9]{16}$/.test(p)) {
      await tabellaCheckin(env);
      const ck = await env.DB.prepare("SELECT richiesta_id FROM checkin WHERE token=?").bind(p).first();
      const r = ck && await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(ck.richiesta_id).first();
      if (r && r.stato === "confermata") {
        if (BL.includes(r.lingua)) L = r.lingua;
        await env.DB.prepare("UPDATE bot_chat SET richiesta_id=?, lingua=?, agg=? WHERE chat_id=?").bind(r.id, L, new Date().toISOString(), c.chat_id).run();
        c.richiesta_id = r.id;
        return inviaBot(env, chat, BT[L].hiG(String(r.nome).split(/\s+/)[0], fdBot(r.arrivo, L), fdBot(r.partenza, L)), (await menuBot(env, c, L)));
      }
    }
    return inviaBot(env, chat, BT[L].hi((m.from && m.from.first_name) || ""), (await menuBot(env, c, L)));
  }
  if (testo === "/menu" || testo === "/help" || testo === "/prova") return inviaBot(env, chat, BT[L].hi(c.nome), (await menuBot(env, c, L)));
  if (testo === "/lingua" || testo === "/language") return aggiornaBot(env, { callback_query: { id: "x", data: "lingua", from: m.from, message: { chat: { id: chat } } } });
  if (!testo) return inviaBot(env, chat, BT[L].hi(c.nome), (await menuBot(env, c, L)));
  if (c.stato === "host") {
    await env.DB.prepare("UPDATE bot_chat SET stato=NULL, agg=? WHERE chat_id=?").bind(new Date().toISOString(), c.chat_id).run();
    const ok = await inoltraBot(env, c, L, m, testo);
    return inviaBot(env, chat, ok ? BT[L].hostSent : BT[L].noHost, { inline_keyboard: [[{ text: BT[L].m.menu, callback_data: "menu" }]] });
  }
  // limite: 30 domande all'ora per chat
  const ora = new Date().toISOString().slice(0, 13);
  const n = c.finestra === ora ? (c.n || 0) + 1 : 1;
  await env.DB.prepare("UPDATE bot_chat SET n=?, finestra=?, agg=? WHERE chat_id=?").bind(n, ora, new Date().toISOString(), c.chat_id).run();
  if (n > 30) return n === 31 ? inviaBot(env, chat, BT[L].many) : null;
  await tgBot(env, "sendChatAction", { chat_id: chat, action: "typing" });
  let a;
  try { a = await aiBot(env, c, L, testo); } catch (e) { a = { tipo: "inoltra" }; }
  const torna = { inline_keyboard: [[{ text: BT[L].m.menu, callback_data: "menu" }]] };
  if (a.tipo === "date") return inviaBot(env, chat, await preventivoBot(env, L, String(a.arrivo || ""), String(a.partenza || ""), a.ospiti), torna);
  if (a.tipo === "date_chiedi") return inviaBot(env, chat, BT[L].dateAsk);
  if (a.tipo === "mare") return inviaBot(env, chat, await mareBot(env, L), torna);
  if (a.tipo === "eventi") return inviaBot(env, chat, eventiBot(L), torna);
  if (a.tipo === "host") return inviaBot(env, chat, await voceBot(env, c, L, "host"));
  if (a.tipo === "risposta" && a.testo) return inviaBot(env, chat, String(a.testo).slice(0, 1500), torna);
  const ok = await inoltraBot(env, c, L, m, testo);
  return inviaBot(env, chat, ok ? BT[L].fwd : BT[L].noHost, torna);
}
async function pulisciBot(env) {
  await tabelleBot(env);
  const lim = new Date(Date.now() - 90 * 864e5).toISOString(), lim2 = new Date(Date.now() - 30 * 864e5).toISOString();
  await env.DB.prepare("DELETE FROM bot_chat WHERE agg < ?").bind(lim).run();
  await env.DB.prepare("DELETE FROM bot_fw WHERE creato < ?").bind(lim2).run();
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
  ORA_CAL = await orari(env);
  const occ = (await env.DB.prepare("SELECT o.*, r.ospiti, r.nome, r.contatto, r.telefono, r.messaggio, r.animale FROM occupato o LEFT JOIN richieste r ON r.id = o.richiesta_id ORDER BY o.arrivo").all()).results || [];
  const nuove = (await env.DB.prepare("SELECT * FROM richieste WHERE stato='nuova' ORDER BY arrivo").all()).results || [];
  const ora = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Casalaggiu//Prenotazioni//IT", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Casalaggiù", "X-WR-TIMEZONE:Europe/Rome", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  const ev = (uid, dal, al, titolo, desc, prov) => {
    L.push("BEGIN:VEVENT", `UID:${uid}@casalaggiu.boneggio.it`, `DTSTAMP:${ora}`, `DTSTART;VALUE=DATE:${icData(dal)}`, `DTEND;VALUE=DATE:${icData(al)}`,
      icPiega(`SUMMARY:${icEsc(titolo)}`), icPiega(`DESCRIPTION:${icEsc(desc)}`), "TRANSP:OPAQUE", prov ? "STATUS:TENTATIVE" : "STATUS:CONFIRMED", "END:VEVENT");
  };
  for (const o of occ) {
    if (o.richiesta_id) ev(o.id, o.arrivo, o.partenza, `🏠 ${o.nome || "Ospite"} (${o.ospiti || "?"})${o.animale ? " 🐾" : ""}`, [`Arrivo ${o.arrivo} dalle ${oraF("it", ORA_CAL.in)}, partenza ${o.partenza} entro le ${oraF("it", ORA_CAL.out)}`, o.contatto ? `Contatto: ${o.contatto}${o.telefono ? " · tel. " + o.telefono : ""}` : "", o.messaggio ? `Messaggio: ${o.messaggio}` : ""].filter(Boolean).join("\n"));
    else ev(o.id, o.arrivo, o.partenza, `⛔ ${o.nota || "Date bloccate"}`, `Date bloccate dall'area proprietario. Partenza ${o.partenza}.`);
  }
  for (const r of nuove) ev("q_" + r.id, r.arrivo, r.partenza, `❓ Richiesta: ${r.nome} (${r.ospiti})${r.animale ? " 🐾" : ""}`, `Da confermare nell'area proprietario.\nContatto: ${r.contatto}${r.telefono ? " · tel. " + r.telefono : ""}${r.messaggio ? "\nMessaggio: " + r.messaggio : ""}`, true);
  L.push("END:VCALENDAR");
  return new Response(L.join("\r\n") + "\r\n", { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store", ...CORS } });
}

// ---------- autenticazione proprietario ----------
// Accesso: password (+ codice a 6 cifre dell'app di autenticazione se la verifica in due passaggi è attiva).
// Dopo il login il pannello usa un token di sessione (salvato solo come impronta sha256 nella tabella sessioni, 30 giorni).
async function isAdmin(env, password) {
  const sha = await getSet(env, "admin_sha");
  if (!sha || !password) return false;
  return (await sha256(String(password))) === sha;
}
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32enc(bytes) { let bits = 0, val = 0, out = ""; for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
function b32dec(s) { const out = []; let bits = 0, val = 0; for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, "")) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
async function totp(secret, passo) {
  const key = await crypto.subtle.importKey("raw", b32dec(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8); let x = passo; for (let i = 7; i >= 0; i--) { msg[i] = x & 255; x = Math.floor(x / 256); }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg)), o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}
async function totpValido(secret, codice) {
  const c = String(codice || "").replace(/\D/g, ""), p = Math.floor(Date.now() / 30000);
  if (c.length !== 6 || !secret) return false;
  for (const d of [-1, 0, 1]) if ((await totp(secret, p + d)) === c) return true;
  return false;
}
async function tabellaSessioni(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS sessioni (sha TEXT PRIMARY KEY, creata TEXT NOT NULL, scade TEXT NOT NULL, info TEXT)").run();
}
async function sessioneValida(env, tok) {
  if (!/^[a-f0-9]{48}$/.test(String(tok || ""))) return false;
  await tabellaSessioni(env);
  const r = await env.DB.prepare("SELECT scade FROM sessioni WHERE sha=?").bind(await sha256(tok)).first();
  return !!(r && r.scade > new Date().toISOString());
}
async function nuovaSessione(env, info) {
  await tabellaSessioni(env);
  const tok = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 48);
  const scade = new Date(Date.now() + 30 * 864e5).toISOString();
  await env.DB.prepare("DELETE FROM sessioni WHERE scade < ?").bind(new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO sessioni (sha, creata, scade, info) VALUES (?,?,?,?)").bind(await sha256(tok), new Date().toISOString(), scade, String(info || "").slice(0, 120)).run();
  return tok;
}
const due2fa = async (env) => (await getSet(env, "totp_on")) === "1" && !!(await getSet(env, "totp_secret"));
// codici di emergenza (se perdi il telefono): 8 codici monouso, salvati come impronta
async function codiceEmergenza(env, codice) {
  const c = String(codice || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 10) return false;
  let L = []; try { L = JSON.parse((await getSet(env, "totp_backup")) || "[]"); } catch (e) { L = []; }
  const h = await sha256(c), i = L.indexOf(h);
  if (i < 0) return false;
  L.splice(i, 1); await putSet(env, "totp_backup", JSON.stringify(L));
  return true;
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
  try { await env.DB.prepare("ALTER TABLE richieste ADD COLUMN guida_inviata TEXT").run(); } catch (e) { /* già presente */ }
  try { await env.DB.prepare("ALTER TABLE richieste ADD COLUMN cf TEXT").run(); } catch (e) { /* già presente */ }
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
    const animale = body.animale && (await getSet(env, "pet_on")) !== "0" ? 1 : 0;
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
    // codice fiscale dell'intestatario (facoltativo): serve solo per la ricevuta, resta sulla prenotazione
    const cf = String(body.cf || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cf && !/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(cf)) return json({ ok: false, errore: "campo", ospite: 0, campo: "cf" }, 400);
    await env.DB.prepare("UPDATE richieste SET cf=? WHERE id=?").bind(cf || null, ric.id).run();
    const prima = !ck.compilato;
    await env.DB.prepare("UPDATE checkin SET compilato=?, dati=?, istat=?, cancellato=NULL WHERE token=?").bind(new Date().toISOString(), JSON.stringify({ tipo: v.tipo, ospiti: v.ospiti }), JSON.stringify(v.istat), t).run();
    ctx.waitUntil(telegram(env, `🪪 Check-in ${prima ? "compilato" : "aggiornato"}: ${ric.nome}, ${ric.arrivo} → ${ric.partenza}, ${v.ospiti.length} ${v.ospiti.length === 1 ? "ospite" : "ospiti"}. I dati sono nel pannello admin.`));
    return json({ ok: true });
  }

  if (a === "recensione") {
    // l'ospite lascia la recensione dal link ricevuto per email (una sola per prenotazione)
    const x = await recensionePerToken(env, body.t);
    if (!x) return json({ ok: false, errore: "non_trovato" }, 404);
    if (x.gia) return json({ ok: false, errore: "gia" }, 409);
    if (x.presto) return json({ ok: false, errore: "presto" }, 403);
    if (x.scaduto) return json({ ok: false, errore: "scaduto" }, 410);
    const stelle = Math.round(Number(body.stelle));
    const testo = testoRec(body.testo, 1500), nome = clean(body.nome, 40) || String(x.ric.nome || "").trim().split(/\s+/)[0];
    if (!(stelle >= 1 && stelle <= 5)) return json({ ok: false, errore: "stelle" }, 400);
    if (testo.length < 10) return json({ ok: false, errore: "testo" }, 400);
    const lingua = ["it", "en", "de", "nl", "es", "fr"].includes(body.lingua) ? body.lingua : (x.ric.lingua || "it");
    await env.DB.prepare("INSERT INTO recensioni (id, richiesta_id, creata, nome, stelle, testo, lingua, mese, stato) VALUES (?,?,?,?,?,?,?,?, 'attesa')").bind(crypto.randomUUID().replace(/-/g, "").slice(0, 16), x.ric.id, new Date().toISOString(), nome, stelle, testo, lingua, String(x.ric.partenza || "").slice(0, 7)).run();
    ctx.waitUntil(telegram(env, `⭐ Nuova recensione da ${nome} (${"★".repeat(stelle)}${"☆".repeat(5 - stelle)}):\n«${testo.slice(0, 300)}${testo.length > 300 ? "…" : ""}»\nPubblicala dal pannello admin → Recensioni.`));
    return json({ ok: true });
  }

  if (a === "guida_pin") {
    // QR in casa: l'ospite inserisce il PIN e riceve la chiave della guida (max 10 tentativi sbagliati all'ora)
    const pinOk = await getSet(env, "guida_pin");
    let f = {};
    try { f = JSON.parse((await getSet(env, "guida_fail")) || "{}"); } catch (e) { f = {}; }
    if (!f.t || Date.now() - f.t > 3600e3) f = { n: 0, t: Date.now() };
    if (f.n >= 10) return json({ ok: false, errore: "troppe" }, 429);
    const pin = String(body.pin || "").replace(/\D/g, "");
    if (!pinOk || pin !== pinOk) {
      f.n++; await putSet(env, "guida_fail", JSON.stringify(f));
      await new Promise((r) => setTimeout(r, 600));
      return json({ ok: false, errore: pinOk ? "pin" : "non_attiva" }, 403);
    }
    if (!(await guidaDati(env)).pubblicata) return json({ ok: false, errore: "non_pronta" }, 403);
    return json({ ok: true, k: await guidaChiave(env, "guida_k") });
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

  if (a === "login") {
    // massimo 10 tentativi sbagliati ogni 15 minuti
    let f = {};
    try { f = JSON.parse((await getSet(env, "login_fail")) || "{}"); } catch (e) { f = {}; }
    if (!f.t || Date.now() - f.t > 15 * 60e3) f = { n: 0, t: Date.now() };
    if (f.n >= 10) return json({ ok: false, errore: "troppi_tentativi" }, 429);
    const sbagliato = async (errore) => { f.n++; await putSet(env, "login_fail", JSON.stringify(f)); await new Promise((r) => setTimeout(r, 800)); return json({ ok: false, errore }, 403); };
    if (!(await isAdmin(env, body.password))) return sbagliato("password");
    if (await due2fa(env)) {
      if (!body.codice) return json({ ok: false, errore: "codice_richiesto" }, 403);
      const ok = (await totpValido(await getSet(env, "totp_secret"), body.codice)) || (await codiceEmergenza(env, body.codice));
      if (!ok) return sbagliato("codice");
    }
    await putSet(env, "login_fail", null);
    return json({ ok: true, sessione: await nuovaSessione(env, clean(body.info, 120)) });
  }

  // da qui in poi: solo proprietario (token di sessione; la sola password vale finché la verifica in due passaggi è spenta)
  const okSess = await sessioneValida(env, body.sessione);
  if (!okSess && ((await due2fa(env)) || !(await isAdmin(env, body.password)))) {
    await new Promise((r) => setTimeout(r, 500));
    return json({ ok: false, errore: body.sessione ? "sessione" : "password" }, 403);
  }

  if (a === "admin_2fa") {
    let L = []; try { L = JSON.parse((await getSet(env, "totp_backup")) || "[]"); } catch (e) { L = []; }
    return json({ ok: true, attiva: await due2fa(env), emergenza: L.length });
  }
  if (a === "admin_2fa_nuovo") {
    const sec = b32enc(crypto.getRandomValues(new Uint8Array(20)));
    await putSet(env, "totp_pending", sec);
    return json({ ok: true, segreto: sec, uri: `otpauth://totp/Casalaggi%C3%B9:admin?secret=${sec}&issuer=Casalaggi%C3%B9&digits=6&period=30` });
  }
  if (a === "admin_2fa_attiva") {
    const sec = await getSet(env, "totp_pending");
    if (!sec || !(await totpValido(sec, body.codice))) return json({ ok: false, errore: "codice" }, 400);
    const cod = [], hs = [];
    for (let i = 0; i < 8; i++) { const c = b32enc(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10); cod.push(c); hs.push(await sha256(c)); }
    await putSet(env, "totp_secret", sec); await putSet(env, "totp_pending", null); await putSet(env, "totp_on", "1");
    await putSet(env, "totp_backup", JSON.stringify(hs));
    return json({ ok: true, emergenza: cod.map((c) => c.slice(0, 5) + "-" + c.slice(5)) });
  }
  if (a === "admin_2fa_disattiva") {
    if (!(await totpValido(await getSet(env, "totp_secret"), body.codice))) return json({ ok: false, errore: "codice" }, 400);
    for (const k of ["totp_on", "totp_secret", "totp_backup", "totp_pending"]) await putSet(env, k, null);
    return json({ ok: true });
  }
  if (a === "admin_esci_tutti") {
    await tabellaSessioni(env);
    await env.DB.prepare("DELETE FROM sessioni").run();
    return json({ ok: true });
  }
  if (a === "admin_esci") {
    if (body.sessione) { await tabellaSessioni(env); await env.DB.prepare("DELETE FROM sessioni WHERE sha=?").bind(await sha256(String(body.sessione))).run(); }
    return json({ ok: true });
  }

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
      impostazioni: { perche: await percheDati(env), ora: await orari(env), pet_on: (await getSet(env, "pet_on")) !== "0", iban: await getSet(env, "iban"), beneficiario: await getSet(env, "beneficiario"), supplemento_pet: Number(await getSet(env, "supplemento_pet")) || 0, prezzi_ospiti: (await getSet(env, "prezzi_ospiti")) === "1", min_notti: await minNottiBase(env), ical: await icalToken(env), locatore: await locatore(env), whatsapp: await getSet(env, "whatsapp"), guida: (await guidaDati(env)).pubblicata, tg_bot: await getSet(env, "gb_user") },
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

  if (a === "admin_prezzo_aggiungi" || a === "admin_prezzo_modifica") {
    // dal = primo giorno, al = giorno di partenza (non conteggiato): un periodo può iniziare il giorno in cui finisce il precedente
    const modId = a === "admin_prezzo_modifica" ? clean(body.id, 30) : null;
    if (modId && !(await env.DB.prepare("SELECT id FROM prezzi WHERE id=?").bind(modId).first())) return json({ ok: false, errore: "non_trovato" }, 404);
    const dal = String(body.dal || ""), al = String(body.al || "");
    let prezzo = Math.round(Number(body.prezzo) * 100) / 100;
    if (!DATE.test(dal) || !DATE.test(al) || al <= dal) return json({ ok: false, errore: "date" }, 400);
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
    const c = await env.DB.prepare("SELECT dal, al FROM prezzi WHERE dal < ? AND al > ? AND id <> ? LIMIT 1").bind(al, dal, modId || "").first();
    if (c) return json({ ok: false, errore: "periodo_sovrapposto", con: c }, 409);
    const mn = minValido(body.min_notti);
    if (mn === undefined) return json({ ok: false, errore: "min_notti" }, 400);
    const sv = supValido(body.sup_brevi);
    if (sv === undefined) return json({ ok: false, errore: "sup_brevi" }, 400);
    if (modId) await env.DB.prepare("UPDATE prezzi SET dal=?, al=?, prezzo=?, nota=?, tipo=?, per_ospiti=?, min_notti=?, sup_brevi=? WHERE id=?").bind(dal, al, prezzo, clean(body.nota, 80), tipo, perOsp, mn, sv, modId).run();
    else await env.DB.prepare("INSERT INTO prezzi (id,dal,al,prezzo,nota,tipo,per_ospiti,min_notti,sup_brevi) VALUES (?,?,?,?,?,?,?,?,?)").bind("p_" + uid(), dal, al, prezzo, clean(body.nota, 80), tipo, perOsp, mn, sv).run();
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

  // ---------- etichette in casa (QR / NFC) ----------
  if (a === "admin_etichette") return json({ ok: true, etichette: await etichetteDati(env), rifiuti: await rifiutiDati(env), base: "https://casalaggiu.it/i/?t=" });
  if (a === "admin_etichetta_salva") {
    const L = await etichetteDati(env), x = body.e || {};
    let id = slugEt(x.id), vecchia = id ? L.find((z) => z.id === id) : null;
    if (id && !vecchia) return json({ ok: false, errore: "non_trovato" }, 404);
    const e = pulisciEtichetta(x, vecchia);
    if (!e.t.it) return json({ ok: false, errore: "nome" }, 400);
    if (!vecchia) {
      // l'indirizzo nasce dal nome italiano e poi non cambia più (QR e NFC già stampati)
      const b = slugEt(x.slug || e.t.it) || "oggetto";
      id = b; let n = 2; while (L.some((z) => z.id === id)) id = `${b}-${n++}`;
      if (L.length >= 60) return json({ ok: false, errore: "troppe" }, 400);
    }
    // le traduzioni scritte a mano (lingua diversa dall'automatico) restano finché l'italiano non cambia
    let errori = [];
    try { errori = await traduciEtichetta(env, e, !!body.ritraduci); } catch (er) { errori = Object.keys(LINGUE_GUIDA); }
    const finale = { id, ...e, agg: new Date().toISOString() };
    if (vecchia) L[L.indexOf(vecchia)] = finale; else L.push(finale);
    await putSet(env, "etichette", JSON.stringify(L));
    return json({ ok: true, e: finale, errori });
  }
  if (a === "admin_etichetta_testi") {
    // correzione a mano di una traduzione: non viene più sovrascritta finché l'italiano resta uguale
    const L = await etichetteDati(env), e = L.find((z) => z.id === slugEt(body.id)), l = String(body.lingua || "");
    if (!e) return json({ ok: false, errore: "non_trovato" }, 404);
    if (!LINGUE_GUIDA[l]) return json({ ok: false, errore: "lingua" }, 400);
    const t = String(body.t || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60), xx = String(body.x || "").replace(/\r/g, "").slice(0, 4000);
    if (t) e.t[l] = t; else delete e.t[l];
    if (xx.trim()) e.x[l] = xx; else delete e.x[l];
    e.tr[l] = await impronta(e); e.agg = new Date().toISOString();
    await putSet(env, "etichette", JSON.stringify(L));
    return json({ ok: true, e });
  }
  if (a === "admin_etichetta_elimina") {
    const L = (await etichetteDati(env)).filter((z) => z.id !== slugEt(body.id));
    await putSet(env, "etichette", JSON.stringify(L));
    return json({ ok: true });
  }
  if (a === "admin_etichette_ordine") {
    const L = await etichetteDati(env), ord = (Array.isArray(body.ids) ? body.ids : []).map(slugEt);
    L.sort((p, q) => (ord.indexOf(p.id) + 1 || 999) - (ord.indexOf(q.id) + 1 || 999));
    await putSet(env, "etichette", JSON.stringify(L));
    return json({ ok: true });
  }
  if (a === "admin_rifiuti_salva") {
    const r = pulisciRifiuti(body.rifiuti || {});
    await putSet(env, "rifiuti", JSON.stringify(r));
    return json({ ok: true, rifiuti: r });
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
  if (a === "admin_sumup_movimenti") {
    // transazioni e versamenti in banca letti da SumUp (il saldo non è disponibile nelle API: lo stima il pannello)
    const key = await getSet(env, "sumup_key"), mc = await getSet(env, "sumup_merchant");
    if (!key || !mc) return json({ ok: false, errore: "non_configurato" }, 400);
    const oggi = new Date().toISOString().slice(0, 10);
    let da = DATE.test(body.da || "") ? body.da : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    let al = DATE.test(body.a || "") ? body.a : oggi;
    if (al < da) [da, al] = [al, da];
    const H = { Authorization: "Bearer " + key }, base = sumupApi(env);
    const dopo = new Date(Date.parse(al + "T00:00:00Z") + 864e5).toISOString().slice(0, 19) + "Z";
    const out = { ok: true, da, a: al, transazioni: [], versamenti: [], errori: {} };
    try {
      let url = `${base}/v2.1/merchants/${encodeURIComponent(mc)}/transactions/history?order=descending&limit=100&oldest_time=${encodeURIComponent(da + "T00:00:00Z")}&newest_time=${encodeURIComponent(dopo)}`;
      for (let pag = 0; pag < 5 && url; pag++) {
        const r = await fetch(url, { headers: H });
        if (!r.ok) { out.errori.transazioni = r.status; break; }
        const d = await r.json();
        for (const t of d.items || []) out.transazioni.push({ id: t.id || "", codice: t.transaction_code || "", data: t.timestamp || "", importo: Number(t.amount) || 0, valuta: t.currency || "EUR", stato: t.status || "", tipo: t.type || "", pagamento: t.payment_type || "", carta: t.card_type || "" });
        const nx = (d.links || []).find((l) => l.rel === "next");
        const q = nx && nx.href && nx.href.includes("?") ? nx.href.slice(nx.href.indexOf("?")) : "";
        url = q ? `${base}/v2.1/merchants/${encodeURIComponent(mc)}/transactions/history${q}` : null;
      }
    } catch (e) { out.errori.transazioni = "rete"; }
    try {
      const r = await fetch(`${base}/v1.0/merchants/${encodeURIComponent(mc)}/payouts?start_date=${da}&end_date=${al}&order=desc&limit=500&format=json`, { headers: H });
      if (!r.ok) out.errori.versamenti = r.status;
      else for (const v of (await r.json()) || []) out.versamenti.push({ id: v.id, data: v.date || "", importo: Number(v.amount) || 0, commissione: Number(v.fee) || 0, tipo: v.type || "", stato: v.status || "", riferimento: v.reference || "", codice: v.transaction_code || "" });
    } catch (e) { out.errori.versamenti = "rete"; }
    // collega le transazioni alle prenotazioni di Casalaggiù
    await tabellaPagamenti(env);
    const pg = (await env.DB.prepare("SELECT p.transazione, p.descrizione, r.nome, r.arrivo FROM pagamenti p LEFT JOIN richieste r ON r.id=p.richiesta_id WHERE p.transazione IS NOT NULL").all()).results || [];
    const M = new Map(pg.map((x) => [x.transazione, x]));
    for (const t of out.transazioni) { const x = M.get(t.id); if (x) t.prenotazione = x.nome ? `${x.nome}${x.arrivo ? " · " + x.arrivo : ""}` : x.descrizione; }
    return json(out);
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
  if (a === "admin_guida") {
    const g = await guidaDati(env);
    return json({ ok: true, guida: g, wifi: { rete: await getSet(env, "guida_wifi_rete"), pass: await getSet(env, "guida_wifi_pass") }, pin: await getSet(env, "guida_pin"), ak: await guidaChiave(env, "guida_ak"), ai: !!(env.AI || env.AI_TEST_URL), auto: (await getSet(env, "guida_auto")) !== "0", giorni: parseInt(await getSet(env, "guida_giorni"), 10) || 3, dal: Number.isNaN(parseInt(await getSet(env, "guida_dal"), 10)) ? 7 : parseInt(await getSet(env, "guida_dal"), 10) });
  }
  if (a === "admin_guida_invio") {
    await putSet(env, "guida_auto", body.auto ? "1" : "0");
    await putSet(env, "guida_giorni", String(Math.min(7, Math.max(1, parseInt(body.giorni, 10) || 3))));
    return json({ ok: true });
  }
  if (a === "admin_orari_salva") {
    const re = /^([01]\d|2[0-3]):[0-5]\d$/, ni = String(body.in || ""), no = String(body.out || "");
    if (!re.test(ni) || !re.test(no)) return json({ ok: false, errore: "orario" }, 400);
    // prima volta: nella guida c'erano gli orari storici 14:00 / 10:00
    const old = { in: (await getSet(env, "ora_in")) || "14:00", out: (await getSet(env, "ora_out")) || "10:00" };
    await putSet(env, "ora_in", ni); await putSet(env, "ora_out", no);
    // aggiorna anche gli orari scritti nella guida della casa (stesso formato hh:mm)
    let guida = 0;
    const gtxt = await getSet(env, "guida");
    if (gtxt) {
      let g2 = gtxt;
      if (old.in !== ni) g2 = g2.split(old.in).join(ni);
      if (old.out !== no) g2 = g2.split(old.out).join(no);
      if (g2 !== gtxt) { await putSet(env, "guida", g2); guida = 1; }
    }
    return json({ ok: true, ora: { in: ni, out: no }, guida });
  }
  if (a === "admin_perche_salva") {
    if (body.ripristina) { await putSet(env, "perche", null); return json({ ok: true }); }
    const titolo = clean(body.titolo, 60), voci = (Array.isArray(body.voci) ? body.voci : []).map((v) => clean(v, 140)).filter(Boolean).slice(0, 6);
    if (!titolo || !voci.length) return json({ ok: false, errore: "perche_vuoto" }, 400);
    const out = { it: { t: titolo, v: voci } }, errori = [];
    const items = [{ id: "t", t: { it: titolo }, x: { it: "" } }, ...voci.map((v, i) => ({ id: "v" + i, t: { it: v }, x: { it: "" } }))];
    await Promise.all(Object.keys(LINGUE_GUIDA).map(async (l) => {
      try {
        const m = await traduciBlocco(env, l, items), tt = m.get("t");
        const vv = voci.map((_, i) => { const x = m.get("v" + i); return x && x.t ? clean(x.t, 180) : null; });
        if (tt && tt.t && vv.every(Boolean)) out[l] = { t: clean(tt.t, 80), v: vv }; else errori.push(l);
      } catch (e) { errori.push(l); }
    }));
    await putSet(env, "perche", JSON.stringify(out));
    return json({ ok: true, errori, perche: out });
  }
  if (a === "admin_recensioni") {
    await tabellaRecensioni(env);
    const L = await env.DB.prepare("SELECT v.*, r.arrivo, r.partenza, r.nome AS nome_pren, r.contatto FROM recensioni v LEFT JOIN richieste r ON r.id = v.richiesta_id ORDER BY v.creata DESC").all();
    const oggi = new Date().toISOString().slice(0, 10);
    const P = await env.DB.prepare("SELECT id, nome, contatto, arrivo, partenza, rec_inviata FROM richieste WHERE stato='confermata' AND partenza <= ? AND partenza >= ? AND id NOT IN (SELECT richiesta_id FROM recensioni) ORDER BY partenza DESC").bind(piuGiorni(oggi, 1), piuGiorni(oggi, -120)).all();
    return json({ ok: true, auto: (await getSet(env, "rec_auto")) !== "0", email: !!(await getSet(env, "resend_key")), recensioni: L.results || [], senza: P.results || [] });
  }
  if (a === "admin_recensioni_auto") {
    await putSet(env, "rec_auto", body.auto ? null : "0");
    return json({ ok: true });
  }
  if (a === "admin_recensione_stato") {
    await tabellaRecensioni(env);
    const st = ["attesa", "pubblicata", "nascosta"].includes(body.stato) ? body.stato : null;
    if (!st) return json({ ok: false, errore: "stato" }, 400);
    await env.DB.prepare("UPDATE recensioni SET stato=? WHERE id=?").bind(st, clean(body.id, 20)).run();
    return json({ ok: true });
  }
  if (a === "admin_recensione_elimina") {
    await tabellaRecensioni(env);
    await env.DB.prepare("DELETE FROM recensioni WHERE id=?").bind(clean(body.id, 20)).run();
    return json({ ok: true });
  }
  if (a === "admin_recensione_invia") {
    const r = await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(clean(body.id, 20)).first();
    if (!r || r.stato !== "confermata") return json({ ok: false, errore: "non_trovata" }, 404);
    const x = await emailRecensione(env, r);
    return json(x, x.ok ? 200 : 400);
  }
  if (a === "admin_recensione_link") {
    const r = await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(clean(body.id, 20)).first();
    if (!r || r.stato !== "confermata") return json({ ok: false, errore: "non_trovata" }, 404);
    return json({ ok: true, link: `${SITO}/recensione.html?t=${await creaCheckin(env, r)}` });
  }
  if (a === "admin_guida_invia_ora") {
    const r = await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(clean(body.id, 20)).first();
    if (!r || r.stato !== "confermata") return json({ ok: false, errore: "non_trovata" }, 404);
    const x = await emailGuida(env, r);
    return json(x, x.ok ? 200 : 400);
  }
  if (a === "admin_guida_salva") {
    const sezioni = pulisciSezioni(body.sezioni);
    if (!sezioni.length) return json({ ok: false, errore: "guida_vuota" }, 400);
    const g = { pubblicata: !!body.pubblicata, sezioni };
    let errori = [];
    if (body.traduci) errori = await traduciGuida(env, sezioni, body.traduci === "tutto");
    await putSet(env, "guida", JSON.stringify(g));
    return json({ ok: true, guida: g, errori_traduzione: errori });
  }
  if (a === "admin_guida_accesso") {
    const rete = clean(body.rete, 64), pass = String(body.pass ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
    const pin = String(body.pin || "").trim();
    if (pin && !/^\d{4,8}$/.test(pin)) return json({ ok: false, errore: "pin_formato" }, 400);
    await putSet(env, "guida_wifi_rete", rete || null);
    await putSet(env, "guida_wifi_pass", pass || null);
    if ("dal" in body) { const d = parseInt(body.dal, 10); await putSet(env, "guida_dal", String(d >= 0 && d <= 60 ? d : 7)); }
    if (pin !== ((await getSet(env, "guida_pin")) || "")) {
      await putSet(env, "guida_pin", pin || null);
      await putSet(env, "guida_k", null); // i telefoni che avevano il vecchio PIN devono reinserirlo
      await putSet(env, "guida_fail", null);
    }
    return json({ ok: true });
  }
  if (a === "admin_gbot") {
    return json({ ok: true, attivo: !!(await getSet(env, "gb_token")), user: await getSet(env, "gb_user"), owner: !!(await getSet(env, "gb_owner")), code: await getSet(env, "gb_own_code"), ai: !!(env.AI || env.AI_TEST_URL) });
  }
  if (a === "admin_gbot_token") {
    const tok = String(body.token || "").trim();
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(tok)) return json({ ok: false, errore: "token_formato" }, 400);
    if (tok === (await getSet(env, "tg_token"))) return json({ ok: false, errore: "token_avvisi" }, 400);
    await putSet(env, "gb_token", tok);
    const me = await tgBot(env, "getMe");
    if (!me.ok) { await putSet(env, "gb_token", null); return json({ ok: false, errore: "token_telegram", dettaglio: me.description }, 400); }
    const sec = crypto.randomUUID().replace(/-/g, "");
    await putSet(env, "gb_user", me.result.username);
    await putSet(env, "gb_secret", sec);
    if (!(await getSet(env, "gb_own_code"))) await putSet(env, "gb_own_code", crypto.randomUUID().replace(/-/g, "").slice(0, 16));
    const wh = await tgBot(env, "setWebhook", { url: (env.WORKER_URL || "https://casalaggiu.maurizio-covarelli.workers.dev") + "/tg", secret_token: sec, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    if (!wh.ok) return json({ ok: false, errore: "webhook", dettaglio: wh.description }, 400);
    for (const l of BL) await tgBot(env, "setMyCommands", { commands: [{ command: "menu", description: BT[l].m.menu.replace(/^\S+\s/, "") }, { command: "lingua", description: BT[l].m.lingua.replace(/^\S+\s/, "") }], ...(l === "it" ? {} : { language_code: l }) });
    return json({ ok: true, user: me.result.username });
  }
  if (a === "admin_gbot_scollega") {
    await tgBot(env, "deleteWebhook", { drop_pending_updates: true });
    for (const k of ["gb_token", "gb_user", "gb_secret", "gb_owner"]) await putSet(env, k, null);
    return json({ ok: true });
  }
  if (a === "admin_gbot_owner_reset") {
    await putSet(env, "gb_owner", null);
    await putSet(env, "gb_own_code", crypto.randomUUID().replace(/-/g, "").slice(0, 16));
    return json({ ok: true });
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
    return json({ ok: true, regole: await regoleSconti(env, true), codici: (await env.DB.prepare("SELECT * FROM codici ORDER BY creato DESC").all()).results || [] });
  }
  if (a === "admin_sconti_regole") {
    const v = (x, max) => { const n = Math.round(Number(x) || 0); return n >= 0 && n <= max ? n : null; };
    const vals = { sc_lungo_pct: v(body.lungo_pct, 90), sc_lungo_notti: v(body.lungo_notti, 90), sc_lm_pct: v(body.lm_pct, 90), sc_lm_giorni: v(body.lm_giorni, 120) };
    if (Object.values(vals).some((x) => x === null)) return json({ ok: false, errore: "sconto" }, 400);
    for (const k in vals) await putSet(env, k, vals[k] ? String(vals[k]) : null);
    if ("lungo_on" in body) await putSet(env, "sc_lungo_on", body.lungo_on ? null : "0");
    if ("lm_on" in body) await putSet(env, "sc_lm_on", body.lm_on ? null : "0");
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
    if ("pet_on" in body) await putSet(env, "pet_on", body.pet_on ? null : "0");
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(invioGuideAutomatico(env));
    ctx.waitUntil(invioRecensioniAuto(env).catch(() => {}));
    ctx.waitUntil(pulisciBot(env).catch(() => {}));
  },
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
          const r = await env.DB.prepare("SELECT dal, al, prezzo, nota, tipo, per_ospiti, min_notti, sup_brevi FROM prezzi WHERE al > ? ORDER BY dal").bind(oggi).all();
          return json({ ok: true, prezzi: r.results, animali: (await getSet(env, "pet_on")) !== "0", supplemento_pet: Number(await getSet(env, "supplemento_pet")) || 0, prezzi_ospiti: (await getSet(env, "prezzi_ospiti")) === "1", servizi: await serviziAttivi(env), sconti: await regoleSconti(env), perche: await percheDati(env), ora: await orari(env), whatsapp: await getSet(env, "whatsapp"), telegram: await getSet(env, "gb_user"), min_notti: await minNottiBase(env) });
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
        if (action === "etichetta") {
          const t = slugEt(url.searchParams.get("t"));
          const e = (await etichetteDati(env)).find((z) => z.id === t);
          if (!e) return json({ ok: false, errore: "non_trovato" }, 404);
          const out = { ok: true, e: etichettaPubblica(e), guida: !!(await guidaDati(env)).pubblicata };
          if (e.rifiuti) { const r = await rifiutiDati(env); const oggi = new Date().toISOString().slice(0, 10); out.rifiuti = { sere: r.sere, eccezioni: r.eccezioni.filter((z) => z.d >= piuGiorni(oggi, -1)).slice(0, 20) }; }
          return json(out);
        }
        if (action === "checkin") {
          const t = String(url.searchParams.get("t") || "");
          if (!/^[a-f0-9]{16}$/.test(t)) return json({ ok: false, errore: "non_trovato" }, 404);
          await migra(env);
          await tabellaCheckin(env);
          const ck = await env.DB.prepare("SELECT * FROM checkin WHERE token=?").bind(t).first();
          const ric = ck && await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(ck.richiesta_id).first();
          if (!ck || !ric || ric.stato !== "confermata") return json({ ok: false, errore: "non_trovato" }, 404);
          return json({ ok: true, arrivo: ck.arrivo, partenza: ck.partenza, ospiti: ric.ospiti, lingua: ric.lingua, nome: String(ric.nome || "").split(/\s+/)[0], compilato: !!ck.compilato, cf: ric.cf || "", scaduto: ck.partenza < new Date().toISOString().slice(0, 10) });
        }
        if (action === "guida") {
          await migra(env);
          const t = String(url.searchParams.get("t") || ""), k = String(url.searchParams.get("k") || ""), ak = String(url.searchParams.get("a") || "");
          const g = await guidaDati(env);
          if (ak) {
            if (!/^[a-f0-9]{32}$/.test(ak) || ak !== (await getSet(env, "guida_ak"))) return json({ ok: false, errore: "non_trovato" }, 404);
            return json(await guidaPerOspite(env, { anteprima: true, pubblicata: g.pubblicata }));
          }
          if (k) {
            if (!/^[a-f0-9]{32}$/.test(k) || k !== (await getSet(env, "guida_k")) || !(await getSet(env, "guida_pin"))) return json({ ok: false, errore: "chiave" }, 403);
            if (!g.pubblicata) return json({ ok: false, errore: "non_pronta" }, 403);
            return json(await guidaPerOspite(env, {}));
          }
          if (!/^[a-f0-9]{16}$/.test(t)) return json({ ok: false, errore: "non_trovato" }, 404);
          await tabellaCheckin(env);
          const ck = await env.DB.prepare("SELECT * FROM checkin WHERE token=?").bind(t).first();
          const ric = ck && await env.DB.prepare("SELECT * FROM richieste WHERE id=?").bind(ck.richiesta_id).first();
          if (!ck || !ric || ric.stato !== "confermata") return json({ ok: false, errore: "non_trovato" }, 404);
          const oggi = new Date().toISOString().slice(0, 10), dal = await guidaDal(env, ck.arrivo), al = piuGiorni(ck.partenza, 2);
          const chi = { nome: String(ric.nome || "").split(/\s+/)[0], lingua: ric.lingua, arrivo: ck.arrivo, partenza: ck.partenza };
          if (!g.pubblicata) return json({ ok: false, errore: "non_pronta", ...chi }, 403);
          if (oggi < dal) return json({ ok: false, errore: "presto", dal, ...chi }, 403);
          if (oggi > al) return json({ ok: false, errore: "scaduto", ...chi }, 410);
          return json(await guidaPerOspite(env, { ...chi, checkin: ck.compilato ? null : t }));
        }
        if (action === "recensione") {
          const x = await recensionePerToken(env, url.searchParams.get("t"));
          if (!x) return json({ ok: false, errore: "non_trovato" }, 404);
          return json({ ok: true, nome: String(x.ric.nome || "").trim().split(/\s+/)[0], lingua: x.ric.lingua, arrivo: x.ric.arrivo, partenza: x.ric.partenza, gia: x.gia ? { stelle: x.gia.stelle, testo: x.gia.testo, nome: x.gia.nome } : null, presto: x.presto, scaduto: x.scaduto });
        }
        if (action === "recensioni") {
          await tabellaRecensioni(env);
          const L = await env.DB.prepare("SELECT nome, stelle, testo, lingua, mese FROM recensioni WHERE stato='pubblicata' ORDER BY creata DESC LIMIT 60").all();
          const lista = L.results || [], media = lista.length ? Math.round(lista.reduce((t, r) => t + r.stelle, 0) / lista.length * 10) / 10 : 0;
          return new Response(JSON.stringify({ ok: true, n: lista.length, media, lista }), { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" } });
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
      if (request.method === "POST" && url.pathname === "/tg") {
        const sec = await getSet(env, "gb_secret");
        if (!sec || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== sec) return new Response("no", { status: 403 });
        let u = null;
        try { u = await request.json(); } catch (e) { u = null; }
        if (u) ctx.waitUntil(aggiornaBot(env, u).catch(() => {}));
        return new Response("ok");
      }
      if (request.method === "POST") {
        const text = await request.text();
        if (text.length > 120000) return json({ ok: false, errore: "troppo_grande" }, 413);
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
