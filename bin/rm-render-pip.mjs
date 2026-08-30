#!/usr/bin/env node
/**
 * rm-render-pip — render a composition by letting each tool do what it is good at.
 *
 * The stock renderer screenshots every frame of the whole page, so each frame
 * pays to re-decode and re-composite the footage that ffmpeg already has on
 * disk in the right form. That is most of the cost, and it buys nothing: the
 * pixels of a talking head do not change because a caption faded in over them.
 *
 * So the work is split. ffmpeg builds the footage layer — trims, scales, crops
 * and places each clip, and carries the audio through untouched. The browser
 * draws only what the browser is for: type, cards, components, the wallpaper,
 * anything animated. The two are composited once, in ffmpeg.
 *
 * The browser stays the single source of truth for layout. Nothing here knows
 * where a pip sits or how big it is; the page is asked, and it answers with the
 * rect it actually laid out. The alternative — this file reimplementing the
 * composition's CSS — is two descriptions of one layout, which drift.
 *
 * The holes are punched by colour rather than by a mask. Each clip's <video>
 * has its source removed and its box filled with a key colour, so what the
 * capture shows is the element's own background, border and shadow with a flat
 * middle. ffmpeg keys that middle out. Borders, rounded corners and drop
 * shadows come through for free because they were never the video's pixels.
 *
 *   rm-render-pip <projectId> <folder> [--fps 30] [--from 0] [--to 12]
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";
import { defaultRoot } from "../lib/library.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const die = (message) => {
	console.error(`rm-render-pip: ${message}`);
	process.exit(1);
};

const [projectId, folder = "canvas-pip-transcript"] = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
if (!projectId) die("usage: rm-render-pip <projectId> [folder] [--fps 30] [--from 0] [--to 12]");

const FPS = Number(flag("fps", 30));
const root = join(defaultRoot(), projectId, "media", "Renders", folder);
if (!(await stat(join(root, "index.html")).catch(() => null))) die(`no composition at ${root}`);

/*
 * The key colour is one the brand cannot produce and a camera will not: pure
 * magenta at full saturation. The tolerance has to be wide enough to take the
 * anti-aliased rim of the rounded corner with it — a hairline of half-magenta
 * survives an exact match and reads as a purple outline — and everything the
 * composition actually contains is far enough away in colour to be safe.
 */
const KEY = "#FF00FF";

