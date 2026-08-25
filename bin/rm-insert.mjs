#!/usr/bin/env node
/*
 * Put a title into a recording you already have.
 *
 *   rm-insert <recording.mp4> --title "Estimating, in one pass" [options]
 *   rm-insert <recording.mp4> --scene <scene.html> --at 12
 *
 * Options
 *   --title <text>      a title card, built from the components
 *   --eyebrow <text>    the small line above it
 *   --sub <text>        the line below it
 *   --scene <file>      an authored scene body instead of --title
 *   --wallpaper <name>  brand wallpaper for the card (default rm-dark-dotgrid)
 *   --seconds <n>       how long the card holds (default 3)
 *   --at <seconds>      where it goes; omitted means the front
 *   --over              lay it OVER the video instead of cutting it in
 *   --for <seconds>     how long an overlay stays (default --seconds)
 *   --out <dir>         where the render and document land (default beside the video)
 *
 * Composing builds a video from parts. This is the other half: an existing
 * capture, with a card dropped in, without rebuilding anything.
 *
 * It writes an AxcutDocument with both pieces already on the timeline rather than
 * asking the editor to perform an insert. The fork declares `insert_asset_clip`
 * and implements it nowhere — no applier, no caller, no UI — so the operation can
 * be described and nothing carries it out. A timeline that already contains the
 * clip needs none of that.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FPS, SCENE_H, SCENE_W, sceneHtml } from "../lib/compose.mjs";
import { documentFor, imageOverlay, insertAt } from "../lib/insert-clip.mjs";
import { hasAlpha, renderStill } from "../lib/render-still.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const die = (m) => {
	console.error(`rm-insert: ${m}`);
	process.exit(1);
};

const video = argv.find((a) => !a.startsWith("-"));
if (!video) die('usage: rm-insert <recording.mp4> --title "…" [--at <seconds>]');
const source = resolve(video);

const titleText = flag("title");
const sceneFile = flag("scene");
if (!titleText && !sceneFile) die("say what to insert: --title <text> or --scene <file>");

const outDir = resolve(flag("out", dirname(source)));
const cardSec = Number(flag("seconds", 3));
const atSec = argv.includes("--at") ? Number(flag("at", 0)) : null;
await mkdir(outDir, { recursive: true });

/** A file that exists is not a file a demuxer can open; ffmpeg writes its index last. */
async function probe(file) {
	try {
		const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", file]);
		const sec = Number(JSON.parse(stdout)?.format?.duration);
		if (!Number.isFinite(sec) || sec <= 0) throw new Error("no duration");
		return Math.round(sec * 1000);
	} catch {
		die(`${basename(file)} is not a readable video — if it was just rendered, the render did not finish.`);
	}
}

const sourceMs = await probe(source);

/*
 * Render the card.
 *
 * Written into components/ and rendered from there: the scene links
 * ../brand/fonts/fonts.css and ./rm-video.js by relative path, and those hold
 * only inside that directory. Removed afterwards, because a generated file left
 * beside hand-written ones is a file somebody will edit.
 */
const overlay = argv.includes("--over");
const stem = basename(source, extname(source));
const cardName = `${stem}-title`;
const cardMp4 = join(outDir, `${cardName}.mp4`);
const scratch = join(ROOT, "components", `.insert-${process.pid}.html`);

const body = sceneFile
	? await readFile(resolve(sceneFile), "utf8")
	: [
			`<rm-title at="0" for="${Math.round(cardSec * 1000)}"`,
			flag("eyebrow") ? ` eyebrow="${flag("eyebrow").replace(/"/g, "&quot;")}"` : "",
			` title="${titleText.replace(/"/g, "&quot;")}"`,
			flag("sub") ? ` sub="${flag("sub").replace(/"/g, "&quot;")}"` : "",
			"></rm-title>",
		].join("");

if (!overlay) {
	await writeFile(scratch, sceneHtml({ wallpaper: flag("wallpaper", "rm-dark-dotgrid"), body, title: cardName }), "utf8");
}

