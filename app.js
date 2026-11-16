
(() => {
"use strict";
const SLOTS=[{k:"desayuno",n:"Desayuno"},{k:"almuerzo",n:"Almuerzo",opt:true},{k:"comida",n:"Comida"},{k:"merienda",n:"Merienda"},{k:"cena",n:"Cena"}];
const SLOTN=Object.fromEntries(SLOTS.map(s=>[s.k,s.n]));SLOTN.extra="Extras";
const DOW=["LUN","MAR","MIÉ","JUE","VIE","SÁB","DOM"];
const DOWL=["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado","Domingo"];
const COLS=["recipes","products","plan","log","workouts","routines","weights","shopping","config"];
const DEFAULT_GOALS={kcal:1700,p:120,c:170,f:60};

const S={db:null,loaded:{},data:Object.fromEntries(COLS.map(c=>[c,{}])),date:todayStr(),week:null,view:"hoy",
  ui:{semTab:"comidas",recFilter:"todas",recQ:"",progRange:7,progTab:"alimentacion",exSel:"",confirm:null},draft:null,offline:false};
S.week=weekStart(S.date);

/* ---------- utils ---------- */
function todayStr(){const d=new Date();return ymd(d)}
function ymd(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
function pd(s){return new Date(s+"T12:00:00")}
function addDays(s,n){const d=pd(s);d.setDate(d.getDate()+n);return ymd(d)}
function dowIdx(s){return (pd(s).getDay()+6)%7}
function weekStart(s){return addDays(s,-dowIdx(s))}
function dm(s){const d=pd(s);return d.getDate()+"/"+(d.getMonth()+1)}
function longDate(s){return pd(s).toLocaleDateString("es-ES",{weekday:"long",day:"numeric",month:"long"})}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function n(v){return v==null||v===""||isNaN(+v)?null:+v}
function fmt(v,d){if(v==null||isNaN(v))return "—";const dig=d!=null?d:(Math.abs(v)<100?1:0);return (+v).toLocaleString("es-ES",{maximumFractionDigits:dig})}
function slug(s){return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,60)||uid()}
function lsGet(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}}
function lsSet(k,v){try{v==null?localStorage.removeItem(k):localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
const D=c=>S.data[c];
function goals(date){const cfg=D("config").main||{};const base=Object.assign({},DEFAULT_GOALS,cfg.goals||{});
  if(date&&cfg.goalsRest&&!((cfg.schedule||{})[dowIdx(date)]))return Object.assign({},base,cfg.goalsRest,{rest:true});
  return base}

/* ---------- macros ---------- */
const MK=["kcal","p","c","f"];
function recipeMacros(r,serv){
  serv=serv||1;const out={kcal:0,p:0,c:0,f:0,miss:{}};
  if(r.ingredients&&r.ingredients.length){
    const base=r.servings||1;
    r.ingredients.forEach(i=>{const q=(n(i.qty)||0)/100;MK.forEach(k=>{const v=n(i.per100&&i.per100[k]);if(v==null)out.miss[k]=1;else out[k]+=v*q})});
    MK.forEach(k=>out[k]=out[k]/base*serv);
  }else{MK.forEach(k=>{const v=n(r[k]);if(v==null){out[k]=null;out.miss[k]=1}else out[k]=v*serv})}
  return out;
}
function sumM(list){const out={kcal:0,p:0,c:0,f:0,miss:{}};list.forEach(m=>MK.forEach(k=>{const v=m?n(m[k]):null;if(v==null)out.miss[k]=1;else out[k]+=v;if(m&&m.miss&&m.miss[k])out.miss[k]=1}));return out}
function pre(m,k){return m.miss&&m.miss[k]?"≥ ":""}
function planEntry(e){
  if(!e)return null;
  if(e.type==="libre")return {title:"Libre",libre:true,m:{kcal:null,p:null,c:null,f:null,miss:{kcal:1,p:1,c:1,f:1}}};
  if(e.type==="recipe"){const r=D("recipes")[e.id];if(!r)return {title:"Receta borrada",m:{kcal:null,p:null,c:null,f:null,miss:{kcal:1,p:1,c:1,f:1}}};return {title:r.title,recipe:r,id:e.id,serv:e.servings||1,m:recipeMacros(r,e.servings||1)}}
  if(e.type==="custom")return {title:e.title,m:recipeMacros(e,1)};
  return null;
}
function dayPlan(date){const p=D("plan")[date]||{};const out={};SLOTS.forEach(s=>out[s.k]=planEntry(p[s.k]));return out}
function dayPlanTotals(date){const p=dayPlan(date);const known=[];let libre=0,empty=0;SLOTS.forEach(s=>{const e=p[s.k];if(!e){if(!s.opt)empty++;return}if(e.libre){libre++;return}known.push(e.m)});return {m:sumM(known),libre,empty}}
function dayLog(date){return ((D("log")[date]||{}).items)||[]}
function dayLogTotals(date){return sumM(dayLog(date))}

/* ---------- datos: Supabase (o modo demo en este dispositivo) ---------- */
const CFG=window.MIPLAN_CONFIG||{};
const DEMO=!CFG.supabaseUrl||!CFG.supabaseAnonKey;
let sb=null,user=null;
const queue={};
function cacheKey(){return "mp-cache-"+(DEMO?"demo":user&&user.id)}
function persistCache(){lsSet(cacheKey(),S.data)}
function outbox(){return lsGet("mp-outbox-"+(user?user.id:"demo"))||{}}
function setOutbox(o){lsSet("mp-outbox-"+(user?user.id:"demo"),Object.keys(o).length?o:null)}
async function remoteWrite(path,data){
  const i=path.indexOf("/");const col=path.slice(0,i),id=path.slice(i+1);
  if(col==="products"){
    if(data===null){const {error}=await sb.from("products").delete().eq("id",id);if(error)throw error;return}
    const {error}=await sb.from("products").upsert({id,ean:data.ean||null,data});if(error)throw error;return;
  }
  if(data===null){const {error}=await sb.from("user_docs").delete().match({user_id:user.id,col,id});if(error)throw error;return}
  const {error}=await sb.from("user_docs").upsert({user_id:user.id,col,id,data,updated_at:new Date().toISOString()},{onConflict:"user_id,col,id"});if(error)throw error;
}
function save(path,data){
  const i=path.indexOf("/");const col=path.slice(0,i),id=path.slice(i+1);
  if(data===null)delete S.data[col][id];else S.data[col][id]=data;
  persistCache();render();
  if(DEMO)return Promise.resolve();
  const ob=outbox();ob[path]=data;setOutbox(ob);
  const p=(queue[path]||Promise.resolve()).catch(()=>{}).then(()=>remoteWrite(path,data)).then(()=>{const o=outbox();if(path in o&&JSON.stringify(o[path])===JSON.stringify(data)){delete o[path];setOutbox(o)}setSync()});
  queue[path]=p;
  p.catch(e=>{setSync();if(!navigator.onLine)toast("Sin conexión: se guardará al volver la cobertura");else toast("No se ha podido guardar: "+(e&&e.message||"error"))});
  return p;
}
async function flushOutbox(){
  if(DEMO||!user)return;const ob=outbox();const keys=Object.keys(ob);if(!keys.length)return;
  for(const k of keys){try{await remoteWrite(k,ob[k]);const o=outbox();delete o[k];setOutbox(o)}catch(e){break}}
  setSync();
}
window.addEventListener("online",()=>{flushOutbox();loadAll(true)});
function setSync(){const el=document.getElementById("sync");if(!el)return;const pend=Object.keys(outbox()).length;
  el.textContent=DEMO?"Modo demo":!navigator.onLine?"Sin conexión"+(pend?" · "+pend+" pendientes":""):pend?"Guardando…":S.loadedAll?"✓ Guardado":"Cargando…"}
async function fetchAll(table,cols,filter){
  const out=[];let from=0;const size=1000;
  for(;;){let q=sb.from(table).select(cols).range(from,from+size-1);if(filter)q=filter(q);const {data,error}=await q;if(error)throw error;out.push(...data);if(data.length<size)break;from+=size}
  return out;
}
let lastLoad=0;
async function loadAll(silent){
  if(DEMO||!user)return;
  try{
    const [docs,prods]=await Promise.all([fetchAll("user_docs","col,id,data",q=>q.eq("user_id",user.id)),fetchAll("products","id,data")]);
    const data=Object.fromEntries(COLS.map(c=>[c,{}]));
    docs.forEach(d=>{if(data[d.col])data[d.col][d.id]=d.data});
    prods.forEach(p=>data.products[p.id]=p.data);
    const ob=outbox();Object.entries(ob).forEach(([k,v])=>{const i=k.indexOf("/");const c=k.slice(0,i),id=k.slice(i+1);if(!data[c])return;if(v===null)delete data[c][id];else data[c][id]=v});
    S.data=data;S.loadedAll=true;lastLoad=Date.now();persistCache();render();if(sheetFn&&!sheetRoot.contains(document.activeElement))drawSheet();
  }catch(e){if(!silent)toast("No se han podido cargar tus datos: "+(e.message||"sin conexión"))}
  setSync();
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&user&&Date.now()-lastLoad>60000){flushOutbox().then(()=>loadAll(true))}});
function setLog(date,items){return save("log/"+date,{date,items})}

/* ---------- render plumbing ---------- */
const main=document.getElementById("main");
let pendingRender=false;
function render(){
  const a=document.activeElement;
  if(a&&main.contains(a)&&/INPUT|TEXTAREA|SELECT/.test(a.tagName)&&a.dataset.live!=="1"){pendingRender=true;return}
  pendingRender=false;
  document.querySelectorAll("nav.bar a").forEach(x=>x.classList.toggle("on",x.dataset.nav===S.view));
  setSync();
  const nav=document.querySelector("nav.bar");if(nav)nav.hidden=!!S.gate||!S.ready;
  if(S.gate){main.innerHTML=S.gate();return}
  if(!S.ready)return;
  const v={hoy:vHoy,semana:vSemana,recetas:vRecetas,entreno:vEntreno,progreso:vProgreso}[S.view]||vHoy;
  main.innerHTML=(DEMO?`<div class="note" style="margin-bottom:12px">Modo demo: los datos se guardan solo en este dispositivo. Para sincronizar y usar el escáner de etiquetas, configura Supabase (ver la guía).</div>`:"")+v();
}
main.addEventListener("focusout",()=>setTimeout(()=>{if(pendingRender)render()},0));
function route(){const h=(location.hash||"#hoy").slice(1);S.view=["hoy","semana","recetas","entreno","progreso"].includes(h)?h:"hoy";render();window.scrollTo(0,0)}
window.addEventListener("hashchange",route);

let tt;function toast(msg){const r=document.getElementById("toastRoot");r.innerHTML=`<div class="toast" role="status">${esc(msg)}</div>`;clearTimeout(tt);tt=setTimeout(()=>r.innerHTML="",2600)}

/* ---------- sheet ---------- */
const sheetRoot=document.getElementById("sheetRoot");
let sheetFn=null;
function openSheet(fn){if(fn!==barcodeSheet)stopCamera();sheetFn=fn;drawSheet();document.body.style.overflow="hidden"}
function drawSheet(){if(!sheetFn)return;const st=sheetRoot.querySelector(".sheet");const sc=st?st.scrollTop:0;sheetRoot.innerHTML=`<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true">${sheetFn()}</div></div>`;const ns=sheetRoot.querySelector(".sheet");if(ns)ns.scrollTop=sc}
function closeSheet(){stopCamera();sheetFn=null;sheetRoot.innerHTML="";document.body.style.overflow="";if(pendingRender)render()}
function sheetHead(title,sub){return `<div class="sheet-h"><div>${sub?`<div class="eyebrow">${esc(sub)}</div>`:""}<h2>${esc(title)}</h2></div><button class="btn ghost" data-act="close" aria-label="Cerrar">✕</button></div>`}

/* ---------- small components ---------- */
function macroLine(m,opts){opts=opts||{};return `<span class="mk num"><b>${pre(m,"kcal")}${fmt(m.kcal,0)}</b> kcal</span><span class="mk num"><i class="dot" style="background:var(--p)"></i>P ${pre(m,"p")}${fmt(m.p)} g</span><span class="mk num"><i class="dot" style="background:var(--c)"></i>HC ${pre(m,"c")}${fmt(m.c)} g</span><span class="mk num"><i class="dot" style="background:var(--f)"></i>G ${pre(m,"f")}${fmt(m.f)} g</span>`}
function pct(v,g){return Math.max(0,Math.min(100,(v||0)/g*100))}
function protChip(p,g){if(p==null)return "";const r=p/g;const cls=r>=.9?"ok":r>=.7?"warn":"bad";return `<span class="chip ${cls} num">P ${fmt(p,0)} g</span>`}
function kcalChip(k,g,pref){if(k==null)return "";const r=k/g;const cls=r>1.08?"bad":r<.75?"warn":"ok";return `<span class="chip ${cls} num">${pref||""}${fmt(k,0)} kcal</span>`}

/* =========================================================
   HOY
   ========================================================= */
function vHoy(){
  const date=S.date,g=goals(date),wk=weekStart(date);
  const tot=dayLogTotals(date),items=dayLog(date),plan=dayPlan(date),pt=dayPlanTotals(date);
  const strip=Array.from({length:7},(_,i)=>{const d=addDays(wk,i);return `<button data-act="pickDate" data-d="${d}" class="${d===date?"on":""} ${d===todayStr()?"today":""} ${dayLog(d).length?"has":""}" aria-label="${DOWL[i]} ${dm(d)}"><span>${DOW[i]}</span><b>${pd(d).getDate()}</b><i></i></button>`}).join("");
  const remaining=g.kcal-(tot.kcal||0);
  const bar=(k,col)=>`<div class="between"><span>${{p:"Proteína",c:"Hidratos",f:"Grasas"}[k]}</span><span class="num"><b>${pre(tot,k)}${fmt(tot[k],0)}</b> / ${g[k]} g</span></div><div class="bar"><i style="width:${pct(tot[k],g[k])}%;background:${col}"></i></div>`;
  const incomplete=Object.keys(tot.miss).length;
  let html=`<div class="stack-lg">
  <div class="stack">
    <div class="between"><div><div class="eyebrow">${date===todayStr()?"Hoy":esc(longDate(date).split(",")[0])}</div><h1>${esc((longDate(date).split(", ")[1]||"").replace(/^./,c=>c.toUpperCase()))}</h1></div>
    <div class="row"><button class="btn ghost sm" data-act="shiftWeek" data-n="-7" aria-label="Semana anterior">‹</button>${date!==todayStr()?`<button class="btn soft sm" data-act="pickDate" data-d="${todayStr()}">Hoy</button>`:""}<button class="btn ghost sm" data-act="shiftWeek" data-n="7" aria-label="Semana siguiente">›</button></div></div>
    <div class="strip">${strip}</div>
  </div>
  <section class="hero">
    <div><div class="lbl">Registrado</div><div class="big num">${pre(tot,"kcal")}${fmt(tot.kcal,0)}</div><div class="lbl num">de ${fmt(g.kcal,0)} kcal${g.rest?" (descanso)":(D("config").main||{}).goalsRest?" (gym)":""} · ${remaining>=0?"te quedan "+fmt(remaining,0):"te pasas "+fmt(-remaining,0)}</div><div class="bar"><i style="width:${pct(tot.kcal,g.kcal)}%;background:${(tot.kcal||0)>g.kcal*1.05?"var(--bad)":"var(--on-forest)"}"></i></div></div>
    <div class="mac">${bar("p","var(--p)")}${bar("c","var(--c)")}${bar("f","var(--f)")}</div>
    <div class="foot"><span class="num">Plan del día: ${pt.libre||pt.empty?"≥ ":""}${fmt(pt.m.kcal,0)} kcal · P ${fmt(pt.m.p,0)} g${pt.libre?" · "+pt.libre+" libre":""}</span>${incomplete?`<span>Algún registro no tiene todos los macros (≥)</span>`:""}<button data-act="goals">Objetivos ⚙</button></div>
  </section>
  <section class="stack"><div class="between"><h2>Tus comidas</h2><button class="btn soft sm" data-act="copyPlanDay">Copiar plan a registrado</button></div>`;
  SLOTS.forEach(s=>{
    const logged=items.filter(i=>i.slot===s.k);const pe=plan[s.k];
    if(s.opt&&!logged.length&&!pe){html+=`<div class="between card planned" style="padding:10px 14px"><span class="muted small">${s.n} (opcional)</span><button class="btn sm soft" data-act="addFood" data-slot="${s.k}">+ Añadir</button></div>`;return}
    html+=`<div class="card slot"><div class="slot-h"><h3>${s.n}</h3>${logged.length?`<span class="state done">✓ Registrado</span>`:`<span class="state todo">Por registrar</span>`}</div>`;
    if(logged.length){logged.forEach(it=>html+=logItem(date,it))}
    else if(pe){html+=`<div class="item"><div class="t">${esc(pe.title)}${pe.serv&&pe.serv!==1?` <span class="muted small">× ${fmt(pe.serv)}</span>`:""}</div><div></div><div class="m">${pe.libre?"Comida libre: registra lo que comas":macroLine(pe.m)}</div></div>`}
    html+=`<div class="row wrap">${!logged.length&&pe&&!pe.libre?`<button class="btn primary sm" data-act="ate" data-slot="${s.k}">✓ Me lo he comido</button>`:""}<button class="btn soft sm" data-act="addFood" data-slot="${s.k}">${logged.length?"+ Añadir más":pe&&!pe.libre?"Comí otra cosa":"+ Registrar"}</button></div></div>`;
  });
  const extras=items.filter(i=>!SLOTN[i.slot]||i.slot==="extra");
  html+=`<div class="card slot"><div class="slot-h"><h3>Extras y picoteo</h3><span class="muted small num">${extras.length?fmt(sumM(extras).kcal,0)+" kcal":""}</span></div>${extras.map(it=>logItem(date,it)).join("")||`<div class="muted small">Nada fuera del plan.</div>`}<div><button class="btn soft sm" data-act="addFood" data-slot="extra">+ Extra</button></div></div></section>`;
  html+=todayTraining(date)+`</div>`;
  return html;
}
function logItem(date,it){
  const m={kcal:it.kcal,p:it.p,c:it.c,f:it.f,miss:{}};MK.forEach(k=>{if(n(it[k])==null)m.miss[k]=1});
  const c=S.ui.confirm==="log:"+it.id;
  return `<div class="item"><div class="t">${esc(it.name)}${it.estimated?` <span class="est">≈ estimado</span>`:""}</div><div class="row">${c?`<span class="confirm"><button class="btn sm danger" data-act="delLog" data-d="${date}" data-id="${it.id}">Borrar</button><button class="btn sm ghost" data-act="cancelConfirm">No</button></span>`:`<button class="btn ghost sm" data-act="editLog" data-d="${date}" data-id="${it.id}" aria-label="Editar">✎</button><button class="btn ghost sm" data-act="askConfirm" data-k="log:${it.id}" aria-label="Borrar">✕</button>`}</div><div class="m">${macroLine({kcal:n(it.kcal),p:n(it.p),c:n(it.c),f:n(it.f),miss:{}})}</div>${it.notes?`<div class="muted small" style="grid-column:1/-1">${esc(it.notes)}</div>`:""}</div>`;
}
function routineFor(date){const sch=((D("config").main||{}).schedule)||{};const id=sch[dowIdx(date)];return id&&D("routines")[id]?{id,...D("routines")[id]}:null}
function workoutsOn(date){return Object.entries(D("workouts")).filter(([,w])=>w.date===date).map(([id,w])=>({id,...w}))}
function todayTraining(date){
  const done=workoutsOn(date),r=routineFor(date);
  let body;
  if(done.length)body=done.map(w=>`<div class="item"><div class="t">✓ ${esc(w.name)}</div><div class="muted small num">${w.durationMin?fmt(w.durationMin,0)+" min":""}</div><div class="m num">${workoutSummary(w)}</div></div>`).join("");
  else if(r)body=`<div class="item"><div class="t">${esc(r.name)}</div><div></div><div class="m">${(r.exercises||[]).map(e=>esc(e.name)).join(" · ")}</div></div>`;
  else body=`<div class="muted small">Sin sesión asignada a este día. Asigna rutinas por día en Semana → Entreno.</div>`;
  return `<section class="card stack"><div class="between"><h2>Entreno</h2><a class="btn ghost sm" href="#entreno">Ver todo ›</a></div>${body}<div class="row wrap"><button class="btn primary sm" data-act="startWorkout" data-r="${r?r.id:""}" data-d="${date}">${done.length?"+ Otra sesión":"Empezar sesión"}</button></div></section>`;
}

/* add/edit food sheet */
function foodSheet(date,slot,editId){
  const st=S.ui.food||(S.ui.food={tab:editId?"manual":"productos",q:""});
  const it=editId?dayLog(date).find(i=>i.id===editId):null;
  let h=sheetHead(it?"Editar registro":"Registrar "+(SLOTN[slot]||"").toLowerCase(),longDate(date));
  if(!it)h+=`<div class="seg"><button class="${st.tab==="productos"?"on":""}" data-act="foodTab" data-t="productos">Productos</button><button class="${st.tab==="recetas"?"on":""}" data-act="foodTab" data-t="recetas">Recetas</button><button class="${st.tab==="manual"?"on":""}" data-act="foodTab" data-t="manual">A mano</button></div>`;
  if(st.tab==="productos"&&!it){
    if(st.sel&&D("products")[st.sel]){const pr=D("products")[st.sel];const g=st.g!=null?st.g:(pr.servingG||100);
      h+=`<div class="card stack"><div class="between"><div><b>${esc(pr.name)}</b><div class="small muted">${esc([pr.brand,pr.store].filter(Boolean).join(" · "))} · por 100 ${esc(pr.unit||"g")}: ${fmt(pr.per100&&pr.per100.kcal,0)} kcal</div></div><button class="btn ghost sm" data-act="foodUnsel">Cambiar</button></div>
      <div class="field"><label for="foodG">Cantidad (${esc(pr.unit||"g")})</label><input class="input num" id="foodG" type="number" step="any" inputmode="decimal" value="${g}" data-live="1"></div>
      ${pr.servingG?`<div class="row wrap">${[0.5,1,2].map(x=>`<button class="btn soft sm" data-act="foodQty" data-g="${pr.servingG*x}">${x===1?"1 ración":x+" raciones"} · ${fmt(pr.servingG*x,0)} ${esc(pr.unit||"g")}</button>`).join("")}</div>`:""}
      <div class="row wrap small" id="foodGM">${macroLine(prodMacros(pr,g))}</div>
      <button class="btn primary block" data-act="logProduct">Registrar</button></div>`;
    }else{
      h+=`<div class="row wrap"><button class="btn primary sm" data-act="barcode" data-from="food">▥ Código de barras</button>${S.canScan?`<button class="btn soft sm" data-act="scan" data-from="food">📷 Etiqueta</button>`:""}<button class="btn soft sm" data-act="newProduct" data-from="food">+ Producto nuevo</button></div>
      <input class="search" id="foodPQ" placeholder="Buscar producto: cottage, skyr, basmati…" value="${esc(st.pq||"")}" data-act="foodPQ">
      <div class="stack">${productRows(st.pq||"","pickProduct")}</div>`;
    }
  }else if(st.tab==="recetas"&&!it){
    const rs=Object.entries(D("recipes")).filter(([,r])=>!st.q||r.title.toLowerCase().includes(st.q.toLowerCase())).sort((a,b)=>(b[1].fav?1:0)-(a[1].fav?1:0)||a[1].title.localeCompare(b[1].title));
    h+=`<input class="search" id="foodQ" placeholder="Buscar receta…" value="${esc(st.q)}" data-act="foodQ"><div class="field"><label for="foodServ">Raciones</label><input class="input" id="foodServ" type="number" step="0.25" min="0.25" value="${st.serv||1}" inputmode="decimal"></div><div class="stack" id="foodList">${rs.map(([id,r])=>{const m=recipeMacros(r);return `<button class="list-btn" data-act="logRecipe" data-id="${id}"><span class="t">${r.fav?"★ ":""}${esc(r.title)}</span><span class="muted small num">${fmt(m.kcal,0)} kcal · P ${fmt(m.p,0)}</span></button>`}).join("")||`<div class="empty">No hay recetas con ese nombre.</div>`}</div>`;
  }else{
    const v=it||{};
    h+=`<form class="stack" data-form="food" data-d="${date}" data-slot="${slot}" data-id="${it?it.id:""}">
      <div class="field"><label for="fName">Qué has comido</label><input class="input" id="fName" required value="${esc(v.name)}" placeholder="p. ej. Yogur +Proteínas con arándanos"></div>
      <div class="grid4"><div class="field"><label for="fK">kcal</label><input class="input" id="fK" type="number" step="any" inputmode="decimal" value="${v.kcal??""}"></div><div class="field"><label for="fP">Prot. g</label><input class="input" id="fP" type="number" step="any" inputmode="decimal" value="${v.p??""}"></div><div class="field"><label for="fC">HC g</label><input class="input" id="fC" type="number" step="any" inputmode="decimal" value="${v.c??""}"></div><div class="field"><label for="fF">Grasa g</label><input class="input" id="fF" type="number" step="any" inputmode="decimal" value="${v.f??""}"></div></div>
      ${it?`<div class="field"><label for="fSlot">Comida</label><select class="input" id="fSlot">${[...SLOTS.map(s=>[s.k,s.n]),["extra","Extra"]].map(([k,nm])=>`<option value="${k}" ${k===(it.slot||"extra")?"selected":""}>${nm}</option>`).join("")}</select></div>`:""}
      <label class="row small"><input type="checkbox" id="fEst" ${v.estimated?"checked":""}> Valores estimados (sin etiqueta)</label>
      <div class="field"><label for="fNotes">Notas</label><textarea class="input" id="fNotes">${esc(v.notes)}</textarea></div>
      <button class="btn primary block" type="submit">${it?"Guardar cambios":"Registrar"}</button></form>`;
  }
  return h;
}

/* ---------- products ---------- */
function prodMacros(pr,g){const q=(n(g)||0)/100;const o={miss:{}};MK.forEach(k=>{const v=n(pr.per100&&pr.per100[k]);if(v==null){o[k]=null;o.miss[k]=1}else o[k]=v*q});return o}
function norm(x){return String(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")}
function productRows(q,act){
  const words=norm(q).split(/\s+/).filter(Boolean);
  const ps=Object.entries(D("products")).filter(([,p])=>{const hay=norm([p.name,p.brand,p.store,p.ean].join(" "));return words.every(w=>hay.includes(w))}).sort((a,b)=>(b[1].uses||0)-(a[1].uses||0)||a[1].name.localeCompare(b[1].name)).slice(0,60);
  if(!ps.length)return `<div class="empty">${q?"No está en tus productos.":"Aún no hay productos."}</div>${q&&q.length>=3&&!DEMO?`<button class="btn soft block" data-act="offSearch" data-q="${esc(q)}">Buscar «${esc(q)}» en Open Food Facts</button>`:""}`;
  return ps.map(([id,p])=>`<button class="list-btn" data-act="${act}" data-id="${id}"><span style="min-width:0"><span class="t" style="display:block">${esc(p.name)}</span><span class="small muted">${esc([p.brand,p.store,p.verified?"✓ etiqueta":""].filter(Boolean).join(" · "))}</span></span><span class="muted small num" style="text-align:right;white-space:nowrap">${fmt(p.per100&&p.per100.kcal,0)} kcal<br>P ${fmt(p.per100&&p.per100.p)} /100${esc(p.unit||"g")}</span></button>`).join("");
}
function vProductos(){
  const cnt=Object.keys(D("products")).length;
  return `<div class="stack"><div class="row wrap"><button class="btn primary sm" data-act="barcode" data-from="prod">▥ Código de barras</button>${S.canScan?`<button class="btn soft sm" data-act="scan" data-from="prod">📷 Etiqueta</button>`:""}<button class="btn soft sm" data-act="newProduct" data-from="prod">+ Producto</button></div>
  <input class="search" id="prodQ" placeholder="Buscar en ${cnt} productos…" value="${esc(S.ui.prodQ||"")}" data-act="prodQ" data-live="1">
  <div class="stack" id="prodGrid">${productRows(S.ui.prodQ||"","openProduct")}</div>
  <div class="note">Valores por 100 g o 100 ml. Los que llevan “✓ etiqueta” se han leído de tu envase; el resto son referencias de webs y conviene confirmarlos la próxima vez que los compres.</div></div>`;
}
function productSheet(){
  const d=S.ui.prodDraft;const c=S.ui.confirm==="prod:"+d._id;
  return sheetHead(d._id?"Editar producto":"Producto nuevo",d._scanned?"Leído de tu foto · revísalo":"")+`
  ${d._notes?`<div class="note">${esc(d._notes)}</div>`:""}
  ${d._dup?`<div class="note">Ya tenías un producto con este código de barras (${esc(d._dup)}). Al guardar, se actualizará.</div>`:""}
  <form class="stack" data-form="product">
  <div class="field"><label for="pdN">Nombre</label><input class="input" id="pdN" required value="${esc(d.name)}" placeholder="p. ej. Skyr natural"></div>
  <div class="grid2"><div class="field"><label for="pdB">Marca</label><input class="input" id="pdB" value="${esc(d.brand)}" placeholder="Hacendado"></div><div class="field"><label for="pdS">Supermercado</label><input class="input" id="pdS" value="${esc(d.store)}" placeholder="Mercadona" list="storeList"></div></div>
  <datalist id="storeList">${["Mercadona","Lidl","Carrefour","Dia","Alcampo","Consum","Aldi","Eroski"].map(x=>`<option value="${x}">`).join("")}</datalist>
  <div class="field"><label for="pdU">Valores por 100…</label><select class="input" id="pdU">${["g","ml"].map(u=>`<option ${d.unit===u?"selected":""}>${u}</option>`).join("")}</select></div>
  <div class="grid4"><div class="field"><label for="pdK">kcal</label><input class="input" id="pdK" type="number" step="any" inputmode="decimal" value="${d.per100.kcal??""}" required></div><div class="field"><label for="pdP">Prot.</label><input class="input" id="pdP" type="number" step="any" inputmode="decimal" value="${d.per100.p??""}"></div><div class="field"><label for="pdC">HC</label><input class="input" id="pdC" type="number" step="any" inputmode="decimal" value="${d.per100.c??""}"></div><div class="field"><label for="pdF">Grasa</label><input class="input" id="pdF" type="number" step="any" inputmode="decimal" value="${d.per100.f??""}"></div></div>
  <div class="grid2"><div class="field"><label for="pdSv">Ración habitual (g/ml)</label><input class="input" id="pdSv" type="number" step="any" value="${d.servingG??""}" placeholder="opcional"></div><div class="field"><label for="pdE">Código de barras</label><input class="input num" id="pdE" inputmode="numeric" value="${esc(d.ean)}" placeholder="opcional"></div></div>
  <label class="row small"><input type="checkbox" id="pdV" ${d.verified?"checked":""}> Comprobado con la etiqueta de mi envase</label>
  <button class="btn primary block" type="submit">Guardar producto</button></form>
  ${d._id?(c?`<span class="confirm">¿Borrar producto? <button class="btn sm danger" data-act="delProduct">Sí, borrar</button><button class="btn sm ghost" data-act="cancelConfirm">No</button></span>`:`<button class="btn ghost danger" data-act="askConfirm" data-k="prod:${d._id}">Borrar producto</button>`):""}`;
}
function scanSheet(){
  const sc=S.ui.scan;
  let h=sheetHead("Escanear etiqueta");
  h+=`<div class="note">Haz una foto de la <b>tabla nutricional</b> de cerca, recta, con buena luz y sin reflejos. ${CFG.aiScan?"Si quieres, añade otra del frontal para el nombre y la marca (máximo 2).":"Se lee en tu móvil, gratis. La primera vez descarga el lector (unos 5 MB, mejor con wifi)."}</div>
  <label class="btn soft block" for="scanFile" style="cursor:pointer">${sc.files.length?"📷 "+sc.files.length+" foto"+(sc.files.length>1?"s":"")+" lista"+(sc.files.length>1?"s":"")+" · cambiar":"📷 Hacer foto o elegir de la galería"}</label>
  <input type="file" id="scanFile" accept="image/*" multiple hidden>`;
  if(sc.status==="reading")h+=`<div class="empty" id="ocrProg">Leyendo la etiqueta…</div><button class="btn ghost" data-act="scanStop">Cancelar</button>`;
  else h+=`<button class="btn primary block" data-act="scanRun" ${sc.files.length?"":"disabled"}>Leer etiqueta</button>`;
  if(sc.status==="error")h+=`<div class="note" style="color:var(--bad)">${esc(sc.msg)}</div>`;
  return h;
}

async function shrink(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=url});
    const max=1600,sc=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement("canvas");c.width=Math.round(img.naturalWidth*sc);c.height=Math.round(img.naturalHeight*sc);
    c.getContext("2d").drawImage(img,0,0,c.width,c.height);
    return c.toDataURL("image/jpeg",0.85).split(",")[1];
  }finally{URL.revokeObjectURL(url)}
}
async function callScan(files,signal){
  const images=[];for(const f of files)images.push({data:await shrink(f),mediaType:"image/jpeg"});
  if(signal.aborted)throw {code:"cancelled"};
  const {data:{session}}=await sb.auth.getSession();
  const res=await fetch(CFG.supabaseUrl.replace(/\/$/,"")+"/functions/v1/scan-label",{method:"POST",signal,headers:{"Content-Type":"application/json",apikey:CFG.supabaseAnonKey,Authorization:"Bearer "+(session&&session.access_token)},body:JSON.stringify({images})});
  const out=await res.json().catch(()=>({}));
  if(!res.ok)throw {code:out.error||"upstream_error",message:out.message};
  return out.result||{};
}
/* ---------- lector de etiquetas gratis (OCR en el móvil) ---------- */
function parseLabel(raw){
  const text=String(raw||"").replace(/\r/g,"");
  const lines=text.split("\n").map(l=>l.trim()).filter(Boolean);
  const N=s=>{if(s==null)return null;const m=String(s).replace(/[oO](?=[,.]\d)/g,"0").match(/<?\s*(\d{1,4}(?:[.,]\d{1,2})?)/);if(!m)return null;const v=parseFloat(m[1].replace(",","."));return isFinite(v)?v:null};
  const numsIn=l=>(l.replace(/(\d)\s+([.,])\s*(\d)/g,"$1$2$3").match(/<?\s*\d{1,4}(?:[.,]\d{1,2})?/g)||[]).map(N).filter(v=>v!=null);
  const low=lines.map(l=>l.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,""));
  // kcal: "1234 kJ / 295 kcal", "295 kcal", "kcal 295"
  let kcal=null;
  const all=low.join("\n");
  let m=all.match(/kj\s*\/\s*kcal\D{0,12}(\d{1,5})\s*\/\s*(\d{1,4}(?:[.,]\d)?)/);
  if(m)kcal=N(m[2]);
  if(kcal==null){m=all.match(/(\d{1,4}(?:[.,]\d)?)\s*k?cal\b/);if(m)kcal=N(m[1])}
  if(kcal==null){m=all.match(/kcal\D{0,12}(\d{1,4}(?:[.,]\d)?)/);if(m)kcal=N(m[1])}
  if(kcal==null){m=all.match(/(\d{2,5})\s*kj/);if(m)kcal=Math.round(N(m[1])/4.184)}
  if(kcal!=null&&kcal>900)kcal=Math.round(kcal/4.184);
  const find=(re,not)=>{
    for(let i=0;i<low.length;i++){const l=low[i];if(!re.test(l)||(not&&not.test(l)))continue;
      const after=l.replace(re,"#").split("#").slice(1).join(" ");let ns=numsIn(after);
      if(!ns.length&&low[i+1]&&!/[a-z]{4,}|kj|kcal/.test(low[i+1]))ns=numsIn(low[i+1]);
      ns=ns.filter(v=>v<=100);
      if(ns.length)return ns[0];}
    return null;
  };
  const f=find(/\b(grasas?|lipidos?|materia grasa)\b/,/saturad|monoinsat|poliinsat|trans/);
  const c=find(/(hidratos de carbono|carbohidratos|hidratos)/,/azucar/);
  const p=find(/\bprote[i1l]nas?\b/);
  const unit=/100\s*ml/.test(all)?"ml":"g";
  const per100={kcal,p,c,f};
  const notes=[];
  const found=["kcal","p","c","f"].filter(k=>per100[k]!=null).length;
  if(kcal!=null&&p!=null&&c!=null&&f!=null){const calc=4*p+4*c+9*f;if(calc>0&&Math.abs(calc-kcal)/kcal>0.2)notes.push(`Ojo: con estos macros salen ${Math.round(calc)} kcal y la etiqueta dice ${Math.round(kcal)}. Revisa los números.`)}
  if(found<4)notes.push(`Solo he podido leer ${found} de 4 valores. Completa el resto mirando el envase.`);
  if(!/100\s*(g|ml)/.test(all))notes.push("No veo “por 100 g” en la foto: comprueba que son valores por 100.");
  return {per100,unit,found,notes:notes.join(" ")};
}
let ocrWorker=null;
async function ocrScan(files,signal,onProgress){
  if(!window.Tesseract)await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js");
  if(!ocrWorker)ocrWorker=await Tesseract.createWorker("spa",1,{logger:m=>{if(m.status&&onProgress)onProgress(m.status,m.progress)}});
  let text="";
  for(const f of files){
    if(signal.aborted)throw {code:"cancelled"};
    const url=await prepForOcr(f);
    const r=await ocrWorker.recognize(url);text+="\n"+(r.data&&r.data.text||"");
  }
  if(signal.aborted)throw {code:"cancelled"};
  const parsed=parseLabel(text);
  if(!parsed.found)throw {message:"No he encontrado la tabla nutricional en la foto. Acércate más, que la tabla salga recta y con buena luz, sin reflejos."};
  return {per100:parsed.per100,unit:parsed.unit,notes:parsed.notes,raw:text};
}
async function prepForOcr(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=url});
    const target=2000,sc=Math.min(2,target/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement("canvas");c.width=Math.round(img.naturalWidth*sc);c.height=Math.round(img.naturalHeight*sc);
    const x=c.getContext("2d");x.drawImage(img,0,0,c.width,c.height);
    const d=x.getImageData(0,0,c.width,c.height),a=d.data;
    for(let i=0;i<a.length;i+=4){let g=0.299*a[i]+0.587*a[i+1]+0.114*a[i+2];g=Math.max(0,Math.min(255,(g-128)*1.5+128));a[i]=a[i+1]=a[i+2]=g}
    x.putImageData(d,0,0);return c.toDataURL("image/png");
  }finally{URL.revokeObjectURL(url)}
}
async function runScan(){
  const sc=S.ui.scan;if(!S.canScan||!sc.files.length)return;
  sc.status="reading";sc.ctl=new AbortController();drawSheet();
  try{
    const r=CFG.aiScan?await callScan(sc.files,sc.ctl.signal):await ocrScan(sc.files,sc.ctl.signal,(st,pr)=>{const el=document.getElementById("ocrProg");if(el)el.textContent=({"loading tesseract core":"Preparando el lector…","initializing tesseract":"Preparando el lector…","loading language traineddata":"Descargando el idioma español (solo la primera vez)…","initializing api":"Preparando el lector…","recognizing text":"Leyendo… "+Math.round((pr||0)*100)+" %"})[st]||"Leyendo…"});
    if(!r.ean&&S.ui.pendingEan)r.ean=S.ui.pendingEan;S.ui.pendingEan=null;
    const per=(r&&r.per100)||{};
    const ean=r&&r.ean?String(r.ean).replace(/\D/g,""):"";
    const dupEntry=ean?Object.entries(D("products")).find(([,p])=>p.ean===ean):null;
    if(dupEntry&&MK.every(k=>n(per[k])==null)){sc.status="idle";afterProductPicked(dupEntry[0]);toast("Encontrado por código de barras: "+dupEntry[1].name);return}
    S.ui.prodDraft={_id:dupEntry?dupEntry[0]:null,_dup:dupEntry?dupEntry[1].name:null,_scanned:true,_notes:[CFG.aiScan?"":"Leído en tu móvil. Revisa cada número con el envase antes de guardar.",r.notes,r.confidence?"Confianza: "+r.confidence:""].filter(Boolean).join(" "),
      name:r.name||(dupEntry?dupEntry[1].name:""),brand:r.brand||"",store:r.store||"",ean,unit:r.unit==="ml"?"ml":"g",per100:{kcal:n(per.kcal),p:n(per.p),c:n(per.c),f:n(per.f)},servingG:n(r.servingG),verified:false};
    sc.status="idle";sc.files=[];openSheet(productSheet);
  }catch(e){
    if(e&&(e.code==="cancelled"||e.name==="AbortError")){sc.status="idle";drawSheet();return}
    sc.status="error";sc.msg=(e&&e.message)||({no_json:"No he podido sacar los datos de la foto. Prueba con una foto más recta y cercana de la tabla."})[e&&e.code]||(navigator.onLine?"No se ha podido leer la etiqueta. Inténtalo otra vez.":"Sin conexión: la lectura de etiquetas necesita internet.");
    drawSheet();
  }
}
/* ---------- código de barras y Open Food Facts ---------- */
const BRAND_STORE=[[/hacendado|bosque verde|deliplus|compy|steinburg/i,"Mercadona"],[/milbona|pikok|solevita|lidl|cien|freeway|deluxe/i,"Lidl"],[/carrefour/i,"Carrefour"],[/^dia\b|dia%/i,"Dia"],[/auchan|alcampo/i,"Alcampo"],[/consum/i,"Consum"],[/eroski/i,"Eroski"],[/aldi|milsani|gut bio/i,"Aldi"]];
function storeFor(brand){for(const [re,st] of BRAND_STORE)if(re.test(brand||""))return st;return ""}
function fromOFF(p,ean){
  const nu=p.nutriments||{};
  const kcal=nu["energy-kcal_100g"]!=null?+nu["energy-kcal_100g"]:nu["energy_100g"]!=null?Math.round(+nu["energy_100g"]/4.184):null;
  const brand=String(p.brands||"").split(",")[0].trim();
  const unit=/ml|cl|\bl\b/i.test(p.quantity||"")&&!/g\b/i.test(p.quantity||"")?"ml":"g";
  return {_id:null,_off:true,name:(p.product_name_es||p.product_name||"").trim(),brand,store:storeFor(brand)||String(p.stores||"").split(",")[0].trim(),ean:String(p.code||ean||""),unit,
    per100:{kcal:n(kcal),p:n(nu.proteins_100g),c:n(nu.carbohydrates_100g),f:n(nu.fat_100g)},servingG:n(p.serving_quantity),verified:false,source:"Open Food Facts"};
}
async function offByEan(ean){
  const r=await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(ean)}.json?fields=code,product_name,product_name_es,brands,stores,quantity,serving_quantity,nutriments`);
  if(!r.ok)return null;const j=await r.json();return j&&j.status===1&&j.product?fromOFF(j.product,ean):null;
}
async function offSearch(q){
  const u=`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=24&tagtype_0=countries&tag_contains_0=contains&tag_0=spain&fields=code,product_name,product_name_es,brands,stores,quantity,serving_quantity,nutriments`;
  const r=await fetch(u);if(!r.ok)throw new Error("Open Food Facts no responde");const j=await r.json();
  return (j.products||[]).map(p=>fromOFF(p)).filter(p=>p.name&&p.per100.kcal!=null);
}
async function handleEan(ean){
  ean=String(ean||"").replace(/\D/g,"");if(ean.length<8){toast("Código no válido");return}
  const hit=Object.entries(D("products")).find(([,p])=>p.ean===ean);
  if(hit){toast("Encontrado: "+hit[1].name);afterProductPicked(hit[0]);return}
  S.ui.bc={status:"lookup",ean};drawSheet();
  let d=null;try{d=await offByEan(ean)}catch(e){}
  if(d&&d.per100.kcal!=null){d._notes="Datos de Open Food Facts (base abierta, la rellenan voluntarios). Compruébalos con tu envase y marca la casilla si coinciden.";S.ui.prodDraft=d;openSheet(productSheet);return}
  S.ui.bc={status:"notfound",ean};S.ui.pendingEan=ean;drawSheet();
}
let bcStream=null,bcTimer=null,bcReader=null;
function stopCamera(){clearInterval(bcTimer);bcTimer=null;if(bcReader){try{bcReader.reset()}catch(e){}bcReader=null}if(bcStream){bcStream.getTracks().forEach(t=>t.stop());bcStream=null}}
function loadScript(src){return new Promise((res,rej)=>{const s=document.createElement("script");s.src=src;s.onload=res;s.onerror=()=>rej(new Error("No se pudo cargar el lector"));document.head.appendChild(s)})}
async function startCamera(){
  const v=document.getElementById("bcVideo");if(!v)return;
  const onCode=code=>{if(!code)return;stopCamera();if(navigator.vibrate)navigator.vibrate(60);handleEan(code)};
  try{
    if("BarcodeDetector" in window){
      const fm=await BarcodeDetector.getSupportedFormats().catch(()=>[]);
      if(fm.includes("ean_13")){
        bcStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280}},audio:false});
        v.srcObject=bcStream;await v.play();
        const det=new BarcodeDetector({formats:["ean_13","ean_8","upc_a","upc_e"]});
        bcTimer=setInterval(async()=>{if(v.readyState<2)return;try{const r=await det.detect(v);if(r&&r[0])onCode(r[0].rawValue)}catch(e){}},250);
        return;
      }
    }
    if(!window.ZXing)await loadScript("https://unpkg.com/@zxing/library@0.20.0/umd/index.min.js");
    const hints=new Map();hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,[ZXing.BarcodeFormat.EAN_13,ZXing.BarcodeFormat.EAN_8,ZXing.BarcodeFormat.UPC_A,ZXing.BarcodeFormat.UPC_E]);
    bcReader=new ZXing.BrowserMultiFormatReader(hints);
    await bcReader.decodeFromConstraints({video:{facingMode:{ideal:"environment"}}},v,(res)=>{if(res)onCode(res.getText())});
  }catch(e){S.ui.bc={status:"camerr",msg:e&&e.name==="NotAllowedError"?"No has dado permiso a la cámara. Actívalo en los ajustes del navegador para esta web.":"No se ha podido abrir la cámara. Escribe el número del código de barras abajo."};drawSheet()}
}
function barcodeSheet(){
  const bc=S.ui.bc||{status:"scan"};
  let h=sheetHead("Escanear código de barras");
  if(bc.status==="scan")h+=`<div style="position:relative;border-radius:var(--r);overflow:hidden;background:#000;aspect-ratio:4/3;max-width:100%"><video id="bcVideo" playsinline muted style="width:100%;height:100%;object-fit:cover"></video><div style="position:absolute;left:12%;right:12%;top:42%;height:16%;border:2px solid rgb(255 255 255/.8);border-radius:10px"></div></div><div class="small muted">Centra el código de barras en el recuadro.</div>`;
  if(bc.status==="lookup")h+=`<div class="empty">Buscando el código ${esc(bc.ean)}…</div>`;
  if(bc.status==="camerr")h+=`<div class="note">${esc(bc.msg)}</div>`;
  if(bc.status==="notfound")h+=`<div class="note">El código <b class="num">${esc(bc.ean)}</b> no está en tus productos ni en Open Food Facts. Haz una foto de la tabla nutricional y lo guardamos con este código para la próxima vez.</div>${S.canScan?`<button class="btn primary block" data-act="scan" data-from="keep">📷 Escanear etiqueta</button>`:""}<button class="btn soft block" data-act="newProductEan">Crear a mano</button>`;
  h+=`<form class="row" data-form="ean"><input class="input num" id="eanIn" inputmode="numeric" placeholder="O escribe el número del código" style="flex:1"><button class="btn soft" type="submit">Buscar</button></form>`;
  return h;
}
function offSheet(){
  const st=S.ui.off;
  let h=sheetHead("Open Food Facts","Buscar «"+st.q+"»");
  if(st.status==="loading")h+=`<div class="empty">Buscando…</div>`;
  else if(st.status==="error")h+=`<div class="note">${esc(st.msg)}</div>`;
  else if(!st.items.length)h+=`<div class="empty">Sin resultados. Prueba con otras palabras o escanea la etiqueta.</div>`;
  else h+=`<div class="stack">${st.items.map((p,i)=>`<button class="list-btn" data-act="pickOff" data-i="${i}"><span style="min-width:0"><span class="t" style="display:block">${esc(p.name)}</span><span class="small muted">${esc([p.brand,p.store].filter(Boolean).join(" · "))}</span></span><span class="muted small num" style="white-space:nowrap">${fmt(p.per100.kcal,0)} kcal<br>P ${fmt(p.per100.p)}</span></button>`).join("")}</div>`;
  return h+`<div class="small muted">Datos de Open Food Facts, base abierta (licencia ODbL). Revisa los valores con tu envase.</div>`;
}
function afterProductPicked(id){
  const from=S.ui.prodFrom;
  if(from&&from.type==="food"){S.ui.food={tab:"productos",sel:id,pq:""};const d=from.date,sl=from.slot;openSheet(()=>foodSheet(d,sl))}
  else if(from&&from.type==="recipe"){const ing=S.ui.recDraft.ingredients[from.ix];const p=D("products")[id];if(ing&&p){ing.name=p.name;ing.unit=p.unit||"g";ing.per100=Object.assign({},p.per100);ing.productId=id}openSheet(recipeEditSheet)}
  else if(from&&from.type==="keep"){closeSheet()}
  else closeSheet();
}
function bumpUse(id){const p=D("products")[id];if(p)save("products/"+id,Object.assign({},p,{uses:(p.uses||0)+1}))}

function ingPickSheet(){return `<div class="sheet-h"><div><div class="eyebrow">Ingrediente</div><h2>Elegir producto</h2></div><button class="btn ghost" data-act="backToRecipe">‹ Volver</button></div><input class="search" id="ingPQ" placeholder="Buscar producto…" value="${esc(S.ui.pickQ||"")}" data-act="ingPQ"><div class="stack">${productRows(S.ui.pickQ||"","pickIng")}</div><div class="row wrap"><button class="btn soft" data-act="barcode" data-from="recipe">▥ Código de barras</button>${S.canScan?`<button class="btn soft" data-act="scan" data-from="recipe">📷 Etiqueta</button>`:""}</div>`}

/* goals sheet */
function goalsSheet(){
  const g=goals(),cfg=D("config").main||{};const gr=Object.assign({},g,cfg.goalsRest||{});
  const kcalFromMacros=g.p*4+g.c*4+g.f*9;
  return sheetHead("Objetivos diarios")+`<form class="stack" data-form="goals">
  <div class="grid4"><div class="field"><label for="gK">kcal</label><input class="input" id="gK" type="number" value="${g.kcal}"></div><div class="field"><label for="gP">Prot. g</label><input class="input" id="gP" type="number" value="${g.p}"></div><div class="field"><label for="gC">HC g</label><input class="input" id="gC" type="number" value="${g.c}"></div><div class="field"><label for="gF">Grasa g</label><input class="input" id="gF" type="number" value="${g.f}"></div></div>
  <div class="eyebrow" style="margin-top:4px">Días de descanso (sin rutina asignada)</div>
  <div class="grid4"><div class="field"><label for="gKr">kcal</label><input class="input" id="gKr" type="number" value="${cfg.goalsRest?gr.kcal:""}" placeholder="igual"></div><div class="field"><label for="gPr">Prot. g</label><input class="input" id="gPr" type="number" value="${cfg.goalsRest?gr.p:""}" placeholder="igual"></div><div class="field"><label for="gCr">HC g</label><input class="input" id="gCr" type="number" value="${cfg.goalsRest?gr.c:""}" placeholder="igual"></div><div class="field"><label for="gFr">Grasa g</label><input class="input" id="gFr" type="number" value="${cfg.goalsRest?gr.f:""}" placeholder="igual"></div></div>
  <div class="note num">Días de gym: tus macros suman ${fmt(kcalFromMacros,0)} kcal (P×4 + HC×4 + G×9).${cfg.profile?` Proteína: ${fmt(g.p/cfg.profile.weightKg,2)} g por kg de peso.`:""}</div>
  ${cfg.explanation?`<div class="small muted">${esc(cfg.explanation)}</div>`:""}
  <button class="btn primary block" type="submit">Guardar objetivos</button></form>`;
}

/* =========================================================
   SEMANA
   ========================================================= */
function vSemana(){
  const wk=S.week,g=goals();
  let h=`<div class="stack-lg"><div class="stack"><div class="eyebrow">Planificación</div><h1>Tu semana</h1>
  <div class="seg"><button class="${S.ui.semTab==="comidas"?"on":""}" data-act="semTab" data-t="comidas">Comidas</button><button class="${S.ui.semTab==="entreno"?"on":""}" data-act="semTab" data-t="entreno">Entreno</button></div>
  <div class="between"><button class="btn soft sm" data-act="shiftWeek" data-n="-7">‹ Anterior</button><b class="num">${dm(wk)} – ${dm(addDays(wk,6))}</b><button class="btn soft sm" data-act="shiftWeek" data-n="7">Siguiente ›</button></div></div>`;
  if(S.ui.semTab==="entreno")return h+semEntreno(wk)+`</div>`;
  const days=Array.from({length:7},(_,i)=>addDays(wk,i));
  let totK=0,totP=0,kDays=0,lowP=0,libres=0;
  days.forEach(d=>{const t=dayPlanTotals(d);libres+=t.libre;if(!t.libre&&!t.empty){totK+=t.m.kcal;totP+=t.m.p;kDays++;if(t.m.p<goals(d).p*.9)lowP++}});
  h+=`<div class="card stack"><div class="between"><h3>Resumen del plan</h3><button class="btn primary sm" data-act="shopping">Lista de la compra</button></div>
  <div class="stats"><div class="stat"><b class="num">${kDays?fmt(totK/kDays,0):"—"}</b><span>kcal/día media*</span></div><div class="stat"><b class="num">${kDays?fmt(totP/kDays,0):"—"}</b><span>g proteína/día*</span></div><div class="stat"><b class="num">${lowP}</b><span>días bajo ${fmt(g.p*.9,0)} g P</span></div></div>
  <div class="small muted">*Media de los ${kDays} días planificados completos. ${libres?libres+" comidas libres no cuentan.":""} Objetivo: ${(D("config").main||{}).goalsRest?`${g.kcal} kcal días de gym · ${Object.assign({},g,(D("config").main||{}).goalsRest).kcal} kcal descanso`:g.kcal+" kcal"} y ${g.p} g de proteína.</div></div>`;
  days.forEach((d,i)=>{
    const p=dayPlan(d),t=dayPlanTotals(d),gd=goals(d),rt=routineFor(d);
    h+=`<div class="card day ${d===todayStr()?"today":""}"><div class="day-h"><h3>${DOWL[i]} <span class="muted small" style="font-family:var(--font-body)">${dm(d)}${d===todayStr()?" · hoy":""}</span></h3><div class="row">${kcalChip(t.m.kcal,gd.kcal,t.libre||t.empty?"≥ ":"")}${protChip(t.m.p,gd.p)}</div></div><div class="small muted">${rt?"🏋 "+esc(rt.name)+" · objetivo "+gd.kcal+" kcal":"Descanso · objetivo "+gd.kcal+" kcal"}</div>`;
    SLOTS.forEach(s=>{const e=p[s.k];h+=`<button class="prow" data-act="planSlot" data-d="${d}" data-slot="${s.k}"><span class="s">${s.n}</span><span class="n ${e?"":"empty"}">${e?esc(e.title)+(e.serv&&e.serv!==1?" × "+fmt(e.serv):""):s.opt?"—":"+ Elegir"}</span><span class="k num">${e&&!e.libre?fmt(e.m.kcal,0):""}</span></button>`});
    h+=`</div>`;
  });
  return h+`<div class="row wrap"><button class="btn soft" data-act="copyWeek">Copiar esta semana a la siguiente</button></div></div>`;
}
function semEntreno(wk){
  const sch=((D("config").main||{}).schedule)||{};
  let h=`<div class="note">Asigna una rutina a cada día de la semana. Se repite todas las semanas; debajo ves lo que hiciste realmente.</div>`;
  for(let i=0;i<7;i++){const d=addDays(wk,i);const r=sch[i]&&D("routines")[sch[i]];const done=workoutsOn(d);
    h+=`<div class="card day ${d===todayStr()?"today":""}"><div class="day-h"><h3>${DOWL[i]} <span class="muted small" style="font-family:var(--font-body)">${dm(d)}</span></h3>${done.length?`<span class="chip ok">✓ Hecho</span>`:d<todayStr()&&r?`<span class="chip warn">No registrado</span>`:""}</div>
    <button class="prow" data-act="assignRoutine" data-i="${i}"><span class="s">Plan</span><span class="n ${r?"":"empty"}">${r?esc(r.name):"Descanso · tocar para asignar"}</span><span class="k">${r?(r.exercises||[]).length+" ej.":""}</span></button>
    ${done.map(w=>`<div class="prow" style="cursor:default"><span class="s">Hecho</span><span class="n">${esc(w.name)}</span><span class="k num">${w.durationMin?fmt(w.durationMin,0)+"′":""}</span></div><div class="setlist num">${workoutSummary(w)}</div>`).join("")}</div>`}
  return h;
}
function planSlotSheet(date,slot){
  const st=S.ui.ps||(S.ui.ps={q:""});const cur=(D("plan")[date]||{})[slot];
  const rs=Object.entries(D("recipes")).filter(([,r])=>!st.q||r.title.toLowerCase().includes(st.q.toLowerCase())).sort((a,b)=>{const pa=(a[1].slots||[]).includes(slot)?0:1,pb=(b[1].slots||[]).includes(slot)?0:1;return pa-pb||a[1].title.localeCompare(b[1].title)});
  return sheetHead(SLOTN[slot],longDate(date))+`
  <div class="row wrap"><button class="btn soft sm" data-act="setPlan" data-v="libre">Comida libre</button><button class="btn soft sm" data-act="setPlan" data-v="">Dejar vacío</button><button class="btn soft sm" data-act="planCustom">Algo puntual…</button></div>
  <div class="field"><label for="psServ">Raciones</label><input class="input" id="psServ" type="number" step="0.25" min="0.25" value="${cur&&cur.servings||1}" inputmode="decimal"></div>
  <input class="search" id="psQ" placeholder="Buscar receta…" value="${esc(st.q)}" data-act="psQ">
  <div class="stack">${rs.map(([id,r])=>{const m=recipeMacros(r);const on=cur&&cur.type==="recipe"&&cur.id===id;return `<button class="list-btn" data-act="setPlan" data-v="r:${id}" ${on?'style="border-color:var(--forest)"':""}><span class="t">${on?"✓ ":""}${esc(r.title)}</span><span class="muted small num">${fmt(m.kcal,0)} kcal · P ${fmt(m.p,0)}</span></button>`}).join("")}</div>`;
}
function customPlanSheet(date,slot){
  return sheetHead("Algo puntual",SLOTN[slot]+" · "+longDate(date))+`<form class="stack" data-form="planCustom" data-d="${date}" data-slot="${slot}"><div class="field"><label for="pcN">Nombre</label><input class="input" id="pcN" required></div><div class="grid4"><div class="field"><label for="pcK">kcal</label><input class="input" id="pcK" type="number" step="any"></div><div class="field"><label for="pcP">Prot.</label><input class="input" id="pcP" type="number" step="any"></div><div class="field"><label for="pcC">HC</label><input class="input" id="pcC" type="number" step="any"></div><div class="field"><label for="pcF">Grasa</label><input class="input" id="pcF" type="number" step="any"></div></div><button class="btn primary block" type="submit">Planificar</button></form>`;
}
function shoppingSheet(){
  const wk=S.week;const agg={};
  for(let i=0;i<7;i++){const p=dayPlan(addDays(wk,i));SLOTS.forEach(s=>{const e=p[s.k];if(!e||!e.recipe||!e.recipe.ingredients)return;const base=e.recipe.servings||1;e.recipe.ingredients.forEach(ing=>{const name=ing.name.replace(/\s*·\s*(estimado|referencia.*|seco)$/i,"").trim();const key=name+"|"+(ing.unit||"g");agg[key]=agg[key]||{name,unit:ing.unit||"g",qty:0,uses:0};agg[key].qty+=(n(ing.qty)||0)/base*e.serv;agg[key].uses++})})}
  const checks=((D("shopping")[wk]||{}).checked)||{};
  const list=Object.entries(agg).sort((a,b)=>(checks[a[0]]?1:0)-(checks[b[0]]?1:0)||a[1].name.localeCompare(b[1].name));
  const left=list.filter(([k])=>!checks[k]).length;
  return sheetHead("Lista de la compra",dm(wk)+" – "+dm(addDays(wk,6)))+`<div class="note">Sale de las recetas planificadas esta semana (${list.length} productos, te faltan ${left}). Las comidas libres y la merienda flexible no suman ingredientes.</div>
  <div class="stack">${list.map(([k,v])=>`<label class="list-btn" style="cursor:pointer"><span class="row" style="min-width:0"><input type="checkbox" data-act="shopCheck" data-k="${esc(k)}" ${checks[k]?"checked":""}><span class="t" style="${checks[k]?"text-decoration:line-through;color:var(--muted)":""}">${esc(v.name)}</span></span><span class="muted small num" style="white-space:nowrap">${fmt(v.qty,0)} ${esc(v.unit)}</span></label>`).join("")||`<div class="empty">Planifica recetas en la semana para generar la lista.</div>`}</div>
  ${Object.keys(checks).length?`<button class="btn soft" data-act="shopReset">Desmarcar todo</button>`:""}`;
}
function routinePickSheet(i){
  const sch=((D("config").main||{}).schedule)||{};
  return sheetHead("Rutina del "+DOWL[i].toLowerCase())+`<div class="stack"><button class="list-btn" data-act="setSchedule" data-i="${i}" data-r=""><span class="t">${!sch[i]?"✓ ":""}Descanso</span></button>${Object.entries(D("routines")).map(([id,r])=>`<button class="list-btn" data-act="setSchedule" data-i="${i}" data-r="${id}"><span class="t">${sch[i]===id?"✓ ":""}${esc(r.name)}</span><span class="muted small">${(r.exercises||[]).length} ejercicios</span></button>`).join("")}</div><button class="btn soft" data-act="editRoutine" data-id="">+ Crear rutina nueva</button>`;
}

/* =========================================================
   RECETAS
   ========================================================= */
function vRecetas(){
  const all=Object.entries(D("recipes"));
  const seg=`<div class="seg"><button class="${S.ui.recTab!=="productos"?"on":""}" data-act="recTab" data-t="recetas">Recetas</button><button class="${S.ui.recTab==="productos"?"on":""}" data-act="recTab" data-t="productos">Productos</button></div>`;
  if(S.ui.recTab==="productos")return `<div class="stack-lg"><div class="stack"><div><div class="eyebrow">Tu despensa</div><h1>Mis productos</h1></div>${seg}</div>${vProductos()}</div>`;
  return `<div class="stack-lg"><div class="stack"><div class="between"><div><div class="eyebrow">A tu gusto</div><h1>Mis recetas</h1></div><button class="btn primary sm" data-act="editRecipe" data-id="">+ Nueva</button></div>${seg}
  <input class="search" id="recQ" placeholder="Buscar por nombre o ingrediente…" value="${esc(S.ui.recQ)}" data-act="recQ" data-live="1">
  <div class="seg"><button class="${S.ui.recFilter==="todas"?"on":""}" data-act="recFilter" data-t="todas">Todas</button><button class="${S.ui.recFilter==="fav"?"on":""}" data-act="recFilter" data-t="fav">★ Favoritas</button><button class="${S.ui.recFilter==="prot"?"on":""}" data-act="recFilter" data-t="prot">Más proteicas</button></div></div>
  <div class="rgrid" id="recGrid">${recipeCards(all)}</div></div>`;
}
function recipeCards(all){
  const q=S.ui.recQ.toLowerCase();
  let rs=all.filter(([,r])=>!q||r.title.toLowerCase().includes(q)||(r.ingredients||[]).some(i=>i.name.toLowerCase().includes(q)));
  if(S.ui.recFilter==="fav")rs=rs.filter(([,r])=>r.fav);
  rs=rs.map(([id,r])=>[id,r,recipeMacros(r)]);
  if(S.ui.recFilter==="prot")rs.sort((a,b)=>(b[2].p/(b[2].kcal||1))-(a[2].p/(a[2].kcal||1)));else rs.sort((a,b)=>a[1].title.localeCompare(b[1].title));
  if(!rs.length)return `<div class="empty" style="grid-column:1/-1">${all.length?"Nada coincide con la búsqueda.":"Aún no tienes recetas. Crea la primera con “+ Nueva”."}</div>`;
  return rs.map(([id,r,m])=>`<button class="card rcard" data-act="openRecipe" data-id="${id}"><div class="between"><span class="eyebrow">${esc((r.slots||[]).map(s=>SLOTN[s]).join(" · ")||"Receta")}</span>${r.fav?"<span>★</span>":""}</div><div class="t">${esc(r.title)}</div><div class="kc num">${fmt(m.kcal,0)} <span class="muted small" style="font-family:var(--font-body)">kcal</span></div><div class="row wrap small num"><span class="mk"><i class="dot" style="background:var(--p)"></i>${fmt(m.p,0)}</span><span class="mk"><i class="dot" style="background:var(--c)"></i>${fmt(m.c,0)}</span><span class="mk"><i class="dot" style="background:var(--f)"></i>${fmt(m.f,0)}</span></div><div class="pdens num">${m.kcal?fmt(m.p/m.kcal*100,1)+" g prot. por 100 kcal":""}</div></button>`).join("");
}
function recipeSheet(id){
  const r=D("recipes")[id];if(!r)return sheetHead("Receta")+`<div class="empty">Esta receta ya no existe.</div>`;
  const m=recipeMacros(r),base=r.servings||1;const c=S.ui.confirm==="rec:"+id;
  return sheetHead(r.title,(r.slots||[]).map(s=>SLOTN[s]).join(" · ")||"Receta")+`
  <div class="card"><div class="row wrap small">${macroLine(m)}</div><div class="small muted" style="margin-top:6px">Por ración${base>1?" (receta para "+base+")":""}.</div></div>
  ${r.ingredients&&r.ingredients.length?`<div><h3 style="margin-bottom:4px">Ingredientes</h3>${r.ingredients.map(i=>{const k=n(i.per100&&i.per100.kcal);return `<div class="ing"><span>${esc(i.name)}</span><span class="num muted">${k!=null?fmt(k*(n(i.qty)||0)/100,0)+" kcal":""}</span><span class="q num">${fmt(n(i.qty),0)} ${esc(i.unit||"g")}</span></div>`}).join("")}</div>`:""}
  ${r.steps?`<div><h3 style="margin-bottom:4px">Preparación</h3><div class="small" style="white-space:pre-wrap">${esc(r.steps)}</div></div>`:""}
  ${r.notes?`<div class="note">${esc(r.notes)}</div>`:""}
  <div class="row wrap"><button class="btn primary sm" data-act="recToToday" data-id="${id}">+ Registrar hoy</button><button class="btn soft sm" data-act="favRecipe" data-id="${id}">${r.fav?"★ Quitar de favoritas":"☆ Favorita"}</button><button class="btn soft sm" data-act="editRecipe" data-id="${id}">Editar</button>
  ${c?`<span class="confirm">¿Borrar receta? <button class="btn sm danger" data-act="delRecipe" data-id="${id}">Sí, borrar</button><button class="btn sm ghost" data-act="cancelConfirm">No</button></span>`:`<button class="btn ghost sm danger" data-act="askConfirm" data-k="rec:${id}">Borrar</button>`}</div>`;
}
function recipeEditSheet(){
  const d=S.ui.recDraft;const m=recipeMacros(d);
  return sheetHead(d._id?"Editar receta":"Nueva receta")+`<form class="stack" data-form="recipe">
  <div class="field"><label for="reT">Nombre</label><input class="input" id="reT" required value="${esc(d.title)}" data-rd="title"></div>
  <div class="grid2"><div class="field"><label for="reS">Raciones que salen</label><input class="input" id="reS" type="number" min="1" step="1" value="${d.servings||1}" data-rd="servings"></div>
  <div class="field"><label>Sirve para</label><div class="row wrap">${SLOTS.map(s=>`<label class="chip"><input type="checkbox" data-rslot="${s.k}" ${(d.slots||[]).includes(s.k)?"checked":""}> ${s.n}</label>`).join("")}</div></div></div>
  <div><div class="between"><h3>Ingredientes</h3><span class="small muted">Valores por 100 g o 100 ml</span></div>
  ${(d.ingredients||[]).map((i,ix)=>`<div class="ingedit"><div class="row" style="min-width:0"><input class="input" placeholder="Ingrediente" value="${esc(i.name)}" data-ri="${ix}" data-f="name" aria-label="Ingrediente" list="prodList"><button type="button" class="btn ghost sm" data-act="ingFromProduct" data-ix="${ix}" aria-label="Buscar en mis productos" title="Buscar en mis productos">🔎</button></div><input class="input" type="number" step="any" placeholder="Cant." value="${i.qty??""}" data-ri="${ix}" data-f="qty" aria-label="Cantidad"><select class="input" data-ri="${ix}" data-f="unit" aria-label="Unidad">${["g","ml"].map(u=>`<option ${i.unit===u?"selected":""}>${u}</option>`).join("")}</select>
  <div class="g4">${MK.map(k=>`<input class="input" type="number" step="any" placeholder="${{kcal:"kcal",p:"P",c:"HC",f:"G"}[k]}/100" value="${i.per100&&i.per100[k]!=null?i.per100[k]:""}" data-ri="${ix}" data-f="${k}" aria-label="${k} por 100">`).join("")}<button type="button" class="btn ghost sm" data-act="rmIng" data-ix="${ix}" aria-label="Quitar">✕</button></div></div>`).join("")}
  <datalist id="prodList">${Object.values(D("products")).map(p=>`<option value="${esc(p.name)}">`).join("")}</datalist>
  <button type="button" class="btn soft sm" data-act="addIng" style="margin-top:8px">+ Ingrediente</button><div class="small muted" style="margin-top:6px">Escribe o toca 🔎 para elegir de tus productos: los valores se rellenan solos.</div></div>
  ${!(d.ingredients||[]).length?`<div><h3>O macros directos por ración</h3><div class="grid4" style="margin-top:6px">${MK.map(k=>`<div class="field"><label>${{kcal:"kcal",p:"Prot.",c:"HC",f:"Grasa"}[k]}</label><input class="input" type="number" step="any" value="${d[k]??""}" data-rd="${k}"></div>`).join("")}</div></div>`:""}
  <div class="field"><label for="reSt">Preparación</label><textarea class="input" id="reSt" data-rd="steps">${esc(d.steps)}</textarea></div>
  <div class="card"><div class="row wrap small" id="reTot">${macroLine(m)}</div><div class="small muted">Por ración</div></div>
  <button class="btn primary block" type="submit">Guardar receta</button></form>`;
}

/* =========================================================
   ENTRENO
   ========================================================= */
function wVolume(w){if(w.exercises&&w.exercises.length)return w.exercises.reduce((a,e)=>a+(e.sets||[]).reduce((b,s)=>b+(n(s.kg)||0)*(n(s.reps)||0),0),0);return n(w.summary&&w.summary.volume)}
function wSets(w){if(w.exercises&&w.exercises.length)return w.exercises.reduce((a,e)=>a+(e.sets||[]).length,0);return n(w.summary&&w.summary.sets)}
function workoutSummary(w){return `${w.exercises&&w.exercises.length?w.exercises.length+" ejercicios · ":""}${fmt(wSets(w),0)} series · ${fmt(wVolume(w),0)} kg${w.kcal?" · "+fmt(w.kcal,0)+" kcal":""}`}
function lastFor(name,beforeDate){
  const ws=Object.values(D("workouts")).filter(w=>(!beforeDate||w.date<=beforeDate)&&(w.exercises||[]).some(e=>e.name.toLowerCase()===name.toLowerCase())).sort((a,b)=>b.date.localeCompare(a.date));
  if(!ws.length)return null;const e=ws[0].exercises.find(e=>e.name.toLowerCase()===name.toLowerCase());return {date:ws[0].date,sets:e.sets||[]};
}
function e1rm(kg,reps){return kg*(1+reps/30)}
function exerciseNames(){const s=new Set();Object.values(D("workouts")).forEach(w=>(w.exercises||[]).forEach(e=>s.add(e.name)));Object.values(D("routines")).forEach(r=>(r.exercises||[]).forEach(e=>s.add(e.name)));return [...s].sort()}
function vEntreno(){
  const ws=Object.entries(D("workouts")).sort((a,b)=>b[1].date.localeCompare(a[1].date));
  const draft=S.draft||lsGet("mp-draft");
  const exs=exerciseNames().filter(x=>Object.values(D("workouts")).some(w=>(w.exercises||[]).some(e=>e.name===x)));
  if(!S.ui.exSel&&exs.length)S.ui.exSel=exs[0];
  let h=`<div class="stack-lg"><div class="stack"><div class="eyebrow">Fuerza</div><h1>Entreno</h1>
  ${draft?`<div class="card between"><div><b>Sesión a medias</b><div class="small muted">${esc(draft.name||"Sesión")} · ${dm(draft.date)}</div></div><button class="btn primary sm" data-act="resumeWorkout">Continuar</button></div>`:""}
  <div class="row wrap"><button class="btn primary" data-act="startWorkout" data-r="" data-d="${todayStr()}">Empezar sesión</button><button class="btn soft" data-act="editRoutine" data-id="">+ Rutina</button></div></div>`;
  // routines
  const rs=Object.entries(D("routines"));
  h+=`<section class="stack"><h2>Tus rutinas</h2>${rs.length?rs.map(([id,r])=>`<div class="card stack"><div class="between"><h3 style="font-size:16px">${esc(r.name)}</h3><div class="row"><button class="btn ghost sm" data-act="editRoutine" data-id="${id}">Editar</button><button class="btn soft sm" data-act="startWorkout" data-r="${id}" data-d="${todayStr()}">Empezar</button></div></div><div class="setlist">${(r.exercises||[]).map(e=>`<span>${esc(e.name)} <span class="num">${e.sets||""}×${esc(e.reps||"")}</span></span>`).join("")}</div></div>`).join(""):`<div class="empty card">Crea tus rutinas (por ejemplo, Torso A, Pierna B…) para empezar las sesiones con los ejercicios ya puestos.</div>`}</section>`;
  // progression
  if(exs.length){
    const pts=Object.values(D("workouts")).filter(w=>(w.exercises||[]).some(e=>e.name===S.ui.exSel)).sort((a,b)=>a.date.localeCompare(b.date)).map(w=>{const e=w.exercises.find(e=>e.name===S.ui.exSel);const top=Math.max(...(e.sets||[]).map(s=>n(s.kg)||0));const best=Math.max(...(e.sets||[]).map(s=>e1rm(n(s.kg)||0,n(s.reps)||0)));return {date:w.date,top,best}});
    const last=pts[pts.length-1];
    h+=`<section class="card stack"><div class="between wrap"><h2>Progresión</h2><select class="input" style="width:auto;max-width:100%" id="exSel" data-act="exSel">${exs.map(x=>`<option ${x===S.ui.exSel?"selected":""}>${esc(x)}</option>`).join("")}</select></div>
    ${pts.length>1?lineChart(pts.map(p=>({x:p.date,y:p.top})),{unit:"kg"}):`<div class="note">Con ${pts.length} sesión registrada aún no hay línea. A partir de la segunda verás cómo sube la carga.</div>`}
    ${last?`<div class="stats"><div class="stat"><b class="num">${fmt(last.top)}</b><span>kg máx. última vez</span></div><div class="stat"><b class="num">${fmt(last.best,0)}</b><span>1RM estimado</span></div><div class="stat"><b class="num">${pts.length}</b><span>sesiones</span></div></div>`:""}</section>`;
  }
  // history
  h+=`<section class="stack"><h2>Historial</h2>${ws.length?ws.map(([id,w])=>{const c=S.ui.confirm==="w:"+id;return `<details class="card"><summary class="stack" style="gap:4px"><div class="between"><h3 style="font-size:16px">${esc(w.name)}</h3><span class="muted small">${esc(longDate(w.date))}</span></div><div class="setlist num">${w.durationMin?`<span>${fmt(w.durationMin,0)} min</span>`:""}<span>${workoutSummary(w)}</span></div></summary>
  <div class="stack" style="margin-top:10px">${(w.exercises||[]).map(e=>`<div><b class="small">${esc(e.name)}</b><div class="setlist num">${(e.sets||[]).map(s=>`<span>${fmt(n(s.reps),0)} × ${fmt(n(s.kg))} kg</span>`).join("")}</div></div>`).join("")||`<div class="small muted">Sin detalle por ejercicio.</div>`}
  ${w.notes?`<div class="note">${esc(w.notes)}</div>`:""}
  <div class="row wrap">${(w.exercises||[]).length?`<button class="btn soft sm" data-act="repeatWorkout" data-id="${id}">Repetir</button>`:""}<button class="btn soft sm" data-act="editWorkout" data-id="${id}">Editar</button>${c?`<span class="confirm">¿Borrar? <button class="btn sm danger" data-act="delWorkout" data-id="${id}">Sí</button><button class="btn sm ghost" data-act="cancelConfirm">No</button></span>`:`<button class="btn ghost sm danger" data-act="askConfirm" data-k="w:${id}">Borrar</button>`}</div></div></details>`}).join(""):`<div class="empty card">Aún no hay sesiones.</div>`}</section></div>`;
  return h;
}
function newDraft(routineId,date,fromWorkout){
  let exs=[],name="Sesión";
  if(fromWorkout){name=fromWorkout.name;exs=(fromWorkout.exercises||[]).map(e=>({name:e.name,target:"",sets:(e.sets||[]).map(()=>({kg:"",reps:""}))}))}
  else if(routineId&&D("routines")[routineId]){const r=D("routines")[routineId];name=r.name;exs=(r.exercises||[]).map(e=>({name:e.name,target:(e.sets||3)+"×"+(e.reps||""),sets:Array.from({length:+e.sets||3},()=>({kg:"",reps:""}))}))}
  exs.forEach(e=>{const l=lastFor(e.name);if(l)e.sets=e.sets.map((s,i)=>{const ls=l.sets[i]||l.sets[l.sets.length-1]||{};return {kg:"",reps:"",phk:ls.kg??"",ph:ls.reps??""}})});
  return {id:null,date,name,routineId:routineId||null,start:Date.now(),exercises:exs,notes:"",durationMin:""};
}
function persistDraft(){lsSet("mp-draft",S.draft)}
function loggerSheet(){
  const d=S.draft;const names=exerciseNames();
  let h=sheetHead(d.id?"Editar sesión":"Sesión en curso",longDate(d.date))+`<div class="grid2"><div class="field"><label for="wN">Nombre</label><input class="input" id="wN" value="${esc(d.name)}" data-dw="name"></div><div class="field"><label for="wD">Fecha</label><input class="input" id="wD" type="date" value="${d.date}" data-dw="date"></div></div>`;
  d.exercises.forEach((e,ei)=>{const l=lastFor(e.name,d.id?addDays(d.date,-1):null);
    h+=`<div class="card ex"><div class="between"><input class="input" style="font-weight:600" value="${esc(e.name)}" placeholder="Ejercicio" list="exList" data-ex="${ei}" data-f="name" aria-label="Ejercicio"><button class="btn ghost sm" data-act="rmEx" data-ei="${ei}" aria-label="Quitar ejercicio">✕</button></div>
    ${l?`<div class="last num">Última vez (${dm(l.date)}): ${l.sets.map(s=>`${fmt(n(s.reps),0)}×${fmt(n(s.kg))}`).join(" · ")} kg${e.target?" · objetivo "+esc(e.target):""}</div>`:e.target?`<div class="last">Objetivo ${esc(e.target)}</div>`:""}
    <div class="sets"><span class="h">#</span><span class="h">kg</span><span class="h">reps</span><span></span>${e.sets.map((s,si)=>`<span class="i num">${si+1}</span><input class="input num" type="number" step="any" inputmode="decimal" value="${s.kg??""}" placeholder="${s.phk??""}" data-ex="${ei}" data-si="${si}" data-f="kg" aria-label="kg serie ${si+1}"><input class="input num" type="number" step="1" inputmode="numeric" value="${s.reps??""}" placeholder="${s.ph??""}" data-ex="${ei}" data-si="${si}" data-f="reps" aria-label="reps serie ${si+1}"><button class="btn ghost sm" data-act="rmSet" data-ei="${ei}" data-si="${si}" aria-label="Quitar serie">−</button>`).join("")}</div>
    <div><button class="btn soft sm" data-act="addSet" data-ei="${ei}">+ Serie</button></div></div>`});
  h+=`<datalist id="exList">${names.map(x=>`<option value="${esc(x)}">`).join("")}</datalist><button class="btn soft" data-act="addEx">+ Ejercicio</button>
  <div class="grid2"><div class="field"><label for="wDur">Duración (min)</label><input class="input" id="wDur" type="number" value="${d.durationMin||""}" placeholder="${d.id?"":Math.max(1,Math.round((Date.now()-d.start)/60000))}" data-dw="durationMin"></div><div class="field"><label for="wK">kcal activas</label><input class="input" id="wK" type="number" value="${d.kcal||""}" data-dw="kcal"></div></div>
  <div class="field"><label for="wNo">Notas</label><textarea class="input" id="wNo" data-dw="notes">${esc(d.notes)}</textarea></div>
  <button class="btn primary block" data-act="saveWorkout">Guardar sesión</button>${d.id?"":`<button class="btn ghost danger" data-act="discardWorkout">Descartar sesión</button>`}`;
  return h;
}
function routineEditSheet(){
  const d=S.ui.rtDraft;const c=S.ui.confirm==="rt:"+d._id;
  return sheetHead(d._id?"Editar rutina":"Nueva rutina")+`<div class="field"><label for="rtN">Nombre</label><input class="input" id="rtN" value="${esc(d.name)}" placeholder="p. ej. Torso A" data-rt="name"></div>
  ${d.exercises.map((e,i)=>`<div class="ingedit" style="grid-template-columns:1fr 56px 70px 32px"><input class="input" value="${esc(e.name)}" placeholder="Ejercicio" list="exList2" data-rte="${i}" data-f="name" aria-label="Ejercicio"><input class="input" type="number" value="${e.sets||""}" placeholder="Series" data-rte="${i}" data-f="sets" aria-label="Series"><input class="input" value="${esc(e.reps||"")}" placeholder="Reps" data-rte="${i}" data-f="reps" aria-label="Repeticiones"><button class="btn ghost sm" data-act="rmRtEx" data-i="${i}" aria-label="Quitar">✕</button></div>`).join("")}
  <datalist id="exList2">${exerciseNames().map(x=>`<option value="${esc(x)}">`).join("")}</datalist>
  <button class="btn soft sm" data-act="addRtEx">+ Ejercicio</button>
  <button class="btn primary block" data-act="saveRoutine">Guardar rutina</button>
  ${d._id?(c?`<span class="confirm">¿Borrar la rutina? <button class="btn sm danger" data-act="delRoutine">Sí, borrar</button><button class="btn sm ghost" data-act="cancelConfirm">No</button></span>`:`<button class="btn ghost danger" data-act="askConfirm" data-k="rt:${d._id}">Borrar rutina</button>`):""}`;
}

/* =========================================================
   PROGRESO
   ========================================================= */
function vProgreso(){
  const g=goals(),R=S.ui.progRange,end=todayStr();
  const days=Array.from({length:R},(_,i)=>addDays(end,i-R+1));
  let h=`<div class="stack-lg"><div class="stack"><div class="eyebrow">Tu constancia cuenta</div><h1>Progreso</h1>
  <div class="seg"><button class="${S.ui.progTab==="alimentacion"?"on":""}" data-act="progTab" data-t="alimentacion">Alimentación</button><button class="${S.ui.progTab==="peso"?"on":""}" data-act="progTab" data-t="peso">Peso</button><button class="${S.ui.progTab==="entreno"?"on":""}" data-act="progTab" data-t="entreno">Entreno</button></div></div>`;
  if(S.ui.progTab==="peso")return h+progPeso()+`</div>`;
  if(S.ui.progTab==="entreno")return h+progEntreno()+`</div>`;
  const logged=days.filter(d=>dayLog(d).length);
  const tots=logged.map(dayLogTotals);
  const avgK=tots.length?tots.reduce((a,t)=>a+t.kcal,0)/tots.length:null;
  const avgP=tots.length?tots.reduce((a,t)=>a+t.p,0)/tots.length:null;
  const pOk=tots.filter(t=>t.p>=g.p*.9).length;
  h+=`<div class="row"><div class="seg" style="flex:1"><button class="${R===7?"on":""}" data-act="progRange" data-n="7">7 días</button><button class="${R===30?"on":""}" data-act="progRange" data-n="30">30 días</button></div></div>
  <div class="stats"><div class="stat"><b class="num">${logged.length}<span class="muted small" style="font-family:var(--font-body)">/${R}</span></b><span>días registrados</span></div><div class="stat"><b class="num">${fmt(avgK,0)}</b><span>kcal media</span></div><div class="stat"><b class="num">${fmt(avgP,0)}</b><span>g prot. media</span></div></div>
  <div class="card stack"><div class="between"><h3>Calorías por día</h3><span class="legend"><span><i class="dot" style="background:var(--forest)"></i> registrado</span><span>— objetivo ${g.kcal}</span></span></div>${barChart(days.map(d=>({label:R===7?DOW[dowIdx(d)].slice(0,2):pd(d).getDate(),v:dayLog(d).length?dayLogTotals(d).kcal:null})),g.kcal,"var(--forest-2)")}</div>
  <div class="card stack"><div class="between"><h3>Proteína por día</h3><span class="legend"><span>— objetivo ${g.p} g</span></span></div>${barChart(days.map(d=>({label:R===7?DOW[dowIdx(d)].slice(0,2):pd(d).getDate(),v:dayLog(d).length?dayLogTotals(d).p:null})),g.p,"var(--p)")}
  <div class="small muted">${tots.length?`${pOk} de ${tots.length} días llegaste al 90 % de la proteína.`:"Registra comidas para ver tu proteína."}</div></div>
  <div class="card stack"><h3>Objetivos</h3><div class="small">${macroLine({...g,miss:{}})}</div><div><button class="btn soft sm" data-act="goals">Cambiar objetivos</button></div></div>`;
  return h+`</div>`;
}
function progPeso(){
  const ws=Object.entries(D("weights")).map(([d,w])=>({date:d,kg:n(w.kg),note:w.note})).filter(w=>w.kg).sort((a,b)=>a.date.localeCompare(b.date));
  const prof=(D("config").main||{}).profile;
  const last=ws[ws.length-1],first=ws[0];
  const avg=(from,to)=>{const s=ws.filter(w=>w.date>from&&w.date<=to);return s.length?s.reduce((a,w)=>a+w.kg,0)/s.length:null};
  const t=todayStr();const a1=avg(addDays(t,-7),t),a0=avg(addDays(t,-14),addDays(t,-7));
  let h=`<form class="card stack" data-form="weight"><h3>Registrar peso</h3><div class="grid2"><div class="field"><label for="wtD">Fecha</label><input class="input" id="wtD" type="date" value="${t}"></div><div class="field"><label for="wtK">Peso (kg)</label><input class="input" id="wtK" type="number" step="0.1" inputmode="decimal" placeholder="${last?fmt(last.kg):prof?prof.weightKg:""}" required></div></div><div class="field"><label for="wtN">Cómo te sientes (opcional)</label><input class="input" id="wtN" placeholder="p. ej. hinchada, regla, dormí mal…"></div><button class="btn primary" type="submit">Guardar</button><div class="small muted">Mejor en ayunas, después del baño, 2–3 veces por semana. Fíjate en la media semanal, no en el dato suelto.</div></form>`;
  h+=`<div class="stats"><div class="stat"><b class="num">${last?fmt(last.kg):"—"}</b><span>último (kg)</span></div><div class="stat"><b class="num">${fmt(a1)}</b><span>media 7 días</span></div><div class="stat"><b class="num">${a1!=null&&a0!=null?(a1-a0>0?"+":"")+fmt(a1-a0,1):"—"}</b><span>vs semana anterior</span></div></div>`;
  h+=ws.length>1?`<div class="card stack"><h3>Evolución</h3>${lineChart(ws.map(w=>({x:w.date,y:w.kg})),{unit:"kg"})}${first&&last?`<div class="small muted num">Desde ${dm(first.date)}: ${(last.kg-first.kg>0?"+":"")+fmt(last.kg-first.kg,1)} kg</div>`:""}</div>`:`<div class="empty card">${prof?`Tu perfil parte de ${prof.weightKg} kg. `:""}Con dos registros aparece la gráfica.</div>`;
  if(ws.length)h+=`<div class="card"><h3 style="margin-bottom:6px">Registros</h3>${ws.slice().reverse().slice(0,20).map(w=>`<div class="ing"><span class="num">${esc(longDate(w.date))}</span><span class="num"><b>${fmt(w.kg)}</b> kg <button class="btn ghost sm" data-act="delWeight" data-d="${w.date}" aria-label="Borrar">✕</button></span>${w.note?`<span class="q">${esc(w.note)}</span>`:""}</div>`).join("")}</div>`;
  return h;
}
function progEntreno(){
  const t=todayStr(),wk=weekStart(t);
  const weeks=Array.from({length:6},(_,i)=>addDays(wk,(i-5)*7));
  const data=weeks.map(w=>{const ws=Object.values(D("workouts")).filter(x=>x.date>=w&&x.date<addDays(w,7));return {label:dm(w),v:ws.reduce((a,x)=>a+(wVolume(x)||0),0),c:ws.length}});
  const thisW=data[5];
  return `<div class="stats"><div class="stat"><b class="num">${thisW.c}</b><span>sesiones esta semana</span></div><div class="stat"><b class="num">${fmt(thisW.v/1000,1)}</b><span>t de volumen</span></div><div class="stat"><b class="num">${Object.keys(D("workouts")).length}</b><span>sesiones totales</span></div></div>
  <div class="card stack"><h3>Volumen semanal (kg × reps)</h3>${barChart(data.map(d=>({label:d.label,v:d.v||null})),null,"var(--forest-2)")}<div class="setlist num">${data.map(d=>`<span>${d.label}: ${d.c} ses.</span>`).join("")}</div></div>
  <div class="note">La progresión por ejercicio está en la pestaña Entreno.</div>`;
}

/* ---------- charts ---------- */
function barChart(pts,goal,color){
  const W=320,H=150,pl=30,pb=20,pt=10,pr=6;const vals=pts.map(p=>p.v).filter(v=>v!=null);
  const max=Math.max(goal||0,...vals,1)*1.1;const bw=(W-pl-pr)/pts.length;
  const y=v=>pt+(H-pt-pb)*(1-v/max);
  const ticks=[0,max/2,max].map(v=>Math.round(v/10)*10);
  let s=`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de barras">`;
  ticks.forEach(v=>s+=`<line x1="${pl}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${pl-4}" y="${y(v)+3}" text-anchor="end">${fmt(v,0)}</text>`);
  pts.forEach((p,i)=>{const x=pl+i*bw;if(p.v!=null){const over=goal&&p.v>goal*1.05;s+=`<rect x="${x+bw*.18}" y="${y(p.v)}" width="${bw*.64}" height="${Math.max(1,H-pb-y(p.v))}" rx="3" fill="${over?"var(--bad)":color}"/>`;if(pts.length<=8)s+=`<text x="${x+bw/2}" y="${y(p.v)-3}" text-anchor="middle">${fmt(p.v,0)}</text>`}else{s+=`<rect x="${x+bw*.18}" y="${H-pb-2}" width="${bw*.64}" height="2" fill="var(--line)"/>`}
    if(pts.length<=8||i%5===0)s+=`<text x="${x+bw/2}" y="${H-5}" text-anchor="middle">${esc(p.label)}</text>`});
  if(goal)s+=`<line x1="${pl}" x2="${W-pr}" y1="${y(goal)}" y2="${y(goal)}" stroke="var(--ink)" stroke-dasharray="4 3" stroke-width="1"/>`;
  return s+`</svg>`;
}
function lineChart(pts,o){
  const W=320,H=150,pl=34,pb=20,pt=12,pr=10;const ys=pts.map(p=>p.y);let mn=Math.min(...ys),mx=Math.max(...ys);const pad=Math.max((mx-mn)*.15,0.5);mn-=pad;mx+=pad;
  const t0=pd(pts[0].x).getTime(),t1=pd(pts[pts.length-1].x).getTime()||t0+1;
  const X=d=>pl+(W-pl-pr)*((pd(d).getTime()-t0)/Math.max(1,t1-t0));const Y=v=>pt+(H-pt-pb)*(1-(v-mn)/(mx-mn));
  let s=`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de evolución">`;
  [mn+pad,(mn+mx)/2,mx-pad].forEach(v=>s+=`<line x1="${pl}" x2="${W-pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${pl-4}" y="${Y(v)+3}" text-anchor="end">${fmt(v,1)}</text>`);
  const path=pts.map((p,i)=>(i?"L":"M")+X(p.x).toFixed(1)+" "+Y(p.y).toFixed(1)).join(" ");
  s+=`<path d="${path} L${X(pts[pts.length-1].x)} ${H-pb} L${X(pts[0].x)} ${H-pb} Z" fill="var(--p)" opacity=".12"/><path d="${path}" fill="none" stroke="var(--p)" stroke-width="2"/>`;
  pts.forEach((p,i)=>s+=`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${i===pts.length-1?4:2.5}" fill="${i===pts.length-1?"var(--forest)":"var(--p)"}"/>`);
  s+=`<text x="${pl}" y="${H-5}">${dm(pts[0].x)}</text><text x="${W-pr}" y="${H-5}" text-anchor="end">${dm(pts[pts.length-1].x)}</text>`;
  return s+`</svg>`;
}

