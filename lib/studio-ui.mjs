/**
 * The Studio UI. One page, no framework, no build step — plain DOM against the
 * JSON the server hands back. Kept dependency-free on purpose: this thing has
 * to survive being ignored for six months and still start.
 */
export function renderStudioHTML({ watch = false } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>RoleModel Studio</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%230bc9ef'/%3E%3Cpath d='M6 4.5l5 3.5-5 3.5z' fill='%23fff'/%3E%3C/svg%3E"/>
<link rel="stylesheet" href="/optics.css"/>
<style>
/*
 * Every colour below is an Optics token. Nothing here invents a hex.
 *
 * Optics ramps run "plus" toward the background and "minus" toward the
 * foreground in BOTH modes, so this mapping is written once and is correct
 * either way — flip color-scheme to light and the whole UI follows. It is
 * pinned dark because this thing sits next to video all day.
 */
:root{
  color-scheme:dark;
  --bg:var(--op-color-neutral-plus-max);
  --panel:var(--op-color-neutral-plus-eight);
  --panel2:var(--op-color-neutral-plus-six);
  --line:var(--op-color-neutral-plus-four);
  --sunk:var(--op-color-neutral-plus-max);
  --fg:var(--op-color-neutral-minus-max);
  --muted:var(--op-color-neutral-minus-four);
  /* RoleModel green is the academy-primary scale; Optics "primary" is blue. */
  --accent:var(--op-color-academy-primary-base);
  --on-accent:var(--op-color-academy-primary-on-base);
  --blue:var(--op-color-primary-base);
  --danger:var(--op-color-alerts-danger-base);
  --danger-fg:var(--op-color-alerts-danger-minus-two);
  --info-bg:var(--op-color-primary-plus-seven);
  --info-fg:var(--op-color-primary-minus-two);
  --d:"Space Grotesk",ui-sans-serif,system-ui,sans-serif;
  --m:"Geist Mono",ui-monospace,SFMono-Regular,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--d);display:flex;min-height:100vh}
