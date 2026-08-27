#!/usr/bin/env node
/**
 * rm-align-audio — make the narration track for a reviewed visual alignment.
 *
 * An alignment is a sequence of corresponding screen and narration ranges. A
 * normal mux can only lay the WHOLE narration on a render; that reintroduces
 * every pause and makes the mapping look like it was ignored. This cuts the
 * chosen narration ranges and joins them in the same order as the visual edit.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};
const input = flag("--input");
const alignmentPath = flag("--alignment");
const output = flag("--output");

if (!input || !alignmentPath || !output) {
  console.error("rm-align-audio: --input, --alignment and --output are required");
  process.exit(1);
}

const alignment = JSON.parse(await readFile(resolve(alignmentPath), "utf8"));
const segments = Array.isArray(alignment?.segments) ? alignment.segments : [];
if (!segments.length) {
  console.error("rm-align-audio: the alignment has no narration segments");
  process.exit(1);
}

const filters = segments.map((segment, index) => {
  const start = Number(segment.audioInSec);
  const end = Number(segment.audioOutSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("rm-align-audio: the alignment has an invalid narration range");
  }
  return `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`;
});
filters.push(`${segments.map((_, index) => `[a${index}]`).join("")}concat=n=${segments.length}:v=0:a=1[aout]`);

const child = spawn("ffmpeg", [
  "-y", "-i", resolve(input), "-filter_complex", filters.join(";"),
  "-map", "[aout]", "-c:a", "pcm_s16le", resolve(output),
], { stdio: "inherit" });
const code = await new Promise((done) => {
  child.on("error", () => done(1));
  child.on("close", done);
});
if (code !== 0) process.exit(code ?? 1);
