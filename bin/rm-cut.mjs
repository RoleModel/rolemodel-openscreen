#!/usr/bin/env node
/*
 * rm-cut — make a cut.json out of a composition, and cache what it needs.
 *
 *   rm-cut seed <projectId> <folder>   read the composition, write cut.json
 *   rm-cut show <projectId> <folder>   what is in the cut, as a table
 *
 * The bridge off HyperFrames. A composition already holds a real edit — seven
 * takes, framing tuned per speaker, a cross-dissolve — and starting the editor
 * from an empty timeline would mean testing it against material nobody chose.
 * This reads that edit out of the markup once, so everything after it can work
 * on data.
 *
 * Seeding is one-way on purpose. The moment cut.json exists it is the truth,
 * and re-seeding would overwrite whatever has been done since — so it refuses
 * to run over one that is already there.
 */
import { readdir, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { allClips, clipSeconds, cutProblems, cutSeconds, overlapAt, readCut } from "../lib/cut.mjs";
import { seedCut } from "../lib/cut-seed.mjs";
import { defaultRoot } from "../lib/library.mjs";

const argv = process.argv.slice(2);
const die = (m) => {
	console.error(`rm-cut: ${m}`);
	process.exit(1);
};

const [cmd, projectId, folder] = argv;
if (!cmd || !projectId || !folder) {
	console.log("\n  rm-cut seed <projectId> <folder>   read a composition, write cut.json");
	console.log("  rm-cut show <projectId> <folder>   what is in the cut\n");
	process.exit(argv.length ? 1 : 0);
}

const root = join(defaultRoot(), projectId, "media", "Renders", folder);
const mediaRoot = join(defaultRoot(), projectId, "media");
if (!(await stat(root).catch(() => null))) die(`no composition at ${root}`);
const cacheDir = join(mediaRoot, ".edit-cache");

if (cmd === "seed") {
	/* One seeder, shared with Studio's Make editable button. Two copies of "read
	   a composition into a cut" is two things to keep in step, and the CLI's copy
	   had already fallen behind — it knew only about <video> and reported a
	   motion piece as having nothing in it. */
	try {
		const made = await seedCut({
			dir: root,
			mediaRoot,
			onStep: (name) => console.log(`  ${name} — caching`),
		});
		console.log("");
		for (const missing of made.skipped) console.log(`  ${missing} is not on disk — left out`);
		console.log(`  wrote ${join(root, "cut.json")}`);
		console.log(`  ${made.clips} clips · ${cutSeconds(made.cut).toFixed(2)}s · ${Object.keys(made.cut.sources).length} sources\n`);
	} catch (error) {
		die(error.message);
	}
} else if (cmd === "show") {
	const cut = await readCut(root).catch(() => die("no cut.json here — run `rm-cut seed` first"));
	console.log(`\n  ${folder} · ${cut.width}x${cut.height} @ ${cut.fps}fps · ${cutSeconds(cut).toFixed(2)}s\n`);
	for (const { track, clip } of allClips(cut)) {
		const source = cut.sources[clip.source];
		console.log(
			`  ${track.id}  ${String(clip.name ?? clip.id).padEnd(18)} ${clip.at.toFixed(2).padStart(7)}s  +${clipSeconds(clip).toFixed(2).padStart(6)}s` +
				/* A graphic has no footage to be "from", and printing `from 0.00s of ?`
				   invents a source that does not exist. */
				(clip.source ? `  from ${clip.in.toFixed(2)}s of ${basename(source?.file ?? "?")}` : "  graphic"),
		);
	}
	for (const track of cut.tracks) {
		for (const join_ of overlapAt(cut, track.id)) {
			console.log(`\n  dissolve  ${join_.from} → ${join_.to}  ${join_.seconds.toFixed(3)}s at ${join_.at.toFixed(2)}s`);
		}
	}
	const problems = cutProblems(cut);
	if (problems.length) {
		console.log("");
		for (const p of problems) console.log(`  ✗ ${p}`);
	}
	console.log("");
} else {
	die(`no such command: ${cmd}`);
}
