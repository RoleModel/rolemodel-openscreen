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
import { existsSync } from "node:fs";
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

// Every assertion that reads OpenScreen's TypeScript needs a checkout to read.
// A fresh clone has none, and crashing here means nobody ever sees the ~100
// assertions below that stand on their own — so skip that section loudly
// instead. CI clones OpenScreen and passes --openscreen, so the drift checks
// still gate every tag.
const HAVE_OS = existsSync(resolve(OS_ROOT, "src/components/video-editor/projectPersistence.ts"));
let skipped = 0;

// Skipping is for the default path only. If someone named a checkout with
// --openscreen and it isn't there, that is a broken invocation — and CI names
// one, so silently skipping would drop the drift checks from the tag gate
// while still printing a green run.
if (!HAVE_OS && i !== -1) {
	console.error(`--openscreen ${OS_ROOT} is not an OpenScreen checkout.`);
	process.exit(2);
}

// `ok` and `detail` are thunks: without a checkout the enums they read are
// null, so they must not be evaluated at all.
function osCheck(label, ok, detail = "") {
	if (!HAVE_OS) {
		skipped++;
		return;
	}
	check(label, ok(), typeof detail === "function" ? detail() : detail);
}

if (HAVE_OS) {
	console.log(`\nVerifying against OpenScreen checkout: ${OS_ROOT}\n`);
} else {
	console.log(`\n! No OpenScreen checkout at ${OS_ROOT}`);
	console.log("  Skipping the schema-drift assertions; the rest still run.");
	console.log("  For the full suite: node lib/verify.mjs --openscreen /path/to/openscreen\n");
}

// ---------------------------------------------------------------- field names
const persistence = HAVE_OS ? await src("src/components/video-editor/projectPersistence.ts") : "";
const ifaceMatch = persistence.match(/export interface ProjectEditorState \{([\s\S]*?)\n\}/);
if (HAVE_OS && !ifaceMatch) {
	console.error("Could not find ProjectEditorState — has the file moved?");
	process.exit(2);
}
const knownFields = new Set(
	[...(ifaceMatch?.[1] ?? "").matchAll(/^\s*(\w+)[?]?:/gm)].map((m) => m[1]),
);
if (HAVE_OS) console.log(`ProjectEditorState exposes ${knownFields.size} fields\n`);

