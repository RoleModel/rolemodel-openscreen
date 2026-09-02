/*
 * Reading a composition into a cut, once.
 *
 * Extracted from bin/rm-cut.mjs so Studio can do it from a button. The CLI was
 * the only way in, and "run this node command" is not an answer — a composition
 * you are looking at should be one click from being editable.
 *
 * One-way on purpose. The moment cut.json exists it is the truth and the markup
 * is a build artefact; re-seeding would silently discard whatever has been done
 * since, so it refuses rather than asking.
 */
import { stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { cacheSource } from "./edit-cache.mjs";
import { cutProblems, emptyCut, writeCut } from "./cut.mjs";

/*
 * The clips a composition holds.
 *
 * `data-start` is where a clip sits, `data-media-start` is its in point and
 * `data-duration` is how much of it plays — so the out point is the one number
 * that has to be computed, and after this nobody stores it again.
 */
export function clipsFromHtml(html) {
	const out = [];
	for (const [tag] of String(html).matchAll(/<video\b[^>]*>/gi)) {
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

/*
 * The mounted beats of a motion composition, as clips.
 *
 * A beat has a start and a duration and nothing else a timeline needs — no
 * source, no in point, because there is no footage under it. Read the same way
 * a video clip is so the editor does not have to know which kind of composition
 * it opened.
 */
export function graphicsFromHtml(html) {
	const out = [];
	/*
	 * Two shapes of scene, and both are clips.
	 *
	 * A mounted beat carries `data-composition-src`; a Canvas component is an
	 * `rm-*` element with its own timing. They are authored differently and they
	 * are the same thing on a timeline — something that appears, lasts, and goes.
	 * Reading only the first left a cut that could not see its own captions or
	 * its closing card.
	 *
	 * The composition root is excluded by construction: it has neither a
	 * composition-src nor an rm- prefix.
	 */
	const shapes = [
		/<[a-z][\w-]*\b[^>]*\bdata-composition-src="[^"]*"[^>]*>/gi,
		/<rm-[\w-]+\b[^>]*\bdata-start="[^"]*"[^>]*>/gi,
	];
	for (const [tag] of shapes.flatMap((re) => [...String(html).matchAll(re)])) {
		const attr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
		/*
		 * A mount may carry no timing at all.
		 *
		 * `data-composition-src` is a seam, not a clip: the caption blocks in a
		 * transcript cut declare their start and duration inside the file they
		 * mount, because that is the thing that knows how long it is. Skipping
		 * anything without timing here dropped six caption blocks — half of what
		 * the video actually shows — from a cut that claimed to describe it.
		 *
		 * So the src is carried out and resolved by the caller, which is the only
		 * part of this that knows where the files are.
		 */
		const seconds = Number(attr("data-duration") ?? 0);
		const src = attr("data-composition-src");
		if (!(seconds > 0) && !src) continue;
		const tagName = (/^<([a-z][\w-]*)/i.exec(tag) ?? [])[1] ?? "scene";
		out.push({
			id: attr("data-composition-id") ?? attr("id") ?? `scene-${out.length + 1}`,
			name: attr("data-composition-id") ?? attr("id") ?? tagName,
			at: Number(attr("data-start") ?? 0),
			seconds,
			src: seconds > 0 ? null : src,
		});
	}
	return out;
}

/**
 * Build a cut for one composition, caching everything it needs on the way.
 *
 * `onStep` is called with each source as it is cached, because this takes about
 * three seconds a take and silence for half a minute reads as a hang.
 */
export async function seedCut({ dir, mediaRoot, onStep = () => {} }) {
	if (await stat(join(dir, "cut.json")).catch(() => null)) {
		throw new Error("this composition already has a cut — that is the truth now, and re-seeding would overwrite it");
	}
	const html = await readFile(join(dir, "index.html"), "utf8");
	const found = clipsFromHtml(html);
	const graphics = [];
	for (const scene of graphicsFromHtml(html)) {
		if (!scene.src) {
			graphics.push(scene);
			continue;
		}
		/* Follow the seam and read the timing from the file that owns it — the
		   first element inside declaring both a start and a duration. */
		const part = await readFile(join(dir, scene.src), "utf8").catch(() => "");
		const timed = /<[a-z][\w-]*\b[^>]*\bdata-start="([\d.]+)"[^>]*\bdata-duration="([\d.]+)"[^>]*>/i.exec(part)
			?? /<[a-z][\w-]*\b[^>]*\bdata-duration="([\d.]+)"[^>]*\bdata-start="([\d.]+)"[^>]*>/i.exec(part);
		if (!timed) continue;
		const [at, seconds] = /data-start="[\d.]+"[^>]*data-duration/.test(timed[0])
			? [Number(timed[1]), Number(timed[2])]
			: [Number(timed[2]), Number(timed[1])];
		if (!(seconds > 0)) continue;
		graphics.push({ ...scene, at, seconds });
	}
	if (!found.length && !graphics.length) throw new Error("nothing timed in that composition to read — no footage and no mounted beats");

	const cut = emptyCut({
		width: Number(/data-width="(\d+)"/.exec(html)?.[1]) || 1920,
		height: Number(/data-height="(\d+)"/.exec(html)?.[1]) || 1080,
		fps: Number(/data-fps="(\d+)"/.exec(html)?.[1]) || 60,
	});
	const video = { id: "v1", kind: "video", clips: [] };
	const cacheDir = join(mediaRoot, ".edit-cache");
	const skipped = [];

	for (const item of found) {
		const file = join(mediaRoot, item.file);
		if (!(await stat(file).catch(() => null))) {
			skipped.push(item.file);
			continue;
		}
		onStep(basename(item.file));
		const cached = await cacheSource(file, cacheDir);
		cut.sources[cached.key] = { file: item.file, seconds: cached.seconds, frames: cached.frames, interval: 0.5, count: cached.frames };
		video.clips.push({
			id: item.id,
			source: cached.key,
			in: Number(item.in.toFixed(3)),
			out: Number((item.in + item.seconds).toFixed(3)),
			at: Number(item.at.toFixed(3)),
			...(Number.isFinite(item.framing.focus) ? { framing: item.framing } : {}),
		});
	}

	/*
	 * Graphics on their own lane, above the footage.
	 *
	 * Above because that is where they sit in the picture — a title is over a
	 * clip, not beside it — and on their own lane because moving a title should
	 * never shove a take out of the way.
	 */
	if (graphics.length) {
		cut.tracks.push({
			id: "g1",
			kind: "graphic",
			clips: graphics.map((g) => ({ id: g.id, name: g.name, in: 0, out: Number(g.seconds.toFixed(3)), at: Number(g.at.toFixed(3)) })),
		});
	}
	if (video.clips.length) cut.tracks.push(video);
	const problems = cutProblems(cut);
	if (problems.length) throw new Error(`the cut this composition describes has problems:\n  ${problems.join("\n  ")}`);
	await writeCut(dir, cut);
	/* Every clip, not just the ones with footage — a motion piece is all
	   graphics, and reporting 0 for eight beats is simply wrong. */
	return { cut, skipped, clips: cut.tracks.reduce((n, t) => n + t.clips.length, 0) };
}
