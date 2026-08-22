#!/usr/bin/env node
/**
 * Verifies the brand layer against OpenScreen's own source of truth.
 *
 * The presets are a patch onto someone else's typed document. If a field name
 * or an enum value drifts, OpenScreen will quietly normalise it back to a
 * default and the video will look stock — a silent failure, which is the worst
 * kind. So rather than trusting the values I wrote, this reads the enums and
 * the ProjectEditorState interface straight out of a checkout and asserts
 * against them.
 *
 *   node lib/verify.mjs --openscreen /path/to/openscreen
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callout, lowerThird, title, watermark, zoomRhythm } from "./annotations.mjs";
import { annotationList, applyTheme, buildEditorPatch, loadPreset, zoomList } from "./theme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--openscreen");
const OS_ROOT = i !== -1 ? process.argv[i + 1] : resolve(ROOT, "../openscreen");

let pass = 0;
const failures = [];
function check(label, ok, detail = "") {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

const src = async (p) => readFile(resolve(OS_ROOT, p), "utf8");

console.log(`\nVerifying against OpenScreen checkout: ${OS_ROOT}\n`);

// ---------------------------------------------------------------- field names
const persistence = await src("src/components/video-editor/projectPersistence.ts");
const ifaceMatch = persistence.match(/export interface ProjectEditorState \{([\s\S]*?)\n\}/);
if (!ifaceMatch) {
	console.error("Could not find ProjectEditorState — has the file moved?");
	process.exit(2);
}
const knownFields = new Set(
	[...ifaceMatch[1].matchAll(/^\s*(\w+)[?]?:/gm)].map((m) => m[1]),
);
console.log(`ProjectEditorState exposes ${knownFields.size} fields\n`);

// ---------------------------------------------------------------- enum values
const types = await src("src/components/video-editor/types.ts");
const exporterTypes = await src("src/lib/exporter/types.ts");
const union = (text, name) => {
	const m = text.match(new RegExp(`export type ${name} =([^;]*);`));
	return m ? new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])) : null;
};
const maskShapes = union(types, "WebcamMaskShape");
const quality = union(exporterTypes, "ExportQuality");
const layoutPresets = new Set(
	[...persistence.matchAll(/case "(picture-in-picture|no-webcam|vertical-stack|dual-frame)":/g)].map(
		(m) => m[1],
	),
);

// ---------------------------------------------------------------- the presets
const presetIds = (await readdir(resolve(ROOT, "presets")))
	.filter((f) => f.endsWith(".json"))
	.map((f) => f.replace(/\.json$/, ""));

for (const id of presetIds) {
	console.log(`preset: ${id}`);
	const preset = await loadPreset(id);
	const variants = Object.keys(preset.variants ?? {}).filter((k) => !k.startsWith("$"));

	for (const variant of variants) {
		const patch = buildEditorPatch(preset, { variant });
		const unknown = Object.keys(patch).filter((k) => !knownFields.has(k));
		check(`${variant}: every field exists on ProjectEditorState`, unknown.length === 0, unknown.join(", "));
		check(
			`${variant}: webcamMaskShape is legal`,
			!patch.webcamMaskShape || maskShapes.has(patch.webcamMaskShape),
			patch.webcamMaskShape,
		);
		check(
			`${variant}: exportQuality is legal`,
			!patch.exportQuality || quality.has(patch.exportQuality),
			patch.exportQuality,
		);
		check(
			`${variant}: webcamLayoutPreset is legal`,
			!patch.webcamLayoutPreset || layoutPresets.has(patch.webcamLayoutPreset),
			patch.webcamLayoutPreset,
		);
		check(
			`${variant}: layout survives its aspect ratio`,
			!(patch.webcamLayoutPreset === "vertical-stack" && !/^(\d+):(\d+)$/.test(patch.aspectRatio ?? "")) ||
				(() => {
					const [w, h] = patch.aspectRatio.split(":").map(Number);
					return h > w;
				})(),
			`${patch.webcamLayoutPreset} @ ${patch.aspectRatio}`,
		);
		check(`${variant}: wallpaper resolves to a URL`, /^file:\/\//.test(patch.wallpaper ?? ""));
	}

	for (const unit of Object.keys(preset.units ?? {}).filter((k) => !k.startsWith("$"))) {
		const p = buildEditorPatch(preset, { unit });
		const declared = preset.units[unit].wallpaperFile;
		check(
			`unit ${unit}: ${declared ? "uses its own wallpaper" : "falls back cleanly (no wallpaper set)"}`,
			declared ? p.wallpaper.includes(declared) : Boolean(p.wallpaper),
		);
	}
	console.log("");
}

// ------------------------------------------------------- annotation + zoom shape
console.log("annotation & zoom shape");
const annIface = types.match(/export interface AnnotationRegion \{([\s\S]*?)\n\}/)[1];
const annRequired = [...annIface.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
const styleIface = types.match(/export interface AnnotationTextStyle \{([\s\S]*?)\n\}/)[1];
const styleRequired = [...styleIface.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
const zoomIface = types.match(/export interface ZoomRegion \{([\s\S]*?)\n\}/)[1];
const zoomRequired = [...zoomIface.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);

const samples = [
	...title({ text: "Dock Designer", eyebrow: "Product tour" }),
	...lowerThird({ name: "Dallas Peters", sub: "Senior Designer", startMs: 1000, endMs: 5000 }),
	...callout({ text: "One-click setup", at: { x: 60, y: 40 }, startMs: 6000, endMs: 9000 }),
	...watermark({ endMs: 30000 }),
];
check(
	"annotations carry every required AnnotationRegion field",
	samples.every((a) => annRequired.every((f) => f in a)),
	annRequired.filter((f) => !(f in samples[0])).join(", "),
);
check(
	"annotation styles carry every required AnnotationTextStyle field",
	samples.every((a) => styleRequired.every((f) => f in a.style)),
	styleRequired.filter((f) => !(f in samples[0].style)).join(", "),
);
check("annotation type is a legal AnnotationType", samples.every((a) => a.type === "text"));
check(
	"annotation positions stay inside the frame",
	samples.every((a) => a.position.x >= 0 && a.position.x <= 100 && a.position.y >= 0 && a.position.y <= 100),
);

const zooms = zoomRhythm([
	{ atMs: 2000, at: { x: 0.3, y: 0.4 } },
	{ atMs: 9000, at: { x: 0.7, y: 0.6 }, holdMs: 400 },
]);
check("zooms carry every required ZoomRegion field", zooms.every((z) => zoomRequired.every((f) => f in z)));
check("zoom focus is normalised 0–1", zooms.every((z) => z.focus.cx <= 1 && z.focus.cy <= 1));
check("zoom depth is within 1–6", zooms.every((z) => z.depth >= 1 && z.depth <= 6));
check("short zoom beats are floored to 1200ms", zooms[1].endMs - zooms[1].startMs >= 1200);

// ------------------------------------------------------- round-trip both shapes
console.log("\ndocument round-trip");
const preset = await loadPreset("rolemodel");
const patch = buildEditorPatch(preset, { variant: "master" });

const v7 = {
	schemaVersion: 7,
	project: { id: "p1", title: "t", createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z" },
	assets: [],
	timeline: { clips: [], gaps: [], trimRanges: [], muteRanges: [], speedRanges: [], captionRanges: [] },
	annotations: [],
	zoomRanges: [],
	legacyEditor: { padding: 50 },
};
applyTheme(v7, patch);
annotationList(v7).push(...title({ text: "x" }));
zoomList(v7).push(...zooms);
check("v7: patch lands on legacyEditor", v7.legacyEditor.padding === patch.padding);
check("v7: annotations land on document.annotations", v7.annotations.length > 0);
check("v7: zooms land on document.zoomRanges", v7.zoomRanges.length === zooms.length);
check("v7: schemaVersion untouched", v7.schemaVersion === 7);

const v2 = { version: 2, editor: { padding: 50, zoomRegions: [], annotationRegions: [] } };
applyTheme(v2, patch);
annotationList(v2).push(...title({ text: "x" }));
zoomList(v2).push(...zooms);
check("v2: patch lands on editor", v2.editor.padding === patch.padding);
check("v2: annotations land on editor.annotationRegions", v2.editor.annotationRegions.length > 0);
check("v2: zooms land on editor.zoomRegions", v2.editor.zoomRegions.length === zooms.length);

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