if (overlay) {
	/*
	 * Over the video, using the annotation layer.
	 *
	 * The timeline is a flat clip list with no layers and assets are video-only, so
	 * nothing that is not video can sit above a clip. `document.annotations` is a
	 * layer that already exists, already has a time range and a zIndex, and already
	 * crosses the bridge to the native compositor — so this survives export rather
	 * than being a preview-only trick.
	 */
	const png = join(outDir, `${cardName}.png`);
	const overSec = Number(flag("for", cardSec));
	const startMs = Math.round((atSec ?? 0) * 1000);
	await renderStill({ body, out: png, atMs: Math.round(overSec * 500), width: SCENE_W, height: SCENE_H });
	if (!(await hasAlpha(png))) die("the card came out opaque — it would hide the video rather than sit on it");

	const now2 = new Date().toISOString();
	const doc2 = documentFor({
		id: `${stem}-${SCENE_W}x${SCENE_H}`,
		title: titleText ?? stem,
		pieces: [{ path: source, ms: sourceMs, label: basename(source) }],
		createdAt: now2,
	});
	doc2.annotations = [imageOverlay({ path: png, startMs, endMs: startMs + Math.round(overSec * 1000) })];

	const docPath2 = join(outDir, `${stem}-titled.openscreen`);
	await writeFile(docPath2, `${JSON.stringify(doc2, null, 2)}\n`, "utf8");
	console.log(`\n  over    ${(startMs / 1000).toFixed(1)}–${((startMs + overSec * 1000) / 1000).toFixed(1)}s  ${titleText ?? cardName}`);
	console.log(`  source  ${(sourceMs / 1000).toFixed(1)}s  ${basename(source)}  (untouched, still one clip)`);
	console.log(`\n  ${png}`);
	console.log(`  ${docPath2}\n`);
	process.exit(0);
}

console.log(`\n  card    ${cardSec.toFixed(1)}s  ${cardName}`);
try {
	await run(
		"node",
		[join(ROOT, "components", "render-scene.mjs"), scratch, "-o", cardMp4, "--fps", String(FPS), "--ms", String(Math.round(cardSec * 1000)), "--width", String(SCENE_W)],
		{ cwd: ROOT, maxBuffer: 1 << 24 },
	);
} catch (err) {
	await rm(scratch, { force: true });
	die(`the card failed to render: ${String(err.stderr || err.message).slice(-300)}`);
}
await rm(scratch, { force: true });
const cardMs = await probe(cardMp4);

console.log(`  source  ${(sourceMs / 1000).toFixed(1)}s  ${basename(source)}`);

/*
 * Both pieces on one timeline, the card at `--at`.
 *
 * Nothing is re-encoded and the recording is not touched: the document points at
 * both files and says when each plays. That is the difference between inserting a
 * title and rebuilding the video — and it is why this is reversible.
 */
const pieces = insertAt(
	[{ path: source, ms: sourceMs, label: basename(source) }],
	{ path: cardMp4, ms: cardMs, label: titleText ?? cardName, reason: "title card" },
	atSec,
);

const now = new Date().toISOString();
const doc = documentFor({
	id: `${stem}-${SCENE_W}x${SCENE_H}`,
	title: titleText ?? stem,
	pieces,
	createdAt: now,
});

const docPath = join(outDir, `${stem}-titled.openscreen`);
await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

if (atSec != null && pieces.landedAtSec != null && Math.abs(pieces.landedAtSec - atSec) > 0.05) {
	console.log(`\n  --at ${atSec}s is inside a clip, so the card went to the nearest boundary at ${pieces.landedAtSec.toFixed(1)}s.`);
	console.log("  Splitting the recording to fit it in is a different edit; ask for it explicitly.");
}
console.log(`\n  ${pieces.map((p) => `${(p.ms / 1000).toFixed(1)}s`).join(" + ")} = ${(doc.timeline.clips.at(-1).timelineEndSec).toFixed(1)}s`);
for (const c of doc.timeline.clips) {
	console.log(`    ${c.timelineStartSec.toFixed(1)}–${c.timelineEndSec.toFixed(1)}s  ${doc.assets.find((a) => a.id === c.assetId).label}`);
}
console.log(`\n  ${docPath}\n`);