/* =========================================================
   EVENTS
   ========================================================= */
document.addEventListener("click",e=>{
  const el=e.target.closest("[data-act]");if(!el)return;const a=el.dataset.act,ds=el.dataset;
  if(a==="scrim"){if(e.target===el)closeSheet();return}
  if(el.tagName==="INPUT"&&el.type!=="checkbox")return;
  const H={
    close:closeSheet,
    pickDate(){S.date=ds.d;S.week=weekStart(ds.d);render()},
    shiftWeek(){S.week=addDays(S.week,+ds.n);if(S.view==="hoy"){S.date=addDays(S.date,+ds.n)}render()},
    goals(){openSheet(goalsSheet)},
    askConfirm(){S.ui.confirm=ds.k;render();drawSheet()},
    cancelConfirm(){S.ui.confirm=null;render();drawSheet()},
    ate(){const pe=dayPlan(S.date)[ds.slot];if(!pe)return;const items=dayLog(S.date).slice();items.push({id:uid(),slot:ds.slot,name:pe.title,kcal:r1(pe.m.kcal),p:r1(pe.m.p),c:r1(pe.m.c),f:r1(pe.m.f),recipeId:pe.id||null,servings:pe.serv||1,estimated:!!(pe.recipe&&pe.recipe.estimated)});setLog(S.date,items);toast("Registrado: "+pe.title)},
    copyPlanDay(){const p=dayPlan(S.date),items=dayLog(S.date).slice();let c=0;SLOTS.forEach(s=>{const pe=p[s.k];if(!pe||pe.libre||items.some(i=>i.slot===s.k))return;items.push({id:uid(),slot:s.k,name:pe.title,kcal:r1(pe.m.kcal),p:r1(pe.m.p),c:r1(pe.m.c),f:r1(pe.m.f),recipeId:pe.id||null,servings:pe.serv||1});c++});if(!c){toast("No hay comidas planificadas pendientes");return}setLog(S.date,items);toast(c+" comidas registradas desde el plan")},
    addFood(){S.ui.food=null;const d=S.date,sl=ds.slot;openSheet(()=>foodSheet(d,sl))},
    editLog(){S.ui.food={tab:"manual"};const d=ds.d,id=ds.id;openSheet(()=>foodSheet(d,null,id))},
    delLog(){setLog(ds.d,dayLog(ds.d).filter(i=>i.id!==ds.id));S.ui.confirm=null;toast("Borrado")},
    foodTab(){S.ui.food.tab=ds.t;drawSheet()},
    logRecipe(){const serv=n(document.getElementById("foodServ").value)||1;const r=D("recipes")[ds.id];const m=recipeMacros(r,serv);const date=S.date;const slot=currentFoodSlot;const items=dayLog(date).slice();items.push({id:uid(),slot,name:r.title+(serv!==1?" × "+fmt(serv):""),kcal:r1(m.kcal),p:r1(m.p),c:r1(m.c),f:r1(m.f),recipeId:ds.id,servings:serv,estimated:!!r.estimated});setLog(date,items);closeSheet();toast("Registrado")},
    semTab(){S.ui.semTab=ds.t;render()},
    planSlot(){S.ui.ps={q:""};const d=ds.d,sl=ds.slot;planCtx={d,sl};openSheet(()=>planSlotSheet(d,sl))},
    setPlan(){const {d,sl}=planCtx;const p=Object.assign({},D("plan")[d]||{});const serv=n((document.getElementById("psServ")||{}).value)||1;if(ds.v==="")delete p[sl];else if(ds.v==="libre")p[sl]={type:"libre"};else p[sl]={type:"recipe",id:ds.v.slice(2),servings:serv};save("plan/"+d,p);closeSheet()},
    planCustom(){const {d,sl}=planCtx;openSheet(()=>customPlanSheet(d,sl))},
    copyWeek(){const wk=S.week;let c=0;for(let i=0;i<7;i++){const src=D("plan")[addDays(wk,i)];const dst=addDays(wk,i+7);if(src&&!D("plan")[dst]){save("plan/"+dst,JSON.parse(JSON.stringify(src)));c++}}toast(c?`Copiados ${c} días a la semana siguiente`:"La semana siguiente ya está planificada")},
    shopping(){openSheet(shoppingSheet)},
    shopReset(){save("shopping/"+S.week,{checked:{}});drawSheet()},
    assignRoutine(){const i=+ds.i;openSheet(()=>routinePickSheet(i))},
    setSchedule(){const cfg=Object.assign({},D("config").main||{});cfg.schedule=Object.assign({},cfg.schedule||{});if(ds.r)cfg.schedule[ds.i]=ds.r;else delete cfg.schedule[ds.i];save("config/main",cfg);closeSheet()},
    recFilter(){S.ui.recFilter=ds.t;render()},
    recTab(){S.ui.recTab=ds.t;render()},
    foodUnsel(){S.ui.food.sel=null;S.ui.food.g=null;drawSheet()},
    foodQty(){S.ui.food.g=+ds.g;drawSheet()},
    pickProduct(){S.ui.food.sel=ds.id;S.ui.food.g=null;drawSheet()},
    logProduct(){const st=S.ui.food,pr=D("products")[st.sel];const g=n(document.getElementById("foodG").value);if(!g){toast("Indica la cantidad");return}const m=prodMacros(pr,g);const date=S.date,slot=currentFoodSlot;const items=dayLog(date).slice();items.push({id:uid(),slot,name:pr.name+" · "+fmt(g,0)+" "+(pr.unit||"g"),kcal:r1(m.kcal),p:r1(m.p),c:r1(m.c),f:r1(m.f),productId:st.sel,grams:g,estimated:!pr.verified});setLog(date,items);bumpUse(st.sel);closeSheet();toast("Registrado")},
    openProduct(){const p=D("products")[ds.id];S.ui.prodDraft=Object.assign(JSON.parse(JSON.stringify(p)),{_id:ds.id});S.ui.prodDraft.per100=S.ui.prodDraft.per100||{};S.ui.prodFrom=null;S.ui.confirm=null;openSheet(productSheet)},
    newProduct(){S.ui.prodFrom=ds.from==="food"?{type:"food",date:S.date,slot:currentFoodSlot}:null;S.ui.prodDraft={_id:null,name:(S.ui.food&&S.ui.food.pq&&ds.from==="food")?S.ui.food.pq:"",brand:"",store:"Mercadona",ean:"",unit:"g",per100:{},servingG:null,verified:false};openSheet(productSheet)},
    barcode(){S.ui.prodFrom=ds.from==="food"?{type:"food",date:S.date,slot:currentFoodSlot}:ds.from==="recipe"?S.ui.prodFrom:null;S.ui.bc={status:"scan"};openSheet(barcodeSheet);setTimeout(startCamera,50)},
    newProductEan(){const ean=S.ui.bc&&S.ui.bc.ean;S.ui.prodDraft={_id:null,name:"",brand:"",store:"Mercadona",ean:ean||"",unit:"g",per100:{},servingG:null,verified:false};openSheet(productSheet)},
    offSearch(){const q=ds.q;S.ui.off={q,status:"loading",items:[]};if(!S.ui.prodFrom&&S.ui.food&&sheetFn)S.ui.prodFrom={type:"food",date:S.date,slot:currentFoodSlot};openSheet(offSheet);offSearch(q).then(items=>{S.ui.off.items=items;S.ui.off.status="ok";drawSheet()}).catch(e=>{S.ui.off.status="error";S.ui.off.msg=navigator.onLine?"Open Food Facts no responde ahora. Inténtalo en un rato.":"Sin conexión.";drawSheet()})},
    pickOff(){const d=Object.assign({},S.ui.off.items[+ds.i]);d._notes="Datos de Open Food Facts. Compruébalos con tu envase y marca la casilla si coinciden.";const hit=d.ean&&Object.entries(D("products")).find(([,p])=>p.ean===d.ean);if(hit){afterProductPicked(hit[0]);return}S.ui.prodDraft=d;openSheet(productSheet)},
    account(){openSheet(accountSheet)},
    setTheme(){applyTheme(ds.t);drawSheet()},
    signOut(){signOut()},
    exportData(){exportData()},
    scan(){S.ui.prodFrom=ds.from==="food"?{type:"food",date:S.date,slot:currentFoodSlot}:(ds.from==="recipe"||ds.from==="keep")?S.ui.prodFrom:null;S.ui.scan={files:[],status:"idle"};openSheet(scanSheet)},
    scanRun(){runScan()},
    scanStop(){const sc=S.ui.scan;if(sc&&sc.ctl)sc.ctl.abort()},
    delProduct(){save("products/"+S.ui.prodDraft._id,null);S.ui.confirm=null;closeSheet();toast("Producto borrado")},
    ingFromProduct(){const ix=+ds.ix;S.ui.prodFrom={type:"recipe",ix};S.ui.pickQ=S.ui.recDraft.ingredients[ix].name||"";openSheet(ingPickSheet)},
    pickIng(){afterProductPicked(ds.id)},
    backToRecipe(){openSheet(recipeEditSheet)},
    openRecipe(){const id=ds.id;S.ui.confirm=null;openSheet(()=>recipeSheet(id))},
    favRecipe(){const r=Object.assign({},D("recipes")[ds.id]);r.fav=!r.fav;save("recipes/"+ds.id,r);drawSheet()},
    delRecipe(){save("recipes/"+ds.id,null);S.ui.confirm=null;closeSheet();toast("Receta borrada")},
    recToToday(){const id=ds.id;S.ui.food={tab:"recetas",q:D("recipes")[id].title};currentFoodSlot=guessSlot();const d=S.date=todayStr();openSheet(()=>foodSheet(d,currentFoodSlot))},
    editRecipe(){const id=ds.id;const r=id?JSON.parse(JSON.stringify(D("recipes")[id])):{title:"",servings:1,ingredients:[{name:"",qty:"",unit:"g",per100:{}}],slots:[]};r._id=id||null;S.ui.recDraft=r;openSheet(recipeEditSheet)},
    addIng(){S.ui.recDraft.ingredients=S.ui.recDraft.ingredients||[];S.ui.recDraft.ingredients.push({name:"",qty:"",unit:"g",per100:{}});drawSheet()},
    rmIng(){S.ui.recDraft.ingredients.splice(+ds.ix,1);drawSheet()},
    startWorkout(){const cur=S.draft||lsGet("mp-draft");if(cur){S.draft=cur;openSheet(loggerSheet);toast("Tienes una sesión a medias");return}S.draft=newDraft(ds.r||null,ds.d||todayStr());persistDraft();openSheet(loggerSheet)},
    resumeWorkout(){S.draft=S.draft||lsGet("mp-draft");openSheet(loggerSheet)},
    repeatWorkout(){if(S.draft||lsGet("mp-draft")){toast("Termina o descarta la sesión a medias primero");return}S.draft=newDraft(null,todayStr(),D("workouts")[ds.id]);persistDraft();openSheet(loggerSheet)},
    editWorkout(){const w=JSON.parse(JSON.stringify(D("workouts")[ds.id]));S.draft={...w,id:ds.id,exercises:(w.exercises||[]).map(e=>({name:e.name,sets:e.sets||[]}))};openSheet(loggerSheet)},
    addSet(){const e=S.draft.exercises[+ds.ei];const l=e.sets[e.sets.length-1]||{};e.sets.push({kg:"",reps:"",phk:l.kg||l.phk||"",ph:l.reps||l.ph||""});persistDraft();drawSheet()},
    rmSet(){S.draft.exercises[+ds.ei].sets.splice(+ds.si,1);persistDraft();drawSheet()},
    addEx(){S.draft.exercises.push({name:"",sets:[{kg:"",reps:""},{kg:"",reps:""},{kg:"",reps:""}]});persistDraft();drawSheet()},
    rmEx(){S.draft.exercises.splice(+ds.ei,1);persistDraft();drawSheet()},
    saveWorkout(){const d=S.draft;const exs=d.exercises.filter(e=>e.name.trim()).map(e=>({name:e.name.trim(),sets:e.sets.filter(s=>n(s.reps)!=null||n(s.kg)!=null).map(s=>({kg:n(s.kg)??n(s.phk)??0,reps:n(s.reps)??n(s.ph)??0}))})).filter(e=>e.sets.length);
      if(!exs.length&&!d.id){toast("Apunta al menos una serie");return}
      const w={date:d.date,name:d.name||"Sesión",durationMin:n(d.durationMin)??(d.id?null:Math.max(1,Math.round((Date.now()-d.start)/60000))),kcal:n(d.kcal),notes:d.notes||"",exercises:exs,routineId:d.routineId||null};if(d.summary)w.summary=d.summary;
      save("workouts/"+(d.id||d.date+"-"+uid()),w);if(!d.id)lsSet("mp-draft",null);S.draft=null;closeSheet();toast("Sesión guardada · "+fmt(wVolume(w),0)+" kg de volumen")},
    discardWorkout(){if(S.ui.confirm!=="draft"){S.ui.confirm="draft";el.textContent="Toca otra vez para descartar";return}S.ui.confirm=null;S.draft=null;lsSet("mp-draft",null);closeSheet();render()},
    delWorkout(){save("workouts/"+ds.id,null);S.ui.confirm=null;toast("Sesión borrada")},
    editRoutine(){const id=ds.id;const r=id?JSON.parse(JSON.stringify(D("routines")[id])):{name:"",exercises:[{name:"",sets:3,reps:"8–12"}]};r._id=id||null;S.ui.rtDraft=r;S.ui.confirm=null;openSheet(routineEditSheet)},
    addRtEx(){S.ui.rtDraft.exercises.push({name:"",sets:3,reps:"8–12"});drawSheet()},
    rmRtEx(){S.ui.rtDraft.exercises.splice(+ds.i,1);drawSheet()},
    saveRoutine(){const d=S.ui.rtDraft;if(!d.name.trim()){toast("Ponle un nombre a la rutina");return}const id=d._id||slug(d.name);save("routines/"+id,{name:d.name.trim(),exercises:d.exercises.filter(e=>e.name.trim()).map(e=>({name:e.name.trim(),sets:n(e.sets)||3,reps:e.reps||""}))});closeSheet();toast("Rutina guardada")},
    delRoutine(){const id=S.ui.rtDraft._id;save("routines/"+id,null);const cfg=Object.assign({},D("config").main||{});if(cfg.schedule){cfg.schedule=Object.fromEntries(Object.entries(cfg.schedule).filter(([,v])=>v!==id));save("config/main",cfg)}S.ui.confirm=null;closeSheet()},
    progTab(){S.ui.progTab=ds.t;render()},
    progRange(){S.ui.progRange=+ds.n;render()},
    delWeight(){save("weights/"+ds.d,null)}
  };
  if(H[a]){if(!["askConfirm","cancelConfirm","discardWorkout","close"].includes(a)&&!a.startsWith("del"))S.ui.confirm=null;H[a]()}
});
let currentFoodSlot="extra",planCtx={};
function r1(v){return v==null?null:Math.round(v*10)/10}
function guessSlot(){const h=new Date().getHours();return h<11?"desayuno":h<13?"almuerzo":h<17?"comida":h<20?"merienda":"cena"}
// remember the slot of the last 'add food' tap
document.addEventListener("click",e=>{const el=e.target.closest("[data-act=addFood]");if(el)currentFoodSlot=el.dataset.slot},true);

