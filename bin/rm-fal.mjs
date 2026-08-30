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
 */
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoot } from "../lib/library.mjs";
import { falSettings } from "../lib/settings.mjs";
import { fal, clipProblem, modelById, DEFAULT_MODEL } from "../lib/fal.mjs";
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
if (!projectId || !file || !prompt) die("--project, --file and --prompt are required");

const LIB = defaultRoot();
const mediaDir = join(LIB, projectId, "media");
const source = resolve(mediaDir, file);
// Never read outside the project's own media, whatever the caller passed.
if (!source.startsWith(`${mediaDir}/`)) die("that clip is outside this project");

const { key } = await falSettings();
if (!key) die("no fal key is configured — add one in Studio's Restyle panel, or set FAL_KEY");

const model = flag("model") ?? DEFAULT_MODEL;
const spec = modelById(model);
if (!spec) die(`${model} is not a model this app knows`);

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

const client = await fal({ key }).catch((error) => die(error.message));

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
const bytes = await readFile(sending);
const videoUrl = await client.upload(sending, bytes).catch((error) => die(error.message));

/*
 * Reference images, from one of two roots.
 *
 * A project's own media, or the shared brand shelf under a `brand:` prefix —
 * most projects keep no pictures of their own and the references are brand
 * assets. Two named roots rather than an open path: a bare relative name that
 * could escape either one is how a tool reads a file it was never given.
 */
const BRAND_IMAGERY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "brand", "imagery");
const imageUrls = [];
for (const image of all("image")) {
	const brand = image.startsWith("brand:");
	const root = brand ? BRAND_IMAGERY : mediaDir;
	const path = resolve(root, brand ? image.slice("brand:".length) : image);
	if (!path.startsWith(`${root}/`)) die(`a reference image is outside ${brand ? "the brand shelf" : "this project"}`);
	imageUrls.push(await client.upload(path, await readFile(path)).catch((error) => die(error.message)));
}

console.log("  editing — this takes a few minutes…");
const { url } = await client
	.edit(
		{ model, videoUrl, prompt, keepAudio: !args.includes("--no-audio"), imageUrls, resolution: flag("resolution") ?? undefined },
		{ onLog: (line) => console.log(`  ${line}`) },
	)
	.catch((error) => die(error.message));

/*
 * The result lands beside the footage it was made from, not in Renders.
 *
 * It is source material — something to cut with — and the catalog treats
 * Renders as finished output. Named after the original so the pair stays
 * obvious in a folder listing.
 */
const stem = basename(file, extname(file));
const out = flag("output") ?? join("Footage", `${stem}-restyled.mp4`);
const target = resolve(mediaDir, out);
if (!target.startsWith(`${mediaDir}/`)) die("that output path is outside this project");
await mkdir(dirname(target), { recursive: true });

console.log("  downloading the result…");
const response = await fetch(url);
if (!response.ok) die(`could not download the result (${response.status})`);
await writeFile(target, Buffer.from(await response.arrayBuffer()));

console.log("");
console.log(`  wrote ${out}`);
