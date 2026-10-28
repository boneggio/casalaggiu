// Casalaggiù · generatore delle pagine statiche
// Lanciato da .github/workflows/build.yml a ogni modifica (oppure a mano: node tools/build.mjs)
// Crea: /en/ /de/ /nl/ /es/ /fr/ (copie di index.html nella lingua giusta),
//       le pagine della "Guida al Salento" in 6 lingue, sitemap.xml.
// Fonte unica dei testi: index.html (oggetti T, GUIDE, EVENTS, NIGHT, META, GP) + tools/pagine.json.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SITE = "https://casalaggiu.it";
const rd = f => fs.readFileSync(path.join(ROOT, f), "utf8");
let written = 0;
function out(f, s) {
  const p = path.join(ROOT, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p) && fs.readFileSync(p, "utf8") === s) return;
  fs.writeFileSync(p, s); written++; console.log("scritto", f);
}

const INDEX = rd("index.html");
// --- dati da index.html: tutto ciò che sta tra "const CONFIG=" e "let lang=" sono solo dati
const a = INDEX.indexOf("const CONFIG="), b = INDEX.indexOf("\nlet lang=");
if (a < 0 || b < 0) throw new Error("index.html: blocco dati non trovato");
if (!INDEX.includes("const META=")) { console.log("index.html senza META: pagine non generate"); process.exit(0); }
const ctx = {}; vm.createContext(ctx);
vm.runInContext(INDEX.slice(a, b) + ";this.D={T,GUIDE,EVENTS,NIGHT,META,GP,GPT,SEA_T,AIR_T,LANGS}", ctx);
const { T, GUIDE, EVENTS, NIGHT, META, GP, GPT, SEA_T, AIR_T, LANGS } = ctx.D;
const LS = LANGS.map(x => x[0]);
const PG = JSON.parse(rd("tools/pagine.json"));

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const home = l => l === "it" ? "/" : `/${l}/`;
const gpPath = (k, l) => `${home(l)}${GP[k][l][0]}/`;
const tt = (l, k) => (T[l] && T[l][k]) ?? T.it[k] ?? k;
const loc = (o, l) => (o && (o[l] ?? o.it)) ?? "";

