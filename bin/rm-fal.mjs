#!/usr/bin/env node
/**
 * rm-fal — restyle one clip with fal.ai, into the project it came from.
 *
 * A command rather than a request handler, so it gets what every other long task
 * in this app already has: a line in the Console, streaming progress, a Stop
 * button, and a PATH that works when Studio was launched from Finder. A model
 * call takes minutes, which is far too long to hold an HTTP request open.
 *
 *   rm-fal --project <id> --file Footage/blaine.mp4 --prompt "..." [--model <id>]
 *          [--no-audio] [--resolution 1080p] [--image brand:x.png ...]
 *          [--in 4.5 --out 12.0] [--output Footage/blaine-restyled.mp4]
 *
 * The avatar models take no clip at all — a photograph and a voice track, which
 * is normally one this project already built under Voice:
 *
 *   rm-fal --project <id> --model fal-ai/bytedance/omnihuman
 *          --image Stills/blaine.png --audio Audio/intro.wav [--prompt "..."]
 *
 * And the lipsync models keep a real take, re-timing only its mouth to a new
 * voice — a clip and a voice, with --sync-mode deciding what happens when the
 * two are different lengths:
 *
 *   rm-fal --project <id> --model fal-ai/sync-lipsync/v3
 *          --file Footage/becky.mp4 --audio Audio/ccc-days.wav --sync-mode remap
 *
 * And Veo generates a shot from a description, optionally starting from a
 * still this project already has:
 *
 *   rm-fal --project <id> --model fal-ai/veo3.1 --prompt "..." [--duration 8s]
 *          [--resolution 1080p] [--aspect 16:9] [--no-audio]
 *   rm-fal --project <id> --model fal-ai/veo3.1/image-to-video
 *          --image Stills/blaine.png --prompt "he turns to camera"
 */
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoot } from "../lib/library.mjs";
import { falSettings } from "../lib/settings.mjs";
import { fal, avatarProblem, clipProblem, modelById, takesOf, DEFAULT_MODEL, SENDABLE } from "../lib/fal.mjs";
import { capture, durationOf } from "../lib/narration.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? null : (args[i + 1] ?? null);
};
const all = (name) => args.reduce((found, a, i) => (a === `--${name}` && args[i + 1] ? [...found, args[i + 1]] : found), []);

const die = (message) => {
	console.error(`rm-fal: ${message}`);
	process.exit(1);
};

const projectId = flag("project");
const file = flag("file");
const prompt = flag("prompt");
if (!projectId) die("--project is required");

const LIB = defaultRoot();
const mediaDir = join(LIB, projectId, "media");

const { key } = await falSettings();
if (!key) die("no fal key is configured — add one in Studio's Restyle panel, or set FAL_KEY");

const model = flag("model") ?? DEFAULT_MODEL;
const spec = modelById(model);
if (!spec) die(`${model} is not a model this app knows`);
const takes = takesOf(spec);
/* Three families now: edit a clip, drive a face from a voice, or generate a
   shot outright. Only the first needs a clip on the way in. */
const generating = takes === "text" || takes === "image+text" || takes === "video+text";
const avatar = takes !== "video" && !generating;
if (takes === "video" && !file) die("--file is required");
/* Background removal takes no instruction; every other clip edit does. */
if (takes === "video" && spec.controls.includes("prompt") && !prompt) die("--prompt is required — say what to change");
if (generating && !prompt) die("--prompt is required — it is the shot");

/*
 * Two named roots, never an open path.
 *
 * A project's own media, or the shared brand shelf under a `brand:` prefix —
 * most projects keep no pictures of their own and the references are brand
 * assets. A bare relative name that could escape either one is how a tool reads
 * a file it was never given.
 */
const BRAND_IMAGERY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "brand", "imagery");
const inProject = (given, what) => {
	const brand = given.startsWith("brand:");
	const root = brand ? BRAND_IMAGERY : mediaDir;
	const path = resolve(root, brand ? given.slice("brand:".length) : given);
	if (!path.startsWith(`${root}/`)) die(`${what} is outside ${brand ? "the brand shelf" : "this project"}`);
	return path;
};

/*
 * The result lands beside the footage it was made from, not in Renders.
 *
 * It is source material — something to cut with — and the catalog treats
 * Renders as finished output. Named after the original so the pair stays
 * obvious in a folder listing.
 */
