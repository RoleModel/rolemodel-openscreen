/*
 * Stickers: a picture made into a sticker, cut out, traced to vector, laid on a
 * sheet, and published as a page.
 *
 * Brought over from the addison-photos boards, where the same steps ran as
 * nodes on a canvas. Here they are plain functions over fal.ai, with the
 * models as data so a new one is a row, not a branch.
 */
import { callFal } from "./style-gen.mjs";

/**
 * The sticker styles. A LoRA is not its own endpoint: it rides on a base
 * model and differs only in the weights it loads and the token it was trained
 * against, which is prepended to the prompt — a prompt without it quietly
 * returns the base model, which looks like the style not working.
 */
export const STICKER_MODELS = [
	{
		id: "telegram",
		label: "Sticker (Telegram)",
		endpoint: "fal-ai/flux-lora",
		imageEndpoint: "fal-ai/flux-lora/image-to-image",
		lora: { path: "https://ftxhendy6jwk0sx5.public.blob.vercel-storage.com/loras/telegram-sticker-flux.safetensors", scale: 0.9 },
		trigger: "telesticker, sticker art, white outline",
	},
	{
		id: "bubblegum",
		label: "Bubblegum sticker",
		endpoint: "fal-ai/krea-2/turbo",
		imageEndpoint: "fal-ai/krea-2/turbo/image-to-image",
		lora: { path: "https://huggingface.co/ilkerzgi/krea-2-bubblegum-pop-sticker-lora/resolve/main/bubblegum-pop-sticker.safetensors", scale: 0.9 },
		trigger: "bubblegum pop sticker style",
	},
	{
		id: "plain",
		label: "Plain (no style)",
		endpoint: "fal-ai/nano-banana-pro",
		imageEndpoint: "fal-ai/nano-banana-pro/edit",
		lora: null,
		trigger: "",
	},
];

/** How much a source picture is reworked by a LoRA. fal's default of 0.85 loses the subject. */
export const LORA_STRENGTH = 0.7;

/** Ways to take the background off. All answer { image: { url } }. */
export const CUTOUT_MODELS = [
	{ id: "fal-ai/birefnet/v2", label: "BiRefNet v2 — crisp edges" },
	{ id: "fal-ai/bria/background/remove", label: "Bria — safe on people" },
	{ id: "fal-ai/imageutils/rembg", label: "rembg — quick" },
];

/**
 * Ways to trace a raster to vector. Recraft is the one the boards used; the
 * rest are offered by id, and a Custom entry takes any fal endpoint that
 * answers { image: { url } } with an SVG.
 */
export const VECTORIZE_MODELS = [
	{ id: "fal-ai/recraft/vectorize", label: "Recraft — clean shapes" },
	{ id: "fal-ai/recraft-v3/vectorize", label: "Recraft v3" },
	{ id: "custom", label: "Custom endpoint…" },
];

const IMAGE_URL = /^https?:\/\//i;

/**
 * Put bytes where fal can fetch them. fal's storage takes an upload in two
 * steps: ask for a slot, then PUT the bytes into it; the file URL is the
 * picture's address for every call after.
 */
export async function falUpload({ key, bytes, contentType, name = "picture", fetchImpl = fetch }) {
	const slot = await fetchImpl("https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
		method: "POST",
		headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ content_type: contentType, file_name: name }),
	});
	if (!slot.ok) throw new Error(`fal storage refused the upload (${slot.status})`);
	const { upload_url: uploadUrl, file_url: fileUrl } = await slot.json();
	const put = await fetchImpl(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
	if (!put.ok) throw new Error(`fal storage did not take the bytes (${put.status})`);
	return fileUrl;
}

/** Make a sticker: from a prompt, or from a picture with a prompt to steer it. */
export async function makeSticker({ key, model = "telegram", prompt = "", imageUrl = null, fetchImpl = fetch }) {
	const m = STICKER_MODELS.find((x) => x.id === model) ?? STICKER_MODELS[0];
	const text = String(prompt ?? "").trim() || "a sticker of the subject";
	const withTrigger = m.trigger && !text.toLowerCase().includes(m.trigger.toLowerCase()) ? `${m.trigger}, ${text}` : text;
	const endpoint = imageUrl ? m.imageEndpoint : m.endpoint;
	const body = m.lora
		? { prompt: withTrigger, loras: [{ path: m.lora.path, scale: m.lora.scale }], num_images: 1, output_format: "png", ...(imageUrl ? { image_url: imageUrl, strength: LORA_STRENGTH } : {}) }
		: imageUrl
			? { prompt: `${withTrigger}. A sticker: bold outline, flat colour, transparent background.`, image_urls: [imageUrl], num_images: 1, output_format: "png" }
			: { prompt: `${withTrigger}. A sticker: bold outline, flat colour, on a plain white background.`, num_images: 1, output_format: "png" };
	const data = await callFal(endpoint, body, key, { fetchImpl });
	const url = data.images?.[0]?.url ?? data.image?.url;
	if (!url) throw new Error("the model returned no picture — try again");
	return { url, endpoint };
}