// ---------------------------------------------------------------- enum values
const types = HAVE_OS ? await src("src/components/video-editor/types.ts") : "";
const exporterTypes = HAVE_OS ? await src("src/lib/exporter/types.ts") : "";
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
		osCheck(
			`${variant}: every field exists on ProjectEditorState`,
			() => unknown.length === 0,
			() => unknown.join(", "),
		);
		osCheck(
			`${variant}: webcamMaskShape is legal`,
			() => !patch.webcamMaskShape || maskShapes.has(patch.webcamMaskShape),
			patch.webcamMaskShape,
		);
		osCheck(
			`${variant}: exportQuality is legal`,
			() => !patch.exportQuality || quality.has(patch.exportQuality),
			patch.exportQuality,
		);
		osCheck(
			`${variant}: webcamLayoutPreset is legal`,
			() => !patch.webcamLayoutPreset || layoutPresets.has(patch.webcamLayoutPreset),
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
// Empty without a checkout — every `required` list below is asserted through
// osCheck, so an empty list is skipped rather than passing vacuously.
const requiredFields = (name) => {
	const m = types.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
	return m ? [...m[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]) : [];
};
const annRequired = requiredFields("AnnotationRegion");
const styleRequired = requiredFields("AnnotationTextStyle");
const zoomRequired = requiredFields("ZoomRegion");

const samples = [
	...title({ text: "Dock Designer", eyebrow: "Product tour" }),
	...lowerThird({ name: "Dallas Peters", sub: "Senior Designer", startMs: 1000, endMs: 5000 }),
	...callout({ text: "One-click setup", at: { x: 60, y: 40 }, startMs: 6000, endMs: 9000 }),
	...watermark({ endMs: 30000 }),
];
osCheck(
	"annotations carry every required AnnotationRegion field",
	() => samples.every((a) => annRequired.every((f) => f in a)),
	() => annRequired.filter((f) => !(f in samples[0])).join(", "),
);
osCheck(
	"annotation styles carry every required AnnotationTextStyle field",
	() => samples.every((a) => styleRequired.every((f) => f in a.style)),
	() => styleRequired.filter((f) => !(f in samples[0].style)).join(", "),
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
osCheck("zooms carry every required ZoomRegion field", () => zooms.every((z) => zoomRequired.every((f) => f in z)));
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

// ------------------------------------------------------------- wallpapers
// The brand rule this enforces: RoleModel is linear. A radial gradient sneaking
// back into a recipe is how the bottom-border artefact happened the first time,
// and it is invisible in review because it only shows at 16:9.
console.log("\nwallpapers");
{
	const recipes = JSON.parse(await readFile(resolve(ROOT, "brand/wallpapers.json"), "utf8"));
	const wpSrc = await readFile(resolve(ROOT, "lib/wallpaper.mjs"), "utf8");
	const files = await readdir(resolve(ROOT, "brand/wallpapers"));

	check("recipes exist", Array.isArray(recipes) && recipes.length > 0, `${recipes.length} recipes`);
	check("no radial gradients in the drawing code", !/createRadialGradient|radial-gradient/.test(wpSrc));
	check(
		"every recipe has a rendered JPEG",
		recipes.every((r) => files.includes(`${r.name}.jpg`)),
		recipes.filter((r) => !files.includes(`${r.name}.jpg`)).map((r) => r.name).join(", "),
	);
	check("recipe names are unique", new Set(recipes.map((r) => r.name)).size === recipes.length);
	check(
		"every gradient has at least two stops",
		recipes.every((r) => (r.gradient?.stops?.length ?? 0) >= 2),
	);
	check(
		"no recipe still carries the old gradient edge",
		recipes.every((r) => r.edge === undefined),
		recipes.filter((r) => r.edge).map((r) => r.name).join(", "),
	);
	check("every recipe has a border block", recipes.every((r) => r.border && typeof r.border.width === "number"));

	const { normalize } = await import("./wallpaper.mjs");
	check(
		"normalize is idempotent",
		recipes.every((r) => JSON.stringify(normalize(r)) === JSON.stringify(normalize(normalize(r)))),
	);
	check(
		"the Studio invents no colours",
		!/#[0-9a-fA-F]{3,8}\b/.test(
			(await readFile(resolve(ROOT, "lib/studio-ui.mjs"), "utf8")).replace(/%23[0-9a-fA-F]{6}/g, ""),
		),
	);
}

// ------------------------------------------------------------------- optics
// Optics is imported, not copied: brand/optics/optics.css is @rolemodel/optics
// verbatim, and brand/optics/rolemodel-scales.css carries only what the public
// package does not publish. The assertions that matter are that the vendored
// file is still the *live* system rather than a flattened snapshot of it, and
// that every token the UI spends is actually defined somewhere.
console.log("\noptics");
{
	const vendored = await readFile(resolve(ROOT, "brand/optics/optics.css"), "utf8").catch(() => "");
	const scales = await readFile(resolve(ROOT, "brand/optics/rolemodel-scales.css"), "utf8").catch(() => "");
	const manifest = JSON.parse(await readFile(resolve(ROOT, "brand/optics/manifest.json"), "utf8").catch(() => "null"));

	check("vendored Optics exists", vendored.length > 100000, `${vendored.length} bytes`);
	check("it is the real package, not a flattened copy", /hsl\(\s*var\(--op-color-primary-h\)/.test(vendored));
	check("it drives both modes off color-scheme", /color-scheme:\s*light dark/.test(vendored) && vendored.includes("light-dark("));
	check("the ramps are still re-tintable", /--op-color-primary-h:/.test(vendored));
	check("a manifest pins the version", Boolean(manifest?.version), manifest?.version);

	const defined = (css) => new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]));
	const published = defined(vendored);
	const ours = defined(scales);

	check("the supplement exists", ours.size > 0, `${ours.size} tokens`);
	check(
		"the supplement shadows nothing Optics owns",
		[...ours].every((n) => !published.has(n)),
		[...ours].filter((n) => published.has(n)).slice(0, 4).join(", "),
	);

	// The one that earns its keep. Every --op- token the Studio and the video
	// components reference has to resolve, or it renders as an empty value and
	// the element quietly loses its colour — which reads as a component bug.
	// This is exactly how the four academy-primary tokens were found: they are
	// RoleModel's, and the public package has never carried them.
	const consumers = ["lib/studio-ui.mjs", "bin/rm-studio.mjs", "components/rm-video.js"];
	const used = new Set();
	for (const f of consumers) {
		const body = await readFile(resolve(ROOT, f), "utf8");
		for (const m of body.matchAll(/var\(\s*(--op-[a-z0-9-]+)/g)) used.add(m[1]);
	}
	const missing = [...used].filter((n) => !published.has(n) && !ours.has(n));
	check(
		`every --op- token the UI spends is defined (${used.size} used)`,
		missing.length === 0,
		missing.join(", "),
	);
}