const deliver = async (url, out) => {
	const target = resolve(mediaDir, out);
	if (!target.startsWith(`${mediaDir}/`)) die("that output path is outside this project");
	await mkdir(dirname(target), { recursive: true });
	console.log("  downloading the result…");
	const response = await fetch(url);
	if (!response.ok) die(`could not download the result (${response.status})`);
	await writeFile(target, Buffer.from(await response.arrayBuffer()));
	console.log("");
	console.log(`  wrote ${out}`);
};

/* Results made in parts, joined in order into the one file `out` names. Stream
   copied, so VP9's alpha survives the join untouched. */
const deliverJoined = async (files, out) => {
	const target = resolve(mediaDir, out);
	if (!target.startsWith(`${mediaDir}/`)) die("that output path is outside this project");
	await mkdir(dirname(target), { recursive: true });
	console.log(`  joining ${files.length} parts…`);
	const list = join(dirname(files[0]), "parts.txt");
	await writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
	const joined = await capture("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", target]);
	if (!joined.ok) die("ffmpeg could not join the parts");
	console.log("");
	console.log(`  wrote ${out}`);
};

/* How many frames, and how fast: counted, not read off the header, which an
   export can leave empty or wrong. */
const framesOf = async (path) => {
	const probe = await capture("ffprobe", [
		"-v", "error", "-select_streams", "v:0", "-count_packets",
		"-show_entries", "stream=nb_read_packets,r_frame_rate", "-of", "json", path,
	]);
	const stream = JSON.parse(probe.out || "{}").streams?.[0] ?? {};
	const [num, den] = String(stream.r_frame_rate ?? "0/1").split("/").map(Number);
	return { frames: Number(stream.nb_read_packets) || 0, fps: den ? num / den : 0 };
};

/* The clip as it is, or cut into equal parts each under `maxFrames`. */
const partsFor = async (path, maxFrames) => {
	if (!maxFrames) return [path];
	const { frames, fps } = await framesOf(path);
	if (!frames || !fps) die("could not count the frames in that clip");
	if (frames <= maxFrames) return [path];
	// A few frames of headroom: a re-encoded cut can land a frame either side.
	const count = Math.ceil(frames / (maxFrames - 4));
	const each = frames / count / fps;
	const dir = await mkdtemp(join(tmpdir(), "rm-fal-split-"));
	const parts = [];
	for (let i = 0; i < count; i++) {
		const part = join(dir, `part-${i}.mp4`);
		const cut = await capture("ffmpeg", [
			"-y", "-ss", (i * each).toFixed(3), "-i", path, "-t", each.toFixed(3),
			"-map", "0:v:0", "-map", "0:a:0?",
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
			"-c:a", "aac", "-movflags", "+faststart", part,
		]);
		if (!cut.ok) die(`ffmpeg could not cut part ${i + 1}`);
		const got = await framesOf(part);
		if (got.frames > maxFrames) die(`part ${i + 1} came out at ${got.frames} frames, over the model's ${maxFrames}`);
		parts.push(part);
	}
	return parts;
};

const client = await fal({ key }).catch((error) => die(error.message));
const send = async (path) => client.upload(path, await readFile(path)).catch((error) => die(error.message));

/*
 * Generating a shot, which starts from nothing but words.
 *
 * No clip to trim, no ceiling to keep under, no original audio to preserve —
 * and the result is still footage, so it lands in Footage beside everything
 * that was actually filmed. Named after the run rather than a source, because
 * there is no source to name it after.
 */
