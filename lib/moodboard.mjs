/*
 * A mood board: pictures on a canvas, each with a name and a note.
 *
 * The Showcase composes a scene and the Stickers page makes artwork. This is
 * the step before either — the wall you put references on while you are still
 * deciding what the thing looks like. Nothing here is generated; everything is
 * something somebody found, dropped in, and said a sentence about.
 *
 * Published the same way a sticker sheet is: a folder copied to the public
 * bucket, a plain page that needs no server, and comments through Neon's Data
 * API so whoever has the address can say what they think.
 *
 * WHERE THE NOTES LIVE
 *
 * In `sticker_comments`, which is the table for "somebody said something about
 * a picture in a project" and was already there. A board's key is the board's
 * name and the file, `<board>/<file>`, so it cannot collide with a sticker
 * sheet's bare file names. A table of its own was written and abandoned: Neon's
 * Data API serves the tables it knew about when it was switched on, a new one
 * answers 404 for hours, and `notify pgrst` does not move it — which would have
 * made this feature depend on somebody visiting a console.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A board item's key in the notes table: its board, then its file. */
export const noteKey = (board, file) => `${board}/${file}`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Where a project keeps its boards: one JSON per board. */
export const boardsDir = (projectDir) => join(projectDir, "boards");

/* A board is small and hand-editable on purpose: it is a list of what is on the
   wall, not a scene graph. Positions are fractions of the canvas, so a board
   opened on a laptop and a board opened on a big screen hold their layout. */
export const emptyBoard = (name) => ({ name, title: name, note: "", nodes: [], at: new Date().toISOString() });

