/**
 * Applies a RoleModel brand preset to an OpenScreen project file.
 *
 * No fork required. `.openscreen` is a plain JSON document (`AxcutDocument`,
 * Zod-typed, schemaVersion 7) and every appearance setting the editor exposes
 * lives in it. This module patches that document and nothing else, so it keeps
 * working across OpenScreen upgrades as long as the field names hold.
 *
 * Two document shapes exist in the wild and both are handled:
 *   v7  — { schemaVersion: 7, legacyEditor: {...}, zoomRanges: [], annotations: [] }
 *   v2  — { version: 2, editor: {...} }            (pre-merge editor, still readable)
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Toolkit root. Resolved from this file's own location so it is correct however
 * the package was installed — a git checkout, `npm i -g`, or a Homebrew keg
 * where the tree lives under `libexec` and only `bin/rm-video` is symlinked
 * onto PATH. `RM_OPENSCREEN_HOME` overrides it for unusual layouts.
 */
export const ROOT = process.env.RM_OPENSCREEN_HOME
	? resolve(process.env.RM_OPENSCREEN_HOME)
	: resolve(HERE, "..");

/** Load a preset, resolving its `extends` chain. */
export async function loadPreset(id, { seen = new Set() } = {}) {
	if (seen.has(id)) throw new Error(`Preset "${id}" extends itself`);
	seen.add(id);

	const preset = JSON.parse(await readFile(resolve(ROOT, "presets", `${id}.json`), "utf8"));
	if (!preset.extends) return preset;

	const base = await loadPreset(preset.extends, { seen });
	return {
		...base,
		...preset,
		editor: { ...base.editor, ...preset.editor },
		variants: { ...base.variants, ...preset.variants },
		rationale: { ...base.rationale, ...preset.rationale },
	};
}

/**
 * Resolve the wallpaper to a value OpenScreen will accept.
 *
 * A plain absolute path, not a file URL. This used to hand over
 * `pathToFileURL(abs).href` on the reasoning that the app rewrites only its own
 * bundled wallpapers and passes anything else through untouched. The first half
 * is true — the app's matcher is
 *
 *   /^file:\/\/.*?\/(?:resources\/(?:assets\/)?|public\/)wallpapers\/(wallpaper\d+\.jpg)$/i
 *
 * and it returns the value unchanged when that does not match. The conclusion
 * was wrong, because the thing on the other side of the pass-through is the
 * compositor, which opens the value as a filesystem path. Given a URL it tries
 * to open a file literally named `file:///Users/...` and fails:
 *
 *   [compositor] wallpaper image "file:///…/rm-dark-dotgrid.jpg" :
 *     No such file or directory (os error 2)
 *
 * once per frame — 1804 times in a 30-second export — while the export still
 * exits 0 and writes an MP4 with no wallpaper on it. A silent visual failure,
 * which is why it survived. Measured: 1804 complaints and 20MB with the URL,
 * zero complaints and 32.7MB with the path, same source recording.
 *
 * A file URL arriving from an existing document is converted rather than passed
 * along, so re-branding a document written by the old code repairs it.
 */
/**
 * A Homebrew path that survives the next upgrade.
 *
 * `ROOT` resolves from this file's own location, which under Homebrew is
 *
 *   /opt/homebrew/Cellar/rm-video/0.0.1/libexec
 *
 * — correct for READING at runtime, and ruinous the moment it is written into a
 * saved document, because the version is IN the path. Upgrading to 0.1.0 left
 * every document ever branded pointing at a keg Homebrew had deleted:
 *
 *   [compositor] wallpaper image ".../0.0.1/libexec/brand/wallpapers/academy-ruby.jpg"
 *     : No such file or directory (os error 2)
 *
 * once per frame, while the export still exits 0 and writes an MP4 with no
 * wallpaper on it — the same silent visual failure the file-URL bug above
 * produced, arriving by a different route.
 *
 * Homebrew maintains `opt/<formula>` as a symlink to the current keg for exactly
 * this reason, so the fix is to write that instead. Anything that is not a
 * Cellar path is returned untouched: a checkout, an `npm i -g`, and a user's own
 * file all have stable paths already.
 */