if (generating) {
	const fromStill = takes === "image+text";
	const fromShot = takes === "video+text";
	const stillArg = all("image")[0];
	if (fromStill && !stillArg) die(`--image is required for ${spec.label}`);
	if (fromShot && !file) die(`--file is required for ${spec.label} — the shot it continues`);
	const still = fromStill ? inProject(stillArg, "that picture") : null;
	const shot = fromShot ? inProject(file, "that clip") : null;
	if (still) {
		const wrong = await avatarProblem({ image: still, audio: null });
		/* avatarProblem asks for a voice too; only the picture matters here. */
		if (wrong && !/voice track/.test(wrong)) die(wrong);
	}

	console.log(`  model     ${spec.label}  (${spec.id})`);
	if (fromStill) console.log(`  picture   ${stillArg}`);
	if (fromShot) console.log(`  shot so far  ${file}`);
	console.log(`  shot      ${prompt}`);
	console.log(`  length    ${flag("duration") ?? spec.limits.defaultDuration}  ·  ${flag("resolution") ?? spec.limits.defaultResolution}  ·  audio ${args.includes("--no-audio") ? "off" : "on"}`);
	console.log("");

	let imageUrl;
	let videoUrl;
	if (still) {
		console.log("  uploading the picture…");
		imageUrl = await send(still);
	}
	if (shot) {
		console.log("  uploading the shot…");
		videoUrl = await send(shot);
	}
	console.log("  generating — this takes a few minutes…");
	const { url } = await client
		.edit(
			{
				model,
				imageUrl,
				videoUrl,
				prompt,
				aspect: flag("aspect") ?? undefined,
				duration: flag("duration") ?? undefined,
				resolution: flag("resolution") ?? undefined,
				generateAudio: !args.includes("--no-audio"),
			},
			{ onLog: (line) => console.log(`  ${line}`) },
		)
		.catch((error) => die(error.message));

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	/* An extension is named after what it continues, so a chain of them reads in
	   order in a folder listing rather than as unrelated timestamps. */
	const named = fromShot ? `${basename(file, extname(file))}-longer-${stamp}.mp4` : `generated-${stamp}.mp4`;
	await deliver(url, flag("output") ?? join("Footage", named));
	process.exit(0);
}

/*
 * An avatar is built, not edited.
 *
 * A photograph and a voice track go up and a video of that person speaking
 * comes back, so none of the clip machinery below applies: nothing to trim, no
 * duration to hold under a ceiling, no original audio to preserve. The voice
 * track is usually one this project already made under Voice, which is why the
 * default output is named after it.
 */
if (avatar) {
	/* Two shapes here, not one: a photograph and a voice, or a real clip and a
	   voice. The second is a lipsync — the take is kept and only the mouth is
	   re-timed — so it takes --file where the first takes --image. */
	const lipsync = takes === "video+audio";
	const faceArg = lipsync ? file : all("image")[0];
	const audioArg = flag("audio");
	if (!faceArg || !audioArg) die(`${lipsync ? "--file" : "--image"} and --audio are required for ${spec.label}`);
	const face = inProject(faceArg, lipsync ? "that clip" : "that picture");
	const audio = inProject(audioArg, "that voice track");

	const problem = await avatarProblem({ ...(lipsync ? { video: face } : { image: face }), audio, model });
	if (problem) die(problem);

	const spoken = await durationOf(audio);
	console.log(`  model     ${spec.label}  (${spec.id})`);
	console.log(`  ${lipsync ? "clip     " : "picture  "} ${faceArg}`);
	console.log(`  voice     ${audioArg}${spoken ? `  (${spoken.toFixed(1)}s)` : ""}`);
	if (lipsync) console.log(`  mismatch  ${flag("sync-mode") ?? spec.limits.defaultSyncMode ?? "cut_off"}`);
	console.log("");

	console.log(`  uploading the ${lipsync ? "clip" : "picture"} and the voice…`);
	const faceUrl = await send(face);
	const audioUrl = await send(audio);

	console.log("  generating — this takes a few minutes…");
	const { url } = await client
		.edit(
			{
				model,
				...(lipsync ? { videoUrl: faceUrl } : { imageUrl: faceUrl }),
				audioUrl,
				prompt,
				syncMode: flag("sync-mode") ?? undefined,
			},
			{ onLog: (line) => console.log(`  ${line}`) },
		)
		.catch((error) => die(error.message));

	const stem = basename(lipsync ? faceArg : audioArg, extname(lipsync ? faceArg : audioArg));
	await deliver(url, flag("output") ?? join("Footage", `${stem}-${lipsync ? "lipsync" : "avatar"}.mp4`));
	process.exit(0);
}

const source = inProject(file, "that clip");

/*
 * A range inside the clip, cut before anything is uploaded.
 *
 * Most takes are longer than these models accept — Kling stops at fifteen
 * seconds and a talking head runs twenty to forty — so the alternative to
 * trimming is that most of a project cannot be restyled at all. Re-encoded
 * rather than stream-copied: a copy starts at the nearest keyframe, which moves
 * the in-point by up to a second and changes the duration the model is checking.
 */