document.addEventListener("input",e=>{
  const t=e.target,ds=t.dataset;
  if(ds.act==="recQ"){S.ui.recQ=t.value;const g=document.getElementById("recGrid");if(g)g.innerHTML=recipeCards(Object.entries(D("recipes")));return}
  if(ds.act==="foodPQ"){S.ui.food.pq=t.value;drawSheet();const q=document.getElementById("foodPQ");q.focus();q.setSelectionRange(q.value.length,q.value.length);return}
  if(ds.act==="ingPQ"){S.ui.pickQ=t.value;drawSheet();const q=document.getElementById("ingPQ");q.focus();q.setSelectionRange(q.value.length,q.value.length);return}
  if(ds.act==="prodQ"){S.ui.prodQ=t.value;const g=document.getElementById("prodGrid");if(g)g.innerHTML=productRows(t.value,"openProduct");return}
  if(t.id==="foodG"){const pr=D("products")[S.ui.food.sel];S.ui.food.g=n(t.value);const el=document.getElementById("foodGM");if(el&&pr)el.innerHTML=macroLine(prodMacros(pr,t.value));return}
  if(ds.act==="foodQ"){S.ui.food.q=t.value;S.ui.food.serv=n(document.getElementById("foodServ").value)||1;drawSheet();const q=document.getElementById("foodQ");q.focus();q.setSelectionRange(q.value.length,q.value.length);return}
  if(ds.act==="psQ"){S.ui.ps.q=t.value;drawSheet();const q=document.getElementById("psQ");q.focus();q.setSelectionRange(q.value.length,q.value.length);return}
  if(ds.rd!=null){S.ui.recDraft[ds.rd]=t.value;updRecTot();return}
  if(ds.ri!=null){const ing=S.ui.recDraft.ingredients[+ds.ri];if(MK.includes(ds.f)){ing.per100=ing.per100||{};ing.per100[ds.f]=n(t.value)}else ing[ds.f]=ds.f==="qty"?n(t.value):t.value;updRecTot();return}
  if(ds.dw!=null){S.draft[ds.dw]=t.value;persistDraft();return}
  if(ds.ex!=null){const ex=S.draft.exercises[+ds.ex];if(ds.si!=null)ex.sets[+ds.si][ds.f]=t.value;else ex[ds.f]=t.value;persistDraft();return}
  if(ds.rte!=null){S.ui.rtDraft.exercises[+ds.rte][ds.f]=t.value;return}
  if(ds.rt!=null){S.ui.rtDraft[ds.rt]=t.value;return}
});
function updRecTot(){const el=document.getElementById("reTot");if(el)el.innerHTML=macroLine(recipeMacros(S.ui.recDraft))}
document.addEventListener("change",e=>{
  const t=e.target,ds=t.dataset;
  if(ds.act==="exSel"){S.ui.exSel=t.value;render();return}
  if(ds.act==="shopCheck"){const doc=JSON.parse(JSON.stringify(D("shopping")[S.week]||{checked:{}}));doc.checked=doc.checked||{};if(t.checked)doc.checked[ds.k]=true;else delete doc.checked[ds.k];save("shopping/"+S.week,doc);drawSheet();return}
  if(ds.rslot){const d=S.ui.recDraft;d.slots=d.slots||[];if(t.checked){if(!d.slots.includes(ds.rslot))d.slots.push(ds.rslot)}else d.slots=d.slots.filter(x=>x!==ds.rslot);return}
  if(ds.ri!=null&&ds.f==="unit"){S.ui.recDraft.ingredients[+ds.ri].unit=t.value}
  if(ds.ri!=null&&ds.f==="name"){const hit=Object.entries(D("products")).find(([,p])=>norm(p.name)===norm(t.value));if(hit){const ing=S.ui.recDraft.ingredients[+ds.ri];ing.unit=hit[1].unit||"g";ing.per100=Object.assign({},hit[1].per100);ing.productId=hit[0];drawSheet();toast("Valores de "+hit[1].name)}}
  if(t.id==="importFile"&&t.files[0]){importData(t.files[0]);return}
  if(t.id==="scanFile"){const fs=[...t.files].slice(0,2);S.ui.scan.files=fs;S.ui.scan.status="idle";drawSheet()}
});
document.addEventListener("submit",e=>{
  const f=e.target;e.preventDefault();const v=id=>{const x=document.getElementById(id);return x?x.value:""};
  if(f.dataset.form==="food"){const date=f.dataset.d,id=f.dataset.id;const items=dayLog(date).slice();const rec={name:v("fName").trim(),kcal:n(v("fK")),p:n(v("fP")),c:n(v("fC")),f:n(v("fF")),notes:v("fNotes").trim(),estimated:document.getElementById("fEst").checked};
    if(id){const ix=items.findIndex(i=>i.id===id);items[ix]=Object.assign({},items[ix],rec,{slot:v("fSlot")})}else items.push(Object.assign({id:uid(),slot:f.dataset.slot||"extra"},rec));
    setLog(date,items);closeSheet();toast(id?"Cambios guardados":"Registrado")}
  if(f.dataset.form==="goals"){const cfg=Object.assign({},D("config").main||{});cfg.goals={kcal:n(v("gK"))||1700,p:n(v("gP"))||120,c:n(v("gC"))||170,f:n(v("gF"))||60};if(n(v("gKr"))){cfg.goalsRest={kcal:n(v("gKr")),p:n(v("gPr"))||cfg.goals.p,c:n(v("gCr"))||cfg.goals.c,f:n(v("gFr"))||cfg.goals.f}}else delete cfg.goalsRest;save("config/main",cfg);closeSheet();toast("Objetivos guardados")}
  if(f.dataset.form==="planCustom"){const d=f.dataset.d,sl=f.dataset.slot;const p=Object.assign({},D("plan")[d]||{});p[sl]={type:"custom",title:v("pcN"),kcal:n(v("pcK")),p:n(v("pcP")),c:n(v("pcC")),f:n(v("pcF"))};save("plan/"+d,p);closeSheet()}
  if(f.dataset.form==="recipe"){const d=S.ui.recDraft;if(!d.title.trim()){toast("Ponle nombre");return}const id=d._id||slug(d.title);const out={title:d.title.trim(),servings:n(d.servings)||1,slots:d.slots||[],ingredients:(d.ingredients||[]).filter(i=>i.name.trim()).map(i=>({name:i.name.trim(),qty:n(i.qty),unit:i.unit||"g",per100:i.per100||{}})),steps:d.steps||"",fav:!!d.fav,estimated:!!d.estimated,notes:d.notes||""};if(!out.ingredients.length)MK.forEach(k=>out[k]=n(d[k]));save("recipes/"+id,out);closeSheet();toast("Receta guardada")}
  if(f.dataset.form==="product"){const d=S.ui.prodDraft;const name=v("pdN").trim();if(!name)return;const id=d._id||slug((v("pdB")?v("pdB")+" ":"")+name);
    const out={name,brand:v("pdB").trim(),store:v("pdS").trim(),unit:v("pdU"),per100:{kcal:n(v("pdK")),p:n(v("pdP")),c:n(v("pdC")),f:n(v("pdF"))},servingG:n(v("pdSv")),ean:v("pdE").replace(/\D/g,""),verified:document.getElementById("pdV").checked,source:d._scanned?"Foto de la etiqueta":(d.source||"A mano"),createdBy:d.createdBy||(user?user.id:null),uses:d.uses||0,updatedAt:new Date().toISOString()};
    save("products/"+id,out);toast("Producto guardado");afterProductPicked(id)}
  if(f.dataset.form==="ean"){const ean=v("eanIn");stopCamera();handleEan(ean);return}
  if(f.dataset.form==="login"){doLogin(f.dataset.mode);return}
  if(f.dataset.form==="newpass"){setNewPass();return}
  if(f.dataset.form==="weight"){const kg=n(v("wtK"));if(!kg)return;save("weights/"+v("wtD"),{kg,note:v("wtN").trim()});toast("Peso guardado");f.reset()}
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&sheetFn)closeSheet()});

