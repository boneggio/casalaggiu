/* «Mare oggi»: quale costa scegliere oggi e domani in base al vento (dati MET Norway via worker) */
(function(){
var API="https://casalaggiu.maurizio-covarelli.workers.dev/api";
var S={
it:{h:"Che mare scegliere",oggi:"Oggi",dom:"Domani",v:"Vento da {d}, {k} km/h",calma:"Vento debole: vanno bene sia lo Ionio sia l'Adriatico.",io:"Ionio",ad:"Adriatico",both:"Ionio e Adriatico",src:"Previsioni MET Norway, aggiornate alle {h}. Consiglio indicativo: il mare può cambiare in fretta.",err:"Previsioni non disponibili in questo momento: guarda i link qui sotto."},
en:{h:"Which sea to choose",oggi:"Today",dom:"Tomorrow",v:"Wind from the {d}, {k} km/h",calma:"Light wind: both the Ionian and the Adriatic are good.",io:"Ionian",ad:"Adriatic",both:"Ionian and Adriatic",src:"Forecast by MET Norway, updated at {h}. Just a tip: the sea can change quickly.",err:"Forecast not available right now: see the links below."},
de:{h:"Welches Meer heute",oggi:"Heute",dom:"Morgen",v:"Wind aus {d}, {k} km/h",calma:"Schwacher Wind: Ionisches Meer und Adria sind beide gut.",io:"Ionisches Meer",ad:"Adria",both:"Ionisches Meer und Adria",src:"Vorhersage von MET Norway, aktualisiert um {h}. Nur ein Tipp: das Meer kann sich schnell ändern.",err:"Vorhersage gerade nicht verfügbar: siehe die Links unten."},
nl:{h:"Welke zee vandaag",oggi:"Vandaag",dom:"Morgen",v:"Wind uit het {d}, {k} km/u",calma:"Zwakke wind: zowel de Ionische Zee als de Adriatische Zee zijn goed.",io:"Ionische Zee",ad:"Adriatische Zee",both:"Ionische en Adriatische Zee",src:"Verwachting van MET Norway, bijgewerkt om {h}. Alleen een tip: de zee kan snel veranderen.",err:"Verwachting nu niet beschikbaar: zie de links hieronder."},
es:{h:"Qué mar elegir",oggi:"Hoy",dom:"Mañana",v:"Viento del {d}, {k} km/h",calma:"Viento flojo: valen tanto el Jónico como el Adriático.",io:"Jónico",ad:"Adriático",both:"Jónico y Adriático",src:"Previsión de MET Norway, actualizada a las {h}. Solo un consejo: el mar puede cambiar rápido.",err:"Previsión no disponible ahora: mira los enlaces de abajo."},
fr:{h:"Quelle mer choisir",oggi:"Aujourd'hui",dom:"Demain",v:"Vent du {d}, {k} km/h",calma:"Vent faible : la mer Ionienne et l'Adriatique sont toutes deux bien.",io:"Ionienne",ad:"Adriatique",both:"Ionienne et Adriatique",src:"Prévisions MET Norway, mises à jour à {h}. Simple conseil : la mer peut changer vite.",err:"Prévisions indisponibles pour le moment : voir les liens ci-dessous."}};
var H={
it:{on:{ionio:"sullo Ionio",adri:"sull'Adriatico"},good:"✓ Buona scelta: il vento è favorevole a {n}.",bad:"{n} è {on}: con questo vento è meglio una spiaggia {other}.",calm:"✓ Vento debole: va bene anche {n}."},
en:{on:{ionio:"on the Ionian",adri:"on the Adriatic"},good:"✓ Good choice: the wind favours {n}.",bad:"{n} is {on}: with this wind a beach {other} is better.",calm:"✓ Light wind: {n} is fine too."},
de:{on:{ionio:"am Ionischen Meer",adri:"an der Adria"},good:"✓ Gute Wahl: der Wind ist günstig für {n}.",bad:"{n} liegt {on}: bei diesem Wind ist ein Strand {other} besser.",calm:"✓ Schwacher Wind: auch {n} ist gut."},
nl:{on:{ionio:"aan de Ionische Zee",adri:"aan de Adriatische Zee"},good:"✓ Goede keuze: de wind is gunstig voor {n}.",bad:"{n} ligt {on}: met deze wind is een strand {other} beter.",calm:"✓ Zwakke wind: ook {n} is prima."},
es:{on:{ionio:"en el Jónico",adri:"en el Adriático"},good:"✓ Buena elección: el viento favorece {n}.",bad:"{n} está {on}: con este viento es mejor una playa {other}.",calm:"✓ Viento flojo: {n} también está bien."},
fr:{on:{ionio:"sur la mer Ionienne",adri:"sur l'Adriatique"},good:"✓ Bon choix : le vent est favorable à {n}.",bad:"{n} est {on} : avec ce vent, mieux vaut une plage {other}.",calm:"✓ Vent faible : {n} convient aussi."}};
var cache={},cur=null;
function e(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n}
// rosa dei venti: la freccia va dove soffia il vento (gradi = da dove arriva)
function rosa(c,g,t){var b=e("b","mo-go"),i=e("span","mo-ic");i.setAttribute("aria-hidden","true");
  i.innerHTML='<svg viewBox="0 0 64 64" width="40" height="40"><circle cx="32" cy="32" r="29" fill="none" stroke="var(--line,#dfe1dc)" stroke-width="2"/><text x="32" y="12" text-anchor="middle" font-size="9" fill="var(--muted,#6b7280)" font-family="var(--f-mono,monospace)">N</text>'+(g==null?"":'<g transform="rotate('+(g%360)+' 32 32)"><path d="M32 14 L32 46 M24 38 L32 48 L40 38" stroke="currentColor" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>')+'</svg>';
  b.append(i,document.createTextNode(t));return b}
function draw(box,l,d){
  var s=S[l]||S.it;box.innerHTML="";box.append(e("p","mo-h",s.h));
  if(!d||!d.ok||!d.giorni||!d.giorni.length){box.append(e("p","mo-src",s.err));return}
  var g=e("div","mo-g");
  d.giorni.slice(0,2).forEach(function(x,i){
    var c=x.k==="tram"||x.k==="lev"?"ionio":x.k?"adri":"both",card=e("div","mo-c mo-"+c);
    card.append(e("span","mo-day",i?s.dom:s.oggi),rosa(c,x.gradi,c==="ionio"?s.io:c==="adri"?s.ad:s.both),e("span","mo-w",s.v.replace("{d}",x.dir).replace("{k}",x.kmh)));
    var bc=box.dataset.c,bn=box.dataset.n;
    if(bn&&(bc==="ionio"||bc==="adri")){var h=H[l]||H.it,oth=bc==="ionio"?"adri":"ionio",t=c==="both"?h.calm:c===bc?h.good:h.bad;
      card.append(e("p","mo-here "+(c==="both"||c===bc?"ok":"no"),t.replace("{n}",bn).replace("{on}",h.on[bc]).replace("{other}",h.on[oth])))}
    card.append(e("p","mo-d",x.k?x.desc:s.calma));if(x.vai)card.append(e("p","mo-v",x.vai));
    g.append(card)});
  var h=new Date(d.aggiornato).toLocaleTimeString(l,{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Rome"});
  box.append(g,e("p","mo-src",s.src.replace("{h}",h)));
}
function render(l){
  var box=document.getElementById("mo");if(!box)return;l=S[l]?l:"it";cur=l;
  if(cache[l]){draw(box,l,cache[l]);return}
  fetch(API+"?action=mare&l="+l).then(function(r){return r.json()}).then(function(d){cache[l]=d;if(cur===l)draw(box,l,d)}).catch(function(){draw(box,l,null)});
}
window.moRender=render;
var st=e("style");st.textContent=".mo{min-height:190px;margin:18px 0}.mo-h{font-weight:600;margin:0 0 8px}.mo-g{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:560px){.mo-g{grid-template-columns:1fr}}.mo-c{border:1px solid var(--line,#dfe1dc);border-left:5px solid var(--c);border-radius:12px;padding:12px 14px;background:var(--bg,#fff)}.mo-ionio{--c:var(--ionio,#0f7b77)}.mo-adri{--c:var(--adri,#2a5ea8)}.mo-both{--c:var(--sun,#e0a030)}.mo-day{display:block;font-size:13px;opacity:.75}.mo-go{display:flex;align-items:center;gap:10px;font-size:20px;color:var(--c);margin:4px 0}.mo-ic{display:inline-flex;flex:none}.mo-w{display:block;font-size:14px;font-weight:600}.mo-d,.mo-v{font-size:14px;margin:6px 0 0}.mo-here{font-weight:600;font-size:14px;margin:8px 0 0;padding:6px 10px;border-radius:8px}.mo-here.ok{background:color-mix(in srgb,#1f7a3a 12%,transparent);color:#1f6a33}.mo-here.no{background:color-mix(in srgb,#b3261e 10%,transparent);color:#9a2a1f}.mo-src{font-size:12px;opacity:.75;margin:8px 0 0}";
document.head.append(st);
function go(){render((document.getElementById("mo")||{}).dataset&&document.getElementById("mo").dataset.l||document.documentElement.lang||"it")}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",go);else go();
})();