export function stablePath(abs) {
	if (typeof abs !== "string") return abs;
	// The version segment is what makes this necessary, so it is what gets
	// dropped — and only when the shape is unmistakably a keg.
	return abs.replace(/^(.*)\/Cellar\/([^/]+)\/[^/]+\//, "$1/opt/$2/");
}

export function resolveWallpaper(file, { wallpaperDir = resolve(ROOT, "brand/wallpapers") } = {}) {
	if (!file) return null;
	// The app also accepts a bare colour here, and a colour is not a path.
	if (file.startsWith("#")) return file;
	if (/^https?:/.test(file)) return file;
	// Both conversions on the way through, so re-branding a document written by
	// either older version repairs it rather than carrying the fault forward.
	if (/^file:/.test(file)) return stablePath(fileURLToPath(file));
	return stablePath(isAbsolute(file) ? file : resolve(wallpaperDir, file));
}

/** The ProjectEditorState patch for a preset + optional variant + optional Academy unit. */
export function buildEditorPatch(preset, { variant, unit, wallpaperDir } = {}) {
	const patch = { ...preset.editor };

	// `$`-prefixed keys are authoring notes in the preset JSON, not selectable
	// entries — don't let one be addressed as a unit or a variant.
	const selectable = (o) => Object.keys(o ?? {}).filter((k) => !k.startsWith("$"));

	let wallpaperFile = preset.wallpaperFile;
	if (unit) {
		const u = unit.startsWith("$") ? undefined : preset.units?.[unit];
		if (!u) {
			throw new Error(
				`Preset "${preset.id}" has no unit "${unit}". Known: ${selectable(preset.units).join(", ") || "none"}`,
			);
		}
		if (u.wallpaperFile) wallpaperFile = u.wallpaperFile;
	}

	if (variant) {
		const v = variant.startsWith("$") ? undefined : preset.variants?.[variant];
		if (!v) {
			throw new Error(
				`Preset "${preset.id}" has no variant "${variant}". Known: ${selectable(preset.variants).join(", ")}`,
			);
		}
		for (const [k, val] of Object.entries(v)) {
			if (!k.startsWith("$")) patch[k] = val;
		}
	}

	const wallpaper = resolveWallpaper(wallpaperFile, { wallpaperDir });
	if (wallpaper) patch.wallpaper = wallpaper;

	// vertical-stack is silently downgraded on landscape and dual-frame on portrait.
	// Catch it here rather than letting the app quietly pick something else.
	const portrait = isPortrait(patch.aspectRatio);
	if (patch.webcamLayoutPreset === "vertical-stack" && !portrait) {
		patch.webcamLayoutPreset = "picture-in-picture";
	}
	if (patch.webcamLayoutPreset === "dual-frame" && portrait) {
		patch.webcamLayoutPreset = "picture-in-picture";
	}

	return patch;
}

function isPortrait(aspectRatio) {
	if (typeof aspectRatio !== "string") return false;
	const [w, h] = aspectRatio.split(":").map(Number);
	return Number.isFinite(w) && Number.isFinite(h) && h > w;
}

/** Detect which document shape we were handed. */
export function detectShape(doc) {
	if (typeof doc?.schemaVersion === "number") return "axcut";
	if (doc?.editor && typeof doc.version === "number") return "legacy";
	if (doc?.legacyEditor) return "axcut";
	throw new Error(
		"Unrecognised .openscreen document: no `schemaVersion` and no v2 `editor` block.",
	);
}

/** Apply the patch in place and return the document. */
export function applyTheme(doc, patch) {
	const shape = detectShape(doc);
	if (shape === "axcut") {
		doc.legacyEditor = { ...(doc.legacyEditor ?? {}), ...patch };
		doc.project = { ...(doc.project ?? {}), updatedAt: doc.project?.updatedAt };
	} else {
		doc.editor = { ...(doc.editor ?? {}), ...patch };
	}
	return doc;
}

/** Where zoom regions live, per shape. */
export function zoomList(doc) {
	return detectShape(doc) === "axcut"
		? (doc.zoomRanges ??= [])
		: (doc.editor.zoomRegions ??= []);
}

/** Where annotation regions live, per shape. */
export function annotationList(doc) {
	return detectShape(doc) === "axcut"
		? (doc.annotations ??= [])
		: (doc.editor.annotationRegions ??= []);
}

/**
 * Read an OpenScreen document.
 *
 * This was a bare `JSON.parse(await readFile(...))`, so a document that was not
 * there came back as a fourteen-line ENOENT stack ending inside
 * node:internal/fs/promises. That says where Node gave up, not what went wrong.
 *
 * The case worth naming is the one that produced it: a `brand` step running
 * after a `record` that wrote nothing. The path in the error is exactly the
 * right path — it was simply never created — so the useful answer is what the
 * directory actually holds, which is usually nothing.
 */
export async function readProject(path) {
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if (err.code === "EISDIR") throw new Error(`${path} is a directory, not an OpenScreen document`);
		if (err.code !== "ENOENT") throw err;
		const dir = dirname(path);
		const listing = await readdir(dir).catch(() => null);
		if (listing === null) throw new Error(`no such directory: ${dir}`);
		const docs = listing.filter((f) => f.endsWith(".openscreen"));
		throw new Error(
			`no OpenScreen document at ${path}\n` +
				(docs.length
					? `  ${dir} holds: ${docs.join(", ")}`
					: `  ${dir} holds no .openscreen document at all — a recording has to write one before it can be branded`),
		);
	}
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new Error(`${path} is not valid JSON, so it is not an OpenScreen document — ${err.message}`);
	}
}

