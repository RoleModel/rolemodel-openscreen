/*
 * The three things an editor needs so it never touches the original.
 *
 * A timeline that is smooth is not a rendering trick. It is a timeline that
 * draws itself from small files that were made once: a filmstrip instead of
 * decoded video, an array of peaks instead of decoded audio, and a proxy for
 * the one moment a real picture is needed. Nothing here is clever — it is all
 * ffmpeg — and that is the point. The cleverness in an editor should be in the
 * edit model, not in getting a frame on screen.
 *
 *   proxy   1280x720 @ ~5 Mbps   playback, scrubbing, the preview pane
 *   strip   160x90 every 0.5s    the filmstrip drawn along a clip
 *   peaks   min/max per bucket   the waveform, as numbers rather than audio
 *
 * Keyed by content, not by name. Two projects that import the same take share
 * one cache, a re-import of an unchanged file costs a stat, and a file that
 * really did change gets a new key rather than a stale strip. The hash is of
 * size and mtime rather than the bytes: hashing a 4GB camera original to decide
 * whether to make a thumbnail is the kind of correctness nobody asked for.
 *
 * Everything is written to a `.part` path and renamed. A cache half-built by an
 * interrupted import is worse than no cache, because nothing downstream has any
 * reason to doubt it.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** Proxy geometry and rate. 720p is enough to judge a cut and cheap to seek. */
export const PROXY_HEIGHT = 720;
export const PROXY_BITRATE = "5M";
/** One filmstrip frame every half second — dense enough to recognise a shot. */
export const STRIP_INTERVAL = 0.5;
export const STRIP_HEIGHT = 90;
/** Peaks per second of audio. 100 is finer than any timeline zoom we draw. */
export const PEAKS_PER_SECOND = 100;

/**
 * A stable key for a source file.
 *
 * Size and mtime, not contents. It is wrong in exactly one case — a file edited
 * in place to the same byte length within the same mtime granularity — and that
 * case is worth less than the minutes hashing gigabytes would cost on import.
 */
export async function keyFor(file) {
	const info = await stat(file);
	return createHash("sha256").update(`${info.size}:${info.mtimeMs}:${basename(file)}`).digest("hex").slice(0, 16);
}

const run = (bin, args) =>
	new Promise((done, fail) => {
		const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr.on("data", (d) => (err += d));
		child.on("error", fail);
		child.on("close", (code) => (code === 0 ? done() : fail(new Error(err.split("\n").slice(-4).join("\n")))));
	});

const capture = (bin, args) =>
	new Promise((done) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("error", () => done(""));
		child.on("close", () => done(out));
	});

