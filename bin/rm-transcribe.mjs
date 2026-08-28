#!/usr/bin/env node
/*
 * rm-transcribe — make a timestamped VTT from a project recording.
 *
 * Whisper.cpp accepts audio, not the video containers Studio imports.  This
 * small bridge extracts a mono WAV, makes sure the one local model exists, then
 * writes a VTT beside the paper edit.  The model is cached in the Studio library
 * so the first click may download it, but the second never does.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
const value = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? null : args[at + 1] ?? null;
};
const input = value("--input");
const output = value("--output");
const language = value("--language") || "en";
const die = (message) => {
  console.error(`rm-transcribe: ${message}`);
  process.exit(1);
};
if (!input || !output) die("--input and --output are required");

const run = (bin, argv) => new Promise((resolvePromise) => {
  const child = spawn(bin, argv, { stdio: "inherit" });
  child.on("error", (error) => resolvePromise({ ok: false, error }));
  child.on("close", (code) => resolvePromise({ ok: code === 0, code }));
});

const dir = dirname(output);
/*
 * Assembly prepares several recordings at once. A fixed .paper-edit-audio.wav
 * made those background jobs overwrite one another, so Whisper repeatedly read
 * the last clip to finish extracting and wrote its words under every source.
 * Keep every intermediate and output staging file private to this process.
 */
const temporaryId = `${process.pid}-${randomUUID()}`;
const wav = join(dir, `.paper-edit-audio-${temporaryId}.wav`);
const temporaryBase = join(dir, `.paper-edit-transcript-${temporaryId}`);
const temporaryVtt = `${temporaryBase}.vtt`;
const model = join(dirname(dirname(dir)), ".rm-studio", "models", "ggml-base.en.bin");
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

async function ensureModel() {
  if (existsSync(model)) return;
  await mkdir(dirname(model), { recursive: true });
  const temp = `${model}.download`;
  console.log("Downloading the local speech model once (about 142 MB)…");
  const response = await fetch(modelUrl);
  if (!response.ok || !response.body) throw new Error(`could not download the speech model (${response.status})`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  await rename(temp, model);
}

try {
  await mkdir(dir, { recursive: true });
  await ensureModel();
  console.log("Preparing audio…");
  const audio = await run("ffmpeg", ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", wav]);
  if (!audio.ok) die("ffmpeg could not read audio from this recording");
  console.log("Transcribing…");
  const whisper = await run("whisper-cli", ["-m", model, "-f", wav, "-ovtt", "-of", temporaryBase, "-l", language]);
  if (!whisper.ok) die("whisper could not transcribe this recording");
  await rename(temporaryVtt, output);
  console.log(`Transcript ready: ${output}`);
} catch (error) {
  die(error.message || String(error));
} finally {
  await rm(wav, { force: true }).catch(() => {});
  await rm(temporaryVtt, { force: true }).catch(() => {});
}
