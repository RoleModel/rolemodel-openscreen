/*
 * The round trip between OpenScreen and a HyperFrames composition.
 *
 * The two halves of this pipeline have always disagreed about who owns the cut.
 * OpenScreen owns the EDIT — trimming, reordering, dropping a clip — and it is
 * far better at that than anything here. The composition owns the LOOK — the
 * framing, the speaker's name, the field, the words typed on beside. Until now
 * an edit made on one side was retyped by hand into the other, which is the same
 * copy-once-and-drift that put a composition eight weeks behind its runtime.
 *
 * So: the document states the windows, and the recipe states everything the
 * document has never heard of. `emitCut` writes the document to edit; `adoptCut`
 * merges an edited one back and rebuilds. Per clip, the document wins on `src`,
 * `ms`, `dur` and `start`; the recipe wins on `speaker` and `focus`, because
 * losing a name or a framing to a trim handle is not a trade anybody would make
 * on purpose.
 *
 * A library rather than a command, because a person editing video should never
 * have to open a terminal to get their own edit back: Studio's HyperFrames panel
 * calls both of these, and the CLI is the same two calls for a script.
 *
 * Every failure here throws with a sentence a person can act on. These run
 * behind a button, so "refused" has to say what to do next.
 */
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { cutlistFromDocument, cutlistToDocument } from "./cutlist.mjs";
import { defaultRoot } from "./library.mjs";
import { buildPip } from "./make-pip.mjs";

/** Where a composition and its recipe live. */
function places(projectId, folder, root = defaultRoot()) {
	const projectDir = join(root, projectId);
	const mediaDir = join(projectDir, "media");
	const outDir = join(mediaDir, "Renders", folder);
	return { projectDir, mediaDir, outDir, recipePath: join(outDir, "clips.json") };
}

/**
 * A path, as the composition refers to its footage.
 *
 * Compositions name media relative to the project's media folder, because that
 * is what the staged `source/` symlink resolves. An absolute path from outside
 * it is a file this project does not own, and rewriting the recipe to point at
 * one would build a composition that renders on this machine and nowhere else.
 */
const srcFor = (mediaDir, abs) => {
	const rel = relative(mediaDir, abs);
	return rel.startsWith("..") ? null : rel.split(sep).join("/");
};

/*
 * The recipe, brought up to the composition before anything is built from it.
 *
 * Never the bare file. A composition is edited after it is generated — that is
 * what HyperFrames is for — and the recipe does not hear about any of it. Every
 * path that rebuilds goes through here, so an edit made in the composition is
 * carried forward instead of reverted by the next build.
 */
async function readRecipe(recipePath, outDir) {
	const recipe = await readFile(recipePath, "utf8").then(JSON.parse).catch(() => null);
	if (!recipe?.clips?.length) {
		throw new Error("This composition has no clip list yet. Build it once and it writes one.");
	}
	const html = await readFile(join(outDir, "index.html"), "utf8").catch(() => "");
	if (!html) return { ...recipe, adopted: [] };
	const { recipe: current, changes, matched } = reconcile(recipe, readComposition(html));
	/* Placement travels with the clips: it is the same drift, one level up. */
	const placement = readPlacement(html);
	for (const [key, value] of Object.entries(placement)) {
		const before = current.pip?.[key];
		if (before != null && Math.abs(Number(before) - value) < 0.002) continue;
		if (before != null) changes.push(`pip ${key} ${before} → ${value}`);
	}
	current.pip = { ...(current.pip ?? {}), ...placement };
	/*
	 * The ground: learned once, then owned by the recipe.
	 *
	 * The wallpaper and the scrim are the only things reconcile reads that the
	 * BUILDER also writes, and that makes re-reading them circular. Set
	 * scrim:false, rebuild, and the composition is written without a gradient —
	 * fine. But let anything put a gradient back for one build and reading it
	 * again records scrim:true, which writes a gradient, which reads as true. It
	 * cannot be switched off, and deleting the gradient by hand looks like it
	 * works right up until the next rebuild.
	 *
	 * A clip's window has no such loop: nothing here invents one. So the ground
	 * is adopted only while the recipe has no answer — the first time, learning
	 * what the composition was already doing — and after that the recipe is the
	 * answer and the panel is how it changes.
	 */
	const ground = readGround(html);
	for (const [key, value] of Object.entries(ground)) {
		if (current[key] !== undefined) continue;
		current[key] = value;
	}
	/* Hand-added elements ride along so a rebuild puts them back. */
	current.keep = foreignElements(html);
	/* A count mismatch means the composition was restructured by hand and cannot
	   be matched by position. Build from the recipe and say so, rather than
	   guessing which clip is which and putting one speaker's framing on
	   another's take. */
	return { ...current, adopted: matched ? changes : [], unmatched: !matched };
}