const inSec = Number(flag("in"));
const outSec = Number(flag("out"));
const trimming = Number.isFinite(inSec) && Number.isFinite(outSec) && outSec > inSec;

const whole = await durationOf(source);
const seconds = trimming ? outSec - inSec : whole;
const problem = await clipProblem(source, { seconds: seconds || null, model, ignoreSize: trimming });
if (problem) die(problem);

console.log(`  model     ${spec.label}  (${spec.id})`);
console.log(`  clip      ${file}  (${seconds.toFixed(1)}s)`);
console.log(`  audio     ${args.includes("--no-audio") ? "replaced by the model" : "kept from the original"}`);
console.log("");

/*
 * What goes up is an H.264 MP4 whenever it has to be made: for a range, and for
 * a clip fal will not take as it is (.m4v, .webm, .mkv). The first video and
 * audio streams are named, because an .m4v export often carries its cover art as
 * a second, same-sized video stream, and ffmpeg's own pick could be the picture.
 */
let sending = source;
const converting = !SENDABLE.has(extname(source).toLowerCase());
if (trimming || converting) {
	console.log(trimming ? `  trimming ${inSec.toFixed(2)}s → ${outSec.toFixed(2)}s…` : `  converting ${extname(source)} to .mp4 for fal…`);
	sending = join(await mkdtemp(join(tmpdir(), "rm-fal-")), "clip.mp4");
	const cut = await capture("ffmpeg", [
		"-y", ...(trimming ? ["-ss", String(inSec), "-to", String(outSec)] : []), "-i", source,
		"-map", "0:v:0", "-map", "0:a:0?",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-movflags", "+faststart", sending,
	]);
	if (!cut.ok) die(trimming ? "ffmpeg could not cut that range" : "ffmpeg could not convert that clip");
	const cutProblem = await clipProblem(sending, { seconds, model });
	if (cutProblem) die(cutProblem);
}

const imageUrls = [];
for (const image of all("image")) imageUrls.push(await send(inProject(image, "a reference image")));

const stem = basename(file, extname(file));
/* A model that says what it makes names the file after it: a cutout is a .webm. */
const out = flag("output") ?? join("Footage", `${stem}-${spec.output?.suffix ?? "restyled"}${spec.output?.ext ?? ".mp4"}`);
const editOne = async (videoUrl) => {
	const { url } = await client
		.edit(
			{ model, videoUrl, prompt, keepAudio: !args.includes("--no-audio"), imageUrls, resolution: flag("resolution") ?? undefined },
			{ onLog: (line) => console.log(`  ${line}`) },
		)
		.catch((error) => die(error.message));
	return url;
};

/*
 * A model with a frame ceiling gets a long clip in parts.
 *
 * BiRefNet's video matte takes 512 frames a job — 21 seconds at 24fps — and a
 * talking head is twice that, so fal turned the whole clip away. The clip is cut
 * into equal parts under the ceiling, each part is matted on its own, and the
 * results are joined back into one file. The cuts are re-encoded, not copied, so
 * each part starts on its own first frame and none runs over by a keyframe.
 */
const parts = await partsFor(sending, spec.limits.maxFrames);
if (parts.length === 1) {
	console.log("  uploading the clip…");
	const videoUrl = await send(sending);
	console.log("  editing — this takes a few minutes…");
	await deliver(await editOne(videoUrl), out);
} else {
	console.log(`  ${spec.label} takes at most ${spec.limits.maxFrames} frames, so it goes in ${parts.length} parts`);
	const work = await mkdtemp(join(tmpdir(), "rm-fal-parts-"));
	const done = [];
	for (const [i, part] of parts.entries()) {
		console.log(`  part ${i + 1} of ${parts.length}: uploading…`);
		const videoUrl = await send(part);
		console.log(`  part ${i + 1} of ${parts.length}: editing…`);
		const url = await editOne(videoUrl);
		const response = await fetch(url);
		if (!response.ok) die(`could not download part ${i + 1} (${response.status})`);
		const local = join(work, `out-${i}${spec.output?.ext ?? ".mp4"}`);
		await writeFile(local, Buffer.from(await response.arrayBuffer()));
		done.push(local);
	}
	await deliverJoined(done, out);
}