/*
 * The composition is served rather than opened as a file.
 *
 * A file: page cannot range-request, so a <video> seeked to the middle of a
 * clip never becomes seekable — the same trap that made preload="metadata"
 * break playback in the editor.
 */
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4a": "audio/mp4", ".wav": "audio/wav", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
	const path = resolvePath(root, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
	if (!path.startsWith(root)) return void res.writeHead(403).end();
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) return void res.writeHead(404).end();
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
	const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
	if (range) {
		const start = Number(range[1] || 0);
		const end = range[2] ? Number(range[2]) : info.size - 1;
		res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}`, "accept-ranges": "bytes" });
		return void createReadStream(path, { start, end }).pipe(res);
	}
	res.writeHead(200, { "content-type": type, "content-length": info.size, "accept-ranges": "bytes" });
	createReadStream(path).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await import("playwright").catch(() => die("playwright is not installed here"));
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.RM?.ready, null, { timeout: 30000 }).catch(() => {});
await page.evaluate(() => window.RM?.ready?.());
await page.waitForTimeout(1500);

/*
 * The page describes its own layout, and then gives up its video.
 *
 * Read first, strip second: the rect has to be measured while the element is
 * still the thing the CSS laid out.
 */
const plan = await page.evaluate((key) => {
	const root = document.querySelector("[data-composition-id]");
	const clips = [];
	for (const v of document.querySelectorAll("video[data-start]")) {
		const box = v.getBoundingClientRect();
		const position = getComputedStyle(v).objectPosition.split(" ")[0];
		clips.push({
			src: v.getAttribute("src"),
			start: Number(v.dataset.start) || 0,
			dur: Number(v.dataset.duration) || 0,
			mediaStart: Number(v.dataset.mediaStart) || 0,
			hasAudio: v.dataset.hasAudio !== "false",
			focus: position.endsWith("%") ? Number.parseFloat(position) : 50,
			x: Math.round(box.x), y: Math.round(box.y),
			w: Math.round(box.width), h: Math.round(box.height),
		});
	}
	/*
	 * Now the element becomes its own hole.
	 *
	 * No source, so what paints is its own background — flat key colour, with
	 * the composition's corner radius and drop shadow still on it. The border
	 * goes transparent because it is a translucent white: over the key it
	 * blends to pink and a colour key cannot tell that pink from the fill, so
	 * it survives as a fringe. A translucent edge needs the real pixels behind
	 * it, which is the one thing this split does not have. The rect includes
	 * the border box, so the footage fills that band instead.
	 */
	for (const v of document.querySelectorAll("video[data-start]")) {
		v.removeAttribute("src");
		v.load?.();
		v.style.background = key;
		v.style.borderColor = "transparent";
	}
	return { duration: Number(root.dataset.duration) || 0, clips };
}, KEY);
if (!plan.clips.length) die("that composition has no timed video to render");

const from = Number(flag("from", 0));
const to = Math.min(Number(flag("to", plan.duration)), plan.duration);
const frames = Math.max(1, Math.round((to - from) * FPS));

const work = await mkdtemp(join(tmpdir(), "rm-pip-"));
const run = (bin, argv, opts = {}) =>
	new Promise((done, fail) => {
		const child = spawn(bin, argv, { stdio: ["ignore", "ignore", "pipe"], ...opts });
		let err = "";
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => (code === 0 ? done() : fail(new Error(err.split("\n").slice(-6).join("\n")))));
	});

/*
 * The footage layer, one full-frame segment per clip.
 *
 * Cover, then crop, then place — the same three steps object-fit and
 * object-position describe, done once per clip instead of once per frame. A
 * gap before the first clip is real black with real silence, so the segments
 * concatenate into a continuous track rather than needing a timeline.
 */
console.log(`  ${plan.clips.length} clips · ${frames} frames at ${FPS}fps`);
const segments = [];
let cursor = 0;
const silence = (seconds, out) =>
	run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=1920x1080:r=${FPS}:d=${seconds}`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(seconds), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", out]);