export async function writeProject(path, doc) {
	if (doc.project) doc.project.updatedAt = new Date().toISOString();
	await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/**
 * The crop that removes a padded capture's dead space.
 *
 * A window capture on a HiDPI Mac can come back drawn into a display-sized
 * buffer: the content fills the width and stops short of the bottom, with pure
 * black below it for the whole recording. OpenScreen's own
 * `captureOutputSize` exists to prevent exactly this (its comment cites issue
 * #418) and guards the display case; a window recorded at 1920x980 into a
 * 3840x2160 buffer still arrives with a 200px black band.
 *
 * Compositing that faithfully is worse than useless — the band is *inside* the
 * framed window, so it reads as part of the recording rather than as an
 * artifact. A crop is the fix that costs nothing: `cropRegion` is a clip field
 * the exporter already applies, so nothing is re-encoded and the editor shows
 * the same framing it will render.
 *
 * Returns null when there is nothing to trim, so an untouched clip stays lean —
 * the schema asks for the identity region to be absent rather than stored.
 *
 * `probe` runs a command and hands back stdout as bytes; injected so this stays
 * testable without a video.
 */
export const CROP_BLACK_CEILING = 6; // a sampled pixel at or under this is black
export const CROP_MIN_TRIM = 0.005; // under half a percent is rounding, not padding
// A 64-row probe quantises the answer to 1/64 of the frame, which on a real
// padded capture left ~31px of black still in shot — the crop has to be at least
// as tight as the padding, or it has not fixed anything. 256 puts the error under
// half a percent, and a 256x256 grey frame is 64KB, which is nothing.
const CROP_PROBE_W = 256;
const CROP_PROBE_H = 256;

export async function detectPadding(videoPath, { probe, at = 1 } = {}) {
	const frame = await probe("ffmpeg", [
		/*
		 * `-ignore_editlist 1`, before -i, because it is a demuxer option.
		 *
		 * MP4s from Apple software — QuickTime screen recordings, iPhone footage,
		 * Final Cut exports — carry an `elst` edit list, and seeking into one makes
		 * ffmpeg's mov demuxer say:
		 *
		 *   st: 0 edit list: 1 Missing key frame while searching for timestamp: 1001
		 *   st: 0 edit list 1 Cannot find an index entry before timestamp: 1001.
		 *
		 * It still returns a frame, so this looked harmless — but the frame is the
		 * wrong one: the seek lands where the demuxer could reach rather than where
		 * it was asked for, so padding is detected against a frame from somewhere
		 * else in the video. On a recording that starts on a title card, that is a
		 * crop measured against the title card.
		 *
		 * And it is the loudest thing in the Console during an import, which makes a
		 * working import look like a broken one.
		 */
		"-ignore_editlist", "1",
		"-v", "error", "-ss", String(at), "-i", videoPath, "-frames:v", "1",
		"-vf", `scale=${CROP_PROBE_W}:${CROP_PROBE_H}`, "-f", "rawvideo", "-pix_fmt", "gray", "-",
	]);
	if (!frame || frame.length < CROP_PROBE_W * CROP_PROBE_H) return null;

	const rowIsBlack = (y) => {
		for (let x = 0; x < CROP_PROBE_W; x++) if (frame[y * CROP_PROBE_W + x] > CROP_BLACK_CEILING) return false;
		return true;
	};
	const colIsBlack = (x) => {
		for (let y = 0; y < CROP_PROBE_H; y++) if (frame[y * CROP_PROBE_W + x] > CROP_BLACK_CEILING) return false;
		return true;
	};

	let top = 0;
	while (top < CROP_PROBE_H && rowIsBlack(top)) top++;
	if (top === CROP_PROBE_H) return null; // an all-black frame says nothing useful
	let bottom = CROP_PROBE_H - 1;
	while (bottom > top && rowIsBlack(bottom)) bottom--;
	let left = 0;
	while (left < CROP_PROBE_W && colIsBlack(left)) left++;
	let right = CROP_PROBE_W - 1;
	while (right > left && colIsBlack(right)) right--;

	const region = {
		x: left / CROP_PROBE_W,
		y: top / CROP_PROBE_H,
		width: (right - left + 1) / CROP_PROBE_W,
		height: (bottom - top + 1) / CROP_PROBE_H,
	};
	const trimmed = 1 - region.width * region.height;
	return trimmed >= CROP_MIN_TRIM ? region : null;
}
