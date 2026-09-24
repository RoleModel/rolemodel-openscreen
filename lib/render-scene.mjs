/*
 * A scene, rendered to video.
 *
 * render-still.mjs has named this file in its opening line since it was
 * written — "render-scene.mjs makes video: every frame, encoded, opaque" — and
 * the file did not exist. A scene could be designed, previewed and shot as one
 * still, and the only way to get moving pictures out of it was to record the
 * screen.
 *
 * HOW A FRAME IS MADE
 *
 * Time in a scene is not a clock, it is a number: `RM.seek(ms)` sets a CSS
 * custom property and every animation is a function of it. So a render is not
 * a recording — nothing is played and nothing can drop. Each frame is seeked
 * to exactly n/fps, waited for, and shot. A render on a busy machine is the
 * same file as a render on an idle one, which is the whole reason the clock
 * was built that way.
 *
 * WHY IT PIPES RATHER THAN WRITING FRAMES
 *
 * Twenty seconds at 30fps is six hundred PNGs and about two gigabytes on disk
 * for a file that ends up a few megabytes. They go straight down ffmpeg's
 * stdin instead, so the only thing written is the video.
 *
 * MP4 OR WEBM
 *
 * MP4 for anywhere it is going to be watched. WebM when the scene has to keep
 * its transparency — VP9 carries an alpha channel and H.264 does not, so a
 * transparent scene asked for as MP4 would silently arrive on black.
 */

import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
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
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
};

/** What a scene can be rendered to, and what each is for. */
export const SCENE_FORMATS = [
	{ id: "mp4", ext: ".mp4", label: "MP4 · H.264", alpha: false, note: "Plays anywhere. No transparency." },
	{ id: "webm", ext: ".webm", label: "WebM · VP9", alpha: true, note: "Keeps transparency. For the web." },
];

/** Whatever this machine can encode with, or a sentence saying it cannot. */
export async function sceneRenderProblem() {
	const ok = await new Promise((done) => {
		const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
		child.on("error", () => done(false));
		child.on("close", (code) => done(code === 0));
	});
	return ok ? null : "Rendering a scene needs ffmpeg (brew install ffmpeg).";
}

/**
 * One render of a scene at a time.
 *
 * Every render of a given scene writes the same path, so two at once are two
 * ffmpegs with `-y` on one file. The result cannot be a video, and the way it
 * fails is a black one — which is exactly how this was found: five renders of
 * c12-walkthrough.mp4, started over three and a half hours, all still running
 * and all writing to that single name. Nothing had stopped the second press.
 *
 * `rm-render-pip` has held a lock for this reason since it was written ("two
 * renders of one composition overwrite each other and the finished file is
 * lost"). Scene renders were the path that did not.
 *
 * `wx` is the whole mechanism: it creates the file or it fails, with no window
 * in between. The pid goes in it, and a lock whose process is gone is cleared
 * rather than believed — a render killed by a restart or a crash should not
 * lock a scene out until somebody finds the file and deletes it by hand.
 */
async function takeLock(out) {
	const lockFile = `${out}.lock`;
	const held = await readFile(lockFile, "utf8").catch(() => null);
	if (held !== null) {
		const pid = Number(held.trim());
		/* Signal 0 asks "is this process there" without touching it. */
		const alive = Number.isFinite(pid) && pid > 0 && (() => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (err) {
				/* EPERM means it exists and is not ours; ESRCH means it is gone. */
				return err.code === "EPERM";
			}
		})();
		if (alive) {
			const since = await stat(lockFile).then((st) => st.mtimeMs).catch(() => Date.now());
			const mins = Math.round((Date.now() - since) / 60_000);
			throw new Error(
				`this scene is already rendering (started ${mins} minute${mins === 1 ? "" : "s"} ago, pid ${pid}) — two renders of one scene overwrite each other and neither finishes`,
			);
		}
		await unlink(lockFile).catch(() => {});
	}
	try {
		await writeFile(lockFile, `${process.pid}\n`, { flag: "wx" });
	} catch {
		throw new Error("this scene is already rendering");
	}
	return () => unlink(lockFile).catch(() => {});
}

/**
 * Does this file have an index, and can it be opened?
 *
 * An MP4 written by a killed ffmpeg has every frame in it and no `moov` atom,
 * so nothing can play it — QuickTime and most players show black rather than an
 * error. It is the exact shape of "the render is broken": a file of a plausible
 * size, sitting in Renders/, that opens onto nothing. rm-compose has asserted
 * this on its inputs since it was written; the same reasoning applies here, to
 * the output.
 */
