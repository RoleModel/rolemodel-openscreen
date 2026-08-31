#!/usr/bin/env node
/**
 * rm-retime-pip — put the words back in step with the clips, in place.
 *
 * A PIP composition is built once and then edited: a clip is trimmed, a
 * speaker is moved, a head is cut off the front of a take. HyperFrames changes
 * the clip's window when that happens and cannot know that a separate timeline
 * of words was computed from the old one — so the words carry on firing where
 * they used to, and a speaker's caption runs seconds ahead of their mouth.
 *
 * Rebuilding fixes it and costs everything else: the images added by hand, the
 * cards, the tuned geometry. So this rewrites only the words. It reads the clip
 * windows the file actually has now, recomputes the phrases against them with
 * the same code the builder uses, and swaps out the say blocks and their tweens.
 * Every other element and every other tween is left exactly as it was.
 *
 *   rm-retime-pip <projectId> [folder]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultRoot } from "../lib/library.mjs";
import { durationOf } from "../lib/narration.mjs";
import { sayTrack } from "../lib/make-pip.mjs";

const [projectId, folder = "canvas-pip-transcript"] = process.argv.slice(2);
if (!projectId) {
	console.error("usage: rm-retime-pip <projectId> [folder]");
	process.exit(1);
}
const projectDir = join(defaultRoot(), projectId);
const file = join(projectDir, "media", "Renders", folder, "index.html");
const html = await readFile(file, "utf8").catch(() => null);
if (html === null) {
	console.error(`rm-retime-pip: no composition at ${file}`);
	process.exit(1);
}

/*
 * The clips, as the file has them now.
 *
 * Attribute order is whatever last wrote the tag — the builder writes one
 * order, the HyperFrames editor another — so each attribute is read on its own
 * rather than matched as a sequence.
 */
const attr = (tag, name) => {
	const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
	return m ? m[1] : null;
};
const clips = [];
for (const [tag] of html.matchAll(/<video\b[^>]*\bclass="[^"]*\bpip\b[^"]*"[^>]*>/g)) {
	const src = attr(tag, "src");
	if (!src) continue;
	clips.push({
		id: attr(tag, "id"),
		src: src.replace(/^source\//, ""),
		start: Number(attr(tag, "data-start")) || 0,
		dur: Number(attr(tag, "data-duration")) || 0,
		ms: Number(attr(tag, "data-media-start")) || 0,
	});
}
if (!clips.length) {
	console.error("rm-retime-pip: that composition has no pip clips to read");
	process.exit(1);
}

/*
 * The speaker's name belongs to the cut, not to the transcript, so it is read
 * back off the block being replaced rather than guessed at again.
 *
 * Matched on the class alone. The editor puts its own id first — `<div
 * data-hf-id="hf-8pj8" class="say__who">` — so a pattern anchored to `<div
 * class=` finds nothing, and finding nothing here means writing six empty
 * names over six correct ones. Hence the refusal below rather than a default.
 */
const names = [...html.matchAll(/class="say__who"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
if (names.length !== clips.length) {
	console.error(`rm-retime-pip: found ${names.length} speaker names for ${clips.length} clips — not touching it`);
	process.exit(1);
}
clips.sort((a, b) => a.start - b.start).forEach((clip, i) => {
	clip.speaker = names[i] ?? "";
});

console.log(`  ${clips.length} clips in ${folder}`);
for (const clip of clips) {
	const media = await durationOf(join(projectDir, "media", clip.src)).catch(() => 0);
	const over = clip.ms + clip.dur - media;
	const note = media > 0 && over > 0.05 ? `  OVER-RUNS its file by ${over.toFixed(2)}s` : "";
	console.log(`    ${clip.src.split("/").pop().padEnd(22)} ${clip.start.toFixed(2)}–${(clip.start + clip.dur).toFixed(2)}  from ${clip.ms.toFixed(2)}${note}`);
}
/* Said, not fixed: a gap or an overlap is an editing decision somebody made in
   HyperFrames, and this command's business is the words. */
for (const [a, b] of clips.slice(0, -1).map((c, i) => [c, clips[i + 1]])) {
	const seam = b.start - (a.start + a.dur);
	if (Math.abs(seam) > 0.05) {
		console.log(`    ${seam > 0 ? "gap" : "overlap"} of ${Math.abs(seam).toFixed(2)}s before ${b.src.split("/").pop()}`);
	}
}

const { lines, tweens, words } = await sayTrack({ projectDir, clips });

/*
 * Out with the old words, in with the new — and nothing else.
 *
 * The say blocks are matched by id so an element that merely sits between two
 * of them survives, and the tween block keeps every line that is not about a
 * phrase, a word or a say block: an image the editor positioned has tweens of
 * its own in there, and losing them would be the same class of damage this
 * command exists to avoid.
 */
let out = html;

/*
 * The say blocks, found by walking rather than by matching.
 *
 * A regex could find them when this file was only ever written by the builder.
 * The HyperFrames editor rewrites the document — it pretty-prints, it stamps
 * every element with a data-hf-id, it reorders attributes — and a block that
 * used to be one line is now nine with three nested divs. So the opening tag is
 * found by its id and the end by counting divs, which survives any of that.
 */
const blockAt = (text, from) => {
	const open = text.lastIndexOf("<div", from);
	let depth = 0;
	const tag = /<\/?div\b[^>]*>/g;
	tag.lastIndex = open;
	for (let m = tag.exec(text); m; m = tag.exec(text)) {
		depth += m[0].startsWith("</") ? -1 : 1;
		if (depth === 0) return [open, m.index + m[0].length];
	}
	return null;
};

const spans = [];
for (const m of out.matchAll(/\bid="say-\d+"/g)) {
	const span = blockAt(out, m.index);
	if (span) spans.push(span);
}
if (spans.length !== clips.length) {
	console.error(`rm-retime-pip: found ${spans.length} word blocks for ${clips.length} clips — not touching it`);
	process.exit(1);
}
/* Back to front, so replacing one does not move the next. */
for (let i = spans.length - 1; i >= 0; i -= 1) {
	const [open, close] = spans[i];
	out = out.slice(0, open) + lines[i].trimStart() + out.slice(close);
}

const mine = /^\s*tl\.(set|to)\('#(?:g\d+-\d+|w\d+|say-\d+-in)'.*$/;
out = out.replace(/(var tl = gsap\.timeline\(\{ paused: true \}\);\n)([\s\S]*?)(\n\s*window\.__timelines)/, (_all, head, body, tail) => {
	const kept = body.split("\n").filter((line) => line.trim() && !mine.test(line));
	return head + [...kept, ...tweens].join("\n") + tail;
});

await writeFile(`${file}.before-retime`, html, "utf8");
await writeFile(file, out, "utf8");
console.log("");
console.log(`  ${words} words re-timed against the clips as they are now`);
console.log(`  previous file kept as ${folder}/index.html.before-retime`);
