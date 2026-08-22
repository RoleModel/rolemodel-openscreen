#!/usr/bin/env node
/**
 * Render a component scene to MP4.
 *
 * Deliberately not a reimplementation of HyperFrames — this is the short path
 * for a scene built out of `components/rm-video.js`, and it exists to prove the
 * seek contract holds: step `RM.seek(ms)`, grab a frame, repeat, pipe to ffmpeg.
 * Because nothing plays, the frame at 2400ms is the same frame every run, and a
 * re-render after a copy change produces a byte-identical video except where the
 * copy changed.
 *
 *   node components/render-scene.mjs components/scene.html -o demo.mp4 --fps 30
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const arg = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const input = argv.find((a) => !a.startsWith("-") && a.endsWith(".html"));
if (!input) {
	console.error("usage: render-scene.mjs <scene.html> [-o out.mp4] [--fps 30] [--width 1920] [--ms <duration>]");
	process.exit(1);
}

const out = argv.includes("-o") ? argv[argv.indexOf("-o") + 1] : "scene.mp4";
const fps = Number(arg("fps", 30));
const width = Number(arg("width", 1920));
const height = Math.round((width * 9) / 16);

/**
 * Serve the repo over HTTP rather than opening the file directly.
 *
 * ES modules are blocked over file:// — the origin is `null`, so importing
 * rm-video.js fails CORS and the page renders as bare custom-element tags with
 * no styling, which looks like a component bug and is not one. Serving also
 * matches how HyperFrames loads a scene, so what renders here is what renders
 * there.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".woff2": "font/woff2",
};
const srv = createServer(async (req, res) => {
	const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
	const file = resolve(ROOT, rel);
	// Never serve outside the repo, even if a scene asks for ../../etc/passwd.
	if (!file.startsWith(ROOT) || !(await stat(file).then((s2) => s2.isFile()).catch(() => false))) {
		res.writeHead(404);
		return res.end();
	}
	res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
	createReadStream(file).pipe(res);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const sceneUrl = `${base}/${relative(ROOT, resolve(input)).split(/[\\/]/).join("/")}`;

const { chromium } = await import("playwright");
const browser = await chromium.launch(
	process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
// Tell the scene a renderer is driving, so it does not start its own preview loop.
await page.addInitScript(() => {
	window.__hyperframes = true;
});
await page.goto(sceneUrl, { waitUntil: "networkidle" });
await page.evaluate(() => window.RM.ready());

const durationMs = Number(arg("ms", 0)) || (await page.evaluate(() => window.RM.duration()));
const frames = Math.max(1, Math.round((durationMs / 1000) * fps));
console.log(`  ${input}  ->  ${out}`);
console.log(`  ${(durationMs / 1000).toFixed(2)}s · ${fps}fps · ${frames} frames · ${width}×${height}\n`);

const ff = spawn("ffmpeg", [
	"-y",
	"-f", "image2pipe",
	"-framerate", String(fps),
	"-i", "-",
	"-c:v", "libx264",
	"-pix_fmt", "yuv420p",
	"-crf", "18",
	"-preset", "medium",
	// Even dimensions, or libx264 refuses at odd widths.
	"-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
	out,
]);
ff.stderr.on("data", () => {});

for (let f = 0; f < frames; f++) {
	const ms = Math.round((f / fps) * 1000);
	await page.evaluate((t) => window.RM.seek(t), ms);
	const buf = await page.screenshot({ type: "png" });
	if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
	if (f % fps === 0) process.stdout.write(`\r  ${Math.round((f / frames) * 100)}%`);
}
ff.stdin.end();
process.stdout.write("\r  100%\n");

await new Promise((r) => ff.on("close", r));
await browser.close();
srv.close();
console.log(`\n  wrote ${out}\n`);
