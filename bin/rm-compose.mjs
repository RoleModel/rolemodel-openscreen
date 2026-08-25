#!/usr/bin/env node
/*
 * Build a video out of scenes and footage.
 *
 *   rm-compose <composition.json> [--out <dir>] [--fps 30] [--keep-scenes]
 *
 * A composition is an ordered list of segments. A `scene` segment is components —
 * a title, a lower third, browser chrome — and is rendered here. A `footage`
 * segment is a file already in the project and is used as it is. The result is an
 * .openscreen document the editor opens, with the segments laid end to end.
 *
 * This is a CLI rather than something the Studio does inline because rendering a
 * scene steps a browser frame by frame: a six-second card is 180 seeks and
 * screenshots. The Studio hands it over as a job and streams the output, the same
 * way drafting a script does, so a long render is visible rather than a hung
 * request.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { composeDocument, FPS, SCENE_H, SCENE_W, sceneDurationMs, sceneHtml } from "../lib/compose.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const die = (m) => {
	console.error(`rm-compose: ${m}`);
	process.exit(1);
};

const file = argv.find((a) => !a.startsWith("-"));
if (!file) die("usage: rm-compose <composition.json> [--out <dir>]");

const spec = JSON.parse(await readFile(resolve(file), "utf8"));
const segments = spec.segments ?? [];
if (!segments.length) die("the composition has no segments");

const outDir = resolve(flag("out", dirname(resolve(file))));
const fps = Number(flag("fps", FPS));
await mkdir(outDir, { recursive: true });

/**
 * How long a piece of footage runs, in milliseconds.
 *
 * ffprobe rather than trusting the composition: a segment can name a file that
 * has been replaced since it was added, and laying clips end to end from a stale
 * duration puts every later segment at the wrong time — a drift nobody notices
 * until the narration stops matching halfway through.
 */
/*
 * Did that encode actually finish?
 *
 * ffmpeg writes the moov atom last, so an encode that is killed leaves a file
 * with data, plausible size, and no index — existing, non-empty, and unopenable
 * by any demuxer. Nothing downstream notices until the editor fails with
 * "DEMUXER_ERROR_COULD_NOT_OPEN" days later, pointing at no particular cause.
 * Checking here costs one header read and turns it into a failed render.
 */
async function assertPlayable(file, what) {
	try {
		await run("ffprobe", ["-v", "error", "-show_format", "-of", "json", file]);
	} catch {
		die(`${what} did not finish writing — ${file.split("/").pop()} has no index and cannot be opened. Run it again.`);
	}
}

async function probeMedia(path) {
	const { stdout } = await run("ffprobe", [
		"-v", "quiet",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		path,
	]);
	const data = JSON.parse(stdout);
	const seconds = Number(data?.format?.duration);
	if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`could not read a duration from ${path}`);
	return {
		ms: Math.round(seconds * 1000),
		// Concat needs every input to agree on stream layout. A scene has no audio
		// and a capture usually does, so the silent ones get silence rather than
		// being concatenated without a track — which drops audio from every input
		// after the first mismatch instead of failing.
		hasAudio: (data.streams ?? []).some((st) => st.codec_type === "audio"),
	};
}

/*
 * Scene HTML is written into components/ and rendered from there.
 *
 * Not into the output directory, which is where it belongs: the file links
 * ../brand/optics/optics.css and ./rm-video.js by relative path, and those
 * relationships only hold inside components/. Writing it elsewhere would mean
 * rewriting every link per destination, which is a second thing to get wrong.
 * It is removed afterwards unless --keep-scenes, because a generated file left
 * beside hand-written ones is a file somebody will edit.
 */
const scratch = [];
const pieces = [];

for (const [i, seg] of segments.entries()) {
	const n = String(i + 1).padStart(2, "0");

	if (seg.kind === "footage") {
		const path = resolve(seg.path);
		const { ms, hasAudio } = await probeMedia(path);
		console.log(`  ${n}  footage  ${(ms / 1000).toFixed(1)}s  ${path.split("/").pop()}`);
		pieces.push({ path, ms, hasAudio });
		continue;
	}

	if (seg.kind !== "scene") die(`segment ${n}: unknown kind "${seg.kind}"`);

	/*
	 * A scene is either authored HTML or a list of components.
	 *
	 * `bodyFile` points at markup somebody wrote — the form's six components with
	 * their declared fields is a ceiling, and the renderer never cared where the
	 * HTML came from. Read at render time rather than copied into the spec, so
	 * editing the scene and re-rendering does not need the composition rebuilt.
	 */
	let authored = null;
	if (seg.bodyFile) authored = await readFile(resolve(seg.bodyFile), "utf8");
	else if (typeof seg.body === "string") authored = seg.body;

	/*
	 * An authored scene must say how long it runs.
	 *
	 * Duration is read off `at`/`for` when the elements are structured data; in
	 * free markup there is nothing to read, and guessing produces a card that cuts
	 * mid-sentence. The default is the same floor sceneDurationMs uses.
	 */
	const ms = seg.ms ?? (authored ? 4000 : sceneDurationMs(seg.elements ?? []));
	const name = seg.name || `scene-${n}`;
	const html = join(ROOT, "components", `.compose-${n}.html`);
	const mp4 = join(outDir, `${name}.mp4`);

	await writeFile(
		html,
		sceneHtml({ wallpaper: seg.wallpaper, brand: seg.brand, elements: seg.elements ?? [], body: authored, title: name }),
		"utf8",
	);
	scratch.push(html);

	console.log(`  ${n}  scene    ${(ms / 1000).toFixed(1)}s  ${name} (${authored ? "authored" : `${(seg.elements ?? []).length} elements`})`);
	try {
		await run("node", [join(ROOT, "components", "render-scene.mjs"), html, "-o", mp4, "--fps", String(fps), "--ms", String(ms)], {
			cwd: ROOT,
			maxBuffer: 1 << 24,
		});
	} catch (err) {
		die(`segment ${n} (${name}) failed to render: ${String(err.stderr || err.message).slice(0, 300)}`);
	}
	await assertPlayable(mp4, `segment ${n} (${name})`);
	pieces.push({ path: mp4, ms, hasAudio: false });
}

