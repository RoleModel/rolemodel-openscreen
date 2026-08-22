#!/usr/bin/env node
/**
 * Renders the RoleModel wallpaper set for OpenScreen.
 *
 * OpenScreen composes the screen recording on top of a "wallpaper" — the visible
 * padding area around the capture. That backdrop is the single largest branded
 * surface in a demo video, and the stock set is generic. These are ours.
 *
 * Design intent: a backdrop is not a slide. It sits behind a bright screen
 * recording for the whole runtime, so it stays quiet — low-contrast texture,
 * no focal point, nothing that competes with the content in front of it.
 *
 *   node lib/make-wallpapers.mjs [--out brand/wallpapers] [--width 3840] [--height 2160]
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = resolve(ROOT, arg("out", "brand/wallpapers"));
const W = Number(arg("width", 3840));
const H = Number(arg("height", 2160));
// Tokens are authored against a 1920-wide canvas; scale texture with output size.
const SCALE = W / 1920;

const tokens = JSON.parse(await readFile(resolve(ROOT, "brand/tokens.json"), "utf8"));
const { palette, surfaces } = tokens;
const GRID = Math.round(surfaces.gridSize * SCALE);

/**
 * Compose a CSS background from matched layer/size pairs.
 * `background-image` and `background-size` are positional lists — if their
 * lengths disagree the sizes wrap around onto the wrong layers, which is how
 * a 16px dot grid becomes one enormous dot in the middle of the frame.
 */
function layers(backgroundColor, defs) {
	return `
    background-color: ${backgroundColor};
    background-image: ${defs.map((d) => d.image).join(", ")};
    background-size: ${defs.map((d) => d.size ?? "cover").join(", ")};
    background-repeat: ${defs.map((d) => d.repeat ?? "no-repeat").join(", ")};
  `;
}

const DOT_R = Math.max(1, 1.4 * SCALE);

function dotLayer(color, opacity) {
	return {
		image: `radial-gradient(circle at ${GRID / 2}px ${GRID / 2}px, ${hexA(color, opacity)} 0 ${DOT_R}px, transparent ${DOT_R + 0.6}px)`,
		size: `${GRID}px ${GRID}px`,
		repeat: "repeat",
	};
}

/** Dark dot-grid board, optionally tinted with a unit signature colour. */
function dotGrid({ base = palette.dark, tint = null, tintAlpha = 0.2 } = {}) {
	const defs = [];
	if (tint) {
		defs.push({
			image: `radial-gradient(130% 105% at 50% -10%, ${hexA(tint, tintAlpha)} 0%, transparent 65%)`,
		});
	}
	defs.push(dotLayer(palette.light, surfaces.dotOpacity));
	defs.push({
		image: `radial-gradient(105% 85% at 50% 45%, transparent 35%, ${hexA("#000000", 0.34)} 100%)`,
	});
	return layers(base, defs);
}

/**
 * Primary -> secondary gradient with a binary-digit texture (the ascii panel).
 * The glyph tile is drawn as an SVG data URI; it must be base64-encoded rather
 * than percent-encoded, because a raw `#` in a colour literal would otherwise
 * start a URL fragment and invalidate the whole background-image list.
 */
function asciiPanel() {
	const tileW = Math.round(224 * SCALE);
	const tileH = Math.round(64 * SCALE);
	const glyph = Math.round(26 * SCALE);
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${tileH}">` +
		`<text x="0" y="${Math.round(tileH * 0.68)}" font-family="ui-monospace,monospace" font-size="${glyph}" ` +
		`fill="${palette.light}" fill-opacity="${surfaces.asciiOpacity}" letter-spacing="${Math.round(10 * SCALE)}">1 0 1 0</text>` +
		`</svg>`;
	const uri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
	return layers(palette.primary, [
		// Single quotes: this CSS is inlined into an HTML style="..." attribute,
		// and double quotes here would terminate it and drop the whole rule.
		{ image: `url('${uri}')`, size: `${tileW}px ${tileH}px`, repeat: "repeat" },
		{
			image: `linear-gradient(118deg, ${palette.primary} 0%, ${palette.tertiary} 46%, ${palette.secondary} 100%)`,
		},
	]);
}

/** Near-white surface for lit-room viewing, with a barely-there grid. */
function lightBoard() {
	return layers(palette.light, [
		dotLayer(palette.dark, 0.075),
		{
			image: `radial-gradient(100% 85% at 50% 40%, ${hexA("#ffffff", 0.85)} 0%, transparent 72%)`,
		},
	]);
}

