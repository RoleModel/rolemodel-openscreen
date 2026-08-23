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
 * Voices are Kokoro by default, run locally through `hyperframes tts` — no API
 * key, no per-character billing, and nothing about an unreleased client product
 * leaves the machine. That last point is the one that matters for client work,
 * which is why it stays the default rather than merely being available.
 *
 * ElevenLabs is opt-in, for when a client has asked for a particular commercial
 * voice. Choosing it sends the script text to a third party; only the speak step
 * differs, so the measured-not-estimated SRT holds either way.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseScript } from "./script-parse.mjs";
import { ttsEnv } from "./voice-setup.mjs";

/**
 * Fallback voice list, used only when `hyperframes tts --list --json` cannot be
 * reached. The Studio asks Kokoro directly (see /api/voices) rather than trusting
 * this, because a hardcoded list drifts: the previous one offered `af_bella` and
 * `af_sarah`, which Kokoro has never shipped — picking either failed with "that
 * voice id is not recognised", an error this very file has a handler for. It also
 * hid every non-English voice.
 *
 * Every id below is one `hyperframes tts --list` actually returns.
 */
export const VOICES = [
	{ id: "af_heart", label: "Heart — female, US (Kokoro default)" },
	{ id: "af_nova", label: "Nova — female, US" },
	{ id: "af_sky", label: "Sky — female, US" },
	{ id: "am_adam", label: "Adam — male, US" },
	{ id: "am_michael", label: "Michael — male, US" },
	{ id: "bf_emma", label: "Emma — female, UK" },
	{ id: "bf_isabella", label: "Isabella — female, UK" },
	{ id: "bm_george", label: "George — male, UK" },
	{ id: "ef_dora", label: "Dora — female, Spanish" },
	{ id: "ff_siwis", label: "Siwis — female, French" },
	{ id: "jf_alpha", label: "Alpha — female, Japanese" },
	{ id: "zf_xiaobei", label: "Xiaobei — female, Chinese" },
];

/**
 * Where the voice comes from.
 *
 * Kokoro is the default and stays the default: it runs on this machine, needs no
 * key, costs nothing per character, and nothing about an unreleased client
 * product leaves the building. ElevenLabs is opt-in for the cases where a client
 * has asked for a specific commercial voice, and choosing it means the script
 * text is sent to a third party. The UI says so at the point of choosing rather
 * than burying it here.
 *
 * Only the speak step is per-provider. Measuring each clip and caching it stays
 * shared, because that is what makes the SRT exact by construction — a provider
 * that skipped it would quietly reintroduce the drift this whole file exists to
 * avoid.
 */
export const PROVIDERS = {
	kokoro: {
		label: "Kokoro — local",
		local: true,
		ext: "wav",
	},
	elevenlabs: {
		label: "ElevenLabs — cloud",
		local: false,
		ext: "mp3",
		keyEnv: "ELEVENLABS_API_KEY",
		keyField: "elevenlabsApiKey",
	},
};

export const DEFAULT_PROVIDER = "kokoro";

/**
 * Why a key is not usable, or null if it looks right.
 *
 * The ElevenLabs dashboard shows a key *id* beside the key, and they are easy to
 * confuse: both are long hex strings, and only the key starts with `sk_`. Pasting
 * the id gets a 400 whose meaning is buried in a response body — checking the
 * shape here turns that into an answer before anything is stored.
 */
export function keyProblem(provider, value) {
	const v = String(value ?? "").trim();
	if (!v) return "the key is empty";
	if (provider === "elevenlabs" && !v.startsWith("sk_")) {
		return "that looks like the key *id*, not the key. ElevenLabs keys start with `sk_` and are shown only when the key is created or rotated — create or rotate one and copy that value.";
	}
	return null;
}

/** Where an opt-in API key is kept. Beside the venv, outside the repo. */
export const CONFIG_FILE = join(homedir(), ".rolemodel-video", "config.json");

const readConfig = async () => {
	try {
		return JSON.parse(await readFile(CONFIG_FILE, "utf8"));
	} catch {
		return {};
	}
};

