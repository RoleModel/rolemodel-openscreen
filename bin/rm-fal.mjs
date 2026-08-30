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
import { fal, avatarProblem, clipProblem, modelById, takesOf, DEFAULT_MODEL } from "../lib/fal.mjs";
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
const generating = takes === "text" || takes === "image+text";
const avatar = takes !== "video" && !generating;
if (takes === "video" && (!file || !prompt)) die("--file and --prompt are required");
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
	const stillArg = all("image")[0];
	if (fromStill && !stillArg) die(`--image is required for ${spec.label}`);
	const still = fromStill ? inProject(stillArg, "that picture") : null;
	if (still) {
		const wrong = await avatarProblem({ image: still, audio: null });
		/* avatarProblem asks for a voice too; only the picture matters here. */
		if (wrong && !/voice track/.test(wrong)) die(wrong);
	}

	console.log(`  model     ${spec.label}  (${spec.id})`);
	if (fromStill) console.log(`  picture   ${stillArg}`);
	console.log(`  shot      ${prompt}`);
	console.log(`  length    ${flag("duration") ?? spec.limits.defaultDuration}  ·  ${flag("resolution") ?? spec.limits.defaultResolution}  ·  audio ${args.includes("--no-audio") ? "off" : "on"}`);
	console.log("");

	let imageUrl;
	if (still) {
		console.log("  uploading the picture…");
		imageUrl = await send(still);
	}
	console.log("  generating — this takes a few minutes…");
	const { url } = await client
		.edit(
			{
				model,
				imageUrl,
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
	await deliver(url, flag("output") ?? join("Footage", `generated-${stamp}.mp4`));
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

let sending = source;
if (trimming) {
	console.log(`  trimming ${inSec.toFixed(2)}s → ${outSec.toFixed(2)}s…`);
	sending = join(await mkdtemp(join(tmpdir(), "rm-fal-")), "clip.mp4");
	const cut = await capture("ffmpeg", [
		"-y", "-ss", String(inSec), "-to", String(outSec), "-i", source,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-movflags", "+faststart", sending,
	]);
	if (!cut.ok) die("ffmpeg could not cut that range");
	const cutProblem = await clipProblem(sending, { seconds, model });
	if (cutProblem) die(cutProblem);
}

console.log("  uploading the clip…");
const videoUrl = await send(sending);

const imageUrls = [];
for (const image of all("image")) imageUrls.push(await send(inProject(image, "a reference image")));

console.log("  editing — this takes a few minutes…");
const { url } = await client
	.edit(
		{ model, videoUrl, prompt, keepAudio: !args.includes("--no-audio"), imageUrls, resolution: flag("resolution") ?? undefined },
		{ onLog: (line) => console.log(`  ${line}`) },
	)
	.catch((error) => die(error.message));

const stem = basename(file, extname(file));
await deliver(url, flag("output") ?? join("Footage", `${stem}-restyled.mp4`));
