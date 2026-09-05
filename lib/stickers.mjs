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
const TELEGRAM_LORA = { path: "https://ftxhendy6jwk0sx5.public.blob.vercel-storage.com/loras/telegram-sticker-flux.safetensors", scale: 0.9 };
const TELEGRAM_TRIGGER = "telesticker, sticker art, white outline";

/*
 * `input` is the field the picture goes in; `strength` marks an image-to-image
 * model that reworks the picture by a strength (fal's default loses the
 * subject, see LORA_STRENGTH). `ref` marks a model that only works from a
 * picture: an editing model, which keeps the subject and changes the style —
 * the one to use when a reference is pasted in.
 */
export const STICKER_MODELS = [
	{
		id: "telegram",
		label: "Sticker (Telegram)",
		endpoint: "fal-ai/flux-lora",
		imageEndpoint: "fal-ai/flux-lora/image-to-image",
		lora: TELEGRAM_LORA,
		trigger: TELEGRAM_TRIGGER,
		input: "image_url",
		strength: true,
	},
	{
		id: "bubblegum",
		label: "Bubblegum sticker",
		endpoint: "fal-ai/krea-2/turbo",
		imageEndpoint: "fal-ai/krea-2/turbo/image-to-image",
		lora: { path: "https://huggingface.co/ilkerzgi/krea-2-bubblegum-pop-sticker-lora/resolve/main/bubblegum-pop-sticker.safetensors", scale: 0.9 },
		trigger: "bubblegum pop sticker style",
		input: "image_url",
		strength: true,
	},
	{
		id: "plain",
		label: "Plain (no style)",
		endpoint: "fal-ai/nano-banana-pro",
		imageEndpoint: "fal-ai/nano-banana-pro/edit",
		lora: null,
		trigger: "",
		input: "image_urls",
	},
	{
		id: "kontext-telegram",
		label: "From reference · Telegram style (Kontext + LoRA)",
		endpoint: null,
		imageEndpoint: "fal-ai/flux-kontext-lora",
		lora: TELEGRAM_LORA,
		trigger: TELEGRAM_TRIGGER,
		input: "image_url",
		ref: true,
	},
	{
		id: "kontext",
		label: "From reference · keep the subject (Flux Kontext)",
		endpoint: null,
		imageEndpoint: "fal-ai/flux-pro/kontext",
		lora: null,
		trigger: "",
		input: "image_url",
		ref: true,
	},
	{
		id: "seedream-edit",
		label: "From reference · Seedream 4 edit",
		endpoint: null,
		imageEndpoint: "fal-ai/bytedance/seedream/v4/edit",
		lora: null,
		trigger: "",
		input: "image_urls",
		ref: true,
	},
	{
		id: "qwen-edit",
		label: "From reference · Qwen image edit",
		endpoint: null,
		imageEndpoint: "fal-ai/qwen-image-edit",
		lora: null,
		trigger: "",
		input: "image_url",
		ref: true,
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
 * Ways to trace a raster to vector. Recraft is the one the boards used, and
 * the only vectorizer fal hosts; a Custom entry takes any fal endpoint that
 * answers { image: { url } } with an SVG. (A "recraft-v3/vectorize" row was
 * here once — fal has no such path, and it answered 404.)
 */
export const VECTORIZE_MODELS = [
	{ id: "fal-ai/recraft/vectorize", label: "Recraft — clean shapes" },
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
	if (m.ref && !imageUrl) throw new Error(`${m.label} works from a picture — paste or pick a reference first`);
	const endpoint = imageUrl ? m.imageEndpoint : m.endpoint;
	/* A LoRA carries the look in its weights; the rest are told what a sticker is. */
	const note = m.lora ? "" : `. Make it a sticker: bold outline, flat colour, ${imageUrl ? "transparent background, the subject kept as it is" : "on a plain white background"}.`;
	const body = { prompt: `${withTrigger}${note}`, num_images: 1, output_format: "png" };
	if (m.lora) body.loras = [{ path: m.lora.path, scale: m.lora.scale }];
	if (imageUrl) {
		if (m.input === "image_urls") body.image_urls = [imageUrl];
		else body.image_url = imageUrl;
		if (m.strength) body.strength = LORA_STRENGTH;
	}
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

/*
 * An SVG as a PNG, for a model that only reads rasters. Drawn by Chromium at
 * the size asked, on a transparent ground, fitted inside a square — the same
 * engine that renders stills, so what fal gets is what a browser shows.
 */
export async function svgToPng(svg, { size = 2048 } = {}) {
	const { chromium } = await import("playwright");
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
		const data = `data:image/svg+xml;base64,${Buffer.from(String(svg), "utf8").toString("base64")}`;
		await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><img id="i" src="${data}" style="display:block;width:${size}px;height:${size}px;object-fit:contain" /></body></html>`, { waitUntil: "load" });
		await page.evaluate(() => document.getElementById("i").decode().catch(() => {}));
		return await page.locator("#i").screenshot({ type: "png", omitBackground: true });
	} finally {
		await browser.close();
	}
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
 *
 * Comments open under the sticker that was clicked, not in a side panel: the
 * card is what the reader is looking at, so the thread and the form drop out
 * of it. The pointer is the board's own arrow with a name tag, the one the
 * sticker boards use, so the page feels like the place the stickers came from.
 */
export function sheetPage({ title, sheetFile, zipFile = null, items, made = new Date(), comments = null, grid = null }) {
	/*
	 * The sheet image is the first thing a reader sees, so a sticker on it is
	 * a target too: hot spots laid over the picture, one per cell, from the same
	 * geometry the sheet was drawn with. A press opens that sticker's card.
	 */
	let hots = "";
	if (grid) {
		const cols = Math.max(1, Math.min(12, Number(grid.columns) || 4));
		const size = Number(grid.size) || 300;
		const gap = Number(grid.gap) || 40;
		const margin = Number(grid.margin) || 60;
		const rows = Math.max(1, Math.ceil(items.length / cols));
		const W = margin * 2 + cols * size + (cols - 1) * gap;
		const H = margin * 2 + rows * size + (rows - 1) * gap;
		const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`;
		hots = items
			.map((it, i) => {
				const cx = margin + (i % cols) * (size + gap);
				const cy = margin + Math.floor(i / cols) * (size + gap);
				return `<button class="hot" type="button" data-for="${esc(it.file)}" data-name="${esc(it.name)}" title="${esc(it.name)}" style="left:${pct(cx, W)};top:${pct(cy, H)};width:${pct(size, W)};height:${pct(size, H)}"><b class="n" data-count="${esc(it.file)}"></b></button>`;
			})
			.join("");
	}
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} — stickers</title>
<style>
  :root { color-scheme: dark; --green: #46e76f; }
  body { margin: 0; background: #141414; color: #bcbcbc; font: 400 16px/24px "DM Sans", system-ui, -apple-system, sans-serif; }
  header { padding: 40px 24px 8px; max-width: 1100px; margin: 0 auto; }
  h1 { margin: 0; font-size: 32px; line-height: 36px; color: #fff; letter-spacing: -0.5px; }
  .meta { color: #979797; font-size: 14px; margin: 8px 0 0; }
  .sheet { max-width: 1100px; margin: 24px auto; padding: 0 24px; }
  .sheet img { display: block; width: 100%; height: auto; border-radius: 12px; background: repeating-conic-gradient(#1c1c1c 0 25%, #171717 0 50%) 0 0 / 24px 24px; }
  .sheetwrap { position: relative; }
  .hot { position: absolute; padding: 0; border: 2px solid transparent; border-radius: 10px; background: none; cursor: pointer; }
  .hot:hover { border-color: var(--green); background: rgba(70, 231, 111, 0.08); }
  .tip { color: #979797; font-size: 14px; margin: 10px 0 0; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0 0; }
  .btn { display: inline-block; border: 0; padding: 10px 16px; border-radius: 6px; background: var(--green); color: #141414; font-weight: 600; text-decoration: none; font-size: 14px; }
  .btn.ghost { background: #1a1a1a; color: #bcbcbc; border: 1px solid #282828; }
  button.btn { font: inherit; font-size: 14px; line-height: 24px; }
  /*
   * The comment popover: one box, opened where the sticker was clicked, on the
   * sheet or on a card. The thread on top, a text area and Post below. Escape or
   * a click elsewhere closes it.
   */
  .hot.open { border-color: var(--green); background: rgba(70, 231, 111, 0.08); }
  .hot .n:empty { display: none; }
  .hot .n { position: absolute; top: -8px; right: -8px; min-width: 22px; padding: 2px 6px; border-radius: 999px; background: var(--green); color: #141414; font-size: 12px; font-weight: 700; line-height: 18px; text-align: center; }
  /* The menu on a sticker: download it, or comment. */
  .menu { position: absolute; z-index: 20; display: none; min-width: 180px; padding: 6px; border-radius: 10px; background: #1c1c1c; border: 1px solid #333; box-shadow: 0 12px 40px rgba(0,0,0,.55); }
  .menu.on { display: grid; }
  .menu a, .menu button { display: block; width: 100%; box-sizing: border-box; padding: 9px 12px; border: 0; border-radius: 6px; background: none; color: #eee; font: inherit; font-size: 14px; text-align: left; text-decoration: none; cursor: pointer; }
  .menu a:hover, .menu button:hover { background: #2a2a2a; }
  .menu button[hidden] { display: none; }
  .pop { position: absolute; z-index: 20; width: min(360px, calc(100vw - 32px)); padding: 12px; border-radius: 12px; background: #1c1c1c; border: 1px solid #333; box-shadow: 0 12px 40px rgba(0,0,0,.55); display: none; }
  .pop.on { display: grid; gap: 10px; }
  .pop::before { content: ""; position: absolute; top: -7px; left: var(--ax, 24px); width: 12px; height: 12px; background: #1c1c1c; border-left: 1px solid #333; border-top: 1px solid #333; transform: rotate(45deg); }
  .pop.up::before { top: auto; bottom: -7px; border: 0; border-right: 1px solid #333; border-bottom: 1px solid #333; }
  .pop h3 { margin: 0; font-size: 14px; color: #fff; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
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
  form.add button { padding: 8px 14px; border-radius: 6px; border: 0; background: var(--green); color: #141414; font-weight: 600; font-size: 14px; cursor: pointer; }
  form.add button:disabled { opacity: .5; }
  .err { color: #ff8a80; font-size: 13px; }
  .linkbox { display: block; width: 100%; box-sizing: border-box; margin-top: 10px; padding: 8px 10px; border-radius: 6px; border: 1px solid #282828; background: #0f0f0f; color: #eee; font: inherit; font-size: 14px; }
  /* The board's pointer: an arrow with a name tag, shown once the mouse moves. */
  body.cur, body.cur * { cursor: none !important; }
  .cur-box { position: fixed; top: 0; left: 0; z-index: 9999; pointer-events: none; will-change: transform; display: none; }
  body.cur .cur-box { display: block; }
  .cur-box svg { position: absolute; top: 0; left: 0; width: 20px; height: 20px; }
  .cur-box .tag { position: absolute; top: 18px; left: 12px; padding: 2px 8px; font-size: 12px; line-height: 18px; color: #141414; white-space: nowrap; border-radius: 4px; background: var(--green); box-shadow: 0 2px 5px rgba(0,0,0,.2); font-weight: 600; }
  .cur-box .tag:empty { display: none; }
</style>
</head>
<body>
<header><h1>${esc(title)}</h1><p class="meta">${items.length} sticker${items.length === 1 ? "" : "s"} · made ${made.toISOString().slice(0, 10)} with RoleModel Studio</p></header>
<section class="sheet">
  <div class="sheetwrap"><img src="${esc(sheetFile)}" alt="${esc(title)} sheet" />${hots}</div>
  <p class="tip">Click a sticker to download it${comments ? " or leave a comment" : ""}.</p>
  <div class="row"><a class="btn" href="${esc(sheetFile)}" download>Download the sheet (SVG)</a>${zipFile ? `<a class="btn" href="${esc(zipFile)}" download>Download everything (ZIP)</a>` : ""}<a class="btn ghost" href="${esc(sheetFile)}">Open the sheet</a><button class="btn ghost" id="copyLink" type="button">Copy link</button></div>
</section>
<div class="menu" id="menu"><a id="mDownload" href="#" download>Download</a><button id="mComment" type="button"${comments ? "" : " hidden"}>Comment…</button></div>
<div class="cur-box" id="cur" aria-hidden="true"><svg viewBox="0 0 24 24" fill="#46e76f" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 3.2v17.6c0 .45.54.67.85.35l4.3-4.3a.5.5 0 0 1 .36-.15h6.08a.5.5 0 0 0 .35-.85L6.35 2.85a.5.5 0 0 0-.85.35Z"/></svg><div class="tag" id="curTag"></div></div>
<script>
(() => {
  // Copy link: the page's own address, so a reader can hand the sheet on.
  // The clipboard API is refused in some windows (an app's web view, a page
  // without a user gesture the browser trusts), so there are two more ways: the
  // old execCommand path, and last, a box with the link already selected.
  const b = document.getElementById("copyLink"), was = b.textContent;
  const oldWay = () => {
    const t = document.createElement("textarea");
    t.value = location.href; t.setAttribute("readonly", ""); t.style.cssText = "position:fixed;left:-9999px";
    document.body.append(t); t.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {}
    t.remove(); return ok;
  };
  const showBox = () => {
    let box = document.getElementById("linkBox");
    if (!box) {
      box = document.createElement("input"); box.id = "linkBox"; box.readOnly = true; box.className = "linkbox";
      b.parentElement.after(box);
    }
    box.value = location.href; box.focus(); box.select();
  };
  b.onclick = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(location.href); ok = true; } catch {}
    if (!ok) ok = oldWay();
    if (ok) { b.textContent = "Copied"; } else { b.textContent = "Select and copy"; showBox(); }
    setTimeout(() => { b.textContent = was; }, 1800);
  };
})();
(() => {
  // The menu on a sticker. Under it, kept on the page; above when there is no
  // room below. Comment hands the sticker on to the comment box.
  const menu = document.getElementById("menu"), dl = document.getElementById("mDownload"), cm = document.getElementById("mComment");
  let on = null;
  const closeMenu = () => { menu.classList.remove("on"); on?.classList.remove("open"); on = null; };
  window.placeBox = (box, el) => {
    const r = el.getBoundingClientRect();
    box.classList.add("on");
    const w = box.offsetWidth, h = box.offsetHeight;
    const left = Math.max(16, Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - w - 16));
    const below = r.bottom + 10 + h <= window.innerHeight || r.top - 10 - h < 0;
    const top = below ? window.scrollY + r.bottom + 10 : window.scrollY + r.top - 10 - h;
    box.classList.toggle("up", !below);
    box.style.left = left + "px"; box.style.top = top + "px";
    box.style.setProperty("--ax", Math.max(12, Math.min(w - 24, window.scrollX + r.left + r.width / 2 - left - 6)) + "px");
  };
  for (const h of document.querySelectorAll(".hot")) h.addEventListener("click", () => {
    if (on === h) return closeMenu();
    closeMenu();
    window.dispatchEvent(new Event("sticker-menu"));
    on = h; h.classList.add("open");
    dl.href = h.dataset.for; dl.download = h.dataset.for;
    dl.textContent = "Download " + (/\.svg$/i.test(h.dataset.for) ? "SVG" : "PNG");
    window.placeBox(menu, h);
  });
  dl.addEventListener("click", () => closeMenu());
  cm.addEventListener("click", () => { const h = on; closeMenu(); window.dispatchEvent(new CustomEvent("sticker-comment", { detail: { el: h, file: h.dataset.for, name: h.dataset.name } })); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  document.addEventListener("pointerdown", (e) => { if (on && !menu.contains(e.target) && !e.target.closest(".hot")) closeMenu(); });
})();
(() => {
  // The pointer. Only where there is a real mouse: a finger has no cursor to replace.
  if (!window.matchMedia("(pointer: fine)").matches) return;
  const box = document.getElementById("cur"), tag = document.getElementById("curTag");
  const name = () => { try { return localStorage.getItem("sticker-name") || ""; } catch { return ""; } };
  tag.textContent = name() || "You";
  window.addEventListener("mousemove", (e) => { box.style.transform = "translate3d(" + e.clientX + "px," + e.clientY + "px,0)"; document.body.classList.add("cur"); });
  document.body.addEventListener("mouseleave", () => document.body.classList.remove("cur"));
  window.addEventListener("sticker-name", () => { tag.textContent = name() || "You"; });
})();
</script>
${
	comments
		? `<script>
(() => {
  const API = ${JSON.stringify(comments.dataApi)};
  const PROJECT = ${JSON.stringify(comments.project)};
  // Neon's Data API wants a token even from a stranger. Neon Auth hands out an
  // anonymous one on the same endpoint as the API, under the auth host.
  const AUTH = API.replace(".apirest.", ".neonauth.").replace("/rest/v1", "/auth");
  let jwt = null;
  const token = async (fresh) => {
    if (jwt && !fresh) return jwt;
    try { const r = await fetch(AUTH + "/token/anonymous"); jwt = r.ok ? (await r.json()).token : null; } catch { jwt = null; }
    return jwt;
  };
  const api = async (path, init, retry = true) => {
    const t = await token(false);
    const r = await fetch(API + path, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", ...(init && init.headers), ...(t ? { Authorization: "Bearer " + t } : {}) } });
    if ((r.status === 401 || r.status === 400) && retry) { await token(true); return api(path, init, false); }
    return r;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const where = (sticker) => "project=eq." + encodeURIComponent(PROJECT) + "&sticker=eq." + encodeURIComponent(sticker);
  const load = async (sticker) => { const r = await api("/sticker_comments?" + where(sticker) + "&order=created_at.asc"); return r.ok ? r.json() : []; };
  const savedName = () => { try { return localStorage.getItem("sticker-name") || ""; } catch { return ""; } };
  const count = (sticker, n) => { const b = document.querySelector('[data-count="' + sticker + '"]'); if (b) b.textContent = n ? String(n) : ""; };
  /* The one popover, built once and moved to whatever was clicked. */
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.innerHTML = '<h3><span class="pname"></span><button type="button" class="x" aria-label="Close">×</button></h3><div class="thread"><div class="empty">Loading…</div></div><form class="add"><input name="who" placeholder="Your name" maxlength="80" /><textarea name="what" placeholder="Say something about this sticker" maxlength="2000" required></textarea><div class="send"><small>Enter posts, Shift+Enter for a new line</small><button type="submit">Post</button></div></form><div class="err"></div>';
  document.body.append(pop);
  const thread = pop.querySelector(".thread"), form = pop.querySelector("form"), who = form.who, what = form.what, err = pop.querySelector(".err"), pname = pop.querySelector(".pname");
  let current = null, anchor = null;
  const close = () => { pop.classList.remove("on"); anchor?.classList.remove("open"); anchor = null; current = null; };
  const paint = (list) => {
    thread.innerHTML = list.length ? list.map((c) => "<div class=c><b>" + esc(c.author || "Someone") + "</b><time>" + new Date(c.created_at).toLocaleString() + "</time><p>" + esc(c.body) + "</p></div>").join("") : "<div class=empty>No comments yet. Be the first.</div>";
    thread.scrollTop = thread.scrollHeight;
    if (current) count(current, list.length);
  };
  const place = (el) => window.placeBox(pop, el);
  const open = async (el, sticker, name) => {
    close();
    anchor = el; current = sticker;
    el.classList.add("open");
    pname.textContent = name;
    thread.innerHTML = '<div class="empty">Loading…</div>'; err.textContent = ""; what.value = "";
    who.value = savedName();
    place(el);
    what.focus();
    paint(await load(sticker));
    place(el);
  };
  what.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = what.value.trim(); if (!body || !current) return;
    const author = who.value.trim();
    try { localStorage.setItem("sticker-name", author); } catch {}
    window.dispatchEvent(new Event("sticker-name"));
    form.querySelector("button").disabled = true; err.textContent = "";
    const sticker = current, el = anchor;
    const r = await api("/sticker_comments", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ project: PROJECT, sticker, author: author || null, body }) });
    form.querySelector("button").disabled = false;
    if (!r.ok) { err.textContent = "Could not post the comment (" + r.status + ")."; return; }
    what.value = "";
    if (current === sticker) { paint(await load(sticker)); place(el); }
  };
  pop.querySelector(".x").onclick = close;
  window.addEventListener("sticker-comment", (e) => open(e.detail.el, e.detail.file, e.detail.name));
  window.addEventListener("sticker-menu", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  document.addEventListener("pointerdown", (e) => { if (anchor && !pop.contains(e.target) && !e.target.closest(".hot, .menu")) close(); });
  window.addEventListener("resize", () => { if (anchor) place(anchor); });
  // Counts on every sticker, so a thread is visible before it is opened.
  api("/sticker_comments?project=eq." + encodeURIComponent(PROJECT) + "&select=sticker").then((r) => (r.ok ? r.json() : [])).then((rows) => { const by = {}; for (const r of rows) by[r.sticker] = (by[r.sticker] || 0) + 1; for (const [k, v] of Object.entries(by)) count(k, v); }).catch(() => {});
})();
</script>`
		: ""
}
</body>
</html>
`;
}