/* ---------- cuenta, importar/exportar ---------- */
function accountSheet(){
  const counts=COLS.map(c=>[c,Object.keys(D(c)).length]);
  return sheetHead("Tu cuenta")+`
  <div class="card stack"><div><div class="eyebrow">Sesión</div><b>${DEMO?"Modo demo (sin cuenta)":esc(user&&user.email)}</b></div>
  <div class="small muted">${esc(setSyncText())}</div>
  ${DEMO?"":`<button class="btn soft" data-act="signOut">Cerrar sesión</button>`}</div>
  <div class="card stack"><h3>Tus datos</h3><div class="small muted num">${counts.map(([c,k])=>`${({recipes:"recetas",products:"productos",plan:"días planificados",log:"días registrados",workouts:"sesiones",routines:"rutinas",weights:"pesos",shopping:"listas",config:"ajustes"})[c]}: ${k}`).join(" · ")}</div>
  <div class="row wrap"><button class="btn soft sm" data-act="exportData">Descargar copia (JSON)</button><label class="btn soft sm" for="importFile" style="cursor:pointer">Importar datos…</label><input type="file" id="importFile" accept="application/json,.json" hidden></div>
  <div class="small muted">Importar añade o sustituye documentos con el mismo nombre; no borra nada. Los productos que ya existen en la base compartida no se tocan.</div>
  ${S.ui.importMsg?`<div class="note">${esc(S.ui.importMsg)}</div>`:""}</div>
  <div class="card stack"><h3>Aspecto</h3><div class="seg">${[["light","Claro"],["dark","Oscuro"],["auto","Como el móvil"]].map(([k,l])=>`<button class="${themeNow()===k?"on":""}" data-act="setTheme" data-t="${k}">${l}</button>`).join("")}</div></div>
  <div class="card stack"><h3>Instalar en el móvil</h3><div class="small">iPhone: abre la web en Safari → botón Compartir → “Añadir a pantalla de inicio”.<br>Android: en Chrome, menú ⋮ → “Instalar aplicación”.</div></div>`;
}
function themeNow(){let t="light";try{t=localStorage.getItem("mp-theme")||"light"}catch(e){}return t}
function applyTheme(t){try{localStorage.setItem("mp-theme",t)}catch(e){}const r=document.documentElement;if(t==="auto")r.removeAttribute("data-theme");else r.setAttribute("data-theme",t);const d=t==="dark"||(t==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches);const m=document.getElementById("themeColor");if(m)m.setAttribute("content",d?"#111916":"#f3f4ee")}
function setSyncText(){const pend=Object.keys(outbox()).length;return pend?pend+" cambios pendientes de subir":"Todo sincronizado"}
function exportData(){
  const out={format:"mi-plan-export",version:1,exportedAt:new Date().toISOString(),collections:S.data};
  const blob=new Blob([JSON.stringify(out,null,1)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="mi-plan-"+todayStr()+".json";document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);
}
async function importData(file){
  S.ui.importMsg="Importando…";drawSheet();
  try{
    const j=JSON.parse(await file.text());const cols=j.collections||j;let n=0,skipped=0;
    for(const c of COLS){const docs=cols[c]||{};
      if(c==="products"){
        const ids=Object.keys(docs);if(!ids.length)continue;
        if(DEMO){ids.forEach(id=>{if(!S.data.products[id]){S.data.products[id]=docs[id];n++}else skipped++})}
        else{for(let k=0;k<ids.length;k+=200){const chunk=ids.slice(k,k+200).map(id=>({id,ean:docs[id].ean||null,data:Object.assign({},docs[id],{createdBy:user.id})}));const {error}=await sb.from("products").upsert(chunk,{onConflict:"id",ignoreDuplicates:true});if(error)throw error;n+=chunk.length}}
        continue;
      }
      const ids=Object.keys(docs);if(!ids.length)continue;
      if(DEMO){ids.forEach(id=>{S.data[c][id]=docs[id];n++})}
      else{for(let k=0;k<ids.length;k+=200){const chunk=ids.slice(k,k+200).map(id=>({user_id:user.id,col:c,id,data:docs[id],updated_at:new Date().toISOString()}));const {error}=await sb.from("user_docs").upsert(chunk,{onConflict:"user_id,col,id"});if(error)throw error;n+=chunk.length}}
    }
    if(DEMO)persistCache();else await loadAll();
    S.ui.importMsg=`Importados ${n} documentos.${skipped?" "+skipped+" productos ya existían.":""}`;render();drawSheet();
  }catch(e){S.ui.importMsg="No se ha podido importar: "+(e.message||"archivo no válido");drawSheet()}
}

/* ---------- acceso ---------- */
function loginView(mode,msg){
  return `<div class="stack-lg" style="padding-top:24px"><div class="stack"><div class="eyebrow">Nutrición y fuerza</div><h1>${mode==="signup"?"Crea tu cuenta":"Entra en tu plan"}</h1><div class="muted">Tus comidas, recetas y entrenos, sincronizados en todos tus dispositivos.</div></div>
  <form class="card stack" data-form="login" data-mode="${mode}">
  <div class="field"><label for="lgE">Email</label><input class="input" id="lgE" type="email" autocomplete="email" required></div>
  <div class="field"><label for="lgP">Contraseña</label><input class="input" id="lgP" type="password" autocomplete="${mode==="signup"?"new-password":"current-password"}" minlength="8" required></div>
  ${msg?`<div class="note">${esc(msg)}</div>`:""}
  <button class="btn primary block" type="submit">${mode==="signup"?"Crear cuenta":"Entrar"}</button>
  <div class="between small"><button type="button" class="btn ghost sm" data-act="gate" data-m="${mode==="signup"?"login":"signup"}">${mode==="signup"?"Ya tengo cuenta":"Crear cuenta"}</button><button type="button" class="btn ghost sm" data-act="forgot">He olvidado la contraseña</button></div>
  </form><div class="small muted">De momento solo pueden entrar las personas invitadas.</div></div>`;
}
function gate(mode,msg){S.gate=()=>loginView(mode,msg);S.ready=false;render()}
async function doLogin(mode){
  const email=document.getElementById("lgE").value.trim(),password=document.getElementById("lgP").value;
  const r=mode==="signup"?await sb.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}}):await sb.auth.signInWithPassword({email,password});
  if(r.error){gate(mode,({"Invalid login credentials":"Email o contraseña incorrectos.","Email not confirmed":"Confirma tu email: te hemos enviado un enlace."})[r.error.message]||r.error.message);return}
  if(mode==="signup"&&!r.data.session){gate("login","Te hemos enviado un email para confirmar la cuenta. Ábrelo y luego entra aquí.");return}
}
async function setNewPass(){const p=document.getElementById("npP").value;const {error}=await sb.auth.updateUser({password:p});if(error){toast(error.message);return}S.gate=null;toast("Contraseña cambiada");startSession()}
async function signOut(){stopCamera();closeSheet();await sb.auth.signOut();user=null;S.data=Object.fromEntries(COLS.map(c=>[c,{}]));gate("login")}
document.addEventListener("click",async e=>{
  const el=e.target.closest("[data-act=gate],[data-act=forgot]");if(!el)return;
  if(el.dataset.act==="gate"){gate(el.dataset.m);return}
  const email=(document.getElementById("lgE")||{}).value;if(!email){toast("Escribe tu email arriba");return}
  const {error}=await sb.auth.resetPasswordForEmail(email.trim(),{redirectTo:location.origin+location.pathname});
  gate("login",error?error.message:"Te hemos enviado un email para cambiar la contraseña.");
});
async function startSession(){
  const {data:ok,error}=await sb.rpc("is_allowed");
  if(error&&navigator.onLine&&!/fetch/i.test(error.message||"")){toast("Error comprobando acceso: "+error.message)}
  if(ok===false){S.gate=()=>`<div class="stack-lg" style="padding-top:24px"><h1>Aún no tienes acceso</h1><div class="card stack"><div>Tu email <b>${esc(user.email)}</b> no está en la lista de testers. Pide a Sara que te añada y vuelve a entrar.</div><button class="btn soft" data-act="signOut">Cerrar sesión</button></div></div>`;render();return}
  S.gate=null;
  const cached=lsGet(cacheKey());if(cached){S.data=Object.assign(Object.fromEntries(COLS.map(c=>[c,{}])),cached);S.ready=true;render()}
  S.canScan=true;
  await flushOutbox();await loadAll();S.ready=true;render();
}

