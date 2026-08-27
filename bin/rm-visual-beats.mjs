#!/usr/bin/env node
/**
 * rm-visual-beats — turn a screen recording into a small, inspectable visual
 * catalogue for an assembly agent.
 *
 * It intentionally samples rather than tries to narrate the video itself. The
 * resulting timestamped frames give a vision-capable agent evidence to inspect,
 * while the manifest gives Studio a durable contract for validating its edit
 * plan. It captures a frame each second for short walkthroughs and gradually
 * spaces them out for long ones, capped at roughly 180 frames. A 36-frame
 * contact sheet missed the exact click or state change Claude needed to prove
 * a spoken line; this is analysis material, not just a thumbnail gallery.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? null : args[index + 1] ?? null;
};
const input = flag("--input");
const output = flag("--output");
const source = flag("--source") ?? basename(input ?? "recording");

if (!input || !output) {
	console.error("rm-visual-beats: --input and --output are required");
	process.exit(1);
}

function run(bin, argv, { capture = false } = {}) {
	return new Promise((resolvePromise) => {
		const child = spawn(bin, argv, { stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
		let stdout = "";
		child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
		child.on("error", (error) => resolvePromise({ ok: false, stdout, error }));
		child.on("close", (code) => resolvePromise({ ok: code === 0, stdout, code }));
	});
}

const inputPath = resolve(input);
const outputDir = resolve(output);
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const probe = await run(
	"ffprobe",
	["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inputPath],
	{ capture: true },
);
const durationSec = Number.parseFloat(probe.stdout.trim());
if (!probe.ok || !Number.isFinite(durationSec) || durationSec <= 0) {
	console.error("rm-visual-beats: ffprobe could not read the video duration");
	process.exit(1);
}

const sampleEverySec = Math.max(1, Math.ceil(durationSec / 180));
console.log(`Sampling ${basename(inputPath)} every ${sampleEverySec}s for visual alignment…`);
const framePattern = join(outputDir, "frame-%03d.jpg");
const frames = await run("ffmpeg", [
	"-y",
	"-i",
	inputPath,
	"-vf",
	`fps=1/${sampleEverySec},scale=960:-2`,
	"-q:v",
	"4",
	framePattern,
]);
if (!frames.ok) {
	console.error("rm-visual-beats: ffmpeg could not sample the recording");
	process.exit(1);
}

const names = (await readdir(outputDir))
	.filter((name) => /^frame-\d+\.jpg$/i.test(name))
	.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const manifest = {
	version: 1,
	source,
	input: inputPath,
	durationSec: +durationSec.toFixed(3),
	sampleEverySec,
	frames: names.map((file, index) => ({
		atSec: +Math.min(durationSec, index * sampleEverySec).toFixed(3),
		file,
	})),
};
await writeFile(join(outputDir, "visual-beats.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Visual beats ready: ${manifest.frames.length} frames`);
