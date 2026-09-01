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
import { cacheSource, secondsOf } from "../lib/edit-cache.mjs";
import { allClips, clipSeconds, cutProblems, cutSeconds, emptyCut, overlapAt, readCut, writeCut } from "../lib/cut.mjs";
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

/*
 * A clip out of a <video> tag.
 *
 * data-start is where it sits, data-media-start is its in point, data-duration
 * is how much of it plays — so the out point is the one number that has to be
 * computed, and after this nobody stores it either.
 */
function clipsFromHtml(html) {
	const out = [];
	for (const [tag] of html.matchAll(/<video\b[^>]*>/gi)) {
		const attr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
		const num = (name, fallback = 0) => Number(attr(name) ?? fallback) || fallback;
		const src = attr("src");
		if (!src) continue;
		const style = attr("style") ?? "";
		const styleNum = (name) => {
			const found = new RegExp(`--${name}:\\s*([\\d.]+)`).exec(style);
			return found ? Number(found[1]) : undefined;
		};
		out.push({
			id: attr("id") ?? `clip-${out.length + 1}`,
			file: src.replace(/^source\//, ""),
			at: num("data-start"),
			in: num("data-media-start"),
			seconds: num("data-duration"),
			framing: { focus: styleNum("pip-focus"), zoom: styleNum("pip-zoom"), y: styleNum("pip-y") },
		});
	}
	return out;
}

if (cmd === "seed") {
	if (await stat(join(root, "cut.json")).catch(() => null)) {
		die("this composition already has a cut.json — that is the truth now, and re-seeding would overwrite it");
	}
	const html = await readFile(join(root, "index.html"), "utf8");
	const found = clipsFromHtml(html);
	if (!found.length) die("no <video> clips in that composition to seed from");

	console.log(`\n  ${found.length} clips in ${folder}\n`);
	const cut = emptyCut({
		width: Number(/data-width="(\d+)"/.exec(html)?.[1]) || 1920,
		height: Number(/data-height="(\d+)"/.exec(html)?.[1]) || 1080,
		fps: Number(/data-fps="(\d+)"/.exec(html)?.[1]) || 60,
	});
	const video = { id: "v1", kind: "video", clips: [] };

	for (const item of found) {
		/* The composition points at source/Footage/x.mp4, which is a link into the
		   project's own media. Cache against the real file so two compositions
		   using the same take share one proxy. */
		const file = join(mediaRoot, item.file);
		if (!(await stat(file).catch(() => null))) {
			console.log(`  ${basename(item.file).padEnd(20)} missing — skipped`);
			continue;
		}
		process.stdout.write(`  ${basename(item.file).padEnd(20)} caching… `);
		const cached = await cacheSource(file, cacheDir);
		cut.sources[cached.key] = { file: item.file, seconds: cached.seconds, frames: cached.frames };
		video.clips.push({
			id: item.id,
			source: cached.key,
			in: Number(item.in.toFixed(3)),
			out: Number((item.in + item.seconds).toFixed(3)),
			at: Number(item.at.toFixed(3)),
			...(Number.isFinite(item.framing.focus) ? { framing: item.framing } : {}),
		});
		console.log(`${cached.frames} frames`);
	}

	cut.tracks.push(video);
	const problems = cutProblems(cut);
	if (problems.length) {
		console.log("");
		for (const p of problems) console.log(`  ✗ ${p}`);
		die("the seeded cut has problems — nothing written");
	}
	const written = await writeCut(root, cut);
	console.log(`\n  wrote ${written}`);
	console.log(`  ${video.clips.length} clips · ${cutSeconds(cut).toFixed(2)}s · ${Object.keys(cut.sources).length} sources\n`);
} else if (cmd === "show") {
	const cut = await readCut(root).catch(() => die("no cut.json here — run `rm-cut seed` first"));
	console.log(`\n  ${folder} · ${cut.width}x${cut.height} @ ${cut.fps}fps · ${cutSeconds(cut).toFixed(2)}s\n`);
	for (const { track, clip } of allClips(cut)) {
		const source = cut.sources[clip.source];
		console.log(
			`  ${track.id}  ${String(clip.id).padEnd(8)} ${clip.at.toFixed(2).padStart(7)}s  +${clipSeconds(clip).toFixed(2).padStart(6)}s` +
				`  from ${clip.in.toFixed(2)}s of ${basename(source?.file ?? "?")}`,
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