/** Take the background off. */
export async function cutOut({ key, model = CUTOUT_MODELS[0].id, imageUrl, fetchImpl = fetch }) {
	if (!IMAGE_URL.test(String(imageUrl))) throw new Error("the picture needs a URL fal can reach");
	const data = await callFal(model, { image_url: imageUrl }, key, { fetchImpl });
	const url = data.image?.url ?? data.images?.[0]?.url;
	if (!url) throw new Error("the model returned no picture — try again");
	return { url, endpoint: model };
}

/** Trace to vector. Answers an SVG URL. */
export async function vectorize({ key, model = VECTORIZE_MODELS[0].id, endpoint = null, imageUrl, fetchImpl = fetch }) {
	if (!IMAGE_URL.test(String(imageUrl))) throw new Error("the picture needs a URL fal can reach");
	const target = model === "custom" ? String(endpoint ?? "").trim() : model;
	if (!/^[\w.-]+\/[\w./-]+$/.test(target)) throw new Error("give the custom vectorizer a fal endpoint, like fal-ai/recraft/vectorize");
	const data = await callFal(target, { image_url: imageUrl }, key, { fetchImpl });
	const url = data.image?.url ?? data.images?.[0]?.url;
	if (!url) throw new Error("the vectorizer returned nothing — try another model");
	return { url, endpoint: target };
}

/* ── sheets ─────────────────────────────────────────────────────────────── */

