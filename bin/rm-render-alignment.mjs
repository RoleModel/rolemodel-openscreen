#!/usr/bin/env node
/**
 * rm-render-alignment — render a visual narration alignment as one reviewable video.
 *
 * OpenScreen's editable cut document is deliberately only a visual timeline today.
 * This helper renders those chosen screen ranges and their matching narration ranges
 * together, so the project receives a real MP4 with sound instead of a silent edit.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};
const alignmentPath = flag("--alignment");
const narrationPath = flag("--narration");
const audioOutput = flag("--audio-output");
const output = flag("--output");

const die = (message) => {
  console.error(`rm-render-alignment: ${message}`);
  process.exit(1);
};

if (!alignmentPath || !narrationPath || !audioOutput || !output) {
  die("--alignment, --narration, --audio-output and --output are required");
}

const run = (command, commandArgs) =>
  new Promise((done) => {
    const child = spawn(command, commandArgs, { stdio: "inherit" });
    child.on("error", (error) => done({ code: 1, error }));
    child.on("close", (code) => done({ code: code ?? 1 }));
  });

const alignment = JSON.parse(await readFile(resolve(alignmentPath), "utf8"));
const segments = Array.isArray(alignment?.segments) ? alignment.segments : [];
const clips = Array.isArray(alignment?.clips) ? alignment.clips : [];
if (!segments.length || segments.length !== clips.length) die("the alignment needs one narration range and one screen cut for every segment");

for (const [index, segment] of segments.entries()) {
  const audioIn = Number(segment.audioInSec);
  const audioOut = Number(segment.audioOutSec);
  const clip = clips[index];
  const screenIn = Number(clip?.inSec);
  const screenOut = Number(clip?.outSec);
  if (!Number.isFinite(audioIn) || !Number.isFinite(audioOut) || audioOut <= audioIn) die(`narration range ${index + 1} is invalid`);
  if (!clip?.path || !Number.isFinite(screenIn) || !Number.isFinite(screenOut) || screenOut <= screenIn) die(`screen cut ${index + 1} is invalid`);
}

const resolvedNarration = resolve(narrationPath);
const resolvedAudio = resolve(audioOutput);
const resolvedOutput = resolve(output);
const scratch = await mkdtemp(join(tmpdir(), "rm-alignment-"));

try {
  // Build the precise narration track first. It mirrors the video cuts below,
  // rather than attaching the original audio recording as a whole overlay.
  const audioFilters = segments.map((segment, index) => {
    const start = Number(segment.audioInSec);
    const end = Number(segment.audioOutSec);
    return `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`;
  });
  audioFilters.push(`${segments.map((_, index) => `[a${index}]`).join("")}concat=n=${segments.length}:v=0:a=1[aout]`);
  let result = await run("ffmpeg", [
    "-y", "-i", resolvedNarration, "-filter_complex", audioFilters.join(";"),
    "-map", "[aout]", "-c:a", "pcm_s16le", resolvedAudio,
  ]);
  if (result.code !== 0) die("ffmpeg could not build the aligned narration track");

  // Re-encode each visual range before concatenating. This is slower than stream
  // copying, but it stays accurate at edit boundaries and works across project clips.
  const parts = [];
  for (const [index, clip] of clips.entries()) {
    const start = Number(clip.inSec);
    const duration = Number(clip.outSec) - start;
    const part = join(scratch, `cut-${String(index + 1).padStart(3, "0")}.mp4`);
    result = await run("ffmpeg", [
      "-y", "-ss", String(start), "-t", String(duration), "-i", resolve(clip.path),
      "-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-reset_timestamps", "1", "-movflags", "+faststart", part,
    ]);
    if (result.code !== 0) die(`ffmpeg could not render screen cut ${index + 1} (${basename(clip.path)})`);
    parts.push(part);
  }

  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const list = join(scratch, "cuts.txt");
  await writeFile(list, `${parts.map((part) => `file ${quote(part)}`).join("\n")}\n`, "utf8");
  result = await run("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", resolvedAudio,
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart", resolvedOutput,
  ]);
  if (result.code !== 0) die("ffmpeg could not combine the screen edit and aligned narration");
  console.log(`Rendered ${resolvedOutput}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
