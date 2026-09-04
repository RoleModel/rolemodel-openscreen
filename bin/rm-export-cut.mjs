#!/usr/bin/env node
/*
 * Export a cut: every clip as its own file, and the clips joined as one video.
 *
 *   rm-export-cut --cut <Renders/x/cut.json> --media <project media dir>
 *                 --out <dir> --mode parts|joined|both [--name <stem>]
 *
 * Each part is re-encoded, not stream-copied: a copy can only start on a
 * keyframe, so a cut two seconds in would land wherever the encoder happened
 * to put one. Every part is made the same shape — the cut's size and frame
 * rate, stereo 48 kHz sound, silence where a source has none — so the joined
 * video is a plain concat of the parts, with nothing re-encoded twice.
 *
 * Gaps between clips are closed in the joined video: the parts follow one
 * another. Graphics in the cut (clips with no source) are skipped; they are
 * drawn by the composition's render, not by ffmpeg.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? null : argv[i + 1];
};
const die = (m) => {
	console.error(m);
	process.exit(1);
};

const cutFile = flag("cut");
const media = flag("media");
const out = flag("out");
const mode = flag("mode") ?? "both";
if (!cutFile || !media || !out) die("--cut, --media and --out are required");
if (!["parts", "joined", "both"].includes(mode)) die("--mode is parts, joined or both");

const cut = JSON.parse(await readFile(cutFile, "utf8"));
const name = flag("name") ?? basename(join(cutFile, ".."));
const W = Number(cut.width) || 1920;
const H = Number(cut.height) || 1080;
const FPS = Number(cut.fps) || 30;

const clips = (cut.tracks ?? [])
	.filter((t) => !t.kind || t.kind === "video")
	.flatMap((t) => t.clips ?? [])
	.filter((c) => c.source && cut.sources?.[c.source]?.file && c.out > c.in)
	.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
if (!clips.length) die("this cut has no footage clips to export");

const run = (bin, args) =>
	new Promise((done, fail) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		let outText = "";
		child.stdout.on("data", (d) => (outText += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", fail);
		child.on("close", (code) => (code === 0 ? done(outText) : fail(new Error(err.trim().split("\n").slice(-3).join(" ") || `${bin} failed`))));
	});

const hasAudio = async (file) => {
	const text = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]).catch(() => "");
	return /audio/.test(text);
};

const clock = (s) => {
	const m = Math.floor(s / 60);
	return `${m}.${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.round((s % 1) * 100)).padStart(2, "0")}`;
};
const safe = (s) => s.replace(/[\\/:*?"<>|]+/g, "-").trim();

const partsDir = join(out, "parts");
await mkdir(partsDir, { recursive: true });
const made = [];
let n = 0;
for (const clip of clips) {
	n += 1;
	const src = join(media, cut.sources[clip.source].file);
	const dur = clip.out - clip.in;
	const stem = safe(basename(cut.sources[clip.source].file, extname(cut.sources[clip.source].file)));
	const file = join(partsDir, `${String(n).padStart(2, "0")} ${stem} ${clock(clip.in)}-${clock(clip.out)}.mp4`);
	const sound = await hasAudio(src);
	const args = ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(clip.in), "-i", src];
	if (!sound) args.push("-f", "lavfi", "-t", String(dur), "-i", "anullsrc=r=48000:cl=stereo");
	args.push(
		"-t", String(dur),
		"-map", "0:v:0", "-map", sound ? "0:a:0" : "1:a:0",
		"-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p`,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
		"-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
		"-movflags", "+faststart", "-shortest",
		file,
	);
	console.log(`part ${n}/${clips.length}  ${basename(file)}`);
	await run("ffmpeg", args);
	made.push(file);
}

if (mode !== "parts") {
	const list = join(partsDir, ".concat.txt");
	await writeFile(list, made.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
	const joined = join(out, `${safe(name)}.mp4`);
	console.log(`joining ${made.length} parts → ${basename(joined)}`);
	await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", joined]);
	console.log(`done  ${joined}`);
} else {
	console.log(`done  ${made.length} parts in ${partsDir}`);
}
