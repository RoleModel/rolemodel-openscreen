/**
 * Renders a catalog into a self-contained HTML page.
 *
 * This is the browsable surface from the Frame.io/Strada screenshots, minus the
 * parts that need a server. It is one file with the data inlined, so it opens
 * from disk, works offline, and can be dropped in Slack or committed next to a
 * project. No build step, no dependency, nothing to host.
 *
 * What it deliberately is not: a player. Clicking an item reveals it in Finder
 * (via a file:// link) and lets the real app open it. Building a scrub-and-
 * comment surface is the Frame.io conversation, not this.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { duration, human } from "./library.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(await readFile(resolve(HERE, "../brand/tokens.json"), "utf8"));
const { palette, type } = tokens;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function renderCatalogHTML({ projects, generatedAt }) {
  const items = projects.flatMap((p) =>
    (p.catalog?.files ?? []).map((f) => ({
      project: p.name,
      projectId: p.id,
      rel: f.rel,
      name: f.name,
      kind: f.kind,
      bytes: f.bytes,
      mtime: f.mtime,
      tags: f.tags ?? [],
      dur: f.media?.durationSec ?? null,
      w: f.media?.video?.width ?? null,
      h: f.media?.video?.height ?? null,
      fps: f.media?.video?.fps ?? null,
      vcodec: f.media?.video?.codec ?? null,
      acodec: f.media?.audio?.codec ?? null,
      href: f.href ?? null,
      text: f.text ?? "",
    })),
  );

  const totalBytes = items.reduce((n, i) => n + i.bytes, 0);
  const kinds = [...new Set(items.map((i) => i.kind))].sort();

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>RoleModel Library</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0e141b; --panel: #161d27; --line: #232d3a;
    --fg: ${palette.light}; --muted: #8b98a8;
    --accent: ${palette.primary}; --dark: ${palette.dark};
    --display: "${type.display}", ui-sans-serif, system-ui, sans-serif;
    --mono: "${type.mono}", ui-monospace, SFMono-Regular, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--display); }
  header { position: sticky; top: 0; z-index: 5; background: rgba(14,20,27,.94);
           backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); padding: 20px 28px 16px; }
  h1 { margin: 0 0 2px; font-size: 20px; font-weight: 800; letter-spacing: -.02em; }
  .sub { color: var(--muted); font-size: 13px; font-family: var(--mono); }
  .controls { display: flex; gap: 10px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
  input[type=search] { flex: 1 1 280px; min-width: 220px; background: var(--panel); color: var(--fg);
    border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; font: inherit; font-size: 14px; }
  input[type=search]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .chip { background: var(--panel); border: 1px solid var(--line); color: var(--muted);
    border-radius: 999px; padding: 7px 13px; font-size: 13px; cursor: pointer; font: inherit; }
  .chip[aria-pressed=true] { background: var(--accent); border-color: var(--accent); color: var(--dark); font-weight: 600; }
  main { padding: 22px 28px 60px; }
  .project { margin-bottom: 34px; }
  .project > h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--muted); font-family: var(--mono); font-weight: 500; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 13px 14px; display: flex; flex-direction: column; gap: 8px; text-decoration: none; color: inherit; }
  .card:hover { border-color: var(--accent); }
  .card .nm { font-size: 14px; font-weight: 600; word-break: break-word; line-height: 1.3; }
  .card .path { font-family: var(--mono); font-size: 11px; color: var(--muted); word-break: break-all; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .meta span { background: #0e151d; border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px; }
  .kind { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; padding: 2px 7px;
    border-radius: 999px; align-self: flex-start; font-family: var(--mono); }
  .kind.video { background: #123a2c; color: #6fe0b0; }
  .kind.audio { background: #1a2f4a; color: #7db8f0; }
  .kind.still { background: #3a2f14; color: #e8c47a; }
  .empty { color: var(--muted); font-size: 14px; padding: 40px 0; }
  footer { color: var(--muted); font-size: 12px; font-family: var(--mono);
    padding: 0 28px 40px; border-top: 1px solid var(--line); margin: 0 28px; padding-top: 16px; }
</style></head>
<body>
<header>
  <h1>RoleModel Library</h1>
  <div class="sub">${items.length} files · ${human(totalBytes)} · ${projects.length} project${projects.length === 1 ? "" : "s"} · indexed ${esc((generatedAt || "").slice(0, 16).replace("T", " "))}</div>
  <div class="controls">
    <input type="search" id="q" placeholder="Search name, path, folder, codec…" autocomplete="off" />
    <button class="chip" data-kind="" aria-pressed="true">All</button>
    ${kinds.map((k) => `<button class="chip" data-kind="${k}" aria-pressed="false">${k}</button>`).join("")}
  </div>
</header>
<main id="out"></main>
<footer>
  Generated by <code>rm-library view</code>. Cards link to the file on disk — your browser may
  ask before opening a local path. This is a catalog, not a player.
</footer>
<script>
const ITEMS = ${JSON.stringify(items)};
const out = document.getElementById("out");
const q = document.getElementById("q");
let kind = "";

const human = (b) => { const u=["B","KB","MB","GB","TB"]; let i=0,n=b;
  while (n>=1024 && i<u.length-1){n/=1024;i++;} return n.toFixed(n<10&&i>0?2:0)+" "+u[i]; };
const dur = (s) => { if (s==null) return null; const h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=Math.floor(s%60);
  return h ? h+":"+String(m).padStart(2,"0")+":"+String(x).padStart(2,"0") : m+":"+String(x).padStart(2,"0"); };

function render() {
  const terms = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
  const hits = ITEMS.filter((i) => {
    if (kind && i.kind !== kind) return false;
    if (!terms.length) return true;
    const hay = [i.rel, i.name, i.vcodec, i.acodec, i.text, ...(i.tags||[])].filter(Boolean).join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });

  if (!hits.length) { out.innerHTML = '<p class="empty">Nothing matches.</p>'; return; }

  const byProject = {};
  for (const i of hits) (byProject[i.project] ||= []).push(i);

  out.innerHTML = Object.entries(byProject).map(([name, list]) => \`
    <section class="project">
      <h2>\${name} — \${list.length} file\${list.length===1?"":"s"}</h2>
      <div class="grid">\${list.map((i) => {
        const meta = [dur(i.dur), i.w ? i.w+"×"+i.h : null, i.fps ? i.fps+"fps" : null, human(i.bytes), i.vcodec || i.acodec]
          .filter(Boolean).map((m) => "<span>"+m+"</span>").join("");
        const href = i.href ? ' href="'+i.href+'"' : "";
        return \`<a class="card"\${href}>
          <span class="kind \${i.kind}">\${i.kind}</span>
          <div class="nm">\${i.name}</div>
          <div class="path">\${i.rel}</div>
          <div class="meta">\${meta}</div>
        </a>\`;
      }).join("")}</div>
    </section>\`).join("");
}

q.addEventListener("input", render);
for (const btn of document.querySelectorAll(".chip")) {
  btn.addEventListener("click", () => {
    kind = btn.dataset.kind;
    for (const b of document.querySelectorAll(".chip")) b.setAttribute("aria-pressed", String(b === btn));
    render();
  });
}
render();
</script>
</body></html>
`;
}

export { pathToFileURL, duration };
