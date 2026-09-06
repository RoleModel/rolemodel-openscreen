/*
 * Sharing a finished video: a page of our own, on our own storage.
 *
 * A review used to go through OpenFrame — an instance to run, a token to hold,
 * and a link that only resolved for whoever could reach the box. The sticker
 * sheets showed the shorter road: a folder copied to the public bucket, a
 * plain page, and comments through Neon's Data API as the anonymous role. This
 * is that road for video. The page needs no server; the storage keeps the
 * bytes; the database keeps the notes, each pinned to the moment it is about.
 */
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { capture } from "./narration.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The Data API address for a Neon database URL, or null when it is not Neon's. */
export function dataApiFor(databaseUrl) {
	try {
		const u = new URL(String(databaseUrl ?? ""));
		const [endpoint, ...rest] = u.hostname.split(".");
		if (!endpoint?.startsWith("ep-") || !u.hostname.endsWith(".neon.tech")) return null;
		return `https://${endpoint.replace(/-pooler$/, "")}.apirest.${rest.join(".")}${u.pathname.replace(/\/+$/, "")}/rest/v1`;
	} catch {
		return null;
	}
}

/** Neon Auth's host for a Data API address: the same endpoint, under the auth name. */
export const authFor = (dataApi) => String(dataApi).replace(".apirest.", ".neonauth.").replace("/rest/v1", "/auth");

/** A slug fit for a folder and a URL. */
export function shareSlug(text, fallback = "video") {
	const s = String(text ?? "")
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return s || fallback;
}

/** Where a project keeps its share records: one JSON per page. */
export const sharesDir = (projectDir) => join(projectDir, "shares");