/*
 * Where the document is.
 *
 * Once emitted the recipe remembers it, so nothing has to be told. Before that:
 * the newest .openscreen inside the composition folder, then the newest in the
 * project's Footage — which is where the editor saves a capture.
 */
export async function findDocument({ projectId, folder, root, from = null } = {}) {
	const { mediaDir, outDir, recipePath } = places(projectId, folder, root);
	const recipe = await readFile(recipePath, "utf8").then(JSON.parse).catch(() => null);
	const named = from ?? recipe?.document;
	if (named) {
		/* Recorded paths are media-relative, the same as a clip's `src`. Anything
		   passed in may be either, so try the project first and fall back. */
		const abs = named.startsWith(sep) ? resolve(named) : resolve(mediaDir, named);
		if ((await stat(abs).catch(() => null))?.isFile()) return abs;
		const loose = resolve(named);
		if ((await stat(loose).catch(() => null))?.isFile()) return loose;
		throw new Error(`No document at ${abs}.`);
	}
	const found = [];
	for (const dir of [outDir, join(mediaDir, "Footage")]) {
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			if (!entry.isFile() || !entry.name.endsWith(".openscreen")) continue;
			const info = await stat(join(dir, entry.name)).catch(() => null);
			if (info?.isFile()) found.push({ path: join(dir, entry.name), mtime: info.mtimeMs });
		}
	}
	if (!found.length) throw new Error("No OpenScreen document for this composition yet. Send the cut to OpenScreen first.");
	return found.sort((a, b) => b.mtime - a.mtime)[0].path;
}

/**
 * The composition's cut, as a document OpenScreen opens.
 *
 * You cannot adopt an edit from OpenScreen until the cut is in OpenScreen, and
 * nothing put it there — the composition was the only place the windows existed.
 *
 * Ids derive from what they identify (see cutlist.mjs), so emitting twice over
 * an unchanged recipe produces the same document and the editor can tell that
 * nothing moved.
 */
export async function emitCut({ projectId, folder, root } = {}) {
	const { mediaDir, outDir, recipePath } = places(projectId, folder, root);
	const recipe = await readRecipe(recipePath, outDir);

	/*
	 * The lead-in is not part of the cut.
	 *
	 * A composition's first clip starts after the opening card, so its footage
	 * sits at 2.6s while the cut itself starts at zero. An editor opening a
	 * document that begins with 2.6s of nothing sees a mistake, and laying the
	 * spans end to end from zero — which is what a cut list does — would silently
	 * throw the card away on the way back. Record it and re-apply on adopt.
	 */
	const lead = +(Number(recipe.clips[0]?.start) || 0).toFixed(3);

	const clips = [];
	for (const clip of recipe.clips) {
		const path = join(mediaDir, clip.src);
		if (!(await stat(path).catch(() => null))?.isFile()) {
			throw new Error(`${clip.src} is in this composition but not in the project any more.`);
		}
		clips.push({
			path,
			// The speaker, so the editor's clip list reads as the cut does rather
			// than as six copies of a filename.
			label: clip.speaker || basename(clip.src),
			inSec: Number(clip.ms) || 0,
			outSec: (Number(clip.ms) || 0) + (Number(clip.dur) || 0),
			reason: clip.speaker ? `${clip.speaker} — ${folder}` : folder,
		});
	}

	const now = new Date().toISOString();
	const doc = cutlistToDocument({
		id: `doc_${folder}`,
		title: recipe.title ? `${recipe.title} · ${folder}` : folder,
		clips,
		createdAt: now,
		updatedAt: now,
	});
	const docPath = join(outDir, `${folder}.openscreen`);
	await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
	await writeFile(recipePath, `${JSON.stringify({ ...recipe, document: srcFor(mediaDir, docPath) ?? docPath, lead }, null, 2)}\n`, "utf8");
	return { document: docPath, clips: doc.timeline.clips.length, seconds: doc.timeline.clips.at(-1).timelineEndSec, lead };
}