if (!argv.includes("--keep-scenes")) for (const f of scratch) await rm(f, { force: true });

/*
 * Cut the pieces into one video.
 *
 * A v2 document names a single file, so a composition has to become one before
 * it can be opened. Doing it here rather than leaving the editor to assemble
 * clips is also what keeps the audio: the footage's track survives the concat,
 * and the silent scenes get silence of exactly their own length rather than
 * being joined without a track — which drops audio from every input after the
 * first mismatch instead of failing.
 *
 * Re-encoded, not stream-copied. The inputs genuinely differ — a scene is
 * 1920×1080@30 from PNGs with no audio, a capture is whatever the display and
 * the microphone were — and the concat demuxer requires identical parameters.
 * Normalising each input through the filter graph is the version that works on
 * footage nobody vetted first.
 */
const name = spec.name || "composition";
const finalMp4 = join(outDir, `${name}.mp4`);

/*
 * How far under the voice the footage sits when both carry sound. Not a mute:
 * a click or a notification chime in a capture is often the thing the narration
 * is talking about.
 */
const FOOTAGE_UNDER_VOICE = 0.35;

const narration = spec.audio ? resolve(spec.audio) : null;
if (narration && !(await stat(narration).catch(() => null))) die(`no such audio: ${spec.audio}`);

const inputs = [];
for (const p of pieces) inputs.push("-i", p.path);
// One silence source, trimmed per silent piece. Cheaper than an input each.
inputs.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
const silentIdx = pieces.length;

const graph = [];
const labels = [];
pieces.forEach((p, i) => {
	// force_original_aspect_ratio + pad rather than a bare scale: footage that is
	// not 16:9 would otherwise be stretched, and a stretched face is worse than
	// bars.
	graph.push(
		`[${i}:v]scale=${SCENE_W}:${SCENE_H}:force_original_aspect_ratio=decrease,` +
			`pad=${SCENE_W}:${SCENE_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
	);
	if (p.hasAudio) {
		graph.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
	} else {
		graph.push(`[${silentIdx}:a]atrim=duration=${(p.ms / 1000).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
	}
	labels.push(`[v${i}][a${i}]`);
});
graph.push(`${labels.join("")}concat=n=${pieces.length}:v=1:a=1[v][acut]`);

/*
 * Narration, laid over the cut.
 *
 * A screen capture is usually silent — no mic, no system audio — and the voice
 * lives beside it as its own file, which is what rm-voice writes. Without this
 * a composition came out with a valid audio track carrying nothing, which is
 * indistinguishable from "the render lost my audio" and was reported as exactly
 * that.
 *
 * Mixed rather than substituted: footage that does carry sound should keep it,
 * ducked under the voice. normalize=0 because amix otherwise divides every input
 * by their count, which halves the narration for no reason anyone asked for.
 * duration=first keeps the video's length authoritative — narration longer than
 * the cut is trimmed, shorter leaves the tail as it was, and either way the
 * picture is not stretched to fit the voice.
 */
let audioOut = "[acut]";
if (narration) {
	const narrIdx = silentIdx + 1;
	inputs.push("-i", narration);
	graph.push(`[${narrIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[narr]`);
	graph.push(`[acut]volume=${FOOTAGE_UNDER_VOICE}[bed]`);
	graph.push(`[bed][narr]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amixed]`);
	audioOut = "[amixed]";
}

console.log(`\n  cutting ${pieces.length} segments together${narration ? ` with ${narration.split("/").pop()}` : ""}…`);
try {
	await run(
		"ffmpeg",
		[
			"-y",
			...inputs,
			"-filter_complex", graph.join(";"),
			"-map", "[v]",
			"-map", audioOut,
			"-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium",
			"-c:a", "aac", "-b:a", "192k",
			// Longest wins would let a rounding error on one input stretch the cut.
			"-shortest",
			finalMp4,
		],
		{ maxBuffer: 1 << 26 },
	);
} catch (err) {
	die(`could not cut the segments together: ${String(err.stderr || err.message).slice(-400)}`);
}

await assertPlayable(finalMp4, "the cut");

const doc = composeDocument({
	video: finalMp4,
	segments: pieces,
	...(spec.cursorCaptureMode ? { cursorCaptureMode: spec.cursorCaptureMode } : {}),
});
const docPath = join(outDir, `${name}.openscreen`);
await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

const total = pieces.reduce((n, p) => n + p.ms, 0);
const withAudio = pieces.filter((p) => p.hasAudio).length;
console.log(`\n  ${pieces.length} segments, ${(total / 1000).toFixed(1)}s total (${withAudio} carrying audio)`);
console.log(`  ${finalMp4}`);
console.log(`  ${docPath}\n`);
