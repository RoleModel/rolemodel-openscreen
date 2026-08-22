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
import { readFile, writeFile } from "node:fs/promises";
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
 * The app rewrites only its own known bundled paths (`/wallpapers/wallpaperN.jpg`);
 * anything else passes through untouched, so an absolute file URL works. That is
 * the least invasive option and it is what this uses. The tidier fix — a
 * user-wallpapers folder the app scans — is a small upstream contribution, not
 * a reason to fork.
 */
export function resolveWallpaper(file, { wallpaperDir = resolve(ROOT, "brand/wallpapers") } = {}) {
	if (!file) return null;
	if (/^(https?|file):/.test(file)) return file;
	const abs = isAbsolute(file) ? file : resolve(wallpaperDir, file);
	return pathToFileURL(abs).href;
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

export async function readProject(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

export async function writeProject(path, doc) {
	if (doc.project) doc.project.updatedAt = new Date().toISOString();
	await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}