export async function listBoards(projectDir) {
	const names = await readdir(boardsDir(projectDir)).catch(() => []);
	const out = [];
	for (const f of names) {
		if (!f.endsWith(".json")) continue;
		const rec = await readFile(join(boardsDir(projectDir), f), "utf8")
			.then(JSON.parse)
			.catch(() => null);
		if (rec?.name) out.push(rec);
	}
	return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function readBoard(projectDir, name) {
	return readFile(join(boardsDir(projectDir), `${name}.json`), "utf8")
		.then(JSON.parse)
		.catch(() => null);
}

export async function writeBoard(projectDir, board) {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(boardsDir(projectDir), { recursive: true });
	await writeFile(join(boardsDir(projectDir), `${board.name}.json`), `${JSON.stringify(board, null, "\t")}\n`, "utf8");
	return board;
}

/**
 * The published board.
 *
 * The nodes are placed exactly where they were left, as percentages of a
 * canvas whose shape is carried with them, so the page a client opens is the
 * board somebody arranged rather than a re-flowed approximation of it. A press
 * on a picture opens its own note and its own thread, which is the sticker
 * sheet's arrangement and for the same reason: the thing you are looking at is
 * where the conversation about it belongs.
 */
export function boardPage({ title, note = "", nodes, ratio = 16 / 9, made = new Date(), comments = null, project = "", slug = "", version = null }) {
	const v = String(version ?? Math.floor(made.getTime() / 1000));
	const at = (file, src) => src ?? `${file}${String(file).includes("?") ? "&" : "?"}v=${encodeURIComponent(v)}`;
	const cards = nodes
		.map(
			(n) =>
				`<figure class="n" data-for="${esc(n.file)}" data-name="${esc(n.title || n.file)}" style="left:${(n.x * 100).toFixed(3)}%;top:${(n.y * 100).toFixed(3)}%;width:${(n.w * 100).toFixed(3)}%">` +
				`<img src="${esc(at(n.file, n.src))}" alt="${esc(n.title || "")}" loading="lazy" />` +
				`${n.title || n.note ? `<figcaption>${n.title ? `<b>${esc(n.title)}</b>` : ""}${n.note ? `<span>${esc(n.note)}</span>` : ""}</figcaption>` : ""}` +
				`${comments ? `<b class="n__count" data-count="${esc(n.file)}"></b>` : ""}</figure>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}" />
<style>
  :root { color-scheme: dark; --green: #46e76f; }
  body { margin: 0; background: #141414; color: #bcbcbc; font: 400 16px/24px "DM Sans", system-ui, -apple-system, sans-serif; }
  header { padding: 40px 24px 0; max-width: 1400px; margin: 0 auto; }
  h1 { margin: 0; font-size: 30px; line-height: 36px; color: #fff; letter-spacing: -0.5px; }
  .lede { color: #979797; font-size: 15px; margin: 8px 0 0; max-width: 60ch; white-space: pre-wrap; }
  .meta { color: #6f6f6f; font-size: 13px; margin: 6px 0 0; }
  .wall { position: relative; max-width: 1400px; margin: 24px auto 80px; padding: 0 24px; }
  .board { position: relative; width: 100%; aspect-ratio: ${ratio.toFixed(4)}; background: #171717; border: 1px solid #262626; border-radius: 14px; overflow: hidden; }
  .n { position: absolute; margin: 0; }
  .n img { display: block; width: 100%; height: auto; border-radius: 10px; background: #202020; box-shadow: 0 10px 30px rgba(0,0,0,.45); cursor: pointer; }
  .n figcaption { display: block; padding: 6px 2px 0; font-size: 13px; line-height: 18px; }
  .n figcaption b { color: #fff; display: block; }
  .n figcaption span { color: #8f8f8f; }
  .n__count:empty { display: none; }
  .n__count { position: absolute; top: -8px; right: -8px; min-width: 22px; padding: 2px 6px; border-radius: 999px; background: var(--green); color: #141414; font-size: 12px; font-weight: 700; line-height: 18px; text-align: center; }
  .n.open img { outline: 2px solid var(--green); outline-offset: 3px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0 0; }
  .btn { display: inline-block; padding: 10px 16px; border-radius: 6px; background: var(--green); color: #141414; font-weight: 600; text-decoration: none; font-size: 14px; border: 0; font-family: inherit; line-height: 24px; cursor: pointer; }
  .btn.ghost { background: #1a1a1a; color: #bcbcbc; border: 1px solid #282828; }
  .linkbox { display: block; width: 100%; box-sizing: border-box; margin-top: 10px; padding: 8px 10px; border-radius: 6px; border: 1px solid #282828; background: #0f0f0f; color: #eee; font: inherit; font-size: 14px; }
  .tip { color: #777; font-size: 13px; margin: 10px 0 0; }
  /* The note box, opened at the picture it is about. */
  .pop { position: absolute; z-index: 20; width: min(360px, calc(100vw - 32px)); padding: 12px; border-radius: 12px; background: #1c1c1c; border: 1px solid #333; box-shadow: 0 12px 40px rgba(0,0,0,.55); display: none; }
  .pop.on { display: grid; gap: 10px; }
  .pop h3 { margin: 0; font-size: 14px; color: #fff; font-weight: 600; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .pop h3 button { background: none; border: 0; color: #888; font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; }
  .thread { display: grid; gap: 8px; max-height: 40vh; overflow: auto; }
  .c { padding: 8px 10px; border-radius: 8px; background: #262626; }
  .c b { color: #fff; font-weight: 600; font-size: 13px; }
  .c time { color: #777; font-size: 12px; margin-inline-start: 8px; }
  .c p { margin: 4px 0 0; font-size: 14px; white-space: pre-wrap; }
  .empty { color: #777; font-size: 13px; }
  form.add { display: grid; gap: 8px; }
  form.add input, form.add textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; border: 1px solid #333; background: #0f0f0f; color: #eee; font: inherit; font-size: 14px; }
  form.add textarea { resize: vertical; min-height: 72px; }
  form.add .send { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  form.add .send small { color: #777; font-size: 12px; }
  .err { color: #ff8a80; font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  ${note ? `<p class="lede">${esc(note)}</p>` : ""}
  <p class="meta">${nodes.length} item${nodes.length === 1 ? "" : "s"} · put up ${made.toISOString().slice(0, 10)} with RoleModel Studio</p>
</header>
<div class="wall">
  <div class="board">
${cards}
  </div>
  ${comments ? '<p class="tip">Press a picture to read its note and say what you think.</p>' : ""}
  <div class="row"><button class="btn ghost" id="copyLink" type="button">Copy link</button></div>
</div>
${
	comments
		? `<div class="pop" id="pop"><h3><span class="pname"></span><button class="x" type="button" aria-label="Close">×</button></h3><p class="pnote empty"></p><div class="thread"><div class="empty">Loading…</div></div><form class="add"><input name="who" placeholder="Your name" maxlength="80" /><textarea name="what" placeholder="What works, what should change" maxlength="2000" required></textarea><div class="send"><small>Enter posts, Shift+Enter for a new line</small><button class="btn" type="submit">Post</button></div></form><div class="err"></div></div>`
		: ""
}
<script>
(() => {
  const b = document.getElementById("copyLink"), was = b.textContent;
  const oldWay = () => { const t = document.createElement("textarea"); t.value = location.href; t.setAttribute("readonly", ""); t.style.cssText = "position:fixed;left:-9999px"; document.body.append(t); t.select(); let ok = false; try { ok = document.execCommand("copy"); } catch {} t.remove(); return ok; };
  const showBox = () => { let box = document.getElementById("linkBox"); if (!box) { box = document.createElement("input"); box.id = "linkBox"; box.readOnly = true; box.className = "linkbox"; b.parentElement.after(box); } box.value = location.href; box.focus(); box.select(); };
  b.onclick = async () => { let ok = false; try { await navigator.clipboard.writeText(location.href); ok = true; } catch {} if (!ok) ok = oldWay(); b.textContent = ok ? "Copied" : "Select and copy"; if (!ok) showBox(); setTimeout(() => { b.textContent = was; }, 1800); };
})();
${
	comments
		? `(() => {
  const API = ${JSON.stringify(comments.dataApi)};
  const PROJECT = ${JSON.stringify(project)};
  const BOARD = ${JSON.stringify(slug)};
  const NOTES = ${JSON.stringify(Object.fromEntries(nodes.map((n) => [n.file, n.note || ""])))};
  const KEY = (file) => BOARD + "/" + file;
  const AUTH = API.replace(".apirest.", ".neonauth.").replace("/rest/v1", "/auth");
  let jwt = null;
  const token = async (fresh) => { if (jwt && !fresh) return jwt; try { const r = await fetch(AUTH + "/token/anonymous"); jwt = r.ok ? (await r.json()).token : null; } catch { jwt = null; } return jwt; };
  const api = async (path, init, retry = true) => {
    const t = await token(false);
    const r = await fetch(API + path, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", ...(init && init.headers), ...(t ? { Authorization: "Bearer " + t } : {}) } });
    if ((r.status === 401 || r.status === 400) && retry) { await token(true); return api(path, init, false); }
    return r;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pop = document.getElementById("pop"), thread = pop.querySelector(".thread"), form = pop.querySelector("form"), err = pop.querySelector(".err"), pname = pop.querySelector(".pname"), pnote = pop.querySelector(".pnote");
  let anchor = null, current = null;
  const close = () => { pop.classList.remove("on"); anchor?.classList.remove("open"); anchor = null; current = null; };
  const count = (file, n) => { const el = document.querySelector('[data-count="' + file.replace(/"/g, '\\\\"') + '"]'); if (el) el.textContent = n ? String(n) : ""; };
  const where = (file) => "project=eq." + encodeURIComponent(PROJECT) + "&sticker=eq." + encodeURIComponent(KEY(file));
  const load = async (file) => { const r = await api("/sticker_comments?" + where(file) + "&order=created_at.asc"); return r.ok ? r.json() : []; };
  const paint = (list) => {
    thread.innerHTML = list.length ? list.map((c) => "<div class=c><b>" + esc(c.author || "Someone") + "</b><time>" + new Date(c.created_at).toLocaleString() + "</time><p>" + esc(c.body) + "</p></div>").join("") : "<div class=empty>Nothing said yet. Be the first.</div>";
    thread.scrollTop = thread.scrollHeight;
    if (current) count(current, list.length);
  };
  const place = (el) => {
    const r = el.getBoundingClientRect();
    pop.classList.add("on");
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.max(16, Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - w - 16));
    const below = r.bottom + 12 + h <= window.innerHeight || r.top - 12 - h < 0;
    pop.style.left = left + "px";
    pop.style.top = (below ? window.scrollY + r.bottom + 12 : window.scrollY + r.top - 12 - h) + "px";
  };
  const open = async (fig) => {
    if (anchor === fig) return close();
    close();
    anchor = fig; current = fig.dataset.for;
    fig.classList.add("open");
    pname.textContent = fig.dataset.name;
    pnote.textContent = NOTES[current] || "";
    pnote.style.display = NOTES[current] ? "" : "none";
    thread.innerHTML = '<div class="empty">Loading…</div>'; err.textContent = ""; form.what.value = "";
    try { form.who.value = localStorage.getItem("sticker-name") || ""; } catch {}
    place(fig); form.what.focus();
    paint(await load(current));
    place(fig);
  };
  for (const fig of document.querySelectorAll(".n")) fig.querySelector("img").addEventListener("click", () => open(fig));
  pop.querySelector(".x").onclick = close;
  form.what.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = form.what.value.trim(); if (!body || !current) return;
    const author = form.who.value.trim();
    try { localStorage.setItem("sticker-name", author); } catch {}
    const btn = form.querySelector("button[type=submit]"); btn.disabled = true; err.textContent = "";
    const item = current, el = anchor;
    const r = await api("/sticker_comments", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ project: PROJECT, sticker: KEY(item), author: author || null, body }) });
    btn.disabled = false;
    if (!r.ok) { err.textContent = "Could not post that (" + r.status + ")."; return; }
    form.what.value = "";
    if (current === item) { paint(await load(item)); place(el); }
  };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  document.addEventListener("pointerdown", (e) => { if (anchor && !pop.contains(e.target) && !e.target.closest(".n")) close(); });
  window.addEventListener("resize", () => { if (anchor) place(anchor); });
  /* Counts on every picture, so a thread is visible before it is opened. */
  api("/sticker_comments?project=eq." + encodeURIComponent(PROJECT) + "&sticker=like." + encodeURIComponent(BOARD + "/*") + "&select=sticker").then((r) => (r.ok ? r.json() : [])).then((rows) => { const by = {}; for (const r of rows) { const f = String(r.sticker).slice(BOARD.length + 1); by[f] = (by[f] || 0) + 1; } for (const [k, n] of Object.entries(by)) count(k, n); }).catch(() => {});
})();`
		: ""
}
</script>
</body>
</html>
`;
}
