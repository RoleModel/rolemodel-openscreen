#!/usr/bin/env node
/**
 * rm-voice — turn a project's script into narration plus a synced SRT.
 *
 *   rm-voice ridgeline-cable-rail-promo --script opener
 *   rm-voice ridgeline-cable-rail-promo --script opener --voice bm_george --gap 400
 *   rm-voice --voices
 *   rm-voice --setup [--force]     build the local voice environment
 *
 * There is nothing to install by hand. On first use this creates its own Python
 * virtualenv and points hyperframes at it — no system Python, no pip, no
 * environment variable to export.
 *
 * Writes into the project, next to everything else that belongs to it:
 *
 *   media/Audio/<script>.wav        the voice track
 *   media/Audio/<script>.srt        subtitles, exact by construction
 *   media/Audio/<script>.vtt        the same, for a <track> element
 *   media/Audio/.clips/             per-line cache, keyed by voice + text
 *
 * Run from the Studio (Voice panel) or straight from a terminal — it is the
 * same code path either way, and the Studio streams this output into Console.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { defaultRoot, readManifest } from "../lib/library.mjs";
import { DEFAULT_PROVIDER, PROVIDERS, VOICES, concat, hasApiKey, parseScript, srt, synth, vtt } from "../lib/narration.mjs";
import { isReady, setup, venvDir } from "../lib/voice-setup.mjs";

process.stdout.on("error", (e) => {
	if (e.code === "EPIPE") process.exit(0);
	throw e;
});

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	if (i === -1) return d;
	const v = argv[i + 1];
	return v && !v.startsWith("--") ? v : true;
};
const die = (m) => {
	console.error(`rm-voice: ${m}`);
	process.exit(1);
};

/**
 * Setup, on demand or on first use.
 *
 * `pip install kokoro-onnx soundfile` is the documented fix and it fails on a
 * current Mac with PEP 668's externally-managed-environment. Nobody should have
 * to learn that to record a demo, so we build a private venv and point
 * hyperframes at it. See lib/voice-setup.mjs.
 */
async function ensureVoice({ force = false } = {}) {
	if (!force && (await isReady())) return true;
	console.log(force ? "\n  Rebuilding the voice environment\n" : "\n  Setting up voice, once\n");
	const r = await setup({ onLog: (l) => console.log(l), force });
	if (!r.ok) {
		console.error(`\n  Could not set up voice: ${r.reason}`);
		if (r.hint) console.error(`\n  ${r.hint}`);
		console.error("");
		return false;
	}
	console.log(`\n  Ready. ${r.already ? "Already set up." : `Installed into ${venvDir()}`}\n`);
	return true;
}

if (argv.includes("--setup")) {
	const ok = await ensureVoice({ force: argv.includes("--force") });
	process.exit(ok ? 0 : 1);
}

if (argv.includes("--voices")) {
	console.log("\n  Voices (local Kokoro, via hyperframes tts)\n");
	for (const v of VOICES) console.log(`  ${v.id.padEnd(12)} ${v.label}`);
	console.log("\n  Full list:  npx hyperframes tts --list\n");
	process.exit(0);
}

const ROOT = defaultRoot();
const id = argv.find((a) => !a.startsWith("--"));
if (!id) die('which project? e.g. rm-voice ridgeline-cable-rail-promo --script opener');

const projectDir = join(ROOT, id);
const manifest = await readManifest(projectDir).catch(() => null);
if (!manifest) die(`no project "${id}" in ${ROOT}`);

const scriptsDir = join(projectDir, "scripts");
let name = flag("script");
if (typeof name !== "string") {
	// One script in the project is not a choice worth making the user type.
	const found = (await readdir(scriptsDir).catch(() => [])).filter((f) => f.endsWith(".md"));
	if (found.length === 1) name = found[0].replace(/\.md$/, "");
	else if (!found.length) die(`no scripts in ${scriptsDir} — write one in the Studio first`);
	else die(`--script is required. Found: ${found.map((f) => f.replace(/\.md$/, "")).join(", ")}`);
}

const sourceArg = flag("source");
const scriptPath = typeof sourceArg === "string" ? resolve(projectDir, sourceArg) : join(scriptsDir, `${name}.md`);
const sourceRelative = relative(projectDir, scriptPath);
if (typeof sourceArg === "string" && (sourceRelative === "" || sourceRelative === ".." || sourceRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))) {
	die("--source must be a file inside the project");
}
const source = await readFile(scriptPath, "utf8").catch(() => null);
if (source == null) die(`no narration source at ${scriptPath}`);

const lines = parseScript(source);
if (!lines.length) die("that script has no speakable lines — headings and code blocks are skipped");

// Do this before the first line is synthesised, not after 40 of them fail.
if (!(await ensureVoice())) process.exit(1);

const provider = typeof flag("provider") === "string" ? flag("provider") : manifest.voiceProvider || DEFAULT_PROVIDER;
if (!PROVIDERS[provider]) die(`unknown --provider "${provider}". One of: ${Object.keys(PROVIDERS).join(", ")}`);
// Kokoro ids are readable names; ElevenLabs ids are opaque, so there is no sane
// default for one and picking Kokoro's would be silently wrong.
const voice = typeof flag("voice") === "string" ? flag("voice") : manifest.voice || (provider === "kokoro" ? "af_heart" : null);
if (!voice) die("--voice is required for ElevenLabs: the voice_id from your voice library");
if (!(await hasApiKey(provider))) {
	die(`${provider} needs an API key. Set ${PROVIDERS[provider].keyEnv}, or save one in the Studio under Voice.`);
}
const gapMs = Number(flag("gap", 320)) || 320;
const outDir = join(projectDir, "media", "Audio");
await mkdir(outDir, { recursive: true });

console.log(`\n  ${manifest.name}${manifest.client ? ` · ${manifest.client}` : ""}`);
console.log(`  script  ${name}   ·   ${provider}/${voice}   ·   gap  ${gapMs}ms`);
if (!PROVIDERS[provider].local) console.log("  this sends the script text to ElevenLabs");
console.log(`  ${lines.length} lines\n`);

let cachedCount = 0;
const clips = await synth(lines, {
	provider,
	voice,
	clipDir: join(outDir, ".clips"),
	onLine: ({ i, total, text, seconds, cached }) => {
		if (cached) cachedCount++;
		const n = String(i + 1).padStart(String(total).length, " ");
		console.log(`  ${n}/${total}  ${seconds.toFixed(2)}s  ${cached ? "cached " : "spoken "} ${text.slice(0, 78)}`);
	},
}).catch((e) => die(e.message));

const wav = join(outDir, `${name}.wav`);
await concat(clips, { out: wav, gapMs }).catch((e) => die(e.message));

await writeFile(join(outDir, `${name}.srt`), srt(clips, { gapMs }), "utf8");
await writeFile(join(outDir, `${name}.vtt`), vtt(clips, { gapMs }), "utf8");

const total = clips.reduce((n, c) => n + c.seconds, 0) + (gapMs / 1000) * (clips.length - 1);
console.log(`\n  ${total.toFixed(1)}s of narration${cachedCount ? `  (${cachedCount} line${cachedCount === 1 ? "" : "s"} from cache)` : ""}`);
console.log(`  ${wav}`);
console.log(`  ${join(outDir, `${name}.srt`)}`);
console.log(`\n  Feed the SRT to a recast render, or drop the wav on a HyperFrames scene.\n`);
