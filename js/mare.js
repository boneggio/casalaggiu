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
var cache={},cur=null;
function e(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n}
function draw(box,l,d){
  var s=S[l]||S.it;box.innerHTML="";box.append(e("p","mo-h",s.h));
  if(!d||!d.ok||!d.giorni||!d.giorni.length){box.append(e("p","mo-src",s.err));return}
  var g=e("div","mo-g");
  d.giorni.slice(0,2).forEach(function(x,i){
    var c=x.k==="tram"?"ionio":x.k?"adri":"both",card=e("div","mo-c mo-"+c);
    card.append(e("span","mo-day",i?s.dom:s.oggi),e("b","mo-go",c==="ionio"?"→ "+s.io:c==="adri"?"→ "+s.ad:"✓ "+s.both),e("span","mo-w",s.v.replace("{d}",x.dir).replace("{k}",x.kmh)));
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
var st=e("style");st.textContent=".mo{min-height:190px;margin:18px 0}.mo-h{font-weight:600;margin:0 0 8px}.mo-g{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:560px){.mo-g{grid-template-columns:1fr}}.mo-c{border:1px solid var(--line,#dfe1dc);border-left:5px solid var(--c);border-radius:12px;padding:12px 14px;background:var(--bg,#fff)}.mo-ionio{--c:var(--ionio,#0f7b77)}.mo-adri{--c:var(--adri,#2a5ea8)}.mo-both{--c:var(--sun,#e0a030)}.mo-day{display:block;font-size:13px;opacity:.75}.mo-go{display:block;font-size:20px;color:var(--c);margin:2px 0}.mo-w{display:block;font-size:14px;font-weight:600}.mo-d,.mo-v{font-size:14px;margin:6px 0 0}.mo-src{font-size:12px;opacity:.75;margin:8px 0 0}";
document.head.append(st);
function go(){render((document.getElementById("mo")||{}).dataset&&document.getElementById("mo").dataset.l||document.documentElement.lang||"it")}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",go);else go();
})();