async function isPlayable(file) {
	return new Promise((done) => {
		const probe = spawn("ffprobe", ["-v", "error", "-show_format", "-of", "json", file], { stdio: "ignore" });
		probe.on("error", () => done(false));
		probe.on("close", (code) => done(code === 0));
	});
}

/* The same static server render-still uses, for the same reason: Chromium
   refuses ES module imports over file://, so nothing upgrades and the frame
   comes out empty with nothing to say why. */
const SCENE_PATH = "/components/__scene.html";

/**
 * Device pixels per CSS pixel while shooting. The frames are reduced on the way
 * into the encoder.
 *
 * Two is the right default and stays the default: it is supersampling, every
 * output pixel the average of four, and the single biggest thing available for
 * how a render looks.
 *
 * It is also almost the whole cost of a render. Measured on an 85-second
 * Showcase scene — 17 device layers, 18 captions — the screenshot is about 90%
 * of each frame, and it is 430ms at 1x, 766ms at 1.5x and 1,890ms at 2x. The
 * same scene is roughly 18, 33 and 60 minutes. That is a real choice between a
 * master and something you can look at before lunch, so it is a parameter with
 * a default rather than a constant with an argument attached to it.
 */
export const SHOT_SCALES = [
	{ id: 2, label: "Best", note: "Supersampled. The master." },
	{ id: 1.5, label: "Faster", note: "Still supersampled, about half the time." },
	{ id: 1, label: "Draft", note: "No supersampling. Softer type and edges." },
];
const SHOT_SCALE = 2;

function serve(resolveFile, page_html) {
	const srv = createServer((req, res) => {
		const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
		/*
		 * The page under render is served out of memory, never off disk.
		 *
		 * It used to be written into `components/` so that its relative imports
		 * resolved — and the dev server runs under `node --watch`, which saw a
		 * new file in a watched folder and restarted itself mid-render. The
		 * Studio reloaded, the panel went with it, and the render died with no
		 * error to show for it. Served from here, the URL still sits in
		 * `components/` for the imports and nothing ever touches the repo.
		 */
		if (pathname === SCENE_PATH) {
			const buf = Buffer.from(page_html, "utf8");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": buf.length });
			return res.end(buf);
		}
		const outside = resolveFile?.(pathname) ?? null;
		const file = outside ?? resolve(ROOT, pathname.replace(/^\/+/, ""));
		if (!outside && !file.startsWith(ROOT)) {
			res.writeHead(403);
			return res.end();
		}
		const size = statSync(file, { throwIfNoEntry: false })?.size;
		if (size == null) {
			res.writeHead(404);
			return res.end();
		}
		const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
		if (range) {
			const start = range[1] ? Number(range[1]) : 0;
			const end = range[2] ? Math.min(Number(range[2]), size - 1) : Math.min(start + 8 * 1024 * 1024 - 1, size - 1);
			res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
			return createReadStream(file, { start, end }).pipe(res);
		}
		res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
		createReadStream(file).pipe(res);
	});
	return srv;
}

/**
 * Render `body` to `out`.
 *
 * `durationMs` defaults to what the scene says its own length is, so a render
 * is as long as the design rather than as long as somebody guessed.
 */