/**
 * The key for a provider, or null. Environment first so CI never needs the file.
 *
 * Never logged, never returned to the browser, never put in an argv — it goes
 * into a request header and nowhere else. `hasApiKey` is what the UI asks.
 */
export async function apiKeyFor(provider) {
	const cfg = PROVIDERS[provider];
	if (!cfg?.keyEnv) return null;
	const fromEnv = process.env[cfg.keyEnv];
	if (fromEnv?.trim()) return fromEnv.trim();
	const stored = (await readConfig())[cfg.keyField];
	return stored?.trim() ? stored.trim() : null;
}

/** Whether a provider is usable right now, without revealing the key. */
export async function hasApiKey(provider) {
	if (PROVIDERS[provider]?.local) return true;
	return Boolean(await apiKeyFor(provider));
}

/** Store a key for later runs. Written 0600 — it is a credential. */
export async function setApiKey(provider, value) {
	const cfg = PROVIDERS[provider];
	if (!cfg?.keyField) throw new Error(`${provider} takes no API key`);
	const problem = keyProblem(provider, value);
	if (problem) throw new Error(problem);
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	const next = { ...(await readConfig()), [cfg.keyField]: String(value).trim() };
	await writeFile(CONFIG_FILE, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
	return CONFIG_FILE;
}

/**
 * Turn an ElevenLabs error response into one useful sentence.
 *
 * Shared by both calls because the first version was not: `elevenLabsVoices`
 * threw `ElevenLabs returned 400` without reading the body, so the one thing
 * that explained the failure — their own `detail.message` — was discarded.
 *
 * Their auth failures arrive as **400**, not 401, with `detail.type` set to
 * `authentication_error`. Keying off the HTTP status alone reports a bad key as
 * a generic bad request, which is what sent this in the wrong direction. Read
 * the body and trust `detail.type` over the status code.
 */
async function explainElevenLabs(res, voice) {
	let detail = null;
	try {
		detail = (await res.json())?.detail ?? null;
	} catch {
		detail = null;
	}
	const message = typeof detail === "string" ? detail : detail?.message;
	const kind = typeof detail === "object" ? detail?.type : null;

	if (kind === "authentication_error" || res.status === 401) {
		// Their message names the exact mistake — pasting the key *id* instead of
		// the key — far better than anything invented here.
		return message ? `ElevenLabs rejected the key: ${message}` : "ElevenLabs rejected the API key";
	}
	if (res.status === 404) return `ElevenLabs has no voice "${voice}" — check the voice_id`;
	if (res.status === 429) return "ElevenLabs rate limit or quota reached";
	return `ElevenLabs returned ${res.status}${message ? `: ${message}` : ""}`;
}

/**
 * One line of ElevenLabs speech, written to `file`.
 *
 * mp3 rather than pcm because it is the default and the smallest thing to cache;
 * concat() re-encodes every clip to 24k mono pcm anyway, so the wire format never
 * reaches the finished track. Duration still comes from ffprobe, exactly as it
 * does for Kokoro — the SRT is measured, not estimated, whichever provider ran.
 */
async function speakElevenLabs(text, voice, file, apiKey) {
	if (!apiKey) throw new Error("no ElevenLabs API key — set ELEVENLABS_API_KEY or save one under Voice");
	if (!voice) throw new Error("ElevenLabs needs a voice_id — the 20-character id from your voice library, not its name");

	let res;
	try {
		res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
			method: "POST",
			headers: { "xi-api-key": apiKey, "content-type": "application/json" },
			body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
		});
	} catch (e) {
		throw new Error(`could not reach ElevenLabs: ${e.message ?? e}`);
	}

	if (!res.ok) throw new Error(await explainElevenLabs(res, voice));

	const bytes = Buffer.from(await res.arrayBuffer());
	if (!bytes.length) throw new Error("ElevenLabs returned no audio");
	await writeFile(file, bytes);
}

/** The voices an ElevenLabs account can use. Ids, not names — theirs are opaque. */
export async function elevenLabsVoices(apiKey) {
	const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey } });
	if (!res.ok) throw new Error(await explainElevenLabs(res, null));
	const body = await res.json();
	return (body?.voices ?? [])
		.filter((v) => v?.voice_id)
		.map((v) => ({
			id: String(v.voice_id),
			label: [v.name, v.labels?.gender, v.labels?.accent].filter(Boolean).join(" · "),
		}));
}

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

