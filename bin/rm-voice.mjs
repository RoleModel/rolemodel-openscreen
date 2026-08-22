#!/usr/bin/env node
/**
 * rm-voice — turn a project's script into narration plus a synced SRT.
 *
 *   rm-voice feeney-cable-rail-promo --script opener
 *   rm-voice feeney-cable-rail-promo --script opener --voice bm_george --gap 400
 *   rm-voice --voices
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
import { join } from "node:path";
import { defaultRoot, readManifest } from "../lib/library.mjs";
import { VOICES, concat, parseScript, srt, synth, vtt } from "../lib/narration.mjs";

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

if (argv.includes("--voices")) {
	console.log("\n  Voices (local Kokoro, via hyperframes tts)\n");
	for (const v of VOICES) console.log(`  ${v.id.padEnd(12)} ${v.label}`);
	console.log("\n  Full list:  npx hyperframes tts --list\n");
	process.exit(0);
}

const ROOT = defaultRoot();
const id = argv.find((a) => !a.startsWith("--"));
if (!id) die('which project? e.g. rm-voice feeney-cable-rail-promo --script opener');

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

const scriptPath = join(scriptsDir, `${name}.md`);
const source = await readFile(scriptPath, "utf8").catch(() => null);
if (source == null) die(`no script at ${scriptPath}`);

const lines = parseScript(source);
if (!lines.length) die("that script has no speakable lines — headings and code blocks are skipped");

const voice = typeof flag("voice") === "string" ? flag("voice") : manifest.voice || "af_nova";
const gapMs = Number(flag("gap", 320)) || 320;
const outDir = join(projectDir, "media", "Audio");
await mkdir(outDir, { recursive: true });

console.log(`\n  ${manifest.name}${manifest.client ? ` · ${manifest.client}` : ""}`);
console.log(`  script  ${name}   ·   voice  ${voice}   ·   gap  ${gapMs}ms`);
console.log(`  ${lines.length} lines\n`);

let cachedCount = 0;
const clips = await synth(lines, {
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
