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
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

/**
 * Brands added in the Studio, beside the person's settings.
 *
 * Not in ROOT/presets: a Homebrew install keeps the toolkit in its own Cellar
 * folder and replaces it on every upgrade, so a brand saved there would vanish
 * the next time `brew upgrade` ran.
 */
export const USER_PRESETS = join(homedir(), ".config", "rolemodel-openscreen", "presets");

/** The shipped presets first, in the order they have always been offered. */
const SHIPPED_ORDER = ["rolemodel", "academy", "lightning"];
const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

function presetPath(id) {
	if (!PRESET_ID.test(id)) throw new Error(`"${id}" is not a preset name`);
	for (const dir of [resolve(ROOT, "presets"), USER_PRESETS]) {
		const file = resolve(dir, `${id}.json`);
		if (existsSync(file)) return file;
	}
	throw new Error(`no preset called "${id}"`);
}

/** Every preset: the shipped ones, then the ones added on this Mac. */
export async function listPresetIds() {
	const ids = async (dir) => (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
	const shipped = await ids(resolve(ROOT, "presets"));
	const added = (await ids(USER_PRESETS)).filter((id) => !shipped.includes(id) && PRESET_ID.test(id));
	const rank = (id) => (SHIPPED_ORDER.includes(id) ? SHIPPED_ORDER.indexOf(id) : SHIPPED_ORDER.length);
	return [...shipped.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)), ...added.sort()];
}

/**
 * The OpenScreen settings a brand can set, and what each one accepts.
 *
 * Read from OpenScreen's ProjectEditorState (src/components/video-editor/
 * projectPersistence.ts) and the unions beside it. Only the look-and-feel
 * fields: crops, zooms, trims, annotations and the webcam position belong to a
 * recording, not to a brand. verify.mjs checks this list against a checkout, so
 * a field OpenScreen renames fails the build rather than silently doing nothing.
 */
export const PRESET_FIELDS = [
	{ key: "aspectRatio", label: "Aspect ratio", group: "Frame", kind: "select", options: ["16:9", "9:16", "1:1", "4:3", "4:5", "16:10", "10:16", "native"] },
	{ key: "padding", label: "Padding", group: "Frame", kind: "number", min: 0, max: 200, step: 1 },
	{ key: "borderRadius", label: "Corner radius", group: "Frame", kind: "number", min: 0, max: 100, step: 1 },
	{ key: "shadowIntensity", label: "Shadow", group: "Frame", kind: "number", min: 0, max: 1, step: 0.01 },
	{ key: "showBlur", label: "Blur the backdrop", group: "Frame", kind: "boolean" },
	{ key: "motionBlurAmount", label: "Motion blur", group: "Motion", kind: "number", min: 0, max: 1, step: 0.01 },
	{ key: "autoZoomEnabled", label: "Auto zoom", group: "Motion", kind: "boolean" },
	{ key: "autoFocusAll", label: "Auto focus every region", group: "Motion", kind: "boolean" },
	{ key: "cursorTheme", label: "Cursor", group: "Motion", kind: "text" },
	{ key: "webcamLayoutPreset", label: "Webcam layout", group: "Webcam", kind: "select", options: ["picture-in-picture", "vertical-stack", "dual-frame", "no-webcam"] },
	{ key: "webcamMaskShape", label: "Webcam shape", group: "Webcam", kind: "select", options: ["circle", "rounded", "square", "rectangle"] },
	{ key: "webcamSizePreset", label: "Webcam size", group: "Webcam", kind: "number", min: 5, max: 100, step: 1 },
	{ key: "webcamMirrored", label: "Mirror the webcam", group: "Webcam", kind: "boolean" },
	{ key: "webcamReactiveZoom", label: "Webcam follows zoom", group: "Webcam", kind: "boolean" },
	{ key: "exportFormat", label: "Export format", group: "Export", kind: "select", options: ["mp4", "gif"] },
	{ key: "exportQuality", label: "Export quality", group: "Export", kind: "select", options: ["source", "good", "medium"] },
	{ key: "gifFrameRate", label: "GIF frame rate", group: "Export", kind: "select", options: [15, 20, 25, 30] },
	{ key: "gifSizePreset", label: "GIF size", group: "Export", kind: "select", options: ["large", "medium", "original"] },
	{ key: "gifLoop", label: "Loop the GIF", group: "Export", kind: "boolean" },
];

/** The four colours a brand names. The annotation builders read them. */
export const PRESET_COLORS = [
	{ key: "primary", label: "Primary", hint: "Eyebrows, callout backgrounds" },
	{ key: "accent", label: "Accent", hint: "Lower-third subtitles" },
	{ key: "dark", label: "Background", hint: "The plain-colour wallpaper" },
	{ key: "light", label: "Text", hint: "Titles, names, watermark" },
];

