/*
 * One frame of a scene, with the background knocked out.
 *
 * render-scene.mjs makes video: every frame, encoded, opaque. An overlay is the
 * opposite — a single still that has to be transparent everywhere the design does
 * not paint, so the footage shows through underneath.
 *
 * That transparency is the entire point and it is easy to lose. The stage paints
 * a background by default, and any wallpaper obviously does; either one turns the
 * card into an opaque rectangle that hides the video it was meant to sit on. So
 * the wallpaper is refused here rather than merely omitted, and the page and stage
 * are forced transparent before the shot.
 *
 * Chromium's `omitBackground` is what actually produces the alpha channel; without
 * it the screenshot is composited onto white and the PNG has no transparency at
 * all — it looks right in a viewer and covers the video in the render.
 */

import { createReadStream } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sceneHtml } from "./compose.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const TYPES = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};

/**
 * Render `body` at `atMs` to a transparent PNG at `out`.
 *
 * Served over HTTP rather than opened from disk: Chromium refuses ES module
 * imports over file://, so rm-video.js never runs and no component upgrades —
 * the shot comes out empty with nothing to say why.
 */
export async function renderStill({ body, out, atMs = 0, width = 1920, height = 1080, brand }) {
	const scratch = join(ROOT, "components", `.still-${process.pid}.html`);
	await writeFile(
		scratch,
		sceneHtml({ body, title: "still", brand }).replace(
			"</style>",
			/*
			 * Nothing opaque behind the design.
			 *
			 * `html, body` carry the page ground and rm-scene paints its own; both
			 * would be captured as solid pixels. Cleared here rather than in
			 * sceneHtml, because a video render wants them.
			 */
			"  html, body { background: transparent !important; }\n" +
				"  rm-scene { background: transparent !important; }\n" +
				"</style>",
		),
		"utf8",
	);

	const srv = createServer((req, res) => {
		const p = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
		const file = resolve(ROOT, p);
		if (!file.startsWith(ROOT)) {
			res.writeHead(403);
			return res.end();
		}
		res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
		createReadStream(file).pipe(res).on("error", () => {
			res.writeHead(404);
			res.end();
		});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const port = srv.address().port;

	const { chromium } = await import("playwright");
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
		await page.addInitScript(() => {
			window.__hyperframes = true;
		});
		await page.goto(`http://127.0.0.1:${port}/components/${scratch.split("/").pop()}`, { waitUntil: "networkidle" });
		await page.evaluate(() => window.RM.ready());
		await page.evaluate((t) => window.RM.seek(t), atMs);
		// omitBackground is the whole difference between a card that floats over the
		// video and one that hides it.
		const png = await page.screenshot({ type: "png", omitBackground: true });
		await writeFile(out, png);
		return out;
	} finally {
		await browser.close();
		srv.close();
		await rm(scratch, { force: true });
	}
}

/** Does this PNG actually carry transparency? A still that does not is a rectangle. */
export async function hasAlpha(file) {
	const buf = await readFile(file);
	// PNG colour type lives at byte 25 of the IHDR chunk: 6 = RGBA, 4 = grey+alpha.
	return buf.length > 25 && (buf[25] === 6 || buf[25] === 4);
}
