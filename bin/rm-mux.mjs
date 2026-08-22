#!/usr/bin/env node
/**
 * rm-mux — put the narration onto the render, and make the two agree on length.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 *
 * A recast render and a narration track are authored on different clocks.
 * recast compresses idle time — a five-second interaction becomes 3.8 seconds of
 * video — while the narration is however long it takes to say the words, which
 * was 22 seconds for the same demo. Burn the SRT into the short video and you
 * get cue 1 held on screen for the whole clip and cues 2-7 never shown at all.
 * It looks like it worked. It didn't.
 *
 * So the two clocks have to be reconciled deliberately, and the choice depends
 * on how far apart they are:
 *
 *   within 25%   pad the shorter one. Nobody notices.
 *   narration longer  slow the video to fit, up to --max-stretch. Past that,
 *                stretching turns a demo into a slideshow, so it stretches as
 *                far as it will go and holds the last frame for the remainder —
 *                and tells you, because the real fix is a shorter script or a
 *                longer demo.
 *   video longer pad the narration with silence and leave the picture alone.
 *
 *   rm-mux --video demo.mp4 --audio narration.wav --srt narration.srt -o final.mp4
 */
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { capture, durationOf } from "../lib/narration.mjs";

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
	console.error(`rm-mux: ${m}`);
	process.exit(1);
};

const video = flag("video");
const audio = flag("audio");
const srt = flag("srt", null);
const maxStretch = Number(flag("max-stretch", 2.5));
if (typeof video !== "string" || typeof audio !== "string") {
	die("need --video and --audio (and optionally --srt)");
}
for (const f of [video, audio, ...(typeof srt === "string" ? [srt] : [])]) {
	if (!(await stat(f).then(() => true).catch(() => false))) die(`no such file: ${f}`);
}

const out =
	argv.includes("-o") ? argv[argv.indexOf("-o") + 1]
	: join(dirname(video), basename(video).replace(/\.mp4$/i, "") + "-narrated.mp4");

const vLen = await durationOf(video);
const aLen = await durationOf(audio);
if (!vLen || !aLen) die("could not read a duration — is ffprobe on PATH?");

const ratio = aLen / vLen;
let stretch = 1;
let holdFor = 0;
let padAudio = 0;
let verdict;

if (ratio > 1.25) {
	stretch = Math.min(ratio, maxStretch);
	const stretched = vLen * stretch;
	holdFor = Math.max(0, aLen - stretched);
	verdict =
		holdFor > 0.4
			? `narration is ${ratio.toFixed(1)}x the video — slowed ${stretch.toFixed(2)}x and holding the last frame for ${holdFor.toFixed(1)}s`
			: `narration is longer — slowed the video ${stretch.toFixed(2)}x to fit`;
} else if (ratio < 0.8) {
	padAudio = vLen - aLen;
	verdict = `video is longer — padded the narration with ${padAudio.toFixed(1)}s of silence`;
} else {
	holdFor = Math.max(0, aLen - vLen);
	padAudio = Math.max(0, vLen - aLen);
	verdict = "within 25% — padded the shorter one";
}

const target = Math.max(aLen, vLen * stretch + holdFor);

console.log(`\n  video       ${vLen.toFixed(2)}s   ${basename(video)}`);
console.log(`  narration   ${aLen.toFixed(2)}s   ${basename(audio)}`);
console.log(`  ${verdict}`);
if (holdFor > 2) {
	console.log(`\n  Worth knowing: ${holdFor.toFixed(0)}s of this is a frozen frame.`);
	console.log(`  A shorter script, or a demo with more in it, beats a longer hold.`);
}

// Build one filter chain. Order matters: stretch and pad the picture first, then
// burn subtitles onto the final timeline — burning before the stretch would
// stretch the subtitles along with the picture and desync them from the words.
const vf = [];
if (stretch !== 1) vf.push(`setpts=${stretch.toFixed(6)}*PTS`);
if (holdFor > 0.02) vf.push(`tpad=stop_mode=clone:stop_duration=${holdFor.toFixed(3)}`);
if (typeof srt === "string") {
	// The filter parser treats : and ' as syntax; a Windows-ish or spaced path
	// has to survive that.
	const safe = srt.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
	vf.push(
		`subtitles='${safe}':force_style='FontName=Inter,FontSize=18,PrimaryColour=&H00FFFFFF,` +
			`OutlineColour=&H99000000,BorderStyle=3,Outline=2,Shadow=0,MarginV=42'`,
	);
}
vf.push("format=yuv420p");

const af = padAudio > 0.02 ? `apad=pad_dur=${padAudio.toFixed(3)}` : "anull";

const args = [
	"-y",
	"-i", video,
	"-i", audio,
	"-filter_complex", `[0:v]${vf.join(",")}[v];[1:a]${af}[a]`,
	"-map", "[v]",
	"-map", "[a]",
	"-t", target.toFixed(3),
	"-c:v", "libx264", "-crf", "20", "-preset", "medium",
	"-c:a", "aac", "-b:a", "160k",
	"-movflags", "+faststart",
	out,
];

console.log(`\n  muxing -> ${out}`);
const r = await capture("ffmpeg", args);
if (!r.ok) {
	console.error(r.err.slice(-1600));
	die("ffmpeg failed — see above");
}

const finalLen = await durationOf(out);
console.log(`  ${finalLen.toFixed(2)}s  ·  narration + burned subtitles\n`);
