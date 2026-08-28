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
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
const temporaryWts = `${temporaryBase}.wts`;
const temporaryWords = `${temporaryBase}.words.json`;
const wordsOutput = output.toLowerCase().endsWith(".vtt")
  ? `${output.slice(0, -4)}.words.json`
  : `${output}.words.json`;
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

/*
 * whisper.cpp's `-owts` emits an ffmpeg drawtext filter for each word.  The
 * text before the `|` is the active word and `between(t, start, end)` is its
 * actual recognition window.  Keep that small, machine-readable sidecar next
 * to the VTT so Studio does not have to guess word boundaries by splitting a
 * whole caption evenly.
 */
function wordTimingsFromWts(raw) {
  const words = [];
  for (const line of String(raw ?? "").split("\n")) {
    const match = line.match(/text='((?:\\.|[^'])*)':enable='between\(t,([0-9.]+),([0-9.]+)\)'/);
    if (!match || !match[1].includes("|")) continue;
    const text = match[1].split("|", 1)[0]
      .replace(/\\(.)/g, "$1")
      .replace(/^(?:>\s*|\.\.\.\s*)+/, "")
      .trim();
    const startSec = Number(match[2]);
    const endSec = Number(match[3]);
    if (!text || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) continue;
    words.push({ text, startSec, endSec });
  }
  return words;
}

try {
  await mkdir(dir, { recursive: true });
  await ensureModel();
  console.log("Preparing audio…");
  const audio = await run("ffmpeg", ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", wav]);
  if (!audio.ok) die("ffmpeg could not read audio from this recording");
  console.log("Transcribing…");
  const whisper = await run("whisper-cli", ["-m", model, "-f", wav, "-ovtt", "-owts", "-of", temporaryBase, "-l", language]);
  if (!whisper.ok) die("whisper could not transcribe this recording");
  const wordTimings = wordTimingsFromWts(await readFile(temporaryWts, "utf8").catch(() => ""));
  if (wordTimings.length) {
    await writeFile(temporaryWords, `${JSON.stringify({ version: 1, timing: "word", words: wordTimings }, null, 2)}\n`, "utf8");
  }
  await rename(temporaryVtt, output);
  if (wordTimings.length) {
    await rename(temporaryWords, wordsOutput);
    console.log(`Transcript ready with ${wordTimings.length} timed words: ${output}`);
  } else {
    // Never leave an old word map beside a newer VTT: inaccurate timing is
    // worse than the explicit caption-level fallback in the editor.
    await rm(wordsOutput, { force: true });
    console.log(`Transcript ready with caption timing: ${output}`);
  }
} catch (error) {
  die(error.message || String(error));
} finally {
  await rm(wav, { force: true }).catch(() => {});
  await rm(temporaryVtt, { force: true }).catch(() => {});
  await rm(temporaryWts, { force: true }).catch(() => {});
  await rm(temporaryWords, { force: true }).catch(() => {});
}