export async function listShares(projectDir) {
	const dir = sharesDir(projectDir);
	const names = await readdir(dir).catch(() => []);
	const out = [];
	for (const n of names) {
		if (!n.endsWith(".json")) continue;
		const rec = await readFile(join(dir, n), "utf8")
			.then(JSON.parse)
			.catch(() => null);
		if (rec?.slug) out.push(rec);
	}
	return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * Comments on one project's pages, read the way the page reads them: through
 * the Data API with an anonymous token. Answers [] when anything is missing,
 * because a count is decoration, not a thing to fail a listing over.
 */
export async function shareComments({ dataApi, project, video = null, fetchImpl = fetch }) {
	if (!dataApi) return [];
	try {
		const tok = await fetchImpl(`${authFor(dataApi)}/token/anonymous`).then((r) => (r.ok ? r.json() : null));
		const headers = { Accept: "application/json", ...(tok?.token ? { Authorization: `Bearer ${tok.token}` } : {}) };
		const q = `project=eq.${encodeURIComponent(project)}${video ? `&video=eq.${encodeURIComponent(video)}` : ""}&order=created_at.asc`;
		const r = await fetchImpl(`${dataApi}/video_comments?${q}`, { headers });
		return r.ok ? r.json() : [];
	} catch {
		return [];
	}
}

/**
 * The page. A player, the notes beside it, a form under them. A note made with
 * "at this moment" ticked carries the time; pressing its chip seeks the player
 * there and pauses, so the reader is looking at the frame the note is about.
 */
export function videoPage({ title, videoFile, posterFile = null, made = new Date(), comments = null, project = "", slug = "" }) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}" />
${posterFile ? `<meta property="og:image" content="${esc(posterFile)}" />` : ""}
<style>
  :root { color-scheme: dark; --green: #46e76f; }
  body { margin: 0; background: #141414; color: #bcbcbc; font: 400 16px/24px "DM Sans", system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 1400px; margin: 0 auto; padding: 24px; display: grid; gap: 24px; grid-template-columns: minmax(0, 1fr) 380px; align-items: start; }
  @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; } }
  h1 { margin: 0; font-size: 26px; line-height: 32px; color: #fff; letter-spacing: -0.4px; }
  .meta { color: #979797; font-size: 14px; margin: 6px 0 0; }
  video { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0 0; }
  .btn { display: inline-block; padding: 10px 16px; border-radius: 6px; background: var(--green); color: #141414; font-weight: 600; text-decoration: none; font-size: 14px; border: 0; font-family: inherit; line-height: 24px; cursor: pointer; }
  .btn.ghost { background: #1a1a1a; color: #bcbcbc; border: 1px solid #282828; }
  .linkbox { display: block; width: 100%; box-sizing: border-box; margin-top: 10px; padding: 8px 10px; border-radius: 6px; border: 1px solid #282828; background: #0f0f0f; color: #eee; font: inherit; font-size: 14px; }
  aside { background: #1a1a1a; border: 1px solid #282828; border-radius: 12px; padding: 16px; display: grid; gap: 12px; position: sticky; top: 24px; max-height: calc(100vh - 48px); }
  aside h2 { margin: 0; font-size: 15px; color: #fff; font-weight: 600; }
  .thread { display: grid; gap: 8px; overflow: auto; min-height: 60px; }
  .c { padding: 10px 12px; border-radius: 8px; background: #222; }
  .c .who { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .c b { color: #fff; font-weight: 600; font-size: 13px; }
  .c time { color: #777; font-size: 12px; }
  .c p { margin: 4px 0 0; font-size: 14px; white-space: pre-wrap; }
  .at { display: inline-block; padding: 1px 8px; border-radius: 999px; background: #123a1f; color: var(--green); font-size: 12px; font-weight: 700; border: 0; cursor: pointer; font-family: inherit; }
  .at:hover { background: #185229; }
  .empty { color: #777; font-size: 13px; }
  form.add { display: grid; gap: 8px; }
  form.add input, form.add textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; border: 1px solid #333; background: #0f0f0f; color: #eee; font: inherit; font-size: 14px; }
  form.add textarea { resize: vertical; min-height: 72px; }
  form.add .send { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  form.add label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #bcbcbc; cursor: pointer; }
  form.add label b { color: var(--green); font-weight: 700; }
  form.add button[type=submit] { padding: 8px 14px; }
  form.add button:disabled { opacity: .5; }
  .err { color: #ff8a80; font-size: 13px; }
  .tip { color: #777; font-size: 12px; margin: 0; }
</style>
</head>
<body>
<div class="wrap">
  <main>
    <video id="v" controls playsinline preload="metadata"${posterFile ? ` poster="${esc(posterFile)}"` : ""} src="${esc(videoFile)}"></video>
    <h1 style="margin-top:16px">${esc(title)}</h1>
    <p class="meta">shared ${made.toISOString().slice(0, 10)} with RoleModel Studio</p>
    <div class="row"><a class="btn" href="${esc(videoFile)}" download>Download the video</a><button class="btn ghost" id="copyLink" type="button">Copy link</button></div>
  </main>
  <aside>
    <h2>Notes${comments ? "" : " (off)"}</h2>
    ${
			comments
				? `<div class="thread" id="thread"><div class="empty">Loading…</div></div>
    <form class="add" id="add"><input name="who" placeholder="Your name" maxlength="80" /><textarea name="what" placeholder="What should change, or what works" maxlength="2000" required></textarea><div class="send"><label><input type="checkbox" id="pin" checked /> at <b id="now">0:00</b></label><button class="btn" type="submit">Post</button></div></form>
    <p class="tip">Enter posts, Shift+Enter for a new line. Press a time to jump the video there.</p>
    <div class="err" id="err"></div>`
				: `<p class="empty">This page was published without a comments database.</p>`
		}
  </aside>
</div>
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
  const VIDEO = ${JSON.stringify(slug)};
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
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const v = document.getElementById("v"), thread = document.getElementById("thread"), form = document.getElementById("add"), err = document.getElementById("err"), pin = document.getElementById("pin"), now = document.getElementById("now");
  v.addEventListener("timeupdate", () => { now.textContent = mmss(v.currentTime * 1000); });
  const where = () => "project=eq." + encodeURIComponent(PROJECT) + "&video=eq." + encodeURIComponent(VIDEO);
  const load = async () => { const r = await api("/video_comments?" + where() + "&order=created_at.asc"); return r.ok ? r.json() : []; };
  const paint = (list) => {
    thread.innerHTML = list.length ? list.map((c) => "<div class=c><div class=who>" + (c.at_ms != null ? '<button type="button" class="at" data-at="' + c.at_ms + '">' + mmss(c.at_ms) + "</button>" : "") + "<b>" + esc(c.author || "Someone") + "</b><time>" + new Date(c.created_at).toLocaleString() + "</time></div><p>" + esc(c.body) + "</p></div>").join("") : "<div class=empty>No notes yet. Play the video and say what you see.</div>";
    for (const a of thread.querySelectorAll(".at")) a.onclick = () => { v.currentTime = Number(a.dataset.at) / 1000; v.pause(); v.scrollIntoView({ behavior: "smooth", block: "center" }); };
    thread.scrollTop = thread.scrollHeight;
  };
  try { form.who.value = localStorage.getItem("sticker-name") || ""; } catch {}
  form.what.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.what.addEventListener("focus", () => { if (!v.paused) v.pause(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = form.what.value.trim(); if (!body) return;
    const author = form.who.value.trim();
    try { localStorage.setItem("sticker-name", author); } catch {}
    const btn = form.querySelector("button[type=submit]"); btn.disabled = true; err.textContent = "";
    const at_ms = pin.checked ? Math.round(v.currentTime * 1000) : null;
    const r = await api("/video_comments", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ project: PROJECT, video: VIDEO, at_ms, author: author || null, body }) });
    btn.disabled = false;
    if (!r.ok) { err.textContent = "Could not post the note (" + r.status + ")."; return; }
    form.what.value = "";
    paint(await load());
  };
  load().then(paint);
})();`
		: ""
}
</script>
</body>
</html>
`;
}

/**
 * Publish one video as a page. Builds the folder — the video, a poster frame,
 * the page — copies it to the public bucket, and writes the record beside the
 * project. Returns the record. `remotePath(remote, path)` and `publicBase` are
 * the caller's, because the Studio guards those; `onStep` narrates.
 */
export async function publishShare({ projectDir, projectId, file, title, remote, publicBase, publicBucket, dataApi, remotePath = (r, p) => `${r}:${p}`, onStep = () => {} }) {
	const st = await stat(file).catch(() => null);
	if (!st?.isFile()) throw new Error("no such video");
	const name = String(title ?? "").trim() || basename(file, extname(file));
	const slug = shareSlug(name, "video");
	const ext = extname(file).toLowerCase() || ".mp4";
	const site = join(sharesDir(projectDir), "site", slug);
	await rm(site, { recursive: true, force: true });
	await mkdir(site, { recursive: true });
	const videoFile = `video${ext}`;
	onStep("copying the video");
	await copyFile(file, join(site, videoFile));
	/* A poster a second in, so the page has a picture before anyone presses play.
	   No ffmpeg, no poster — the page still works. */
	let posterFile = null;
	onStep("drawing the poster");
	const poster = await capture("ffmpeg", ["-y", "-ss", "1", "-i", file, "-frames:v", "1", "-q:v", "3", join(site, "poster.jpg")]).catch(() => ({ ok: false }));
	if (poster.ok && (await stat(join(site, "poster.jpg")).catch(() => null))) posterFile = "poster.jpg";
	const made = new Date();
	await writeFile(join(site, "index.html"), videoPage({ title: name, videoFile, posterFile, made, comments: dataApi ? { dataApi } : null, project: projectId, slug }), "utf8");
	const dest = remotePath(remote, `${publicBucket}/share/${projectId}/${slug}`);
	if (!dest) throw new Error("that storage cannot take a page");
	onStep("uploading");
	/* The video and the poster cache like media; the page asks to be checked
	   each time, so a republished page shows at once. */
	const media = await capture("rclone", ["copy", site, dest, "--exclude", "index.html"]);
	if (!media.ok) throw new Error(`rclone could not copy the video: ${(media.err || "").trim().slice(0, 200)}`);
	const page = await capture("rclone", ["copy", site, dest, "--include", "index.html", "--header-upload", "Cache-Control: no-cache"]);
	if (!page.ok) throw new Error(`rclone could not copy the page: ${(page.err || "").trim().slice(0, 200)}`);
	const url = `${String(publicBase).replace(/\/+$/, "")}/share/${encodeURIComponent(projectId)}/${encodeURIComponent(slug)}/index.html`;
	const record = { slug, title: name, file: basename(file), rel: null, remote, bucket: publicBucket, url, video: videoFile, poster: posterFile, at: made.toISOString(), comments: Boolean(dataApi) };
	await mkdir(sharesDir(projectDir), { recursive: true });
	await writeFile(join(sharesDir(projectDir), `${slug}.json`), `${JSON.stringify(record, null, "\t")}\n`, "utf8");
	return record;
}

/** Take a page down: the copy in storage, the folder, the record. */
export async function removeShare({ projectDir, projectId, record, remotePath = (r, p) => `${r}:${p}` }) {
	const dest = remotePath(record.remote, `${record.bucket}/share/${projectId}/${record.slug}`);
	if (dest) {
		const gone = await capture("rclone", ["purge", dest]);
		if (!gone.ok && !/not found/i.test(gone.err || "")) throw new Error(`rclone could not remove it: ${(gone.err || "").trim().slice(0, 200)}`);
	}
	await rm(join(sharesDir(projectDir), "site", record.slug), { recursive: true, force: true });
	await rm(join(sharesDir(projectDir), `${record.slug}.json`), { force: true });
}

/* Kept for callers that stream a site file; the Studio serves records, not bytes. */
export const readSiteFile = (projectDir, slug, name) => createReadStream(join(sharesDir(projectDir), "site", slug, name));
