/**
 * Narration — a markdown script becomes a voice track and a perfectly synced SRT.
 *
 * The obvious pipeline is: synthesise the whole script, then run the resulting
 * audio back through Whisper to get subtitle timings. Don't. You already know
 * the words — sending them through speech recognition to get them back is a
 * lossy round trip that mis-hears product names ("Feeney" becomes "Phoenix",
 * "LightningCAD" becomes "lightning CAD") and costs a transcription pass.
 *
 * So this synthesises **one clip per line**, measures each clip, and writes the
 * SRT from durations it already knows. The timings are exact by construction,
 * the text is exactly what you wrote, and re-rendering after a copy change only
 * re-synthesises the lines that changed.
 *
 * Voices are Kokoro, run locally through `hyperframes tts` — no API key, no
 * per-character billing, and nothing about an unreleased client product leaves
 * the machine. That last point is the one that matters for client work.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseScript } from "./script-parse.mjs";

/** Voices worth knowing. `hyperframes tts --list` has the rest. */
export const VOICES = [
	{ id: "af_nova", label: "Nova — female, US, warm" },
	{ id: "af_bella", label: "Bella — female, US, bright" },
	{ id: "af_sarah", label: "Sarah — female, US, even" },
	{ id: "am_adam", label: "Adam — male, US, low" },
	{ id: "am_michael", label: "Michael — male, US, even" },
	{ id: "bf_emma", label: "Emma — female, UK" },
	{ id: "bm_george", label: "George — male, UK" },
];

export { parseScript, estimateSeconds } from "./script-parse.mjs";

export function capture(cmd, args, opts = {}) {
	return new Promise((res) => {
		const child = spawn(cmd, args, opts);
		let out = "";
		let err = "";
		child.stdout?.on("data", (d) => (out += d));
		child.stderr?.on("data", (d) => (err += d));
		child.on("error", (e) => res({ ok: false, out: "", err: String(e) }));
		child.on("close", (code) => res({ ok: code === 0, code, out, err }));
	});
}

export async function durationOf(file) {
	const { ok, out } = await capture("ffprobe", [
		"-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", file,
	]);
	const n = ok ? Number(out.trim()) : NaN;
	return Number.isFinite(n) ? n : 0;
}

const key = (text, voice) => createHash("sha1").update(`${voice}::${text}`).digest("hex").slice(0, 12);

/**
 * Synthesise one clip per line, caching on (voice, text).
 *
 * The cache is why this is usable: a script edit re-synthesises only the lines
 * that actually changed, so fixing a typo in line 12 of a 40-line script takes
 * a second rather than a minute.
 */
export async function synth(lines, { voice = "af_nova", clipDir, onLine } = {}) {
	await mkdir(clipDir, { recursive: true });
	const clips = [];
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		const file = join(clipDir, `${String(i + 1).padStart(3, "0")}-${key(text, voice)}.wav`);
		let seconds = await durationOf(file);
		let cached = seconds > 0;
		if (!cached) {
			const r = await capture("npx", ["--yes", "hyperframes", "tts", text, "--voice", voice, "--output", file]);
			if (!r.ok) throw new Error(`tts failed on line ${i + 1}: ${r.err.trim() || r.out.trim()}`);
			seconds = await durationOf(file);
			if (!seconds) throw new Error(`tts produced no audio for line ${i + 1}`);
		}
		clips.push({ i, text, file, seconds });
		onLine?.({ i, total: lines.length, text, seconds, cached });
	}
	return clips;
}

/**
 * Concatenate clips with a gap between them.
 *
 * The gap is the whole difference between "a machine reading a list" and
 * narration. ffmpeg's concat demuxer cannot insert silence, so silence is
 * generated as real clips and interleaved.
 */
export async function concat(clips, { out, gapMs = 320, sampleRate = 24000 } = {}) {
	const gapSec = gapMs / 1000;
	const listFile = `${out}.txt`;
	const silence = `${out}.gap.wav`;

	if (gapSec > 0) {
		const r = await capture("ffmpeg", [
			"-y", "-f", "lavfi", "-i", `anullsrc=r=${sampleRate}:cl=mono`,
			"-t", String(gapSec), "-c:a", "pcm_s16le", silence,
		]);
		if (!r.ok) throw new Error(`could not generate the gap: ${r.err.slice(-400)}`);
	}

	const parts = [];
	clips.forEach((c, n) => {
		parts.push(c.file);
		if (gapSec > 0 && n < clips.length - 1) parts.push(silence);
	});
	await writeFile(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");

	// Re-encode rather than -c copy: the clips and the silence can disagree on
	// sample rate, and a stream copy would splice them into a track that plays
	// at the wrong speed after the first join.
	const r = await capture("ffmpeg", [
		"-y", "-f", "concat", "-safe", "0", "-i", listFile,
		"-ar", String(sampleRate), "-ac", "1", "-c:a", "pcm_s16le", out,
	]);
	if (!r.ok) throw new Error(`concat failed: ${r.err.slice(-400)}`);
	return out;
}

const stamp = (sec) => {
	const ms = Math.max(0, Math.round(sec * 1000));
	const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
	const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
	const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
	return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
};

/** SRT from durations we measured, not from guessing at our own audio. */
export function srt(clips, { gapMs = 320 } = {}) {
	const gap = gapMs / 1000;
	let t = 0;
	return `${clips
		.map((c, i) => {
			const start = t;
			const end = t + c.seconds;
			t = end + gap;
			return `${i + 1}\n${stamp(start)} --> ${stamp(end)}\n${c.text}\n`;
		})
		.join("\n")}\n`;
}

/** WebVTT, for anything that wants a <track> rather than a burn-in. */
export function vtt(clips, { gapMs = 320 } = {}) {
	return `WEBVTT\n\n${srt(clips, { gapMs }).replace(/,/g, ".")}`;
}

export async function scriptFrom(path) {
	return parseScript(await readFile(path, "utf8"));
}