export async function renderScene({
	body,
	out,
	format = "mp4",
	fps = 30,
	durationMs = null,
	width = 1920,
	height = 1080,
	brand,
	wallpaper = null,
	footage = null,
	transparent = false,
	resolveFile = null,
	onProgress = null,
	shotScale = SHOT_SCALE,
}) {
	const stop = await sceneRenderProblem();
	if (stop) throw new Error(stop);
	const fmt = SCENE_FORMATS.find((f) => f.id === format) ?? SCENE_FORMATS[0];
	if (transparent && !fmt.alpha) throw new Error(`${fmt.label} cannot carry transparency — render WebM for that.`);

	const made = sceneHtml({ body, title: "render", brand, wallpaper: wallpaper ?? undefined, footage: footage ?? undefined });
	const page_html = transparent
		? made.replace("</style>", "  html, body { background: transparent !important; }\n  rm-scene { background: transparent !important; }\n</style>")
		: made;

	/* Before the browser, the server and the encoder: refusing early is the whole
	   point, and a second render should cost nothing to turn away. */
	const release = await takeLock(out);

	const srv = serve(resolveFile, page_html);
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const port = srv.address().port;

	let browser;
	try {
		const { chromium } = await import("playwright");
		browser = await chromium.launch();
	} catch (err) {
		/* The lock is held from before this point, so it has to come off here too —
		   a browser that will not start must not lock the scene out. */
		await release();
		srv.close();
		throw err;
	}
	let ff = null;
	/* What the finally has to clean up. Set once the name is known, cleared once
	   the file has been moved into place and is somebody else's to keep. */
	let leftover = null;
	try {
		/*
		 * Shot at twice the size and encoded down.
		 *
		 * At one device pixel per CSS pixel the frames came back soft: type,
		 * hairlines and a picture the camera has zoomed into are all resampled
		 * once, by the browser, with nothing left over. Shooting at 2x and
		 * letting ffmpeg do the reduction is supersampling — every output pixel
		 * is the average of four — and it is the single biggest thing that can
		 * be done for how the render looks.
		 */
		const shot = SHOT_SCALES.some((s_) => s_.id === shotScale) ? shotScale : SHOT_SCALE;
		const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: shot });
		await page.addInitScript(() => {
			window.__hyperframes = true;
		});
		await page.goto(`http://127.0.0.1:${port}${SCENE_PATH}`, { waitUntil: "networkidle" });
		await page.evaluate(() => window.RM.ready());
		const total = Math.max(200, Math.round(durationMs ?? (await page.evaluate(() => window.RM.duration()))));
		const frames = Math.max(1, Math.round((total / 1000) * fps));

		/*
		 * PNG in, video out. `-framerate` before the input is what tells ffmpeg
		 * the pipe's rate; after it, it would resample a stream it thinks is
		 * some other speed and the result runs at the wrong length.
		 */
		const args = ["-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-"];
		/* Lanczos, because the default bilinear reduction throws away the very
		   detail the 2x shot was taken for. */
		args.push("-vf", `scale=${width}:${height}:flags=lanczos`);
		args.push(
			...(fmt.id === "webm"
				? ["-c:v", "libvpx-vp9", "-pix_fmt", transparent ? "yuva420p" : "yuv420p", "-b:v", "0", "-crf", "26", "-row-mt", "1"]
				: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "slow", "-movflags", "+faststart"]),
		);
		/*
		 * Written beside the destination and moved into place at the end.
		 *
		 * A render of an 85-second scene takes the better part of an hour, and the
		 * ways it does not finish are ordinary: the window is closed, the app is
		 * quit, the Studio restarts because its own code changed. ffmpeg dies with
		 * it, having written every frame and no `moov` atom — and the half-file was
		 * sitting at the destination under the name of a finished render. Nothing
		 * said so. It looked done, and it played black.
		 *
		 * A rename is atomic on one filesystem, so the finished name can only ever
		 * appear on a file ffprobe has opened. The cost of being interrupted is a
		 * `.part` nobody mistakes for a video, and this cleans up a stale one.
		 */
		const partial = `${out}.part${fmt.ext}`;
		leftover = partial;
		await unlink(partial).catch(() => {});
		args.push(partial);
		ff = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
		let said = "";
		ff.stderr.on("data", (d) => {
			said = `${said}${d}`.slice(-4000);
		});
		const done = new Promise((resolve_, reject) => {
			ff.on("error", reject);
			ff.on("close", (code) => (code === 0 ? resolve_() : reject(new Error(`ffmpeg gave up (${code})${said ? ` — ${said.trim().split("\n").pop()}` : ""}`))));
		});

		for (let n = 0; n < frames; n++) {
			const t = Math.round((n / fps) * 1000);
			await page.evaluate((ms) => window.RM.seek(ms), t);
			/* One frame of settle after the seek: a transition started by the
			   property change has to be laid out before it is worth shooting. */
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
			const shot = await page.screenshot({ type: "png", omitBackground: transparent });
			if (!ff.stdin.write(shot)) await new Promise((r) => ff.stdin.once("drain", r));
			onProgress?.({ frame: n + 1, frames, ms: t, total });
		}
		ff.stdin.end();
		await done;
		/* ffmpeg exiting 0 is not the same as a file that opens — a full disk gets
		   both. The check costs one header read and is the last thing between a
		   render and somebody trusting it. */
		if (!(await isPlayable(partial))) {
			await unlink(partial).catch(() => {});
			throw new Error("the render finished but the file will not open — nothing was kept");
		}
		await rename(partial, out);
		leftover = null;
		return { file: out, format: fmt.id, fps, durationMs: total, frames, width, height, transparent, shotScale: shot };
	} finally {
		try {
			ff?.stdin?.destroyed || ff?.stdin?.end();
		} catch {
			/* already closed */
		}
		await browser.close();
		srv.close();
		/* A render that threw leaves no part file to be found later and wondered
		   about. One killed outright still does — nothing in here runs then — but it
		   is named `.part`, and the next render of the same scene removes it. */
		if (leftover) await unlink(leftover).catch(() => {});
		await release();
	}
}