// ---------------------------------------------------------------- 1. home per lingua
function setMeta(html, re, val, what) {
  if (!re.test(html)) throw new Error("index.html: manca " + what);
  return html.replace(re, val);
}
for (const l of LS) {
  if (l === "it") continue;
  const M = META[l]; let h = INDEX;
  h = setMeta(h, /<html lang="it" data-pl="it">/, `<html lang="${l}" data-pl="${l}">`, "html lang");
  h = setMeta(h, /<title>[^<]*<\/title>/, `<title>${esc(M.t)}</title>`, "title");
  h = setMeta(h, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(M.d)}">`, "description");
  h = setMeta(h, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(M.t)}">`, "og:title");
  h = setMeta(h, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(M.d)}">`, "og:description");
  h = setMeta(h, /<meta property="og:locale" content="[^"]*">/, `<meta property="og:locale" content="${M.loc}">`, "og:locale");
  h = setMeta(h, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${SITE}/${l}/">`, "canonical");
  h = setMeta(h, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${SITE}/${l}/">`, "og:url");
  // testi già nella lingua giusta: niente sfarfallio all'apertura e Google li legge (data-i = testo, data-ih = html)
  {
    const cut = h.indexOf("const CONFIG="), head = h.slice(0, cut), rest = h.slice(cut);
    const fill = (html) => (m, open, tag, k, inner, close) => { const v = T[l] && T[l][k]; return typeof v === "string" ? open + (html ? v : esc(v)) + close : m; };
    h = head.replace(/(<([a-z0-9]+)\b[^>]*\sdata-i="(\w+)"[^>]*>)([^<]*)(<\/\2>)/g, fill(false))
            .replace(/(<([a-z0-9]+)\b[^>]*\sdata-ih="(\w+)"[^>]*>)([\s\S]*?)(<\/\2>)/g, fill(true)) + rest;
  }
  h = h.replace("<head>", "<head>\n<!-- generato da tools/build.mjs: non modificare, si modifica index.html -->");
  out(`${l}/index.html`, h);
}

// ---------------------------------------------------------------- 2. pagine della guida
const brand = (INDEX.match(/<a class="brand"[\s\S]*?<\/a>/) || [""])[0];
const tokens = (INDEX.match(/:root\{\n\s*--bg[\s\S]*?:root\[data-theme="dark"\]\{[\s\S]*?\}/) || [""])[0];
const liveLinks = (INDEX.match(/<div class="live">([\s\S]*?)<\/div>/) || ["", ""])[1].trim();

const CSS = `${tokens}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--f-body);font-size:16px;line-height:1.6}
img{max-width:100%;display:block}a{color:var(--adri)}
.wrap{max-width:1080px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
h1,h2,h3{font-family:var(--f-display);font-weight:400;line-height:1.12;text-wrap:balance;margin:0}
h1{font-size:clamp(34px,5.4vw,58px)}h2{font-size:clamp(26px,3.6vw,38px);margin:48px 0 16px}h3{font-size:21px}
header.top{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
header.top::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:3px;background:linear-gradient(90deg,#e40303 0 16.6%,#ff8c00 0 33.3%,#ffed00 0 50%,#008026 0 66.6%,#24408e 0 83.3%,#732982 0);opacity:.85}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-block:10px}
.brand{font-family:var(--f-display);font-size:22px;text-decoration:none;white-space:nowrap;color:var(--ink);display:inline-flex;align-items:center;gap:9px}.brand-mark{width:36px;height:32px;flex:none}
.brand small{font-family:var(--f-body);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-left:6px}
.langs{display:flex;gap:2px;border:1px solid var(--line);border-radius:999px;padding:2px;background:var(--surface)}
.langs a{text-decoration:none;font-size:12px;font-weight:600;padding:4px 7px;border-radius:999px;color:var(--muted)}
.langs a[aria-current="true"]{background:var(--ink);color:var(--bg)}
@media (max-width:520px){.brand small{display:none}.brand{font-size:19px}.langs a{padding:4px 5px;font-size:11px}}
.crumbs{font-size:13px;color:var(--muted);margin:22px 0 18px}.crumbs a{color:var(--muted)}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;color:var(--muted);margin:0 0 10px}
.intro p{font-size:18px;color:var(--ink);max-width:68ch;margin:16px 0 0}
.note{font-size:13.5px;color:var(--muted);margin-top:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;display:grid;gap:8px;align-content:start}
.card p{margin:0;color:var(--muted);font-size:15px}.card .row{display:flex;justify-content:space-between;gap:8px;align-items:center}
.chip{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:999px;color:#fff}
.chip.adri{background:var(--adri)}.chip.ionio{background:var(--ionio)}.chip.land{background:var(--olive)}
.km{font-family:var(--f-mono);font-size:13px;color:var(--muted);white-space:nowrap}.when{font-weight:600;font-size:13.5px;color:var(--ink)}
.card .more{font-size:13.5px;font-weight:600;text-decoration:none}
.box{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:22px}
.box ol{margin:12px 0 0;padding-left:20px;display:grid;gap:8px}.box .rule{font-weight:600;margin:14px 0 0}
table{border-collapse:collapse;width:100%;max-width:640px;font-size:15px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:center}th:first-child,td:first-child{text-align:left}
.go{font-weight:600;margin:0}.live{display:flex;flex-wrap:wrap;gap:8px}.live a{border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:6px 12px;font-size:14px;text-decoration:none;color:var(--ink)}
.cta{margin:56px 0 0;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:0;background:var(--surface);border:1px solid var(--line);border-radius:20px;overflow:hidden}
.cta img{width:100%;height:100%;object-fit:cover;min-height:220px}.cta div{padding:26px}.cta h2{margin:0 0 10px}.cta p{margin:0 0 18px;color:var(--muted)}
@media (max-width:760px){.cta{grid-template-columns:1fr}.cta img{max-height:240px}}
.btn{display:inline-flex;align-items:center;border:1px solid var(--ink);background:var(--ink);color:var(--bg);padding:11px 18px;border-radius:999px;font-weight:600;text-decoration:none;font-size:15px;margin:0 8px 8px 0}
.btn.sun{background:var(--sun);border-color:var(--sun);color:#1b1404}.btn.ghost{background:transparent;color:var(--ink)}
.gp{display:flex;flex-wrap:wrap;gap:10px}.gp a{border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:8px 14px;font-size:14px;font-weight:600;color:var(--ink);text-decoration:none}
footer{margin-top:64px;padding-block:36px;border-top:1px solid var(--line);font-size:14px;color:var(--muted);position:relative}
footer::after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:linear-gradient(90deg,#e40303 0 16.6%,#ff8c00 0 33.3%,#ffed00 0 50%,#008026 0 66.6%,#24408e 0 83.3%,#732982 0);opacity:.85}
footer p{margin:4px 0}footer a{color:var(--muted)}.mono{font-family:var(--f-mono)}`;

function wiki(lk, l) {
  if (!lk) return null; if (lk.u) return lk.u; if (!lk.w) return null;
  const ll = lk.ll || {}; const L = (l !== "it" && ll[l]) ? l : (l !== "it" && ll.en ? "en" : "it");
  const title = L === "it" ? lk.w : ll[L];
  return `https://${L}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}
function card(l, i, top) {
  const km = i.km ? `${i.km} km · ${i.min}′` : (i.km === 0 && !i.noKm ? "Cutrofiano" : "");
  const u = wiki(i.lk, l);
  return `<article class="card"><div class="row">${top ?? `<span class="chip ${i.c || "land"}">${esc(tt(l, i.c === "adri" ? "adri" : i.c === "ionio" ? "ionio" : "land"))}</span>`}<span class="km">${esc(km)}</span></div>`
    + `<h3>${esc(i.n)}</h3><p>${esc(loc(i.d, l))}</p>`
    + (u ? `<a class="more" href="${esc(u)}" target="_blank" rel="noopener">${esc(PG.common[l].more)} ↗</a>` : "") + `</article>`;
}
const byKm = arr => [...arr].sort((x, y) => (x.km ?? 0) - (y.km ?? 0));

function body(k, l) {
  const C = PG.common[l];
  if (k === "beach") {
    const io = byKm(GUIDE.beach.filter(x => x.c === "ionio")), ad = byKm(GUIDE.beach.filter(x => x.c === "adri"));
    return `<h2>${esc(C.ionio)}</h2><div class="cards">${io.map(i => card(l, i)).join("")}</div>`
      + `<h2>${esc(C.adri)}</h2><div class="cards">${ad.map(i => card(l, i)).join("")}</div>`
      + `<h2>${esc(tt(l, "sea_title"))}</h2><p class="intro-s">${esc(tt(l, "sea_sub"))} <a href="${gpPath("sea", l)}">${esc(GP.sea[l][1])} →</a></p>`;
  }
  if (k === "sea") {
    const W = [["w_tram", "ionio"], ["w_sci", "adri"], ["w_pon", "adri"]];
    const mo = tt(l, "mo");
    return `<h2>${esc(tt(l, "sea_title"))}</h2><div class="cards">` + W.map(([w, c]) =>
      `<article class="card"><div class="row"><span class="chip ${c}">${esc(tt(l, c))}</span></div><h3>${esc(tt(l, w))}</h3><p>${esc(tt(l, w + "_d"))}</p><p class="go" style="color:var(--${c})">→ ${esc(tt(l, w + "_go"))}</p></article>`).join("") + `</div>`
      + `<h2>${esc(tt(l, "wh_title"))}</h2><div class="box"><p style="margin:0">${esc(tt(l, "wh_intro"))}</p><ol>${["wh_s1", "wh_s2", "wh_s3", "wh_s4"].map(s => `<li>${esc(tt(l, s))}</li>`).join("")}</ol><p class="rule">${esc(tt(l, "wh_rule"))}</p></div>`
      + `<h2>${esc(tt(l, "chart_title"))}</h2><table><thead><tr><th></th>${mo.map(m => `<th>${esc(m)}</th>`).join("")}</tr></thead><tbody>`
      + `<tr><td>${esc(tt(l, "t_sea"))}</td>${SEA_T.map(v => `<td>${v}°</td>`).join("")}</tr><tr><td>${esc(tt(l, "t_air"))}</td>${AIR_T.map(v => `<td>${v}°</td>`).join("")}</tr></tbody></table><p class="note">${esc(tt(l, "chart_note"))}</p>`
      + `<h2>${esc(tt(l, "live_title"))}</h2><div class="live">${liveLinks}</div>`;
  }
  if (k === "town") {
    return `<h2>${esc(tt(l, "tab_town"))}</h2><div class="cards">${byKm(GUIDE.town).map(i => card(l, i)).join("")}</div>`
      + `<h2>${esc(tt(l, "tab_food"))}</h2><div class="cards">${GUIDE.food.map(i => card(l, { ...i, km: undefined, noKm: true }, `<span class="chip land">${esc(tt(l, "tab_food"))}</span>`)).join("")}</div>`;
  }
  if (k === "events") {
    return `<h2>${esc(tt(l, "ev_title"))}</h2><p class="note">${esc(tt(l, "ev_sub"))}</p><div class="cards">${EVENTS.map(i => card(l, { ...i, c: "land" }, `<span class="when">${esc(loc(i.w, l))}</span>`)).join("")}</div>`
      + `<h2>${esc(tt(l, "nt_title"))}</h2><p class="note">${esc(tt(l, "nt_sub"))}</p><div class="cards">${NIGHT.map(i => card(l, { ...i, noKm: i.km === 0 })).join("")}</div>`;
  }
}

const KEYS = Object.keys(GP);
function page(k, l) {
  const P = PG.pages[k][l], C = PG.common[l], url = SITE + gpPath(k, l);
  const alt = LS.map(x => `<link rel="alternate" hreflang="${x}" href="${SITE}${gpPath(k, x)}">`).join("\n")
    + `\n<link rel="alternate" hreflang="x-default" href="${SITE}${gpPath(k, "it")}">`;
  const items = k === "beach" ? GUIDE.beach : k === "town" ? GUIDE.town : k === "events" ? EVENTS : [];
  const ld = [{
    "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Casalaggiù", item: SITE + home(l) },
      { "@type": "ListItem", position: 2, name: P.h1, item: url }]
  }];
  if (items.length) ld.push({ "@context": "https://schema.org", "@type": "ItemList", name: P.h1, itemListElement: items.map((i, n) => ({ "@type": "ListItem", position: n + 1, name: i.n })) });
  const langs = LS.map(x => `<a href="${gpPath(k, x)}" hreflang="${x}" lang="${x}" aria-current="${x === l}" data-l="${x}">${x.toUpperCase()}</a>`).join("");
  const others = KEYS.filter(x => x !== k).map(x => `<a href="${gpPath(x, l)}">${esc(GP[x][l][1])} →</a>`).join("");
  return `<!doctype html>
<!-- generato da tools/build.mjs: si modifica tools/pagine.json o index.html -->
<html lang="${l}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(P.title)} | Casalaggiù</title>
<meta name="description" content="${esc(P.desc)}">
<link rel="canonical" href="${url}">
${alt}
<meta property="og:type" content="article">
<meta property="og:site_name" content="Casalaggiù">
<meta property="og:locale" content="${META[l].loc}">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(P.title)}">
<meta property="og:description" content="${esc(P.desc)}">
<meta property="og:image" content="${SITE}/img/og-casalaggiu.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/img/og-casalaggiu.jpg">
<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap">${brand.replace('href="#top"', `href="${home(l)}"`)}<nav class="langs" aria-label="Language">${langs}</nav></div></header>
<main class="wrap">
<nav class="crumbs" aria-label="Breadcrumb"><a href="${home(l)}">Casalaggiù</a> › ${esc(C.guide)} › ${esc(GP[k][l][1])}</nav>
<p class="eyebrow">${esc(C.guide)}</p>
<h1>${esc(P.h1)}</h1>
<div class="intro">${P.intro.map(p => `<p>${esc(p)}</p>`).join("")}</div>
${k === "sea" ? "" : `<p class="note">${esc(C.dist)}</p>`}
${body(k, l)}
<section class="cta"><img src="/img/21-panorama-terrazza.webp" alt="Casalaggiù · Cutrofiano" loading="lazy" width="1200" height="800"><div><h2>${esc(C.cta_t)}</h2><p>${esc(C.cta_x)}</p><a class="btn sun" href="${home(l)}#prenota">${esc(C.cta_b)}</a><a class="btn ghost" href="${home(l)}#casa">${esc(C.cta_h)}</a></div></section>
<h2>${esc(C.other)}</h2>
<div class="gp">${others}</div>
</main>
<footer><div class="wrap">
<p><b>Casalaggiù</b> · ${esc(tt(l, "ft_type"))}</p>
<p>Via Roma 13 · 73020 Cutrofiano (LE) · Puglia · Italia</p>
<p>${esc(C.codes)}: CIN <span class="mono">IT075026C200122953</span> · CIS <span class="mono">LE07502691000075450</span></p>
<p><a href="/privacy.html">${esc(C.privacy)}</a></p>
</div></footer>
<script>document.querySelectorAll(".langs a").forEach(a=>a.addEventListener("click",()=>{try{localStorage.setItem("cdm_lang",a.dataset.l)}catch(e){}}))</script>
</body>
</html>
`;
}
for (const k of KEYS) for (const l of LS) out(gpPath(k, l).slice(1) + "index.html", page(k, l));

// ---------------------------------------------------------------- 3. sitemap
const urlBlock = (paths, pr, cf) => LS.map(l => `  <url><loc>${SITE}${paths(l)}</loc>\n`
  + LS.map(x => `    <xhtml:link rel="alternate" hreflang="${x}" href="${SITE}${paths(x)}"/>\n`).join("")
  + `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${paths("it")}"/>\n`
  + `    <changefreq>${cf}</changefreq><priority>${typeof pr === "function" ? pr(l) : pr}</priority></url>\n`).join("");
let sm = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`
  + urlBlock(home, l => l === "it" ? "1.0" : "0.9", "weekly")
  + KEYS.map(k => urlBlock(l => gpPath(k, l), "0.7", "monthly")).join("")
  + `  <url><loc>${SITE}/privacy.html</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>\n`
  + `  <url><loc>${SITE}/cookie.html</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>\n</urlset>\n`;
out("sitemap.xml", sm);
console.log(`fatto: ${written} file aggiornati`);
