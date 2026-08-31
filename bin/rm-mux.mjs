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
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
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

/*
 * Whether this ffmpeg can draw subtitles at all — one call, cached, because the
 * answer cannot change mid-run and the failure it prevents is otherwise read as
 * a quoting problem.
 */
let subtitlesFilter = null;
const hasSubtitlesFilter = async () => {
	if (subtitlesFilter === null) {
		subtitlesFilter = await new Promise((done) => {
			const child = spawn("ffmpeg", ["-hide_banner", "-filters"], { stdio: ["ignore", "pipe", "ignore"] });
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.on("close", () => done(/^\s*\S+\s+subtitles\s/m.test(out)));
			child.on("error", () => done(false));
		});
	}
	return subtitlesFilter;
};
/** Set when the captions could not be burned, so they ride along as a track. */
let softSubs = null;

// Build one filter chain. Order matters: stretch and pad the picture first, then
// burn subtitles onto the final timeline — burning before the stretch would
// stretch the subtitles along with the picture and desync them from the words.
const vf = [];
if (stretch !== 1) vf.push(`setpts=${stretch.toFixed(6)}*PTS`);
if (holdFor > 0.02) vf.push(`tpad=stop_mode=clone:stop_duration=${holdFor.toFixed(3)}`);
if (typeof srt === "string") {
	/*
	 * Burning captions needs an ffmpeg built with libass, and plenty are not.
	 *
	 * Homebrew's ffmpeg 9 ships without it. What that looks like from here is
	 * three different errors depending on how the argument is shaped — `No option
	 * name near /Users/…`, an unparseable filterchain, and finally `No such
	 * filter: subtitles` — none of which mention libass, and the first two point
	 * straight at the path and waste your time on quoting. So the filter is
	 * checked for before it is used, and its absence is reported as the missing
	 * build option it is.
	 *
	 * The two shaping fixes stay, because both are real independent of libass.
	 * The file is copied to a temp path this code names, so a library under
	 * `~/RoleModel Library` — a space, in the default path — never reaches a
	 * filtergraph that would split on it. And `filename=` is spelled out: ffmpeg
	 * lets a filter's first option go by position, but not once a later one is
	 * given by name, and this always names `force_style`.
	 */
	const plain = join(await mkdtemp(join(tmpdir(), "rm-mux-")), "subs.srt");
	await copyFile(srt, plain);
	const style = [
		"FontName=Inter", "FontSize=18", "PrimaryColour=&H00FFFFFF", "OutlineColour=&H99000000",
		"BorderStyle=3", "Outline=2", "Shadow=0", "MarginV=42",
	].join("\\,");
	if (await hasSubtitlesFilter()) vf.push(`subtitles=filename=${plain}:force_style=${style}`);
	else {
		softSubs = srt;
		console.log("\n  This ffmpeg has no `subtitles` filter, so the captions are not burned in.");
		console.log("  They are attached as a track instead — most players need them switched on.");
		console.log("  To burn them, install an ffmpeg built with libass.");
	}
}
vf.push("format=yuv420p");

const af = padAudio > 0.02 ? `apad=pad_dur=${padAudio.toFixed(3)}` : "anull";

/*
 * MP4s from Apple software carry an `elst` edit list, and the mov demuxer cannot
 * always find a keyframe before the timestamp it shifts to:
 *
 *   st: 0 edit list: 1 Missing key frame while searching for timestamp: 1001
 *   st: 0 edit list 1 Cannot find an index entry before timestamp: 1001.
 *
 * ffmpeg keeps going, which is why this reads as noise — but the frames it
 * returns are NOT the frames that were asked for. Measured on a real capture,
 * seeking to 1s with and without this flag produced two different frames.
 *
 * A demuxer option, so it goes before the `-i` it applies to.
 */
const args = [
	"-y",
	"-ignore_editlist", "1",
	"-i", video,
	"-i", audio,
	/* Only when they could not be burned — see the note above. A third input,
	   so it is a track in the file rather than pixels in the picture. */
	...(softSubs ? ["-i", softSubs] : []),
	"-filter_complex", `[0:v]${vf.join(",")}[v];[1:a]${af}[a]`,
	"-map", "[v]",
	"-map", "[a]",
	...(softSubs ? ["-map", "2:s", "-c:s", "mov_text"] : []),
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
/* Say which of the two happened, rather than always claiming the better one. */
console.log(`  ${finalLen.toFixed(2)}s  ·  narration + ${typeof srt === "string" ? (softSubs ? "subtitles as a track" : "burned subtitles") : "no subtitles"}\n`);
