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
import { readComposition } from "../lib/adopt.mjs";
import { durationOf } from "../lib/narration.mjs";
import { PHRASE_FADE, PIP_FADE, TIMELINE_LOOPS, WORD_DIM, WORD_FILL, sayTrack } from "../lib/make-pip.mjs";

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
 * The clips, as the file has them now — read by the one reader there is.
 *
 * This used to hold its own copy of the pip-tag pattern and its own attribute
 * reader, byte-similar to adopt.mjs's. Two readers of one contract is the
 * copy-and-drift this codebase argues against everywhere else: change how a pip
 * is written and a retime would keep reading it the old way, quietly.
 */
const clips = readComposition(html);
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
/* The names may be in mounted files rather than in index.html, so read across
   everything this composition is made of. */
const dir = join(projectDir, "media", "Renders", folder);
const mountedSrcs = [...html.matchAll(/data-composition-src="([^"]+)"/g)].map((m) => m[1]);
const mountedText = [];
for (const src of mountedSrcs) {
	const text = await readFile(join(dir, src), "utf8").catch(() => null);
	if (text === null) {
		console.error(`rm-retime-pip: this composition mounts ${src}, which is not there — not touching it`);
		process.exit(1);
	}
	mountedText.push({ src, text });
}
const names = [...`${html}${mountedText.map((m) => m.text).join("")}`.matchAll(/class="say__who"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
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

const { lines, phrases, wordCues, outs, pips, words } = await sayTrack({ projectDir, clips });

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

/*
 * The say blocks may not be in this file.
 *
 * A composition can keep each speaker's transcript in its own file under
 * compositions/ and mount it with data-composition-src. The words are then in
 * those files, so a retime has to follow the mounts and write each one — this
 * used to look in index.html only, find no blocks at all, and refuse.
 */
const documents = [
	{ path: file, name: "index.html", text: out, owned: false },
	...mountedText.map((m) => ({ path: join(dir, m.src), name: m.src, text: m.text, owned: true })),
];

/* Which document holds which say block, in clip order. */
const found = [];
for (const doc of documents) {
	/* `\bid="` also matches inside data-composition-id="say-1" — the hyphen is a
	   word boundary — so a mount host and a sub-composition root both counted as
	   word blocks and the totals never lined up. Anchor on whitespace instead. */
	for (const m of doc.text.matchAll(/(?:^|\s)id="say-(\d+)"/g)) {
		const span = blockAt(doc.text, m.index);
		if (span) found.push({ doc, index: Number(m[1]) - 1, span });
	}
}
if (found.length !== clips.length) {
	console.error(`rm-retime-pip: found ${found.length} word blocks for ${clips.length} clips — not touching it`);
	process.exit(1);
}

/* Back to front within each document, so replacing one does not move the next. */
for (const doc of documents) {
	const mine = found.filter((f) => f.doc === doc).sort((a, b) => b.span[0] - a.span[0]);
	for (const { index, span } of mine) {
		const [open, close] = span;
		doc.text = doc.text.slice(0, open) + lines[index].trimStart() + doc.text.slice(close);
	}
}
out = documents[0].text;

/*
 * The timing tables, rewritten; everything else in the block left alone.
 *
 * The builder now emits three tables and a loop rather than six hundred tl.to()
 * lines, so a retime is three assignments — which is the point of the table. A
 * composition built before that still carries the lines, and those are matched
 * and dropped the way they always were, so one retime brings an old file onto
 * the new shape without rebuilding it.
 */
const table = (name, rows) => `      var ${name} = ${JSON.stringify(rows)};`;

/*
 * Ours, by the id it touches.
 *
 * A phrase, a word and a say block are this command's to rewrite. Anything else
 * in the block belongs to something the editor added — an image it positioned
 * has tweens of its own in there — and losing those is the same class of damage
 * a retime exists to avoid.
 */
const mine = /^\s*tl\.(set|to)\('#(?:g\d+-\d+|w\d+|say-\d+-in)'/;

/*
 * Everything that is not a tl. call is scaffolding this command owns: the
 * constants, the tables, the loops, the offset helper. Keeping a line because it
 * failed to match one shape of loop body is how a previous run's `var at = ...`
 * survived into the next file and threw a ReferenceError before the timeline was
 * ever registered.
 *
 * So the rule is positive and narrow: a real tween names its target as a string
 * literal. A line that tweens `at` is a loop body — scaffolding — however much
 * it looks like a tween. Keep the literals that are not ours, drop everything
 * else, and write the scaffolding fresh.
 */
const foreign = (line) => /^\s*tl\.(set|to)\('#/.test(line) && !mine.test(line);

/* One source with the generator, so a retime can only ever produce what a
   fresh build would. This used to be a second copy of the same loops, and the
   copies drifted: a shape fixed in the generator was still broken here. */
const loops = TIMELINE_LOOPS;

out = out.replace(/(var tl = gsap\.timeline\(\{ paused: true \}\);\n)([\s\S]*?)(\n\s*window\.__timelines)/, (_all, head, body, tail) => {
	const kept = body.split("\n").filter(foreign);
	const rebuilt = [
		`      var FADE = ${PHRASE_FADE}, FILL = ${WORD_FILL}, DIM = ${WORD_DIM};`,
		table("PHRASE", phrases),
		table("WORD", wordCues),
		table("OUT", outs),
		table("PIPS", pips),
		`      var PIP_OUT = ${PIP_FADE};`,
		loops,
	];
	return head + [...kept, ...rebuilt].join("\n") + tail;
});

await writeFile(`${file}.before-retime`, html, "utf8");
await writeFile(file, out, "utf8");
/* The transcripts, wherever they live. */
for (const doc of documents.filter((d) => d.owned)) {
	await writeFile(doc.path, doc.text, "utf8");
}
console.log("");
console.log(`  ${words} words re-timed against the clips as they are now`);
console.log(`  previous file kept as ${folder}/index.html.before-retime`);