const key = (text, voice, provider) => createHash("sha1").update(`${provider}::${voice}::${text}`).digest("hex").slice(0, 12);

/**
 * Turn a failed `hyperframes tts` run into one useful sentence.
 *
 * The raw output is npm deprecation warnings, a telemetry notice, ANSI escapes
 * and spinner frames, with the actual reason buried somewhere in the middle.
 * Printing all of it hides the answer — the first version of this reported a
 * network outage as three lines about a deprecated `boolean` package.
 */
export function explainTtsFailure({ out = "", err = "" }) {
	const noise = /^(npm warn|npm notice|npm ERR! code)/;
	const clean = `${out}\n${err}`
		// Strip ANSI/CSI sequences and the box-drawing spinner frames they redraw.
		.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, " ")
		.replace(/[\u2500-\u25FF\u2800-\u28FF]/g, " ")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !noise.test(l))
		.join(" ");

	if (/EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(clean)) {
		return "could not download the voice data. The first run fetches about 27MB from GitHub, so it needs a network connection — everything after that is offline.";
	}
	if (/kokoro[-_]onnx|soundfile/i.test(clean) && /not installed|No module/i.test(clean)) {
		return "the voice environment is incomplete. Rebuild it with: rm-voice --setup --force";
	}
	if (/voice/i.test(clean) && /not found|unknown/i.test(clean)) {
		return "that voice id is not recognised. `rm-voice --voices` lists the ones we use.";
	}
	const m = clean.match(/(?:failed|error)[:\s]+(.{0,220})/i);
	return (m ? m[1] : clean.slice(-220)).trim() || "hyperframes tts failed with no output";
}


/**
 * Synthesise one clip per line, caching on (voice, text).
 *
 * The cache is why this is usable: a script edit re-synthesises only the lines
 * that actually changed, so fixing a typo in line 12 of a 40-line script takes
 * a second rather than a minute.
 */
export async function synth(lines, { provider = DEFAULT_PROVIDER, voice, clipDir, onLine } = {}) {
	const cfg = PROVIDERS[provider];
	if (!cfg) throw new Error(`unknown voice provider "${provider}"`);
	const voiceId = voice ?? (provider === "kokoro" ? "af_heart" : null);
	await mkdir(clipDir, { recursive: true });

	// Point hyperframes at our private venv on the child process, so nobody has
	// to export HYPERFRAMES_PYTHON or install into system Python. See voice-setup.mjs.
	const env = { ...process.env, ...(await ttsEnv()) };
	// Resolved once, not per line: a key lookup reads a file, and forty lines
	// should not mean forty reads.
	const apiKey = cfg.local ? null : await apiKeyFor(provider);

	const clips = [];
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		const file = join(clipDir, `${String(i + 1).padStart(3, "0")}-${key(text, voiceId, provider)}.${cfg.ext}`);
		let seconds = await durationOf(file);
		let cached = seconds > 0;
		if (!cached) {
			// Only this step is per-provider. Measuring and caching stay shared, so
			// the SRT is built from real durations no matter who spoke the words.
			if (provider === "elevenlabs") {
				try {
					await speakElevenLabs(text, voiceId, file, apiKey);
				} catch (e) {
					throw new Error(`line ${i + 1}: ${e.message ?? e}`);
				}
			} else {
				const r = await capture("npx", ["--yes", "hyperframes", "tts", text, "--voice", voiceId, "--output", file], { env });
				if (!r.ok) throw new Error(`line ${i + 1}: ${explainTtsFailure(r)}`);
			}
			seconds = await durationOf(file);
			if (!seconds) throw new Error(`${provider} produced no audio for line ${i + 1}`);
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

	// ffmpeg's scratch: the concat list and the generated silence. They were
	// being left in media/Audio beside the narration, where the library indexer
	// picks `.gap.wav` up as an audio asset and offers it to you as if it were
	// something you made.
	await Promise.all([rm(listFile, { force: true }), rm(silence, { force: true })]);
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