/* ---------- arranque ---------- */
document.getElementById("sync").addEventListener("click",()=>{if(S.ready)openSheet(accountSheet)});
route();
(async()=>{
  if(DEMO){
    const cached=lsGet(cacheKey());S.data=Object.assign(Object.fromEntries(COLS.map(c=>[c,{}])),cached||{});S.ready=true;S.loadedAll=true;S.canScan=true;render();return;
  }
  if(!window.supabase){S.gate=()=>`<div class="stack-lg" style="padding-top:24px"><h1>Sin conexión</h1><div class="card">La primera vez la app necesita internet para cargarse. Conéctate y vuelve a abrirla.</div></div>`;render();return}
  sb=window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  let started=false;
  sb.auth.onAuthStateChange((ev,session)=>{
    if(ev==="PASSWORD_RECOVERY"){S.gate=()=>`<div class="stack-lg" style="padding-top:24px"><h1>Nueva contraseña</h1><form class="card stack" data-form="newpass"><div class="field"><label for="npP">Contraseña nueva</label><input class="input" id="npP" type="password" minlength="8" autocomplete="new-password" required></div><button class="btn primary block" type="submit">Guardar</button></form></div>`;render();return}
    if(session&&session.user){const changed=!user||user.id!==session.user.id;user=session.user;if(changed||!started){started=true;startSession()}}
    else if(ev==="SIGNED_OUT"||!session){user=null;started=false;gate("login")}
  });
  const {data:{session}}=await sb.auth.getSession();
  if(!session)gate("login");
})();
if("serviceWorker" in navigator&&location.protocol==="https:")navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
