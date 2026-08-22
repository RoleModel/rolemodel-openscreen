/**
 * Rasterise wallpaper recipes to JPEG.
 *
 * Drawing happens on a real <canvas> with lib/wallpaper.mjs — the exact code the
 * Studio preview runs. The old build script hand-wrote CSS backgrounds, which
 * meant the preview and the export were two implementations of the same idea and
 * drifted the moment either changed.
 *
 * Playwright is a devDependency, not a runtime one. The Studio never calls this:
 * there, the browser already has a canvas, so it draws the 4K frame itself and
 * POSTs the bytes back. This path is for the batch build and CI.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function withRenderer({ width = 3840, height = 2160 } = {}) {
	const { chromium } = await import("playwright");
	const browser = await chromium.launch(
		process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
	);
	const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
	const source = await readFile(resolve(HERE, "wallpaper.mjs"), "utf8");

	await page.setContent("<!doctype html><html><body style=\"margin:0\"></body></html>");
	// Inline the module rather than serving it: no file:// module loader quirks,
	// and it is provably the same bytes the Studio ships to the browser.
	await page.addScriptTag({ content: `${source}\nwindow.__wp = { draw, normalize };`, type: "module" });
	await page.waitForFunction(() => Boolean(window.__wp));

	return {
		/** @returns {Promise<Buffer>} JPEG bytes */
		async render(recipe, { quality = 0.92, w = width, h = height } = {}) {
			const dataUrl = await page.evaluate(
				({ recipe, quality, w, h }) => {
					const c = document.createElement("canvas");
					c.width = w;
					c.height = h;
					window.__wp.draw(c.getContext("2d"), recipe, w, h);
					return c.toDataURL("image/jpeg", quality);
				},
				{ recipe, quality, w, h },
			);
			return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
		},
		close: () => browser.close(),
	};
}