/*
 * Carry the look forward.
 *
 * Matching is by file first, then by nearest in-point among that file's old
 * windows: two clips cut from one recording are common, and giving the second
 * one the first one's framing is a silent wrong answer. Nearest in-point
 * survives a trim handle moving, which is the edit this exists to absorb.
 */
const stem = (src) => String(src).replace(/\.[^./]+$/, "");

function dressing(old, src, ms) {
	/*
	 * Same file, then same take.
	 *
	 * Swapping a clip to another container is a normal edit — dallas.mp4 became
	 * dallas.mov here — and it is still the same person in the same shot. Matching
	 * on the path alone dropped their name and their framing on the way through,
	 * which reads as the round trip losing work. The stem is the take; only the
	 * extension changed.
	 */
	const sameFile = old.filter((clip) => clip.src === src);
	const sameTake = sameFile.length ? sameFile : old.filter((clip) => stem(clip.src) === stem(src));
	if (!sameTake.length) return {};
	const nearest = sameTake.reduce((best, clip) => (Math.abs((clip.ms ?? 0) - ms) < Math.abs((best.ms ?? 0) - ms) ? clip : best));
	const kept = {};
	if (nearest.speaker) kept.speaker = nearest.speaker;
	for (const key of ["focus", "zoom", "focusY"]) if (nearest[key] != null) kept[key] = nearest[key];
	return kept;
}

/** What an edited document would do to this composition, without doing it. */
export async function planAdopt({ projectId, folder, root, from = null } = {}) {
	const { mediaDir, outDir, recipePath } = places(projectId, folder, root);
	const recipe = await readRecipe(recipePath, outDir);
	const docPath = await findDocument({ projectId, folder, root, from });
	const doc = await readFile(docPath, "utf8").then(JSON.parse).catch((error) => {
		throw new Error(`${basename(docPath)} could not be read: ${error.message}`);
	});

	let cut;
	try {
		cut = cutlistFromDocument(doc);
	} catch (error) {
		/* A v2 capture is the editor's old save format and carries no timeline at
		   all — there is nothing in it to adopt, and the likely mistake is having
		   pointed at a raw recording rather than at an edit. */
		throw new Error(
			/schemaVersion/.test(error.message)
				? `${basename(docPath)} is a raw recording, not an edit. Send the cut to OpenScreen first, edit that, then bring it back.`
				: `${basename(docPath)}: ${error.message}`,
		);
	}
	if (!cut.clips.length) throw new Error(`${basename(docPath)} has no clips left.`);

	/* Put the opening card back in front. See emitCut for why it is not in the
	   document. A recipe that predates this has no lead recorded, so its first
	   clip's own start stands in — which is the same number. */
	const lead = Number.isFinite(Number(recipe.lead)) ? Number(recipe.lead) : Number(recipe.clips[0]?.start) || 0;

	const outside = [];
	const clips = cut.clips
		.map((clip) => {
			const src = srcFor(mediaDir, clip.path);
			if (!src) {
				outside.push(basename(clip.path));
				return null;
			}
			const ms = +clip.inSec.toFixed(3);
			return {
				src,
				...dressing(recipe.clips, src, ms),
				start: +(clip.atSec + lead).toFixed(3),
				ms,
				dur: +(clip.outSec - clip.inSec).toFixed(3),
			};
		})
		.filter(Boolean);

	/*
	 * Refuse rather than half-adopt.
	 *
	 * A document naming footage outside this project would rebuild the cut with
	 * those clips quietly missing — shorter, still rendering, and wrong in a way
	 * you only notice on playback.
	 */
	if (outside.length) {
		throw new Error(`${outside.length} clip(s) come from outside this project and cannot be used here: ${outside.join(", ")}.`);
	}
	if (recipe.clips.some((clip) => clip.speaker) && !clips.some((clip) => clip.speaker)) {
		throw new Error("Every speaker name would be lost — that document is a cut of different footage.");
	}

	return { recipe, docPath, clips, lead, was: recipe.clips.length, adopted: recipe.adopted ?? [], unmatched: Boolean(recipe.unmatched) };
}

/**
 * Merge an edited document back into the composition and rebuild it.
 *
 * Returns what changed, so a caller can say so rather than reporting "done".
 */