// ------------------------------------------------------------- components
// The video components have one hard requirement: time is seeked, not played.
// A `transition`, or a rAF loop driving a value, makes the frame at 2400ms
// depend on when the renderer happened to look — the video then differs between
// runs, which is the kind of bug you only notice in review.
console.log("\ncomponents");
{
	const src = await readFile(resolve(ROOT, "components/rm-video.js"), "utf8");
	const gallery = await readFile(resolve(ROOT, "components/gallery.html"), "utf8");
	const tags = ["rm-scene", "rm-browser", "rm-title", "rm-lower-third", "rm-callout", "rm-stat", "rm-bullets"];

	// Quote-agnostic on purpose. This asserted `define("rm-scene"` and broke the
	// moment a formatter normalised the file to single quotes — a green suite
	// should not depend on which quote character the repo settled on.
	const defines = (t) => new RegExp(`define\\(\\s*['"\`]${t}['"\`]`).test(src);
	check(
		"every component is defined",
		tags.every(defines),
		tags.filter((t) => !defines(t)).join(", "),
	);
	check("the gallery shows every component", tags.filter((t) => t !== "rm-scene").every((t) => gallery.includes(`<${t}`)));
	check("animation is paused, never played", /animation-play-state:\s*paused/.test(src));
	check("no CSS transitions", !/\btransition\s*:/.test(src));
	check("every animation is positioned by --t", !/animation-delay:(?![^;]*var\(--t\))/.test(src));
	check(
		"colour literals only appear as var() fallbacks",
		[...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].every((mm) => {
			const before = src.slice(Math.max(0, mm.index - 90), mm.index);
			return /var\(\s*--op-[a-z0-9-]+\s*,\s*$/.test(before);
		}),
	);
	check("the scene template exists", (await readFile(resolve(ROOT, "components/scene.html"), "utf8")).includes("rm-scene"));

	// Both this file and lib/studio-ui.mjs build CSS inside template literals, and
	// a backtick in a CSS comment silently ends the literal — the module then
	// fails to parse and the page renders as unstyled tags. Cheap to assert, and
	// it has now bitten twice.
	for (const f of ["components/rm-video.js", "lib/studio-ui.mjs", "bin/rm-studio.mjs"]) {
		const { ok } = await import("node:child_process").then((cp) =>
			new Promise((r) => cp.execFile(process.execPath, ["--check", resolve(ROOT, f)], (e) => r({ ok: !e }))),
		);
		check(`${f} parses`, ok);
	}
}

// ------------------------------------------------------------- narration
// The contract that matters: subtitle timings come from measured durations, so
// they cannot drift from the audio. Assert it against synthetic clips rather
// than running a real synth pass, which would need voice data in CI.
console.log("\nnarration");
{
	const { parseScript, estimateSeconds } = await import("./script-parse.mjs");
	const { srt, vtt } = await import("./narration.mjs");

	const md = [
		"# Heading is not spoken",
		"",
		"First line. Second sentence on the same line.",
		"- A bullet keeps its words",
		"```",
		"code is not spoken",
		"```",
		"---",
		"**Bold** and `code` lose their marks.",
	].join("\n");
	const lines = parseScript(md);

	check("headings are not spoken", !lines.some((l) => l.includes("Heading")));
	check("fenced code is not spoken", !lines.some((l) => l.includes("code is not spoken")));
	check("horizontal rules are dropped", !lines.some((l) => /^-{3,}$/.test(l)));
	check("bullets keep their words, lose the marker", lines.includes("A bullet keeps its words"));
	check("one sentence per line", lines.includes("First line.") && lines.includes("Second sentence on the same line."));
	check("inline marks are stripped", lines.includes("Bold and code lose their marks."));
	check("estimate scales with words", estimateSeconds(lines, 0) > 0);

	const clips = [
		{ text: "one", seconds: 2 },
		{ text: "two", seconds: 3 },
		{ text: "three", seconds: 1.5 },
	];
	const out = srt(clips, { gapMs: 500 });
	check("srt is 1-indexed", out.startsWith("1\n"));
	check("srt starts at zero", out.includes("00:00:00,000 --> 00:00:02,000"));
	// 2 + 0.5 = 2.5 -> 5.5, then + 0.5 = 6.0 -> 7.5
	check("srt accumulates duration plus gap", out.includes("00:00:02,500 --> 00:00:05,500"));
	check("the last cue lands where the audio ends", out.includes("00:00:06,000 --> 00:00:07,500"));
	check("a cue exists for every line", out.trim().split(/\n\n/).length === clips.length);
	check("vtt is the same timeline with dots", vtt(clips, { gapMs: 500 }).includes("00:00:02.500 --> 00:00:05.500"));
}

// ------------------------------------------------------------- job allowlist
console.log("\njob allowlist");
{
	const jobs = await import("./jobs.mjs");
	jobs.setTrustedRoot(ROOT);
	const refuses = (bin) => {
		try {
			jobs.run({ bin, args: [] });
			return false;
		} catch {
			return true;
		}
	};
	check("refuses a shell", refuses("/bin/sh"));
	check("refuses a path outside the install", refuses("/tmp/evil"));
	check("refuses an unlisted bare name", refuses("curl"));
	check("allowlist covers the pipeline", ["openscreen", "rm-voice", "rm-mux", "playwright-recast", "ffmpeg"].every((b) => jobs.BINARIES.has(b)));
}

const skipNote = skipped ? `, ${skipped} skipped (no OpenScreen checkout)` : "";
console.log(`\n${pass} passed, ${failures.length} failed${skipNote}\n`);
if (failures.length) {
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