/** Seconds of media, or 0 when ffprobe cannot say. */
export async function secondsOf(file) {
	const out = await capture("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
	return Number.parseFloat(out.trim()) || 0;
}

/** Whether the file has an audio stream at all — a screen capture often has none. */
async function hasAudio(file) {
	const out = await capture("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]);
	return out.trim().length > 0;
}

/** And whether it has a picture at all — a music bed does not. */
async function hasVideo(file) {
	const out = await capture("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=index", "-of", "csv=p=0", file]);
	return out.trim().length > 0;
}

const done = (path) => stat(path).then(() => true).catch(() => false);

/*
 * A proxy, at a size a browser can seek without thinking.
 *
 * `-g 30` and no scene-cut detection on purpose: a keyframe every second means
 * a seek lands within a second's decode of anywhere, which is what makes
 * dragging a playhead feel attached to the picture rather than lagging it. A
 * long GOP is smaller and worse to scrub, and scrubbing is the whole job.
 */
async function buildProxy(source, out, { picture = true } = {}) {
	if (await done(out)) return out;
	const part = `${out}.part`;
	/* A music bed has no picture to shrink. Asking libx264 to scale a stream that
	   is not there fails the whole cache, and the file is already small — so it
	   is remuxed to something a browser will play and left alone. */
	if (!picture) {
		await run("ffmpeg", ["-v", "error", "-i", source, "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", "-y", part]);
		await rename(part, out);
		return out;
	}
	await run("ffmpeg", [
		"-v", "error", "-i", source,
		"-vf", `scale=-2:${PROXY_HEIGHT}`,
		"-c:v", "libx264", "-preset", "veryfast", "-b:v", PROXY_BITRATE,
		"-g", "30", "-sc_threshold", "0",
		"-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k",
		"-movflags", "+faststart",
		/* The draft has no extension ffmpeg recognises, and it guesses the muxer
		   from the name. Without this it exits before the first frame with
		   `Error opening output files: Invalid argument`, which says nothing
		   about containers. */
		"-f", "mp4",
		"-y", part,
	]);
	await rename(part, out);
	return out;
}

/*
 * The filmstrip, as numbered frames rather than one sprite sheet.
 *
 * A sheet is one request and sounds better, until a clip is trimmed and the
 * sheet has to be rebuilt or indexed around. Separate frames are cached by the
 * browser individually, and the timeline asks for the handful it can actually
 * see. They are tiny — 160x90 jpegs are a couple of KB each.
 */
async function buildStrip(source, dir) {
	const marker = join(dir, "index.json");
	if (await done(marker)) return JSON.parse(await readFile(marker, "utf8"));
	const part = `${dir}.part`;
	await rm(part, { recursive: true, force: true });
	await mkdir(part, { recursive: true });
	await run("ffmpeg", [
		"-v", "error", "-i", source,
		"-vf", `fps=${1 / STRIP_INTERVAL},scale=-2:${STRIP_HEIGHT}`,
		"-q:v", "6",
		"-y", join(part, "%05d.jpg"),
	]);
	const frames = (await readdir(part)).filter((n) => n.endsWith(".jpg")).sort();
	const manifest = { interval: STRIP_INTERVAL, height: STRIP_HEIGHT, count: frames.length };
	await writeFile(join(part, "index.json"), `${JSON.stringify(manifest)}\n`, "utf8");
	await rm(dir, { recursive: true, force: true });
	await rename(part, dir);
	return manifest;
}

/*
 * Peaks, from raw samples rather than from a picture of a waveform.
 *
 * ffmpeg can draw a waveform PNG, and that is the tempting shortcut. It is the
 * wrong artefact: a picture cannot be redrawn at another zoom, cannot be
 * recoloured with the theme, and cannot be sliced when a clip is trimmed. Two
 * numbers per bucket can do all three, and the whole array for a two-minute
 * take is smaller than the PNG would have been.
 */
async function buildPeaks(source, out) {
	if (await done(out)) return JSON.parse(await readFile(out, "utf8"));
	const seconds = await secondsOf(source);
	if (!(await hasAudio(source))) {
		const empty = { rate: PEAKS_PER_SECOND, seconds, peaks: [] };
		await writeFile(out, `${JSON.stringify(empty)}\n`, "utf8");
		return empty;
	}
	/* One mono stream of 16-bit samples at a rate that gives whole samples per
	   bucket, read from stdout — no intermediate wav on disk. */
	const rate = PEAKS_PER_SECOND * 100;
	const raw = await new Promise((resolve) => {
		const child = spawn("ffmpeg", ["-v", "error", "-i", source, "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const chunks = [];
		child.stdout.on("data", (d) => chunks.push(d));
		child.on("error", () => resolve(Buffer.alloc(0)));
		child.on("close", () => resolve(Buffer.concat(chunks)));
	});
	const perBucket = Math.max(1, Math.round(rate / PEAKS_PER_SECOND));
	const samples = raw.length / 2;
	const peaks = [];
	for (let i = 0; i < samples; i += perBucket) {
		let min = 0;
		let max = 0;
		for (let j = i; j < Math.min(i + perBucket, samples); j += 1) {
			const v = raw.readInt16LE(j * 2) / 32768;
			if (v < min) min = v;
			if (v > max) max = v;
		}
		/* Three decimals is under a pixel at any zoom we draw, and it halves the
		   size of the file the browser has to parse. */
		peaks.push(Number(min.toFixed(3)), Number(max.toFixed(3)));
	}
	const data = { rate: PEAKS_PER_SECOND, seconds, peaks };
	const part = `${out}.part`;
	await writeFile(part, `${JSON.stringify(data)}\n`, "utf8");
	await rename(part, out);
	return data;
}

/**
 * Everything an editor needs for one source file, built once.
 *
 * Returns the paths rather than the bytes: the timeline fetches them itself,
 * and the server has no reason to hold a filmstrip in memory.
 */
export async function cacheSource(file, cacheDir, { onStep = () => {} } = {}) {
	const key = await keyFor(file);
	await mkdir(join(cacheDir, "proxy"), { recursive: true });
	await mkdir(join(cacheDir, "peaks"), { recursive: true });
	const proxy = join(cacheDir, "proxy", `${key}.mp4`);
	const strip = join(cacheDir, "strip", key);
	const peaks = join(cacheDir, "peaks", `${key}.json`);

	const picture = await hasVideo(file);
	onStep("proxy");
	await buildProxy(file, proxy, { picture });
	onStep("filmstrip");
	/* No picture, no filmstrip: the waveform is the whole of what a sound clip
	   has to show, and it comes from the peaks. */
	const stripInfo = picture ? await buildStrip(file, strip) : { count: 0 };
	onStep("peaks");
	const peakInfo = await buildPeaks(file, peaks);

	return {
		key,
		seconds: peakInfo.seconds || (await secondsOf(file)),
		proxy,
		strip,
		peaks,
		frames: stripInfo.count,
	};
}