export async function adoptCut({ projectId, folder, root, from = null } = {}) {
	const { recipePath } = places(projectId, folder, root);
	const { recipe, docPath, clips, lead, was, adopted } = await planAdopt({ projectId, folder, root, from });
	const { mediaDir } = places(projectId, folder, root);

	const spec = { ...recipe, document: srcFor(mediaDir, docPath) ?? docPath, lead: +lead.toFixed(3), clips };
	const built = await buildPip(projectId, folder, spec);
	/*
	 * After the build, not before.
	 *
	 * buildPip writes clips.json itself — that recipe is how a composition
	 * rebuilds — and it writes only the keys it knows about. Writing ours first
	 * meant the build immediately dropped `document` and `lead`, so the next
	 * adopt could no longer find the document or put the opening card back.
	 */
	const savedSpec = { ...spec };
	delete savedSpec.keep;
	delete savedSpec.adopted;
	delete savedSpec.unmatched;
	await writeFile(recipePath, `${JSON.stringify(savedSpec, null, 2)}\n`, "utf8");
	return { document: docPath, clips, was, words: built.words, seconds: built.seconds, notes: built.notes, adopted };
}

/*
 * What the composition actually says, as opposed to what its recipe remembers.
 *
 * clips.json is the recipe a rebuild works from, and it is only true until
 * somebody edits index.html — which is the entire point of HyperFrames. A pip
 * repointed at a different take, a window nudged, a framing tuned by hand: all
 * of that lives in the composition and none of it gets back to the recipe. The
 * next rebuild then quietly reverts every one of them.
 *
 * That is not a theoretical drift. One real composition here had a pip swapped
 * to a different file, two durations changed, and two in-points moved, none of
 * it in the recipe. So nothing rebuilds from the recipe alone any more: the
 * composition is read first and the recipe is brought up to it.
 *
 * Deliberately a regex over the pip elements rather than a parser. The editor
 * pretty-prints and adds data-hf-id, so the shape of the tag is not stable, but
 * these four attributes are the contract make-pip writes and the runtime reads.
 */
const PIP_TAG = /<video\b[^>]*\bclass="[^"]*\bpip\b[^"]*"[^>]*>/g;
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;

/*
 * Where the pip sits, as the composition states it.
 *
 * Placement is one set of numbers for the whole composition — size, corner,
 * radius — and the recipe did not record it at all, so it lived only in the
 * generated CSS. Anyone who nudged the pip in HyperFrames lost it on the next
 * rebuild, silently, exactly like the clip windows did.
 */
export function readPlacement(html) {
	const num = (name) => {
		const raw = html.match(new RegExp(`--pip-${name}:\\s*(-?[\\d.]+)`))?.[1];
		return raw == null ? null : Number(raw);
	};
	const shot = { size: num("size"), aspect: num("aspect"), right: num("right"), bottom: num("bottom"), radius: num("radius") };
	return Object.fromEntries(Object.entries(shot).filter(([, v]) => Number.isFinite(v)));
}


/*
 * Everything in the composition that a rebuild did not write.
 *
 * buildPip regenerates index.html from the recipe, and the recipe only knows
 * about clips, cards and framing. A background inserted by hand in HyperFrames
 * is in none of those, so every rebuild deleted it without a word — four of
 * them went that way here before anybody noticed, and the loss looked exactly
 * like a framing change misbehaving.
 *
 * Identified by what the generator DOES write rather than by a list of tags:
 * a new component gets kept for free, which is the point. The clock and the
 * two cards are the generator's, and the pips and transcript carry ids it owns.
 */
const GENERATED_ID = /^(pip-\d+|say-\d+|pip-clock|open-field|close-field)$/;

export function foreignElements(html) {
	const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html);
	if (!main) return [];
	const body = main[1];
	const kept = [];

	/*
	 * Depth-counted, not regex-matched.
	 *
	 * A non-greedy tag match closes a transcript block at its FIRST </div>,
	 * which is one of its own word groups — so the block is shredded and its
	 * insides come out as separate top-level elements. Only walking the tags
	 * finds the real top-level children.
	 */
	const TAG = /<(\/?)([a-z][\w-]*)\b([^>]*)>/gi;
	const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
	let depth = 0;
	let openedAt = -1;
	let match;
	while ((match = TAG.exec(body))) {
		const [tag, slash, name, attrs] = match;
		if (VOID.has(name.toLowerCase()) || attrs.trimEnd().endsWith("/")) {
			if (depth === 0) kept.push({ text: tag, attrs });
			continue;
		}
		if (!slash) {
			if (depth === 0) openedAt = match.index;
			depth += 1;
			continue;
		}
		depth -= 1;
		if (depth !== 0 || openedAt < 0) continue;
		const text = body.slice(openedAt, match.index + tag.length);
		kept.push({ text, attrs: /<[a-z][\w-]*\b([^>]*)>/i.exec(text)?.[1] ?? "" });
		openedAt = -1;
	}

	/*
	 * What the generator writes, by id, rather than a list of tags to exclude:
	 * a component nobody has thought of yet is kept for free, which is the point.
	 */
	return kept
		.filter(({ attrs }) => {
			/*
			 * `\bid="` also matches inside data-hf-id="…", because the hyphen
			 * before `id` is a word boundary. That read every pip's id as its
			 * HyperFrames handle, decided none of them were generated, and kept
			 * all six — so the next rebuild emitted them twice. The same shape of
			 * mistake as the anchor that once blanked every speaker name.
			 */
			const id = attrs.match(/(?:^|\s)id="([^"]+)"/)?.[1] ?? "";
			if (GENERATED_ID.test(id)) return false;
			/* The transcript blocks are the only generated elements without an id
			   of their own, and they always carry the say class. */
			return !/\bclass="[^"]*\bsay\b/.test(attrs);
		})
		.map(({ text }) => text.replace(/^\s+/, ""));
}