const XML_HEAD = /<\?xml[^>]*>|<!DOCTYPE[^>]*>/gi;
const SVG_ROOT = /<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/i;
const VIEWBOX = /\bviewBox\s*=\s*["']([^"']+)["']/i;
const WIDTH = /\bwidth\s*=\s*["']([\d.]+)/i;
const HEIGHT = /\bheight\s*=\s*["']([\d.]+)/i;

/** An SVG's drawing box: viewBox first, width/height second, a square last. */
export function svgBox(svg) {
	const root = String(svg).match(SVG_ROOT);
	const attrs = root?.[1] ?? "";
	const vb = attrs.match(VIEWBOX)?.[1]?.trim().split(/[\s,]+/).map(Number);
	if (vb?.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
	const w = Number(attrs.match(WIDTH)?.[1]);
	const h = Number(attrs.match(HEIGHT)?.[1]);
	if (w > 0 && h > 0) return { x: 0, y: 0, w, h };
	return { x: 0, y: 0, w: 1000, h: 1000 };
}

/**
 * Lay stickers on a sheet. Each cell is `size` wide; a sticker is fitted into
 * it keeping its shape. A vector sticker is nested as its own <svg> so its
 * paths stay paths; a raster one is an <image> with the bytes inline, so the
 * sheet is one file that needs nothing beside it.
 */
export function sheetSvg({ items, columns = 4, size = 300, gap = 40, margin = 60, title = "Stickers", ground = "dots" }) {
	const cols = Math.max(1, Math.min(12, Number(columns) || 4));
	const rows = Math.max(1, Math.ceil(items.length / cols));
	const W = margin * 2 + cols * size + (cols - 1) * gap;
	const H = margin * 2 + rows * size + (rows - 1) * gap;
	const cells = items.map((item, i) => {
		const cx = margin + (i % cols) * (size + gap);
		const cy = margin + Math.floor(i / cols) * (size + gap);
		if (item.svg) {
			const box = svgBox(item.svg);
			const inner = String(item.svg).replace(XML_HEAD, "").match(SVG_ROOT);
			const body = inner?.[2] ?? "";
			/* The cell says where and how big; the sticker's own frame attributes go. */
			const attrs = (inner?.[1] ?? "").replace(/\s(width|height|x|y|viewBox|preserveAspectRatio)\s*=\s*["'][^"']*["']/gi, "");
			return `<svg x="${cx}" y="${cy}" width="${size}" height="${size}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" preserveAspectRatio="xMidYMid meet"${attrs.includes("xmlns=") ? "" : ' xmlns="http://www.w3.org/2000/svg"'}${attrs}>${body}</svg>`;
		}
		return `<image x="${cx}" y="${cy}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" href="data:${item.type};base64,${Buffer.from(item.bytes).toString("base64")}"/>`;
	});
	/* The Studio's ground under the stickers: near-black, with the dot grid.
	   "none" leaves the sheet transparent for a print shop's own stock. */
	const back =
		ground === "none"
			? ""
			: `<defs><pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="14" cy="14" r="1.3" fill="#2c2c2c"/></pattern></defs>\n<rect width="${W}" height="${H}" fill="#0f0f0f"/>\n<rect width="${W}" height="${H}" fill="url(#dots)"/>\n`;
	return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n<title>${esc(title)}</title>\n${back}${cells.join("\n")}\n</svg>\n`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The page a published sheet lives on: the sheet, every sticker on its own
 * with a download, and nothing that needs a server. Plain HTML so a phone can
 * read it and Affinity can pull any file from it.
 */
export function sheetPage({ title, sheetFile, zipFile = null, items, made = new Date(), comments = null }) {
	const cards = items
		.map(
			(it) => `<figure class="s" data-sticker="${esc(it.file)}"><img src="${esc(it.file)}" alt="${esc(it.name)}" loading="lazy" /><figcaption><span>${esc(it.name)}</span><a href="${esc(it.file)}" download>${it.file.endsWith(".svg") ? "SVG" : "PNG"}</a>${comments ? `<b class="n" data-count="${esc(it.file)}"></b>` : ""}</figcaption></figure>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} — stickers</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #141414; color: #bcbcbc; font: 400 16px/24px "DM Sans", system-ui, -apple-system, sans-serif; }
  header { padding: 40px 24px 8px; max-width: 1100px; margin: 0 auto; }
  h1 { margin: 0; font-size: 32px; line-height: 36px; color: #fff; letter-spacing: -0.5px; }
  .meta { color: #979797; font-size: 14px; margin: 8px 0 0; }
  .sheet { max-width: 1100px; margin: 24px auto; padding: 0 24px; }
  .sheet img { display: block; width: 100%; height: auto; border-radius: 12px; background: repeating-conic-gradient(#1c1c1c 0 25%, #171717 0 50%) 0 0 / 24px 24px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0 0; }
  a.btn { display: inline-block; padding: 10px 16px; border-radius: 6px; background: #46e76f; color: #141414; font-weight: 600; text-decoration: none; font-size: 14px; }
  a.btn.ghost { background: #1a1a1a; color: #bcbcbc; border: 1px solid #282828; }
  .grid { max-width: 1100px; margin: 32px auto 80px; padding: 0 24px; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; }
  .s { margin: 0; border: 1px solid #282828; border-radius: 10px; overflow: hidden; background: #1a1a1a; }
  .s img { display: block; width: 100%; aspect-ratio: 1; object-fit: contain; background: repeating-conic-gradient(#222 0 25%, #1c1c1c 0 50%) 0 0 / 20px 20px; }
  figcaption { display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px; font-size: 12px; color: #979797; }
  figcaption span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  figcaption a { color: #46e76f; text-decoration: none; font-weight: 600; }
  figcaption .n:empty { display: none; }
  figcaption .n { margin-inline-start: auto; padding: 1px 7px; border-radius: 999px; background: #262626; color: #ddd; font-weight: 600; }
  .s.can { cursor: pointer; }
  .s.can:hover { border-color: #46e76f; }
  /* The comment panel: one sticker, its thread, a form. */
  .panel { position: fixed; inset: 0 0 0 auto; width: min(420px, 100%); background: #171717; border-left: 1px solid #282828; padding: 20px; overflow: auto; transform: translateX(100%); transition: transform .2s; z-index: 10; }
  .panel.on { transform: none; }
  .panel img { display: block; width: 100%; max-height: 220px; object-fit: contain; background: repeating-conic-gradient(#222 0 25%, #1c1c1c 0 50%) 0 0 / 20px 20px; border-radius: 10px; }
  .panel h2 { margin: 14px 0 4px; font-size: 18px; color: #fff; }
  .panel .x { position: absolute; top: 12px; right: 12px; background: none; border: 1px solid #282828; color: #bcbcbc; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  .thread { margin: 12px 0; display: grid; gap: 10px; }
  .c { padding: 10px 12px; border-radius: 8px; background: #1f1f1f; }
  .c b { color: #fff; font-weight: 600; font-size: 13px; }
  .c time { color: #777; font-size: 12px; margin-inline-start: 8px; }
  .c p { margin: 4px 0 0; font-size: 14px; white-space: pre-wrap; }
  form.add { display: grid; gap: 8px; margin-top: 12px; }
  form.add input, form.add textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 6px; border: 1px solid #282828; background: #0f0f0f; color: #eee; font: inherit; }
  form.add button { justify-self: start; padding: 10px 16px; border-radius: 6px; border: 0; background: #46e76f; color: #141414; font-weight: 600; cursor: pointer; }
  .empty { color: #777; font-size: 14px; }
</style>
</head>
<body>
<header><h1>${esc(title)}</h1><p class="meta">${items.length} sticker${items.length === 1 ? "" : "s"} · made ${made.toISOString().slice(0, 10)} with RoleModel Studio</p></header>
<section class="sheet">
  <img src="${esc(sheetFile)}" alt="${esc(title)} sheet" />
  <div class="row"><a class="btn" href="${esc(sheetFile)}" download>Download the sheet (SVG)</a>${zipFile ? `<a class="btn" href="${esc(zipFile)}" download>Download everything (ZIP)</a>` : ""}<a class="btn ghost" href="${esc(sheetFile)}">Open the sheet</a></div>
</section>
<section class="grid">
${cards}
</section>
${
	comments
		? `<aside class="panel" id="panel" aria-label="Comments"><button class="x" id="close" type="button">Close</button><img id="pimg" alt="" /><h2 id="pname"></h2><div class="thread" id="thread"></div><form class="add" id="add"><input id="who" placeholder="Your name" maxlength="80" /><textarea id="what" rows="3" placeholder="Say something about this sticker" maxlength="2000" required></textarea><button type="submit">Add comment</button></form></aside>
<script>
(() => {
  const API = ${JSON.stringify(comments.dataApi)};
  const PROJECT = ${JSON.stringify(comments.project)};
  const H = { Accept: "application/json", "Content-Type": "application/json" };
  const q = (s) => document.querySelector(s);
  const panel = q("#panel"), thread = q("#thread");
  let current = null;
  const load = async (sticker) => {
    const r = await fetch(API + "/sticker_comments?project=eq." + encodeURIComponent(PROJECT) + "&sticker=eq." + encodeURIComponent(sticker) + "&order=created_at.asc", { headers: H });
    return r.ok ? r.json() : [];
  };
  const paint = (list) => {
    thread.innerHTML = list.length ? list.map((c) => "<div class=c><b>" + esc(c.author || "Someone") + "</b><time>" + new Date(c.created_at).toLocaleString() + "</time><p>" + esc(c.body) + "</p></div>").join("") : "<div class=empty>No comments yet. Be the first.</div>";
    const n = q('[data-count="' + current + '"]'); if (n) n.textContent = list.length ? String(list.length) : "";
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const open = async (fig) => {
    current = fig.dataset.sticker;
    q("#pimg").src = current; q("#pname").textContent = fig.querySelector("span").textContent;
    panel.classList.add("on");
    paint(await load(current));
  };
  for (const fig of document.querySelectorAll(".s")) { fig.classList.add("can"); fig.addEventListener("click", (e) => { if (e.target.closest("a")) return; open(fig); }); }
  q("#close").onclick = () => panel.classList.remove("on");
  q("#add").onsubmit = async (e) => {
    e.preventDefault();
    const body = q("#what").value.trim(); if (!body || !current) return;
    const who = q("#who").value.trim(); try { localStorage.setItem("sticker-name", who); } catch {}
    const r = await fetch(API + "/sticker_comments", { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ project: PROJECT, sticker: current, author: who || null, body }) });
    if (!r.ok) { alert("Could not add the comment (" + r.status + ")."); return; }
    q("#what").value = ""; paint(await load(current));
  };
  try { q("#who").value = localStorage.getItem("sticker-name") || ""; } catch {}
  // Counts on every card, so a thread is visible before it is opened.
  fetch(API + "/sticker_comments?project=eq." + encodeURIComponent(PROJECT) + "&select=sticker", { headers: H }).then((r) => (r.ok ? r.json() : [])).then((rows) => { const by = {}; for (const r of rows) by[r.sticker] = (by[r.sticker] || 0) + 1; for (const [k, v] of Object.entries(by)) { const n = q('[data-count="' + k + '"]'); if (n) n.textContent = String(v); } }).catch(() => {});
})();
</script>`
		: ""
}
</body>
</html>
`;
}