nav{width:210px;flex:0 0 210px;background:var(--panel);border-right:1px solid var(--line);padding:20px 0;position:sticky;top:0;height:100vh;overflow:auto}
nav h1{font-size:15px;font-weight:800;letter-spacing:-.02em;margin:0 0 4px;padding:0 20px}
nav .root{font-family:var(--m);font-size:10px;color:var(--muted);padding:0 20px 18px;word-break:break-all}
nav button{display:block;width:100%;text-align:left;background:none;border:0;color:var(--muted);font:inherit;font-size:14px;padding:9px 20px;cursor:pointer;border-left:2px solid transparent}
nav button:hover{color:var(--fg)}
nav button[aria-current=true]{color:var(--fg);border-left-color:var(--accent);background:var(--panel2);font-weight:600}
nav .tools{margin-top:22px;padding:14px 20px 0;border-top:1px solid var(--line);font-family:var(--m);font-size:11px;color:var(--muted);line-height:1.9}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px}
.dot.on{background:var(--accent)}.dot.off{background:var(--op-color-neutral-plus-two)}
main{flex:1;padding:26px 30px 70px;max-width:1500px}
h2{font-size:20px;font-weight:800;letter-spacing:-.02em;margin:0 0 3px}
.lede{color:var(--muted);font-size:13px;margin:0 0 22px;max-width:70ch;line-height:1.55}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
input,select,textarea{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:9px 12px;font:inherit;font-size:14px}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}
textarea{width:100%;min-height:150px;font-family:var(--m);font-size:13px;line-height:1.6;resize:vertical}
input[type=search]{flex:1 1 260px}
button.btn{background:var(--accent);color:var(--on-accent);border:0;border-radius:8px;padding:9px 15px;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
button.btn.ghost{background:var(--panel);color:var(--fg);border:1px solid var(--line);font-weight:500}
button.btn:disabled{opacity:.45;cursor:not-allowed}
.chip{background:var(--panel);border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:6px 13px;font:inherit;font-size:13px;cursor:pointer}
.chip[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.card:hover{border-color:var(--accent)}
.thumb{aspect-ratio:16/9;background:var(--sunk) center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--op-color-neutral-plus-two);font-family:var(--m);font-size:22px;letter-spacing:.3em}
.card .body{padding:11px 12px;display:flex;flex-direction:column;gap:6px}
.card .nm{font-size:13px;font-weight:600;line-height:1.3;word-break:break-word}
.card .path{font-family:var(--m);font-size:10px;color:var(--muted);word-break:break-all}
.meta{display:flex;gap:5px;flex-wrap:wrap;font-family:var(--m);font-size:10px;color:var(--muted)}
.meta span{background:var(--sunk);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
.kind{position:absolute;top:8px;left:8px;font-size:9px;text-transform:uppercase;letter-spacing:.07em;padding:2px 6px;border-radius:999px;font-family:var(--m);background:rgba(0,0,0,.6)}
.kind.video{color:var(--op-color-academy-primary-minus-two)}.kind.audio{color:var(--op-color-primary-minus-three)}.kind.still{color:var(--op-color-alerts-warning-minus-two)}
.thumbwrap{position:relative}
.client{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-family:var(--m);margin:26px 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line)}
.proj{margin:16px 0 8px;display:flex;align-items:baseline;gap:10px}
.proj h3{margin:0;font-size:15px;font-weight:700}
.proj .n{font-family:var(--m);font-size:11px;color:var(--muted)}
.form{display:grid;grid-template-columns:130px 1fr;gap:11px 14px;align-items:center;max-width:620px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px}
.form label{font-size:13px;color:var(--muted)}
.form .full{grid-column:1/-1}
pre{background:var(--sunk);border:1px solid var(--line);border-radius:8px;padding:14px;font-family:var(--m);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0}
.empty{color:var(--muted);font-size:14px;padding:36px 0}
.wp{aspect-ratio:16/9;border-radius:8px;background:var(--sunk) center/cover no-repeat}
.note{background:var(--info-bg);border-left:2px solid var(--blue);padding:11px 14px;border-radius:0 8px 8px 0;font-size:13px;color:var(--info-fg);line-height:1.6;margin-bottom:18px}
.lt{position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:var(--sunk) center/cover no-repeat;border:1px solid var(--line)}
.lt .t{position:absolute;left:6%;bottom:18%;font-weight:800;letter-spacing:-.02em}
.lt .s{position:absolute;left:6%;bottom:10%;font-family:var(--m)}
.lt .eb{position:absolute;left:6%;top:34%;font-family:var(--m);text-transform:uppercase;letter-spacing:.12em}
.lt .ti{position:absolute;left:6%;top:42%;font-weight:800;letter-spacing:-.03em;line-height:1.05;max-width:80%}
.wpe{display:grid;grid-template-columns:minmax(360px,1.35fr) minmax(300px,1fr);gap:20px;align-items:start}
.wpe canvas{width:100%;height:auto;display:block;border-radius:10px;border:1px solid var(--line);background:var(--sunk)}
.wpe .panel2{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.ctl{display:grid;grid-template-columns:96px 1fr auto;gap:9px 10px;align-items:center;font-size:13px}
.ctl label{color:var(--muted)}
.ctl .v{font-family:var(--m);font-size:11px;color:var(--muted);min-width:44px;text-align:right}
.ctl .wide{grid-column:2/-1}
.ctl input[type=color]{width:100%;height:30px;padding:0;border:1px solid var(--line);border-radius:6px;background:none;cursor:pointer}
.ctl input[type=range]{width:100%;accent-color:var(--accent)}
.sec{font-family:var(--m);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:18px 0 9px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.sec:first-child{margin-top:0}
.stop{display:grid;grid-template-columns:56px 1fr 44px 28px;gap:8px;align-items:center;margin-bottom:7px}
.stop button{background:none;border:1px solid var(--line);color:var(--muted);border-radius:6px;cursor:pointer;font:inherit;line-height:1;padding:5px 0}
.wpgrid .card{cursor:pointer}
.wpgrid .card[aria-selected=true]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.badge{display:inline-block;margin-left:7px;min-width:16px;padding:0 5px;border-radius:999px;background:var(--accent);color:var(--on-accent);font-family:var(--m);font-size:10px;font-weight:700;text-align:center;vertical-align:middle}
.badge:empty{display:none}
.con{display:grid;grid-template-columns:250px 1fr;gap:16px;align-items:start}
.joblist{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;max-height:70vh;overflow-y:auto}
.job{padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;display:grid;gap:3px}
.job:last-child{border-bottom:0}
.job[aria-selected=true]{background:var(--panel2);border-left:2px solid var(--accent)}
.job .jl{font-size:12px;font-weight:600;word-break:break-word}
.job .js{font-family:var(--m);font-size:10px;color:var(--muted)}
.job .js.run{color:var(--accent)}
.job .js.bad{color:var(--danger-fg)}
.log{background:var(--sunk);border:1px solid var(--line);border-radius:10px;padding:14px;font-family:var(--m);font-size:12px;line-height:1.55;height:70vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
.log .e{color:var(--danger-fg)}
.log .m{color:var(--muted)}
.cmd{display:flex;gap:8px;margin-top:12px}
.cmd input{flex:1;font-family:var(--m);font-size:12px}
.runrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:9px 0}
.runrow code{font-family:var(--m);font-size:11px;color:var(--muted);background:var(--sunk);border:1px solid var(--line);border-radius:6px;padding:5px 8px;flex:1;min-width:200px;word-break:break-all}
</style></head><body>
<nav>
  <h1>RoleModel Studio</h1>
  <div class="root" id="root">…</div>
  <button data-v="library" aria-current="true">Library</button>
  <button data-v="new">New project</button>
  <button data-v="record">Record</button>
  <button data-v="make">Make a video</button>
  <button data-v="recast">From a test</button>
  <button data-v="scripts">Scripts</button>
  <button data-v="voice">Voice</button>
  <button data-v="brand">Brand</button>
  <button data-v="wallpapers">Wallpapers</button>
  <button data-v="components">Components</button>
  <button data-v="storage">Storage</button>
  <button data-v="console">Console<span class="badge" id="jobn"></span></button>
  <div class="tools" id="tools"></div>
</nav>
<main id="main"></main>
<script>
${watch ? `
/* Live reload (--watch). The reconnect branch is the important one: \`node --watch\`
   restarts the whole server, which drops this stream — so a successful reconnect
   after an error means new code is serving, and the page should reload. */
(()=>{ let dropped=false; const connect=()=>{ const s=new EventSource("/api/reload");
  s.onopen=()=>{ if(dropped) location.reload(); };
  s.onmessage=()=>location.reload();
  s.onerror=()=>{ dropped=true; s.close(); setTimeout(connect,400); }; };
  connect(); })();
` : ""}
let S = null, view = "library", q = "", kind = "", WP = null, recipes = [], editing = null;
let allJobs = [], jobId = null, shellOn = false, es = null, SP = null;
const $ = (s,r=document)=>r.querySelector(s);
const el=(t,c,x)=>{const n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n;};
const human=b=>{const u=["B","KB","MB","GB","TB"];let i=0,n=b;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(n<10&&i>0?2:0)+" "+u[i]};
const dur=s=>{if(s==null)return null;const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=Math.floor(s%60);return h?h+":"+String(m).padStart(2,"0")+":"+String(x).padStart(2,"0"):m+":"+String(x).padStart(2,"0")};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function load(){
  // The wallpaper drawing code, imported from the same file the batch renderer
  // uses. Loaded once; every preview and every export goes through it.
  if(!WP) WP = await import("/wallpaper.mjs");
  // The same parser lib/narration.mjs uses. Served, not re-implemented — a
  // preview that disagrees with the synthesiser is worse than no preview.
  if(!SP) SP = await import("/script-parse.mjs");
  S = await (await fetch("/api/state")).json(); $("#root").textContent = S.libraryRoot;
  $("#tools").innerHTML = Object.entries(S.tools).map(([k,v])=>
    \`<div><span class="dot \${v?"on":"off"}"></span>\${k}</div>\`).join("")
    + \`<div><span class="dot \${S.remotes.length?"on":"off"}"></span>\${S.remotes.length} remote\${S.remotes.length===1?"":"s"}</div>\`;
  refreshJobs();
  render(); }

for (const b of document.querySelectorAll("nav button[data-v]")) b.onclick=()=>go(b.dataset.v);

// Keep the running-job badge honest even when you are looking at another panel.
setInterval(()=>{ if(allJobs.some(j=>j.running) || view==="console") refreshJobs(); }, 3000);

function render(){ const m=$("#main"); m.innerHTML="";
  // One live stream at a time. Leaving the Console open in the background is how
  // you end up with a dozen dangling EventSources and a server that stops
  // answering because it ran out of sockets.
  es?.close(); es=null;
  ({library:vLibrary,new:vNew,record:vRecord,make:vMake,scripts:vScripts,brand:vBrand,wallpapers:vWallpapers,storage:vStorage,console:vConsole,recast:vRecast,components:vComponents,voice:vVoice})[view](m); }

function go(v){
  view=v;
  for(const o of document.querySelectorAll("nav button[data-v]")) o.setAttribute("aria-current",String(o.dataset.v===v));
  render();
}

/* ── running things ──────────────────────────────────────────
   The Studio used to hand you a command to paste. It runs them now: POST the
   binary and an argv array, then watch the output in Console. The server only
   accepts binaries from its allowlist, so this is not a shell over HTTP. */
async function start(step){
  const r=await (await fetch("/api/run",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify(step)})).json();
  if(r.error){ alert(r.error); return null; }
  jobId=r.job.id; go("console"); refreshJobs();
  return r.job;
}

/** Display form of an argv array. For reading, never for re-parsing. */
function show(step){
  const q=s=>/[\\s"']/.test(s)?JSON.stringify(s):s;
  return step.shell ? step.shell : [step.bin,...(step.args||[])].map(q).join(" ");
}

/** A command with a Run button and the exact argv beside it. */
function runRow(step,label){
  const row=el("div","runrow");
  const b=el("button","btn",label||("Run "+(step.label||step.bin)));
  b.onclick=()=>start(step);
  row.append(b, Object.assign(el("code"),{textContent:show(step)}));
  if(step.note) row.append(Object.assign(el("div","path"),{textContent:step.note,style:"flex-basis:100%"}));
  return row;
}

async function refreshJobs(){
  const d=await (await fetch("/api/jobs")).json();
  allJobs=d.jobs; shellOn=d.shell;
  const n=allJobs.filter(j=>j.running).length;
  $("#jobn").textContent=n?String(n):"";
  if(view==="console") render();
}

/* ── Library ─────────────────────────────────────────────── */
function vLibrary(m){
  m.append(Object.assign(el("h2",null,"Library"),{}), el("p","lede",
    "Everything indexed, grouped by client. Thumbnails are poster frames pulled a second in — the first frame of a screen recording is usually a blank window."));

  const row=el("div","row");
  const s=el("input"); s.type="search"; s.placeholder="Search name, path, folder, codec…"; s.value=q;
  s.oninput=()=>{q=s.value;drawItems();};
  row.append(s);
  for(const k of ["","video","audio","still"]){
    const c=el("button","chip",k||"All"); c.setAttribute("aria-pressed",String(kind===k));
    c.onclick=()=>{kind=k;render();}; row.append(c);
  }
  const re=el("button","btn ghost","Re-index all");
  re.onclick=async()=>{re.disabled=true;re.textContent="Indexing…";
    for(const p of S.projects) await fetch("/api/index/"+p.id,{method:"POST"});
    await load();};
  row.append(re);
  m.append(row);
  const host=el("div"); host.id="items"; m.append(host); drawItems();
}

function drawItems(){
  const host=$("#items"); if(!host)return; host.innerHTML="";
  const terms=q.toLowerCase().split(/\\s+/).filter(Boolean);
  const byClient={};
  for(const p of S.projects) (byClient[p.client||"No client"] ||= []).push(p);

  let shown=0;
  for(const [client,projects] of Object.entries(byClient).sort()){
    const rows=[];
    for(const p of projects){
      const files=(p.catalog?.files??[]).filter(f=>{
        if(kind&&f.kind!==kind)return false;
        if(!terms.length)return true;
        const hay=[f.rel,f.name,...(f.tags||[]),f.media?.video?.codec,f.media?.audio?.codec].filter(Boolean).join(" ").toLowerCase();
        return terms.every(t=>hay.includes(t));
      });
      if(files.length||!terms.length) rows.push([p,files]);
    }
    if(!rows.length) continue;
    host.append(el("div","client",client));
    for(const [p,files] of rows){
      const h=el("div","proj");
      h.append(el("h3",null,p.name), el("span","n",
        files.length?\`\${files.length} file\${files.length===1?"":"s"} · \${human(files.reduce((n,f)=>n+f.bytes,0))}\`:"empty"));
      host.append(h);
      if(!files.length){ host.append(el("p","empty","Drop footage in "+p.id+"/media, then Re-index.")); continue; }
      const g=el("div","grid");
      for(const f of files){
        shown++;
        const c=el("div","card");
        const tw=el("div","thumbwrap");
        const t=el("div","thumb");
        if(f.kind==="audio"){ t.textContent="AUDIO"; }
        else { t.style.backgroundImage=\`url('/thumb/\${p.id}/\${encodeURI(f.rel)}')\`; }
        tw.append(t, el("span","kind "+f.kind,f.kind));
        const b=el("div","body");
        b.append(el("div","nm",f.name), el("div","path",f.rel));
        const meta=el("div","meta");
        for(const x of [dur(f.media?.durationSec), f.media?.video?f.media.video.width+"×"+f.media.video.height:null,
             f.media?.video?.fps?f.media.video.fps+"fps":null, human(f.bytes), f.media?.video?.codec||f.media?.audio?.codec].filter(Boolean))
          meta.append(el("span",null,x));
        b.append(meta);
        c.append(tw,b);
        c.onclick=()=>open("/media/"+p.id+"/"+encodeURI(f.rel));
        c.style.cursor="pointer";
        g.append(c);
      }
      host.append(g);
    }
  }
  if(!shown && terms.length) host.append(el("p","empty","Nothing matches."));
  if(!S.projects.length) host.append(el("p","empty","No projects yet — start one under New project."));
}

/* ── New project ─────────────────────────────────────────── */
function vNew(m){
  m.append(el("h2",null,"New project"), el("p","lede",
    "A project is a folder with a manifest. Client is separate from project name — Feeney and Hershey are two clients, not one project."));
  const f=el("div","form");
  const mk=(lbl,node)=>{f.append(el("label",null,lbl),node);return node;};
  const name=mk("Project", Object.assign(el("input"),{placeholder:"Railing Case Study"}));
  const client=mk("Client", Object.assign(el("input"),{placeholder:"Feeney"}));
  const brand=mk("Brand", el("select"));
  for(const p of S.presets){const o=el("option",null,p.label);o.value=p.id;brand.append(o);}
  const store=mk("Storage", el("select"));
  store.append(Object.assign(el("option",null,"Local folder (no bucket)"),{value:"local"}));
  for(const r of S.remotes) store.append(Object.assign(el("option",null,"rclone: "+r),{value:r}));
  const bucket=mk("Bucket", Object.assign(el("input"),{placeholder:"rm-video (remote only)"}));
  const out=el("pre","full"); out.style.display="none";
  const go=el("button","btn","Create project");
  const wrap=el("div","full"); wrap.append(go);
  f.append(wrap,out);
  go.onclick=async()=>{
    go.disabled=true;
    const r=await (await fetch("/api/project",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:name.value,client:client.value,brand:brand.value,
        remote:store.value==="local"?"local":"s3",bucket:bucket.value})})).json();
    go.disabled=false;
    out.style.display="block";
    out.textContent=r.error?("Error: "+r.error):
      \`Created  \${r.project.id}\\n\${S.libraryRoot}/\${r.project.id}/media/\\n\\nFootage/ and Renders/ are ready. Drop files in, then Library → Re-index.\`;
    if(!r.error) await load();
  };
  m.append(f);
}

/* ── Make a video ────────────────────────────────────────── */
function vMake(m){
  m.append(el("h2",null,"Make a video"), el("p","lede",
    "Paste a script or a URL. This writes a brief.md into the project, then runs it through Claude — which is where HyperFrames lives."));
  m.append(Object.assign(el("div","note"),{innerHTML:
    "The brief lands in <code>media/Renders/&lt;date&gt;-&lt;slug&gt;/brief.md</code> so it outlives this tab. The render is long and chatty, so it streams into Console rather than hiding behind a spinner."}));
  const f=el("div","form");
  const mk=(l,n)=>{f.append(el("label",null,l),n);return n;};
  const proj=mk("Project", el("select"));
  for(const p of S.projects) proj.append(Object.assign(el("option",null,(p.client?p.client+" · ":"")+p.name),{value:p.id}));
  const brand=mk("Brand", el("select"));
  for(const p of S.presets) brand.append(Object.assign(el("option",null,p.label),{value:p.id}));
  const title=mk("Title", Object.assign(el("input"),{placeholder:"Website launch promo"}));
  const secs=mk("Seconds", Object.assign(el("input"),{type:"number",value:20,min:5,max:180}));
  const pick=mk("From script", el("select"));
  pick.append(Object.assign(el("option",null,"— write it below —"),{value:""}));
  for(const s of S.scripts) pick.append(Object.assign(el("option",null,s.name),{value:s.name}));
  const src=el("textarea"); src.className="full"; src.placeholder="https://rolemodelsoftware.com\\n\\n— or paste a script —";
  pick.onchange=()=>{const s=S.scripts.find(x=>x.name===pick.value); if(s) src.value=s.body;};
  f.append(src);
  const out=el("div","full");
  const go=el("button","btn","Build the brief");
  const w=el("div","full"); w.append(go); f.append(w,out);
  go.onclick=async()=>{
    const r=await (await fetch("/api/make",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({projectId:proj.value,brand:brand.value,title:title.value,seconds:secs.value,source:src.value})})).json();
    out.innerHTML="";
    if(r.error){out.append(Object.assign(el("pre"),{textContent:"Error: "+r.error}));return;}
    out.append(Object.assign(el("pre"),{textContent:r.prompt}));
    out.append(Object.assign(el("div","path"),{textContent:"brief  "+r.brief}));
    out.append(runRow(r.step,"Run it in Claude"));
    const c=el("button","btn ghost","Copy the prompt");
    c.onclick=()=>navigator.clipboard?.writeText(r.prompt).then(()=>{c.textContent="Copied";
      setTimeout(()=>c.textContent="Copy the prompt",2000);}).catch(()=>{});
    out.append(c);
  };
  m.append(f);
}

/* ── Record ──────────────────────────────────────────────── */
function vRecord(m){
  m.append(el("h2",null,"Record"), el("p","lede",
    "Capture straight into a project. By default OpenScreen writes to its own private recordings folder where nothing can find it — this points it at the project instead."));
  m.append(Object.assign(el("div","note"),{innerHTML:
    "Recording is the one step that can fail for a reason the log won't explain: macOS grants Screen Recording permission to whatever hosts Electron. If <code>record</code> exits immediately, grant the permission to the process running this server and try again."}));
  const f=el("div","form");
  const mk=(l,n)=>{f.append(el("label",null,l),n);return n;};
  const proj=mk("Project", el("select"));
  for(const p of S.projects) proj.append(Object.assign(el("option",null,(p.client?p.client+" · ":"")+p.name),{value:p.id}));
  const title=mk("Name", Object.assign(el("input"),{placeholder:"estimating-screen"}));
  const win=mk("Window", Object.assign(el("input"),{placeholder:"(blank = whole screen)"}));
  const secs=mk("Seconds", Object.assign(el("input"),{type:"number",value:30,min:5,max:600}));
  const steps=el("div","full");
  const go=el("button","btn","Set up the capture");
  const w=el("div","full"); w.append(go); f.append(w,steps);
  go.onclick=async()=>{
    const r=await (await fetch("/api/record",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({projectId:proj.value,title:title.value,window:win.value,seconds:secs.value})})).json();
    steps.innerHTML="";
    if(r.error){steps.append(Object.assign(el("pre"),{textContent:"Error: "+r.error}));return;}
    steps.append(Object.assign(el("div","path"),{textContent:"lands in  "+r.dest}));
    for(const s of r.steps) steps.append(runRow(s));
    // Record -> brand -> export, in order, without babysitting each one.
    const all=el("button","btn","Run all three");
    all.onclick=async()=>{
      all.disabled=true;
      for(const s of r.steps){ const j=await start(s); if(!j) break; await waitFor(j.id); }
      all.disabled=false; refreshJobs();
    };
    steps.append(all);
  };
  m.append(f);
}

/** Resolve when a job exits. Used to chain steps that must not overlap. */
function waitFor(id){
  return new Promise(done=>{
    const s=new EventSource("/api/jobs/"+id+"/events");
    s.onmessage=e=>{const d=JSON.parse(e.data); if(d.done){s.close();done(d.code);}};
    s.onerror=()=>{s.close();done(null);};
  });
}

/* ── Recast ──────────────────────────────────────────────────
   A Playwright trace is already a recording of your product working. This is
   the only input here that regenerates itself: the test runs in CI, the demo
   is cut from the trace, and it can never drift from the UI it documents. */
function vRecast(m){
  m.append(el("h2",null,"From a test"), el("p","lede",
    "Point it at a Playwright trace and get a narrated demo. The test already clicked through the product — actions, screenshots, network waits and cursor positions are all in the trace."));
  m.append(Object.assign(el("div","note"),{innerHTML:
    "Runs <code>playwright-recast</code> (MIT) through npx, so it isn't a dependency of this install. Needs <code>ffmpeg</code> and <code>ffprobe</code> on PATH. Re-run it after every deploy and the demo never goes stale."}));
  const f=el("div","form");
  const mk=(l,n)=>{f.append(el("label",null,l),n);return n;};
  const proj=mk("Project", el("select"));
  for(const p of S.projects) proj.append(Object.assign(el("option",null,(p.client?p.client+" · ":"")+p.name),{value:p.id}));
  const title=mk("Name", Object.assign(el("input"),{placeholder:"estimating-walkthrough"}));
  const trace=mk("Trace", Object.assign(el("input"),{placeholder:"/path/to/test-results  or  trace.zip"}));
  const srt=mk("Narration", Object.assign(el("input"),{placeholder:"(optional) narration.srt"}));
  const prov=mk("Voice", el("select"));
  for(const o of [["none","No voiceover"],["openai","OpenAI"],["elevenlabs","ElevenLabs"],["polly","Amazon Polly"]])
    prov.append(Object.assign(el("option",null,o[1]),{value:o[0]}));
  const voice=mk("Voice ID", Object.assign(el("input"),{placeholder:"nova"}));
  const idle=mk("Idle speed", Object.assign(el("input"),{type:"number",value:3,min:1,max:10,step:0.5}));
  const rez=mk("Resolution", el("select"));
  for(const o of ["1080p","720p"]) rez.append(Object.assign(el("option",null,o),{value:o}));
  const opts=el("div","row"); opts.className="full row";
  const chk=(label,on)=>{ const b=el("button","chip",label); b.setAttribute("aria-pressed",String(on));
    b.onclick=()=>b.setAttribute("aria-pressed",String(b.getAttribute("aria-pressed")!=="true")); opts.append(b); return b; };
  const cCursor=chk("Cursor overlay",true), cClick=chk("Click effects",true), cInterp=chk("Interpolate to 60fps",false);
  f.append(opts);
  const out=el("div","full");
  const build=el("button","btn","Build the command");
  const w=el("div","full"); w.append(build); f.append(w,out);
  build.onclick=async()=>{
    const on=b=>b.getAttribute("aria-pressed")==="true";
    const r=await (await fetch("/api/recast",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({projectId:proj.value,title:title.value,trace:trace.value,srt:srt.value||null,
        provider:prov.value,voice:voice.value||null,speedIdle:idle.value,resolution:rez.value,
        cursor:on(cCursor),click:on(cClick),interpolate:on(cInterp)})})).json();
    out.innerHTML="";
    if(r.error){out.append(Object.assign(el("pre"),{textContent:"Error: "+r.error}));return;}
    out.append(Object.assign(el("div","path"),{textContent:"renders to  "+r.out}));
    if(!r.smooth) out.append(Object.assign(el("div","note"),{textContent:
      "No video beside the trace. recast will assemble from sparse screencast frames, which reads as a slideshow — record with recordVideo and save the .webm next to the .zip under the same name."}));
    if(r.wav) out.append(Object.assign(el("div","path"),{textContent:"narration  "+r.wav}));
    for(const st of r.steps) out.append(runRow(st, st.label.startsWith("narrate")?"Add the narration":"Cut the demo"));
    if(r.steps.length>1){
      const all=el("button","btn","Run both");
      all.onclick=async()=>{ all.disabled=true;
        for(const st of r.steps){ const j=await start(st); if(!j) break; await waitFor(j.id); }
        all.disabled=false; refreshJobs(); };
      out.append(all);
      out.append(Object.assign(el("div","path"),{textContent:"final  "+r.narrated}));
    }
  };
  m.append(f);
}

/* ── Voice ───────────────────────────────────────────────────
   One clip per line, cached on (voice, text), then an SRT written from the
   durations we measured. Nothing gets transcribed back — we already know the
   words, and asking Whisper to guess at them is how "Feeney" becomes "Phoenix". */
function vVoice(m){
  m.append(el("h2",null,"Voice"), el("p","lede",
    "Turn a script into narration and a perfectly synced SRT. Voices are Kokoro, running locally — no API key, no per-character billing, and nothing about an unreleased client product leaves the machine."));
  m.append(Object.assign(el("div","note"),{innerHTML:
    "Timings are exact by construction: each line is synthesised and measured, so the SRT cannot drift from the audio. Edit one line and only that line re-synthesises — the rest come from cache."}));

  const f=el("div","form");
  const mk=(l,n)=>{f.append(el("label",null,l),n);return n;};
  const proj=mk("Project", el("select"));
  for(const p of S.projects) proj.append(Object.assign(el("option",null,(p.client?p.client+" · ":"")+p.name),{value:p.id}));
  const pick=mk("Script", el("select"));
  const voice=mk("Voice", el("select"));
  for(const v of VOICES) voice.append(Object.assign(el("option",null,v.label),{value:v.id}));
  const gap=mk("Gap between lines", Object.assign(el("input"),{type:"number",value:320,min:0,max:1500,step:20}));

  const preview=el("pre","full"); preview.style.maxHeight="260px"; preview.style.overflow="auto";
  const est=el("div","path");
  const fill=()=>{
    pick.innerHTML="";
    const mine=S.scripts.filter(x=>x.project===proj.value);
    if(!mine.length){ pick.append(Object.assign(el("option",null,"— no scripts in this project —"),{value:""})); }
    for(const sc of mine) pick.append(Object.assign(el("option",null,sc.name),{value:sc.name}));
    show();
  };
  const show=()=>{
    const sc=S.scripts.find(x=>x.project===proj.value&&x.name===pick.value);
    const lines=sc?SP.parseScript(sc.body):[];
    preview.textContent=lines.length?lines.map((l,i)=>(i+1)+"  "+l).join("\\n"):"Nothing speakable — headings, bullets markers and code blocks are skipped.";
    est.textContent=lines.length
      ? lines.length+" lines · roughly "+Math.round(SP.estimateSeconds(lines,Number(gap.value||320)))+"s"
      : "";
  };
  proj.onchange=fill; pick.onchange=show; gap.oninput=show;

  const out=el("div","full");
  const go=el("button","btn","Build the narration");
  const w=el("div","full"); w.append(go); f.append(el("label",null,"Lines"),el("span"),preview,est,w,out);
  go.onclick=async()=>{
    const r=await (await fetch("/api/voice",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({projectId:proj.value,script:pick.value,voice:voice.value,gap:Number(gap.value)})})).json();
    out.innerHTML="";
    if(r.error){out.append(Object.assign(el("pre"),{textContent:"Error: "+r.error}));return;}
    out.append(Object.assign(el("div","path"),{textContent:"audio  "+r.out}));
    out.append(Object.assign(el("div","path"),{textContent:"subs   "+r.srt}));
    out.append(runRow(r.step,"Speak it"));
  };
  m.append(f);
  fill();
}

const VOICES=[
  {id:"af_nova",label:"Nova — female, US, warm"},
  {id:"af_bella",label:"Bella — female, US, bright"},
  {id:"af_sarah",label:"Sarah — female, US, even"},
  {id:"am_adam",label:"Adam — male, US, low"},
  {id:"am_michael",label:"Michael — male, US, even"},
  {id:"bf_emma",label:"Emma — female, UK"},
  {id:"bm_george",label:"George — male, UK"},
];

/* ── Scripts ─────────────────────────────────────────────── */
function vScripts(m){
  m.append(el("h2",null,"Scripts"), el("p","lede",
    "Narration and outlines as markdown — greppable, and they diff. A script saved to a project lands in that project's scripts/ folder; the shared shelf is for the ones that travel. Voice reads from here."));

  // Drafting. Claude writes straight into the project's scripts/ folder, in the
  // shape the synthesiser wants — one spoken sentence per line — so a draft is
  // ready for Voice without reformatting.
  const draft=el("div","form"); draft.style.marginBottom="20px";
  const dk=(l,n)=>{draft.append(el("label",null,l),n);return n;};
  const dproj=dk("Project", el("select"));
  for(const p of S.projects) dproj.append(Object.assign(el("option",null,(p.client?p.client+" · ":"")+p.name),{value:p.id}));
  const dname=dk("Save as", Object.assign(el("input"),{placeholder:"opener"}));
  const dsecs=dk("Seconds", Object.assign(el("input"),{type:"number",value:30,min:10,max:180,step:5}));
  const dabout=el("textarea"); dabout.className="full";
  dabout.placeholder="A URL, or a couple of sentences about what the video is for and who is watching.";
  draft.append(el("label",null,"About"),el("span"),dabout);
  const dout=el("div","full");
  const dgo=el("button","btn ghost","Draft it with Claude");
  const dw=el("div","full"); dw.append(dgo); draft.append(dw,dout);
  dgo.onclick=async()=>{
    const r=await (await fetch("/api/script/draft",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({projectId:dproj.value,name:dname.value,seconds:Number(dsecs.value),about:dabout.value})})).json();
    dout.innerHTML="";
    if(r.error){dout.append(Object.assign(el("pre"),{textContent:"Error: "+r.error}));return;}
    dout.append(Object.assign(el("div","path"),{textContent:"writes  "+r.dest}));
    dout.append(runRow(r.step,"Write the draft"));
    dout.append(Object.assign(el("div","path"),{textContent:"When it finishes, reload and it appears below and in Voice."}));
  };
  m.append(draft);

  const f=el("div","form");
  f.append(el("label",null,"Project"));
  const proj=el("select");
  proj.append(Object.assign(el("option",null,"Shared shelf (no project)"),{value:""}));
  for(const p of S.projects) proj.append(Object.assign(el("option",null,(p.client?p.client+" · ":"")+p.name),{value:p.id}));
  f.append(proj);
  f.append(el("label",null,"Name"));
  const name=Object.assign(el("input"),{placeholder:"case-study-opener"}); f.append(name);
  const body=el("textarea"); body.className="full"; body.placeholder="Write the script…";
  f.append(body);
  const save=el("button","btn","Save script"); const w=el("div","full"); w.append(save); f.append(w);
  save.onclick=async()=>{await fetch("/api/script",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({name:name.value,body:body.value,projectId:proj.value||null})}); await load();};
  m.append(f);
  if(S.scripts.length){
    m.append(el("div","client","Saved"));
    const g=el("div","grid");
    for(const s of S.scripts){
      const c=el("div","card"); const b=el("div","body");
      const owner=s.project?(S.projects.find(x=>x.id===s.project)?.name??s.project):"shared";
      b.append(el("div","nm",s.name), el("div","path",owner),
        el("div","path",s.body.slice(0,120)+(s.body.length>120?"…":"")));
      c.append(b); c.style.cursor="pointer";
      c.onclick=()=>{name.value=s.name;body.value=s.body;proj.value=s.project||"";window.scrollTo(0,0);};
      g.append(c);
    }
    m.append(g);
  }
}

/* ── Brand ───────────────────────────────────────────────── */
function vBrand(m){
  m.append(el("h2",null,"Brand"), el("p","lede",
    "Wallpapers and title treatments, generated from the Optics palette. Change the export, re-run sync-brand, and everything here follows."));

  const t=S.tokens||{};
  const pal=t.palette||{};
  m.append(el("div","client","Sub-brands"));
  const pg=el("div","grid");
  for(const [id,b] of Object.entries(t.subBrands||{})){
    const c=el("div","card");
    const sw=el("div","thumb"); sw.style.background=b.hex; sw.style.aspectRatio="16/6";
    const bd=el("div","body");
    bd.append(el("div","nm",b.label), el("div","path",\`\${b.hex} · H\${b.h} S\${b.s}% L\${b.l}%\`));
    c.append(sw,bd); pg.append(c);
  }
  m.append(pg);

  m.append(el("div","client","Title & lower third"));
  const sel=el("div","row");
  const wpSel=el("select");
  for(const w of S.wallpapers) wpSel.append(Object.assign(el("option",null,w.label),{value:w.file}));
  const tIn=Object.assign(el("input"),{value:"Dock Designer",placeholder:"Title"});
  const eIn=Object.assign(el("input"),{value:"Product tour",placeholder:"Eyebrow"});
  const nIn=Object.assign(el("input"),{value:"Dallas Peters",placeholder:"Name"});
  const sIn=Object.assign(el("input"),{value:"Senior Designer",placeholder:"Subtitle"});
  sel.append(wpSel,tIn,eIn,nIn,sIn); m.append(sel);

  const prev=el("div","grid"); prev.style.gridTemplateColumns="repeat(auto-fill,minmax(420px,1fr))";
  m.append(prev);
  const draw=()=>{
    prev.innerHTML="";
    for(const mode of ["title","lower"]){
      const box=el("div","lt");
      box.style.backgroundImage=\`url('/wallpaper/\${wpSel.value}')\`;
      const scale=c=>c/1920*100+"cqw";
      if(mode==="title"){
        const eb=el("div","eb",eIn.value.toUpperCase());
        eb.style.cssText=\`color:\${pal.primary};font-size:1.35cqw\`;
        const ti=el("div","ti",tIn.value);
        ti.style.cssText=\`color:\${pal.light};font-size:5cqw\`;
        box.append(eb,ti);
      } else {
        const n=el("div","t",nIn.value); n.style.cssText=\`color:\${pal.light};font-size:2.3cqw\`;
        const s2=el("div","s",sIn.value); s2.style.cssText=\`color:\${pal.tertiary};font-size:1.25cqw\`;
        box.append(n,s2);
      }
      box.style.containerType="inline-size";
      const c=el("div","card"); c.style.padding="0"; c.append(box);
      const cap=el("div","body"); cap.append(el("div","path",mode==="title"?"title()":"lowerThird()"));
      c.append(cap); prev.append(c);
    }
  };
  for(const i of [wpSel,tIn,eIn,nIn,sIn]) i.oninput=draw, i.onchange=draw;
  draw();

  m.append(el("div","client","Wallpapers"));
  const wg=el("div","grid");
  for(const w of S.wallpapers){
    const c=el("div","card");
    const im=el("div","wp"); im.style.backgroundImage=\`url('/wallpaper/\${w.file}')\`;
    const b=el("div","body"); b.append(el("div","nm",w.label), el("div","path",w.file));
    c.onclick=()=>{ editing=null; view="wallpapers";
      for(const o of document.querySelectorAll("nav button[data-v]")) o.setAttribute("aria-current",String(o.dataset.v==="wallpapers"));
      render(); setTimeout(()=>{const r=recipes.find(x=>x.name===w.name); if(r) openEditor(r);},150); };
    c.append(im,b); wg.append(c);
  }
  m.append(wg);
}

/* ── Wallpapers ──────────────────────────────────────────────
   A wallpaper is a recipe, not a hand-written CSS block. The canvas below runs
   the same lib/wallpaper.mjs the batch renderer runs, so what you see is what
   gets written — Save just re-draws it at 3840×2160 and posts the bytes. */
function vWallpapers(m){
  m.append(el("h2",null,"Wallpapers"), el("p","lede",
    "The backdrop behind the recording — the biggest branded surface in the video. Everything here is linear: no radial gradients, no vignette."));

  const grid=el("div","grid wpgrid");
  const editor=el("div"); editor.style.marginTop="22px";
  const bar=el("div","row");
  const nw=el("button","btn ghost","New wallpaper");
  nw.onclick=()=>openEditor({...WP.DEFAULT_RECIPE, name:"", label:""});
  bar.append(nw);
  m.append(bar, grid, editor);

  const paint=()=>{
    grid.innerHTML="";
    for(const r of recipes){
      const c=el("div","card"); c.setAttribute("aria-selected",String(editing?.name===r.name));
      const cv=el("canvas"); cv.width=460; cv.height=259;
      cv.style.cssText="width:100%;height:auto;display:block";
      WP.draw(cv.getContext("2d"), r, cv.width, cv.height);
      const b=el("div","body"); b.append(el("div","nm",r.label), el("div","path",r.name+".jpg"));
      c.append(cv,b);
      c.onclick=()=>openEditor(r);
      grid.append(c);
    }
  };

  openEditor = (r)=>{
    editing=JSON.parse(JSON.stringify(WP.normalize(r)));
    if(!r.name) editing.name="";
    paint();
    editor.innerHTML="";
    editor.append(buildEditor(editing, paint));
    editor.scrollIntoView({behavior:"smooth",block:"nearest"});
  };

  if(!recipes.length){
    grid.append(Object.assign(el("div","empty","Loading recipes…"),{}));
    fetch("/api/wallpapers").then(r=>r.json()).then(d=>{recipes=d.wallpapers.map(WP.normalize);paint();});
  } else paint();
}

let openEditor = ()=>{};

/** The control panel. Every input mutates the recipe in place and repaints. */
function buildEditor(r, onSaved){
  const wrap=el("div","wpe");
  const left=el("div");
  const cv=el("canvas"); cv.width=1280; cv.height=720;
  left.append(cv);
  const status=el("div","path"); status.style.marginTop="10px"; left.append(status);
  const panel=el("div","panel2");

  const repaint=()=>WP.draw(cv.getContext("2d"), r, cv.width, cv.height);

  const sec=(t)=>panel.append(el("div","sec",t));
  const g=()=>{const d=el("div","ctl");panel.append(d);return d;};

  const textRow=(box,label,get,set,ph)=>{
    const i=Object.assign(el("input"),{value:get()??"",placeholder:ph||""});
    i.className="wide"; i.oninput=()=>{set(i.value);repaint();};
    box.append(el("label",null,label), i);
    return i;
  };
  const colorRow=(box,label,get,set)=>{
    const i=Object.assign(el("input"),{type:"color",value:get()});
    i.oninput=()=>{set(i.value);repaint();};
    box.append(el("label",null,label), i, el("span","v",""));
    return i;
  };
  const rangeRow=(box,label,get,set,min,max,step,fmt)=>{
    const i=Object.assign(el("input"),{type:"range",min,max,step,value:get()});
    const v=el("span","v",(fmt||String)(get()));
    i.oninput=()=>{set(Number(i.value));v.textContent=(fmt||String)(Number(i.value));repaint();};
    box.append(el("label",null,label), i, v);
    return i;
  };
  const selectRow=(box,label,opts,get,set)=>{
    const s=el("select"); s.className="wide";
    for(const o of opts) s.append(Object.assign(el("option",null,o),{value:o,selected:o===get()}));
    s.onchange=()=>{set(s.value);repaint();};
    box.append(el("label",null,label), s);
    return s;
  };

  sec("Identity");
  const idb=g();
  const nameIn=textRow(idb,"Name",()=>r.name,v=>{r.name=v;},"flow-board");
  textRow(idb,"Label",()=>r.label,v=>{r.label=v;},"Flow · tinted board");

  sec("Base + gradient");
  const gb=g();
  colorRow(gb,"Base",()=>r.base,v=>{r.base=v;});
  rangeRow(gb,"Angle",()=>r.gradient.angle,v=>{r.gradient.angle=v;},0,360,1,v=>v+"°");
  const stops=el("div"); stops.className="wide"; gb.append(el("label",null,"Stops"), stops);
  const drawStops=()=>{
    stops.innerHTML="";
    r.gradient.stops.forEach((s,i)=>{
      const row=el("div","stop");
      const c=Object.assign(el("input"),{type:"color",value:s.color});
      c.oninput=()=>{s.color=c.value;repaint();};
      const p=Object.assign(el("input"),{type:"range",min:0,max:1,step:0.01,value:s.at});
      const pv=el("span","v",Math.round(s.at*100)+"%");
      p.oninput=()=>{s.at=Number(p.value);pv.textContent=Math.round(s.at*100)+"%";repaint();};
      const x=el("button",null,"×");
      x.onclick=()=>{ if(r.gradient.stops.length<2) return; r.gradient.stops.splice(i,1); drawStops(); repaint(); };
      row.append(c,p,pv,x); stops.append(row);
    });
    const add=el("button","chip","+ stop");
    add.onclick=()=>{ r.gradient.stops.push({color:r.base,at:1}); drawStops(); repaint(); };
    stops.append(add);
  };
  drawStops();

  sec("Tint");
  const tb=g();
  colorRow(tb,"Colour",()=>r.tint.color,v=>{r.tint.color=v;});
  rangeRow(tb,"Strength",()=>r.tint.alpha,v=>{r.tint.alpha=v;},0,0.6,0.01,v=>v.toFixed(2));
  rangeRow(tb,"Angle",()=>r.tint.angle,v=>{r.tint.angle=v;},0,360,1,v=>v+"°");

  sec("Texture");
  const xb=g();
  selectRow(xb,"Type",WP.TEXTURES,()=>r.texture.type,v=>{r.texture.type=v;});
  colorRow(xb,"Colour",()=>r.texture.color,v=>{r.texture.color=v;});
  rangeRow(xb,"Opacity",()=>r.texture.opacity,v=>{r.texture.opacity=v;},0,0.4,0.005,v=>v.toFixed(3));
  rangeRow(xb,"Spacing",()=>r.texture.size,v=>{r.texture.size=v;},4,96,1,v=>v+"px");
  rangeRow(xb,"Weight",()=>r.texture.weight,v=>{r.texture.weight=v;},0.25,6,0.05,v=>v.toFixed(2));

  sec("Border");
  const bb=g();
  bb.append(Object.assign(el("div","note wide"),{textContent:
    "The edge is a solid line, not a fade. Width is in px at 1920 and scales with the export, so 6px looks like 6px at 4K. Zero turns it off."}));
  rangeRow(bb,"Width",()=>r.border.width,v=>{r.border.width=v;},0,32,1,v=>v+"px");
  colorRow(bb,"Colour",()=>r.border.color,v=>{r.border.color=v;});
  rangeRow(bb,"Inset",()=>r.border.inset,v=>{r.border.inset=v;},0,120,1,v=>v+"px");
  rangeRow(bb,"Radius",()=>r.border.radius,v=>{r.border.radius=v;},0,120,1,v=>v+"px");

  const save=el("button","btn","Save wallpaper");
  save.style.marginTop="18px";
  save.onclick=async()=>{
    if(!nameIn.value.trim()){status.textContent="Name it first.";return;}
    save.disabled=true; save.textContent="Rendering 4K…";
    // Draw the real export off-screen with the identical code path, then hand the
    // server finished bytes. No Playwright on a designer's machine.
    const big=document.createElement("canvas"); big.width=3840; big.height=2160;
    WP.draw(big.getContext("2d"), r, big.width, big.height);
    const jpeg=big.toDataURL("image/jpeg",0.92);
    const res=await (await fetch("/api/wallpaper",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({recipe:r,jpeg})})).json();
    save.disabled=false; save.textContent="Save wallpaper";
    if(res.error){status.textContent="Error: "+res.error;return;}
    status.textContent="Saved "+res.file;
    const d=await (await fetch("/api/wallpapers")).json();
    recipes=d.wallpapers.map(WP.normalize);
    // Refresh state without re-rendering — render() would tear down this editor
    // mid-edit, which is a rotten thing to do to someone who just hit Save.
    S = await (await fetch("/api/state")).json();
    onSaved?.();
  };
  panel.append(save);

  wrap.append(left,panel);
  requestAnimationFrame(repaint);
  return wrap;
}

/* ── Console ─────────────────────────────────────────────────
   Every job the Studio has started, with live output. One EventSource at a
   time, closed on switch — a page that quietly holds twenty open streams is a
   page that stops updating after a while and nobody knows why. */
function vConsole(m){
  m.append(el("h2",null,"Console"), el("p","lede",
    "Everything the Studio runs, as it runs. Output is live — you don't have to go find a terminal to see whether the export worked."));

  const wrap=el("div","con");
  const list=el("div","joblist");
  const right=el("div");
  const log=el("div","log");
  right.append(log);
  wrap.append(list,right);
  m.append(wrap);

  if(shellOn){
    const bar=el("div","cmd");
    const inp=Object.assign(el("input"),{placeholder:"openscreen info --json"});
    const b=el("button","btn","Run");
    const fire=async()=>{ if(!inp.value.trim())return; await start({shell:inp.value.trim()}); inp.value=""; };
    b.onclick=fire; inp.onkeydown=e=>{if(e.key==="Enter")fire();};
    bar.append(inp,b); right.append(bar);
  } else {
    right.append(Object.assign(el("div","note"),{innerHTML:
      "Run buttons build their own commands from a fixed list of binaries, so this page will not run arbitrary text. Want a prompt to type into? Restart with <code>rm-studio --shell</code>."}));
  }

  if(!allJobs.length){
    list.append(Object.assign(el("div","empty","Nothing has run yet."),{style:"padding:20px"}));
  }
  for(const j of allJobs){
    const row=el("div","job"); row.setAttribute("aria-selected",String(j.id===jobId));
    const st=j.running?"running":(j.code===0?"done":"exit "+j.code);
    row.append(el("div","jl",j.label),
      Object.assign(el("div","js "+(j.running?"run":(j.code===0?"":"bad"))),
        {textContent:st+" · "+j.startedAt.slice(11,19)}));
    row.onclick=()=>{jobId=j.id;render();};
    list.append(row);
  }

  if(!jobId){ log.append(Object.assign(el("div","m"),{textContent:"Pick a job."})); return; }

  const cur=allJobs.find(j=>j.id===jobId);
  if(cur){
    const head=el("div","runrow");
    head.append(Object.assign(el("code"),{textContent:cur.command}));
    if(cur.running){
      const s=el("button","btn ghost","Stop");
      s.onclick=async()=>{await fetch("/api/jobs/"+cur.id+"/stop",{method:"POST"});refreshJobs();};
      head.append(s);
    }
    right.insertBefore(head, log);
  }

  es?.close();
  const write=(cls,t)=>{ const d=el("div",cls,t); log.append(d); log.scrollTop=log.scrollHeight; };
  es=new EventSource("/api/jobs/"+jobId+"/events");
  es.onmessage=(e)=>{
    const d=JSON.parse(e.data);
    if(d.done){ write("m","— exited "+d.code+" —"); es.close(); refreshJobs(); return; }
    write(d.stream==="err"?"e":"", d.text);
  };
  es.onerror=()=>es.close();
}

/* ── Components ──────────────────────────────────────────────
   The gallery is a real HyperFrames scene, not a screenshot of one — same
   custom elements, same Optics tokens, same seek contract. If it looks right
   here it renders right, because it is the same code path. */
function vComponents(m){
  m.append(el("h2",null,"Components"), el("p","lede",
    "Custom elements for HyperFrames scenes: title cards, browser chrome, lower thirds, callouts, stats, build-on lists. Drag the scrubber in the frame — the page is seeked to that instant, which is exactly what the renderer does frame by frame."));
  m.append(Object.assign(el("div","note"),{innerHTML:
    "Animation is <em>seeked, not played</em>: every component is a paused CSS animation positioned by one <code>--t</code> property, so frame N is identical on every render. Copy <code>components/scene.html</code> to start a new one."}));
  const bar=el("div","row");
  const open=el("button","btn","Open in a tab");
  open.onclick=()=>window.open("/components/gallery.html","_blank");
  const scene=el("button","btn ghost","Open the scene template");
  scene.onclick=()=>window.open("/components/scene.html","_blank");
  bar.append(open,scene); m.append(bar);
  const f=el("iframe");
  f.src="/components/gallery.html";
  f.style.cssText="width:100%;height:78vh;border:1px solid var(--line);border-radius:10px;background:var(--bg)";
  m.append(f);
  m.append(Object.assign(el("pre"),{style:"margin-top:16px",textContent:
    "node components/render-scene.mjs components/scene.html -o demo.mp4 --fps 30"}));
}

/* ── Storage ─────────────────────────────────────────────── */
function vStorage(m){
  m.append(el("h2",null,"Storage"), el("p","lede",
    "Cloudflare R2 is S3-compatible, so rclone already speaks it — and it has no egress fees, which is the line item that hurts with video."));
  m.append(Object.assign(el("div","note"),{innerHTML:
    "You don't need this until two people need the same footage. Local projects work fine without it."}));
  const f=el("div","form");
  const mk=(l,n)=>{f.append(el("label",null,l),n);return n;};
  const name=mk("Remote name", Object.assign(el("input"),{placeholder:"rm-video"}));
  const ep=mk("Endpoint", Object.assign(el("input"),{placeholder:"https://<account>.r2.cloudflarestorage.com"}));
  const ak=mk("Access key", el("input"));
  const sk=mk("Secret key", Object.assign(el("input"),{type:"password"}));
  const out=el("pre","full"); out.style.display="none";
  const go=el("button","btn","Save remote"); const w=el("div","full"); w.append(go); f.append(w,out);
  go.onclick=async()=>{
    const r=await (await fetch("/api/storage",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:name.value,endpoint:ep.value,accessKeyId:ak.value,secretAccessKey:sk.value})})).json();
    out.style.display="block";
    out.textContent=r.ok?("Saved. rclone remote \\""+name.value+"\\" is ready — pick it when creating a project."):("Failed:\\n"+(r.err||r.out));
    if(r.ok) await load();
  };
  m.append(f);
  if(S.remotes.length){
    m.append(el("div","client","Configured remotes"));
    const g=el("div","grid");
    for(const r of S.remotes){const c=el("div","card");const b=el("div","body");
      b.append(el("div","nm",r));c.append(b);g.append(c);}
    m.append(g);
  }
}

load();
</script></body></html>`;
}