/**
 * Directional brand wash. Kept as a hard gradient with one soft bloom rather
 * than a many-point mesh: overlapping wide radials average out to grey mush
 * and balloon the PNG, and a backdrop wants direction, not blobs.
 */
function wash(from, to, bloom) {
	return layers(palette.dark, [
		dotLayer(palette.light, 0.1),
		{ image: `radial-gradient(55% 70% at 22% 12%, ${hexA(bloom, 0.34)} 0%, transparent 68%)` },
		{ image: `linear-gradient(146deg, ${hexA(from, 0.92)} 0%, ${hexA(to, 0.96)} 100%)` },
	]);
}

function hexA(hex, alpha) {
	const h = hex.replace("#", "");
	const n = Number.parseInt(
		h.length === 3
			? h
					.split("")
					.map((c) => c + c)
					.join("")
			: h,
		16,
	);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const WALLPAPERS = [
	{
		name: "rm-dark-dotgrid",
		label: "RoleModel · dark dot-grid board",
		css: dotGrid({}),
	},
	{
		name: "rm-ascii",
		label: "RoleModel · ascii gradient panel",
		css: asciiPanel(),
	},
	{ name: "rm-light", label: "RoleModel · near-white board", css: lightBoard() },
	{
		name: "rm-wash",
		label: "RoleModel · deep brand wash",
		css: wash("#16202c", "#101a26", palette.primary),
	},
	{
		name: "academy-ruby",
		label: "Academy · Ruby unit (RM Blue)",
		css: dotGrid({ tint: tokens.unitSignatures.ruby }),
	},
	{
		name: "academy-design",
		label: "Academy · Design unit (Light Purple)",
		css: dotGrid({ tint: tokens.unitSignatures.design }),
	},
	{
		name: "academy-rails",
		label: "Academy · Rails unit (Medium Green)",
		css: dotGrid({ tint: tokens.unitSignatures.rails }),
	},
	{
		name: "lightning-wash",
		label: "LightningCAD · deep blue wash (signature not yet set)",
		css: wash("#132133", "#0d1826", palette.rmBlue),
	},
];

await mkdir(OUT, { recursive: true });
// Honour a pinned Chromium if the environment provides one (CI images often do).
const browser = await chromium.launch(
	process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: W, height: H } });

for (const wp of WALLPAPERS) {
	await page.setContent(
		`<!doctype html><html><body style="margin:0"><div style="width:${W}px;height:${H}px;${wp.css}"></div></body></html>`,
	);
	await page.screenshot({ path: resolve(OUT, `${wp.name}.png`), type: "png" });
	console.log(`  ${wp.name}.png  —  ${wp.label}`);
}

// A contact sheet so a human can pick one without opening eight files.
const cells = WALLPAPERS.map(
	(wp) => `
  <figure style="margin:0">
    <div style="width:100%;aspect-ratio:16/9;border-radius:10px;${wp.css}"></div>
    <figcaption style="font:500 15px/1.4 ui-sans-serif,system-ui;color:${palette.light};opacity:.72;padding-top:10px">
      ${wp.label}<br><code style="opacity:.6;font-size:13px">${wp.name}.png</code>
    </figcaption>
  </figure>`,
).join("");

await page.setViewportSize({ width: 1680, height: 1400 });
await page.setContent(
	`<!doctype html><html><body style="margin:0;background:#161d27;padding:56px">
   <h1 style="font:800 34px/1 ui-sans-serif,system-ui;color:${palette.light};letter-spacing:-.03em;margin:0 0 8px">RoleModel wallpapers for OpenScreen</h1>
   <p style="font:400 16px/1.5 ui-sans-serif,system-ui;color:${palette.light};opacity:.6;margin:0 0 40px">Backdrops behind the screen recording. Rendered at ${W}×${H}.</p>
   <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:36px">${cells}</div>
   </body></html>`,
);
await page.screenshot({ path: resolve(OUT, "_contact-sheet.png"), fullPage: true });
await browser.close();

await writeFile(
	resolve(OUT, "index.json"),
	`${JSON.stringify(
		WALLPAPERS.map(({ name, label }) => ({ name, label, file: `${name}.png` })),
		null,
		2,
	)}\n`,
);
console.log(`\n${WALLPAPERS.length} wallpapers + contact sheet -> ${OUT}`);