const HEX = /^#[0-9a-f]{6}$/i;
const GOOGLE_FONTS = /^https:\/\/fonts\.googleapis\.com\/css2?\?/;

function cleanEditor(editor = {}) {
	const out = {};
	for (const field of PRESET_FIELDS) {
		if (!(field.key in editor)) continue;
		let value = editor[field.key];
		if (field.kind === "boolean") value = value === true || value === "true";
		else if (field.kind === "number") {
			value = Number(value);
			if (!Number.isFinite(value) || value < field.min || value > field.max) throw new Error(`${field.label} must be between ${field.min} and ${field.max}.`);
		} else if (field.kind === "select") {
			const match = field.options.find((o) => String(o) === String(value));
			if (match === undefined) throw new Error(`${field.label} cannot be "${value}".`);
			value = match;
		} else value = String(value).trim() || "default";
		out[field.key] = value;
	}
	return out;
}

function cleanColors(colors = {}) {
	const out = {};
	for (const { key, label } of PRESET_COLORS) {
		const value = String(colors[key] ?? "").trim();
		if (!value) continue;
		if (!HEX.test(value)) throw new Error(`${label} colour must look like #1a2b3c.`);
		out[key] = value.toLowerCase();
	}
	return out;
}

function cleanFonts(fonts = {}) {
	const out = {};
	for (const key of ["display", "mono"]) {
		const value = String(fonts[key] ?? "").trim().replace(/["';{}]/g, "");
		if (value) out[key] = value.slice(0, 80);
	}
	const url = String(fonts.importUrl ?? "").trim();
	if (url) {
		if (!GOOGLE_FONTS.test(url)) throw new Error("The font link must be a fonts.googleapis.com link.");
		out.importUrl = url;
	}
	return out;
}

/**
 * Create or update a brand made on the Brand page.
 *
 * It stands on its own: a new brand is written with the full house settings
 * copied in, not an `extends` link, so changing RoleModel's preset later does
 * not quietly change it. Only brands saved here can be updated — the shipped
 * three are files in the toolkit, and an upgrade would put them back anyway.
 */
export async function savePreset({ id: existing, label, description = "", wallpaperFile = "", colors, fonts, editor } = {}) {
	const name = String(label ?? "").trim();
	if (!name) throw new Error("Give the brand a name.");
	let id = existing ? String(existing) : name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	if (!PRESET_ID.test(id)) throw new Error("Use letters or numbers in the brand name.");
	const file = join(USER_PRESETS, `${id}.json`);
	let current = null;
	if (existing) {
		if (!existsSync(file)) throw new Error("Only brands added on this Mac can be changed. Save it under a new name instead.");
		current = JSON.parse(await readFile(file, "utf8"));
	} else if ((await listPresetIds()).includes(id)) throw new Error(`There is already a brand called "${id}".`);
	const house = current ?? (await loadPreset("rolemodel"));
	// An edit keeps what it does not mention: a save that sends only a new
	// padding must not wipe the brand's colours and fonts.
	const palette = colors === undefined ? (current?.colors ?? {}) : cleanColors(colors);
	const preset = {
		id,
		label: name,
		description: String(description ?? "").trim(),
		// A plain-colour wallpaper is the brand's own background colour.
		wallpaperFile: wallpaperFile === "colour" ? (palette.dark ?? "#000000") : String(wallpaperFile || house.wallpaperFile || ""),
		colors: palette,
		fonts: fonts === undefined ? (current?.fonts ?? {}) : cleanFonts(fonts),
		editor: { ...house.editor, ...cleanEditor(editor) },
		variants: house.variants ?? {},
	};
	await mkdir(USER_PRESETS, { recursive: true });
	await writeFile(file, `${JSON.stringify(preset, null, "\t")}\n`);
	return id;
}

/**
 * The palette and type the annotation builders take for a preset.
 *
 * The house names are primary/tertiary/light/dark; the form says accent for
 * tertiary because that is what it is used as.
 */
export function brandStyle(preset) {
	const c = preset?.colors ?? {};
	const colors = {
		...(c.primary ? { primary: c.primary } : {}),
		...(c.accent ? { tertiary: c.accent, accent: c.accent } : {}),
		...(c.light ? { light: c.light } : {}),
		...(c.dark ? { dark: c.dark } : {}),
	};
	const f = preset?.fonts ?? {};
	const fonts = { ...(f.display ? { display: f.display } : {}), ...(f.mono ? { mono: f.mono } : {}) };
	return { colors, fonts };
}

/** Load a preset, resolving its `extends` chain. */
export async function loadPreset(id, { seen = new Set() } = {}) {
	if (seen.has(id)) throw new Error(`Preset "${id}" extends itself`);
	seen.add(id);

	const preset = JSON.parse(await readFile(presetPath(id), "utf8"));
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