for (const [index, clip] of plan.clips.entries()) {
	if (clip.start - cursor > 0.02) {
		const gap = join(work, `gap-${index}.mp4`);
		await silence(clip.start - cursor, gap);
		segments.push(gap);
	}
	const out = join(work, `seg-${index}.mp4`);
	const source = join(root, clip.src);
	const filter = [
		`scale=${clip.w}:${clip.h}:force_original_aspect_ratio=increase`,
		`crop=${clip.w}:${clip.h}:(iw-ow)*${(clip.focus / 100).toFixed(4)}:(ih-oh)/2`,
		`pad=1920:1080:${clip.x}:${clip.y}:black`,
		`fps=${FPS}`,
	].join(",");
	await run("ffmpeg", [
		"-v", "error", "-ss", String(clip.mediaStart), "-t", String(clip.dur), "-i", source,
		"-filter_complex", `[0:v]${filter}[v]`,
		"-map", "[v]", ...(clip.hasAudio ? ["-map", "0:a?"] : []),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", "-y", out,
	]).catch(async () => {
		// A clip with no audio track still has to carry silence, or concat drops
		// the stream for everything after it.
		await run("ffmpeg", [
			"-v", "error", "-ss", String(clip.mediaStart), "-t", String(clip.dur), "-i", source,
			"-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
			"-filter_complex", `[0:v]${filter}[v]`,
			"-map", "[v]", "-map", "1:a", "-t", String(clip.dur),
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
			"-c:a", "aac", "-y", out,
		]);
	});
	segments.push(out);
	cursor = clip.start + clip.dur;
}
if (plan.duration - cursor > 0.02) {
	const tail = join(work, "gap-tail.mp4");
	await silence(plan.duration - cursor, tail);
	segments.push(tail);
}
const list = join(work, "segments.txt");
await writeFile(list, segments.map((s) => `file '${s.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
const footage = join(work, "footage.mp4");
await run("ffmpeg", ["-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-y", footage]);

/*
 * The overlay, straight into ffmpeg's stdin.
 *
 * Frames are pushed down a pipe rather than written out and read back: a
 * two-minute cut is three thousand PNGs and the better part of a gigabyte, and
 * none of it is wanted afterwards.
 */
const out = join(root, `${folder}.mp4`);
const composite = spawn("ffmpeg", [
	"-v", "error",
	"-ss", String(from), "-t", String(to - from), "-i", footage,
	"-f", "image2pipe", "-framerate", String(FPS), "-i", "pipe:0",
	"-filter_complex", `[1:v]colorkey=0x${KEY.slice(1)}:0.22:0.08[ov];[0:v][ov]overlay=0:0:format=auto,fps=${FPS}[v]`,
	"-map", "[v]", "-map", "0:a?",
	/* veryfast, and not because the output needs to be worse: the encoder runs on
	   the same cores as the capture, and at medium it was taking more of them than
	   the browser was, which showed up as the capture slowing to a third of the
	   rate it manages on its own. At crf 18 the difference on screen is nothing. */
	"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
	"-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
	"-y", out,
], { stdio: ["pipe", "ignore", "pipe"] });
let ffmpegSaid = "";
composite.stderr.on("data", (d) => (ffmpegSaid += d));

const began = Date.now();
for (let i = 0; i < frames; i += 1) {
	const ms = (from + i / FPS) * 1000;
	await page.evaluate((ms) => {
		/*
		 * Visibility by window, which is what the HyperFrames runtime does and
		 * what is missing when a composition is driven directly.
		 *
		 * Without it every clip is on screen at once: the words fade out on
		 * their own timeline, but a speaker's name sits at full opacity from
		 * the first frame, so six names printed over each other.
		 */
		const at = ms / 1000;
		for (const e of document.querySelectorAll("[data-composition-id] > [data-start]")) {
			const from = Number(e.dataset.start) || 0;
			const span = Number(e.dataset.duration) || 0;
			e.style.visibility = at >= from && at < from + span ? "" : "hidden";
		}
		window.RM?.seek(ms);
		window.__timelines?.[document.querySelector("[data-composition-id]").dataset.compositionId]?.seek(ms / 1000);
	}, ms);
	/*
	 * PNG, and this is the loop's whole cost.
	 *
	 * The frame is an opaque wallpaper with type on it, and encoding that is
	 * several times the price of the seek and the compositing together. JPEG at
	 * 95 is about a quarter faster and was measured rather than assumed: it also
	 * rings around the key colour, turning five stray pixels into four hundred
	 * and seventy — a purple hairline on the pip. Not a trade worth taking.
	 *
	 * The way out is not a faster encoder, it is a smaller picture: capture only
	 * the drawn layer on a transparent ground and let ffmpeg supply the wallpaper
	 * as a still. That needs a rounded-corner mask for the footage, which the
	 * page can also be asked for — once, not per frame.
	 */
	const shot = await page.screenshot({ type: "png" });
	if (!composite.stdin.write(shot)) await new Promise((r) => composite.stdin.once("drain", r));
	if (i % (FPS * 10) === 0 && i) console.log(`  ${(i / frames * 100).toFixed(0)}% · ${((Date.now() - began) / i).toFixed(0)} ms/frame`);
}
composite.stdin.end();
await new Promise((done, fail) => composite.on("close", (code) => (code === 0 ? done() : fail(new Error(ffmpegSaid.split("\n").slice(-6).join("\n"))))));

const spent = (Date.now() - began) / 1000;
await browser.close();
server.close();
await rm(work, { recursive: true, force: true });
const size = (await stat(out)).size;
console.log("");
console.log(`  wrote ${out}`);
console.log(`  ${(size / 1048576).toFixed(1)}MB · ${spent.toFixed(1)}s for ${(to - from).toFixed(1)}s of video (${(spent / (to - from)).toFixed(1)}x realtime)`);