/*
 * The ground: which wallpaper, and whether it is darkened.
 *
 * Both lived only in the generated CSS. Somebody who changed the wallpaper in
 * HyperFrames, or deleted the darkening gradient because their wallpaper is
 * already dark, got it back on the very next rebuild — over and over, with no
 * indication of what was putting it there.
 */
export function readGround(html) {
	const rule = /\[data-composition-id\]\s*\{[\s\S]*?\}/.exec(html)?.[0] ?? "";
	const background = /background:\s*([\s\S]*?);/.exec(rule)?.[1] ?? "";
	const ground = {};
	const file = background.match(/assets\/wallpapers\/([^"')]+)/)?.[1];
	if (file) ground.wallpaper = file;
	/* The scrim is the gradient layer and the colour under it. Present means the
	   default; gone means somebody took it off on purpose. */
	if (background) ground.scrim = /linear-gradient\(/.test(background);
	return ground;
}

export function readComposition(html) {
	const clips = [];
	for (const [tag] of html.matchAll(PIP_TAG)) {
		const src = attr(tag, "src")?.replace(/^source\//, "");
		if (!src) continue;
		const style = attr(tag, "style") ?? "";
		/* Either spelling counts. make-pip writes --pip-focus; a composition
		   edited by hand often carries the object-position it resolves to, and
		   reading only one of them would call a real framing "unset". */
		const focus = style.match(/--pip-focus:\s*([\d.]+)%/)?.[1] ?? style.match(/object-position:\s*([\d.]+)%/)?.[1];
		const zoom = style.match(/--pip-zoom:\s*([\d.]+)/)?.[1];
		const focusY = style.match(/--pip-y:\s*([\d.]+)/)?.[1];
		clips.push({
			src,
			start: Number(attr(tag, "data-start")) || 0,
			ms: Number(attr(tag, "data-media-start")) || 0,
			dur: Number(attr(tag, "data-duration")) || 0,
			...(focus == null ? {} : { focus: Number(focus) }),
			...(zoom == null ? {} : { zoom: Number(zoom) }),
			...(focusY == null ? {} : { focusY: Number(focusY) }),
		});
	}
	return clips;
}

/**
 * Bring a recipe up to the composition it describes.
 *
 * Returns the recipe and what changed, so a caller can say "3 differences taken
 * from the composition" rather than silently rewriting somebody's file.
 *
 * Refuses on a count mismatch. A composition with a clip added or removed by
 * hand cannot be matched to a recipe by position, and guessing would put one
 * speaker's framing on another's take — the same failure that once blanked
 * every speaker name here.
 */
export function reconcile(recipe, live) {
	if (!live.length || live.length !== recipe.clips.length) {
		return { recipe, changes: [], matched: false };
	}
	const changes = [];
	const clips = recipe.clips.map((clip, i) => {
		const now = live[i];
		const next = { ...clip };
		for (const key of ["src", "ms", "dur", "focus", "zoom", "focusY"]) {
			if (now[key] === undefined) continue;
			const before = clip[key];
			const same = typeof now[key] === "number" ? Math.abs((Number(before) || 0) - now[key]) < 0.002 : before === now[key];
			if (same) continue;
			changes.push(`${clip.speaker ?? clip.src}: ${key} ${before ?? "unset"} → ${now[key]}`);
			next[key] = now[key];
		}
		return next;
	});
	return { recipe: { ...recipe, clips }, changes, matched: true };
}

/**
 * Set the framing in the composition, and change nothing else.
 *
 * Every value here is already a custom property in the file: the placement on
 * the composition rule, the three crop numbers inline on each pip. So this is a
 * substitution, not a render — the wallpaper, the transcript, the cards, the
 * windows and anything inserted by hand come out the other side untouched
 * because they were never read.
 *
 * Pips are matched in document order against the clips they were read from, the
 * same order everything else in this file uses.
 */
export function applyFraming(html, { pip = {}, framing = [], wallpaper = null, scrim = null } = {}) {
	let out = html;

	/*
	 * The ground, when the recipe has an opinion about it.
	 *
	 * Set in place for the same reason as the framing, and it matters more here:
	 * the scrim was the thing that kept coming back. A rebuild honoured
	 * scrim:false, but a rebuild is exactly what must not happen to change a
	 * wallpaper — so without this the setting was true and the file disagreed
	 * with it forever.
	 */
	if (wallpaper != null || scrim != null) {
		out = out.replace(/(\[data-composition-id\][^{]*\{[\s\S]*?)background:[\s\S]*?;/, (rule, head) => {
			const file = wallpaper ?? /assets\/wallpapers\/([^"')]+)/.exec(rule)?.[1] ?? "rm-brand.jpg";
			const url = `url("assets/wallpapers/${file}") center / cover`;
			const keep = scrim == null ? /linear-gradient\(/.test(rule) : scrim !== false;
			return `${head}background: ${
				keep
					? `linear-gradient(color-mix(in srgb, var(--color-dark) 62%, transparent), color-mix(in srgb, var(--color-dark) 78%, transparent)),\n                    ${url},\n                    var(--color-dark)`
					: url
			};`;
		});
	}

	/* Placement, on the composition's own rule. Only the properties that are
	   already declared are replaced: writing new ones would put them in a rule
	   that may not be the one that wins. */
	for (const [name, value, unit] of [
		["size", pip.size, "cqw"],
		["aspect", pip.aspect, ""],
		["right", pip.right, "cqw"],
		["bottom", pip.bottom, "cqw"],
		["radius", pip.radius, "%"],
	]) {
		if (!Number.isFinite(Number(value))) continue;
		out = out.replace(new RegExp(`--pip-${name}:\\s*-?[\\d.]+${unit ? `${unit}` : ""}`), `--pip-${name}: ${value}${unit}`);
	}

	/* The crop, inline on each pip. Rewritten whole rather than patched property
	   by property, so a value that is now the default disappears instead of
	   lingering — a stale --pip-zoom nobody can see is a framing nobody can
	   explain. */
	let at = 0;
	out = out.replace(PIP_TAG, (tag) => {
		const want = framing[at++];
		if (!want) return tag;
		const zoom = Number(want.zoom) || 1;
		const focusY = want.focusY ?? 50;
		const parts = [
			`--pip-focus:${Number(want.focus ?? 50)}%`,
			...(zoom !== 1 ? [`--pip-zoom:${zoom}`] : []),
			...(zoom !== 1 && focusY !== 50 ? [`--pip-y:${focusY}`] : []),
		];
		const style = parts.join(";");
		return /\sstyle="[^"]*"/.test(tag)
			? tag.replace(/\sstyle="[^"]*"/, ` style="${style}"`)
			: tag.replace(/>$/, ` style="${style}">`);
	});
	return out;
}

/**
 * Every pip's framing, for a tool that sets it./**
 * Every pip's framing, for a tool that sets it.
 *
 * Read through the same reconcile as a rebuild, so what a framing UI shows is
 * what is on screen rather than what the recipe last remembered.
 */
export async function readFraming({ projectId, folder, root } = {}) {
	const { outDir, recipePath } = places(projectId, folder, root);
	const recipe = await readRecipe(recipePath, outDir);
	return {
		clips: recipe.clips.map((clip, index) => ({
			index,
			src: clip.src,
			speaker: clip.speaker ?? null,
			focus: Number(clip.focus ?? 50),
			zoom: Number(clip.zoom ?? 1),
			focusY: Number(clip.focusY ?? 50),
			ms: Number(clip.ms) || 0,
			dur: Number(clip.dur) || 0,
		})),
		adopted: recipe.adopted ?? [],
		pip: recipe.pip ?? {},
	};
}

/**
 * Set the framing and rebuild.
 *
 * Only the three framing numbers are taken from the caller. A framing tool has
 * no business moving a window or repointing a clip, and accepting a whole clip
 * list from the browser would let a stale panel overwrite an edit made in
 * HyperFrames since it loaded.
 */
export async function writeFraming({ projectId, folder, root, framing = [], pip = null } = {}) {
	const { outDir, recipePath } = places(projectId, folder, root);
	const recipe = await readRecipe(recipePath, outDir);
	if (framing.length !== recipe.clips.length) {
		throw new Error(`This composition has ${recipe.clips.length} clips and ${framing.length} were sent — reload and try again.`);
	}
	const clips = recipe.clips.map((clip, i) => {
		const want = framing[i] ?? {};
		const zoom = Math.min(4, Math.max(1, Number(want.zoom) || 1));
		return {
			...clip,
			focus: Math.min(100, Math.max(0, Number(want.focus) ?? 50)),
			zoom,
			// Meaningless at zoom 1 — a square cut from 16:9 has no vertical slack
			// until zoom makes some — so it is not written where it cannot apply.
			...(zoom === 1 ? { focusY: 50 } : { focusY: Math.min(100, Math.max(0, Number(want.focusY) ?? 50)) }),
		};
	});
	/*
	 * Placement is optional on the way in.
	 *
	 * A panel that only changed a face's framing must not have to restate where
	 * the pip sits, and sending a partial one must not blank the rest.
	 */
	const clamp = (value, low, high, fallback) => {
		const n = Number(value);
		return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
	};
	const was = recipe.pip ?? {};
	const shot = pip
		? {
				...was,
				size: clamp(pip.size, 4, 100, was.size ?? 46),
				aspect: clamp(pip.aspect, 0.4, 3, was.aspect ?? 1),
				right: clamp(pip.right, -40, 90, was.right ?? -8),
				bottom: clamp(pip.bottom, -40, 90, was.bottom ?? -4),
				radius: clamp(pip.radius, 0, 50, was.radius ?? 50),
			}
		: was;

	/*
	 * Edited in place, never rebuilt.
	 *
	 * Framing is eight numbers and every one of them is already a custom
	 * property in the file — three on each pip, five on the composition. Running
	 * the generator to change them regenerates the whole composition from the
	 * recipe, which throws away everything the recipe does not know about: an
	 * inserted background, a hand-tuned window, anything edited in HyperFrames
	 * since. Nudging a face is not a reason to rewrite a video.
	 *
	 * The same reason /api/hyperframes/insert appends one element and touches
	 * nothing else, rather than rebuilding the cut around it.
	 */
	/* The recipe is what the ground should be; see readRecipe for why it is
	   learned once and owned from then on. */
	const spec0 = recipe;
	const indexPath = join(outDir, "index.html");
	const before = await readFile(indexPath, "utf8");
	const after = applyFraming(before, { pip: shot, framing: clips, wallpaper: spec0.wallpaper ?? null, scrim: spec0.scrim ?? null });
	if (after !== before) {
		await writeFile(`${indexPath}.before-framing`, before, "utf8");
		await writeFile(indexPath, after, "utf8");
	}

	const spec = { ...recipe, clips, pip: shot };
	delete spec.adopted;
	delete spec.unmatched;
	/* `keep` is read from the composition every time, so recording it would be a
	   second copy that can go stale — the exact failure this file exists to end. */
	delete spec.keep;
	await writeFile(recipePath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
	return { clips: clips.length, changed: after !== before, adopted: recipe.adopted ?? [], pip: shot };
}
