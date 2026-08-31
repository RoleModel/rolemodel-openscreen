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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, extname, resolve as resolvePath } from "node:path";
import { defaultRoot } from "../lib/library.mjs";
import { PIP_FADE, PIP_FIRST_FADE } from "../lib/make-pip.mjs";

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

/*
 * Sub-compositions are mounted before the page is served, not after it loads.
 *
 * A composition may keep its scenes in separate files under compositions/ and
 * mount them with data-composition-src. HyperFrames resolves those in its
 * compiler, so its scripts only ever see one flat document — and that timing is
 * the whole point. The timeline is built by an inline script at the end of the
 * body, and GSAP resolves a selector when the tween is made: mounting after
 * load leaves every word and phrase tween pointing at an element that did not
 * exist yet, so the transcript renders permanently invisible while the speaker's
 * name — which has no tween — shows fine. Splicing the files together here
 * means nothing downstream can tell a split composition from a flat one.
 */
let mountedCount = 0;
async function mountSubCompositions(html, dir, depth = 0) {
	if (depth > 8) die("sub-compositions are nested more than eight deep; that is a cycle");
	const mount = /<([a-z][\w-]*)\b([^>]*?)\bdata-composition-src="([^"]+)"([^>]*)>\s*<\/\1>/i;
	let out = html;
	for (let found = out.match(mount); found; found = out.match(mount)) {
		const [whole, tag, before, src, after] = found;
		const file = resolvePath(dir, src);
		if (!file.startsWith(root)) die(`a sub-composition points outside the composition: ${src}`);
		const part = await readFile(file, "utf8").catch(() => null);
		if (part === null) die(`this composition mounts ${src}, which is not there`);
		/* A fragment, so take whatever the file holds minus its document
		   furniture — these are pieces of one composition, not pages. */
		let body = (part.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? part)
			.replace(/<!DOCTYPE[^>]*>/gi, "")
			.replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "")
			.trim();
		/*
		 * Unwrap the sub-composition's own root, exactly as HyperFrames does.
		 *
		 * A sub-composition file has to declare a root carrying
		 * data-composition-id and its dimensions or the checker rejects it — but
		 * that root is scaffolding for the file, not a box in the picture. The
		 * editor's inliner takes its innerHTML for that reason. Keeping it
		 * instead left a real 1920x1080 block in the flow per speaker, which
		 * stacked and pushed each transcript below the bottom of the frame:
		 * present, laid out, and never visible.
		 */
		const root_ = body.match(/^<([a-z][\w-]*)\b([^>]*\bdata-composition-id="[^"]*"[^>]*)>([\s\S]*)<\/\1>$/i);
		if (root_) body = root_[3].trim();
		const inner = await mountSubCompositions(body, dirname(file), depth + 1);
		out = out.replace(whole, `<${tag}${before}data-composition-file="${src}"${after}>\n${inner}\n</${tag}>`);
		mountedCount += 1;
	}
	return out;
}
const server = createServer(async (req, res) => {
	const path = resolvePath(root, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
	if (!path.startsWith(root)) return void res.writeHead(403).end();
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) return void res.writeHead(404).end();
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
	const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
	if (path === resolvePath(root, "index.html")) {
		const flat = await mountSubCompositions(await readFile(path, "utf8"), dirname(path));
		const buffer = Buffer.from(flat, "utf8");
		res.writeHead(200, { "content-type": "text/html", "content-length": buffer.length });
		return void res.end(buffer);
	}
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

if (mountedCount) console.log(`  mounted ${mountedCount} sub-composition${mountedCount === 1 ? "" : "s"}`);

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
		const style = getComputedStyle(v);
		const position = style.objectPosition.split(" ")[0];
		/*
		 * The framing, not just the horizontal focus.
		 *
		 * object-view-box is what --pip-zoom and --pip-y drive, and it never
		 * reached the compositor: only objectPosition was read, so every
		 * speaker rendered at zoom 1 centred vertically and the framing
		 * somebody had tuned per speaker was thrown away in the export.
		 */
		const zoom = Number.parseFloat(style.getPropertyValue("--pip-zoom")) || 1;
		const focusY = Number.parseFloat(style.getPropertyValue("--pip-y"));
		clips.push({
			src: v.getAttribute("src"),
			start: Number(v.dataset.start) || 0,
			dur: Number(v.dataset.duration) || 0,
			mediaStart: Number(v.dataset.mediaStart) || 0,
			hasAudio: v.dataset.hasAudio !== "false",
			focus: position.endsWith("%") ? Number.parseFloat(position) : 50,
			zoom: zoom > 0 ? zoom : 1,
			focusY: Number.isFinite(focusY) ? focusY : 50,
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
	/*
	 * The hole stays fully opaque, and the speaker's fade moves to the footage.
	 *
	 * A colour key cannot express a half-transparent hole. The composition fades
	 * each pip in and out so a speaker change reads as a dissolve, and mid-fade
	 * the captured hole is the key colour at partial strength — R=148 G=1 B=156
	 * at the worst frame — which is nowhere near 0xFF00FF by RGB distance, so it
	 * survived the key and reached the render as a magenta flash, about one frame
	 * per transition. Widening the tolerance would not help: a keyed hole is
	 * binary, so the best it could do is turn the dissolve into a cut.
	 *
	 * So the browser holds the hole steady and ffmpeg fades the footage instead,
	 * which is where a dissolve belongs anyway — it is the picture that should be
	 * dissolving, not the window it is seen through.
	 */
	const hold = document.createElement("style");
	hold.textContent = ".pip, video[data-start] { opacity: 1 !important; }";
	document.head.append(hold);
	/*
	 * Where this composition would rather be represented.
	 *
	 * A thumbnail picked by scoring frames is picking for a screen recording,
	 * where the question is "is this frame inside a zoom". For a composition the
	 * answer is already authored: the opening card is the title, and that is what
	 * a card in a list should show. Left to the heuristic, a two-minute cut with
	 * six speakers thumbnailed at the halfway mark — a picture of whoever
	 * happened to be talking at sixty seconds.
	 *
	 * data-poster on the root overrides it, for a composition whose best frame is
	 * somewhere its author knows about and this cannot infer.
	 */
	const authored = Number.parseFloat(root.dataset.poster ?? "");
	let poster = Number.isFinite(authored) && authored >= 0 ? authored : null;
	if (poster === null) {
		const cards = [...root.querySelectorAll("[data-start][data-duration]")]
			.filter((e) => e.tagName.toLowerCase() !== "video" && e.tagName.toLowerCase() !== "audio" && !/^say-/.test(e.id))
			.map((e) => ({ start: Number(e.dataset.start) || 0, dur: Number(e.dataset.duration) || 0 }))
			.filter((c) => c.dur > 0)
			.sort((a, b) => a.start - b.start);
		/* The opening card, if this composition opens on one — a card that starts
		   after the first speaker is a lower third, not a title. */
		const opening = cards.find((c) => c.start <= 0.05);
		if (opening) poster = opening.start + opening.dur / 2;
	}
	return { duration: Number(root.dataset.duration) || 0, clips, poster };
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
	/*
	 * The view box first, in the source's own pixels.
	 *
	 * Mirrors the .pip rule: --pip-zoom shows 1/zoom of the recording, centred
	 * across and placed by --pip-y down the frame, clamped so the window cannot
	 * leave the picture. Cover and focus then apply to that window, which is
	 * what object-fit and object-position do to a view box in the browser.
	 */
	const vis = 100 / clip.zoom;
	const inset = clip.zoom === 1 ? [] : [
		`crop=iw*${(vis / 100).toFixed(6)}:ih*${(vis / 100).toFixed(6)}`
			+ `:iw*${(((100 - vis) / 2) / 100).toFixed(6)}`
			+ `:ih*${(Math.min(Math.max(clip.focusY - vis / 2, 0), 100 - vis) / 100).toFixed(6)}`,
	];
	/* The dissolve the composition asks for, done to the picture rather than to
	   the window it is seen through. Same lengths the timeline uses, so playback
	   in the editor and the render agree; the first speaker arrives more slowly
	   because it is following the opening card, not another speaker. */
	const into = Math.min(index === 0 ? PIP_FIRST_FADE : PIP_FADE, clip.dur / 3);
	const away = Math.min(PIP_FADE, clip.dur / 3);
	const filter = [
		...inset,
		`scale=${clip.w}:${clip.h}:force_original_aspect_ratio=increase`,
		`crop=${clip.w}:${clip.h}:(iw-ow)*${(clip.focus / 100).toFixed(4)}:(ih-oh)/2`,
		`fps=${FPS}`,
		`fade=t=in:st=0:d=${into.toFixed(3)}`,
		`fade=t=out:st=${(clip.dur - away).toFixed(3)}:d=${away.toFixed(3)}`,
	].join(",");
	/*
	 * Placed with overlay, not pad.
	 *
	 * The pip deliberately hangs off the right edge of the frame, so its box
	 * runs past 1920. `pad` cannot place an input that does not fit inside the
	 * canvas and does not say so — it silently centres it instead, which put
	 * the footage hundreds of pixels left of the circle it belongs in. Only the
	 * sliver where the two happened to overlap showed picture and the rest of
	 * every speaker's circle rendered black. overlay clips at the edges, which
	 * is what a box hanging off the frame needs.
	 */
	const place = `color=c=black:s=1920x1080:r=${FPS}[bg];[0:v]${filter}[fg];[bg][fg]overlay=${clip.x}:${clip.y}:shortest=1[v]`;
	await run("ffmpeg", [
		"-v", "error", "-ss", String(clip.mediaStart), "-t", String(clip.dur), "-i", source,
		"-filter_complex", place,
		"-map", "[v]", ...(clip.hasAudio ? ["-map", "0:a?"] : []),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", "-y", out,
	]).catch(async () => {
		// A clip with no audio track still has to carry silence, or concat drops
		// the stream for everything after it.
		await run("ffmpeg", [
			"-v", "error", "-ss", String(clip.mediaStart), "-t", String(clip.dur), "-i", source,
			"-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
			"-filter_complex", place,
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
/*
 * A partial render is a preview and gets its own name.
 *
 * `--from`/`--to` exist for looking at one transition without paying for two
 * minutes, and they wrote to the same file as the finished cut — so checking a
 * two-second hand-off silently replaced the deliverable with a two-second clip.
 * The composition looked broken (no intro, no ending, images apparently gone)
 * when all that had happened was the render being overwritten.
 */
const partial = from > 0 || to < plan.duration - 0.01;
const out = join(root, partial ? `${folder}-preview.mp4` : `${folder}.mp4`);
if (partial) console.log(`  partial range — writing ${basename(out)}, not the full cut`);
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
		/* Descendants, not children: a clip that lives in a mounted
		   sub-composition sits inside that mount point, and a direct-child
		   selector would leave it visible for the whole cut. */
		for (const e of document.querySelectorAll("[data-composition-id] [data-start]")) {
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
/*
 * The poster time, left beside the file.
 *
 * The thumbnail is made later, from the mp4, by something that has never seen
 * the composition — so the composition's own answer has to travel with the
 * video. A sidecar rather than a container tag: it survives a copy into project
 * media, costs nothing to read, and its absence simply means "no opinion", which
 * is what every other video here has.
 */
if (plan.poster !== null && plan.poster >= from && plan.poster <= to) {
	await writeFile(`${out}.poster`, `${(plan.poster - from).toFixed(3)}\n`, "utf8");
	console.log(`  poster at ${(plan.poster - from).toFixed(2)}s — the opening card`);
}
console.log(`  wrote ${out}`);
console.log(`  ${(size / 1048576).toFixed(1)}MB · ${spent.toFixed(1)}s for ${(to - from).toFixed(1)}s of video (${(spent / (to - from)).toFixed(1)}x realtime)`);
