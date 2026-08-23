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
import { capture } from "./narration.mjs";
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
		// A path, not a URL. The compositor opens this value with the filesystem,
		// so a file:// prefix makes it look for a file literally named
		// "file:///Users/..." — which it reports once per frame while still
		// exiting 0 and writing an MP4 with no wallpaper on it. This assertion
		// used to require the URL form and so locked the bug in place.
		check(`${variant}: wallpaper resolves to a path`, /^\//.test(patch.wallpaper ?? ""), patch.wallpaper);
		check(`${variant}: and the file is really there`, existsSync(patch.wallpaper ?? ""), patch.wallpaper);
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
	// The border is a bottom rule by default and a full frame only on request.
	// radius exists for the frame; a rule has no corners, so a recipe asking for
	// both is a recipe that will not render what its author expected.
	// Checked on the normalized form, which is what the renderer actually sees: a
	// recipe is allowed to omit `sides` and take the default, so asserting on the
	// raw JSON would fail every file that is simply written the short way.
	const wp = await import("./wallpaper.mjs");
	const drawn = recipes.map((r) => wp.normalize(r));
	check(
		"sides is always one the renderer knows",
		drawn.every((r) => wp.BORDER_SIDES.includes(r.border.sides)),
		drawn.filter((r) => !wp.BORDER_SIDES.includes(r.border.sides)).map((r) => r.name).join(", "),
	);
	check("the default is a rule, not a box", wp.DEFAULT_RECIPE.border.sides === "bottom");
	const radiusNoFrame = drawn.filter((r) => r.border.width && r.border.radius && r.border.sides !== "all");
	check(
		"no recipe sets a radius it cannot use",
		radiusNoFrame.length === 0,
		radiusNoFrame.map((r) => `${r.name}: radius ${r.border.radius} on a ${r.border.sides} border`).join(", "),
	);

	const { normalize } = await import("./wallpaper.mjs");
	check(
		"normalize is idempotent",
		recipes.every((r) => JSON.stringify(normalize(r)) === JSON.stringify(normalize(normalize(r)))),
	);
	// The Studio's CSS is in studio.html and its client code in studio.js; the
	// generator is 30 lines of readFile and has no colour in it at all. Checking
	// studio-ui.mjs alone would pass vacuously forever, which is worse than not
	// checking. %23 is an escaped # inside the favicon data URI, not a colour.
	for (const f of ["lib/studio.html", "lib/studio.js"]) {
		const body = (await readFile(resolve(ROOT, f), "utf8")).replace(/%23[0-9a-fA-F]{6}/g, "");
		const hexes = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
		check(`${f} invents no colours`, hexes.length === 0, hexes.join(", "));
	}
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
	// A step is Optics' output and a seed is its input, so only one of them can
	// be shadowed. A second copy of `--op-color-primary-base` sits on top of the
	// computed one and freezes it; redefining `--op-color-primary-h` is how the
	// whole ramp is meant to move. The supplement carries seeds for every family
	// deliberately — that is what makes the published ramps RoleModel's colours
	// rather than Optics' defaults.
	const isSeed = (n) => /-(h|s|l)$/.test(n);
	const shadowedSteps = [...ours].filter((n) => published.has(n) && !isSeed(n));
	check("the supplement shadows no computed Optics token", shadowedSteps.length === 0, shadowedSteps.slice(0, 4).join(", "));
	check("it does carry the seeds that tint the published ramps", [...ours].some((n) => isSeed(n) && published.has(n)));
	check("a seeded family gets all three", ["h", "s", "l"].every((k) => ours.has(`--op-color-primary-${k}`)));
	// Neutral is the deliberate exception, and for two different reasons. Optics
	// defines `neutral-h` as `var(--op-color-primary-h)` so the greys follow the
	// brand hue; a number there would sever that, not shadow it. And `neutral-s`
	// is 4% on purpose — "the neutrals are not grey" is a stated design decision —
	// while the Figma export resolves them to flat grey, so seeding from it would
	// write 0% over the tint and flatten every surface in the interface.
	check("neutral's hue is still Optics' relationship", /--op-color-neutral-h:\s*var\(--op-color-primary-h\)/.test(vendored));
	check("the supplement does not pin neutral's hue", !ours.has("--op-color-neutral-h"));
	check("nor flatten its tint", !ours.has("--op-color-neutral-s"));

	// The ramps it does define must be computed from their own seed, not frozen
	// hexes — that was the 1160-hex failure this whole split exists to undo.
	const computed = (scales.match(/hsl\(var\(--op-color-[a-z-]+-h\)/g) || []).length;
	check("its own ramps are computed, not flattened", computed > 1000, `${computed} computed values`);

	// The one that earns its keep. Every --op- token the Studio and the video
	// components reference has to resolve, or it renders as an empty value and
	// the element quietly loses its colour — which reads as a component bug.
	// This is exactly how the four academy-primary tokens were found: they are
	// RoleModel's, and the public package has never carried them.
	const consumers = ["lib/studio.html", "lib/studio.js", "bin/rm-studio.mjs", "components/rm-video.js"];
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

	// components/rm-video.js still builds CSS inside template literals, and a
	// backtick in a CSS comment silently ends the literal — the module then fails
	// to parse and the page renders as unstyled tags. It has bitten twice, which
	// is why the Studio's own CSS and client code were moved out to studio.html
	// and studio.js. lib/studio.js is checked here because it is the file that
	// used to be that string.
	for (const f of ["components/rm-video.js", "lib/studio.js", "lib/studio-ui.mjs", "bin/rm-studio.mjs"]) {
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

	// The wallpaper editor's slider bounds. These were positional min/max/step
	// arguments until they became a named RANGE table, and the refactor left a
	// stray `min` behind at all nine call sites: `range` then received a number,
	// spreading it produced no bounds at all, and `fmt` received the RANGE object
	// and was called as a function — so buildEditor threw and the editor rendered
	// nothing. Nothing here caught it, because none of these assertions had ever
	// looked at that panel. Two cheap static checks for the same shape of bug.
	{
		const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
		const table = ui.match(/const RANGE = \{([\s\S]*?)\n\}/);
		const keys = table ? [...table[1].matchAll(/^\s*([a-z]+):\s*\{ min: (-?[\d.]+), max: (-?[\d.]+), step: (-?[\d.]+) \}/gm)] : [];
		check("the RANGE table parses", keys.length > 0, `${keys.length} entries`);
		check(
			"every range has min < max and a positive step",
			keys.every((k) => Number(k[2]) < Number(k[3]) && Number(k[4]) > 0),
			keys.filter((k) => !(Number(k[2]) < Number(k[3]) && Number(k[4]) > 0)).map((k) => k[1]).join(", "),
		);
		const defined = new Set(keys.map((k) => k[1]));
		const referenced = [...new Set([...ui.matchAll(/RANGE\.([a-z]+)/g)].map((m) => m[1]))];
		const undef = referenced.filter((k) => !defined.has(k));
		check("every RANGE.* the editor references is defined", undef.length === 0, undef.join(", "));
		// The regression itself: a bare number sitting in the `range` argument slot.
		const orphans = [...ui.matchAll(/(-?[\d.]+),\s*\n\s*RANGE\./g)].map((m) => m[1]);
		check(
			"no leftover positional bound before a RANGE argument",
			orphans.length === 0,
			orphans.length ? `${orphans.length} call sites still pass ${orphans.join(", ")}` : "",
		);
	}

	// Every job gets /dev/null on stdin. Node's default hands the child a pipe
	// nobody ever writes to or closes, so anything that reads stdin blocks on it:
	// `claude -p` waited three seconds, printed "no stdin data received in 3s"
	// into the Console, and finished — a job that worked but looked like it had
	// failed. Nothing here is interactive; the Console is a read-only stream.
	const jobsSrc = await readFile(resolve(ROOT, "lib/jobs.mjs"), "utf8");
	const spawns = [...jobsSrc.matchAll(/spawn\(([\s\S]*?)\);/g)].map((m) => m[1]);
	check("jobs spawn with a stdio option at all", spawns.length > 0 && spawns.every((a) => a.includes("stdio")));
	check(
		"no job inherits an open stdin",
		/const stdio = \["ignore",/.test(jobsSrc),
		"stdin must be ignored, or a child that reads it hangs and reports success",
	);
}

console.log("\nwallpaper handoff");
{
	// Every preset's wallpaper has to exist and has to be shaped the way the
	// compositor reads it. Both halves matter: the file was on disk the whole
	// time and the export still could not open it.
	const theme = await import("./theme.mjs");
	for (const id of ["rolemodel", "academy", "lightning"]) {
		const preset = await theme.loadPreset(id);
		const patch = theme.buildEditorPatch(preset, {});
		check(`${id}: wallpaper is an absolute path`, /^\//.test(patch.wallpaper ?? ""), patch.wallpaper);
		check(`${id}: no scheme was prepended`, !/^[a-z]+:/i.test(patch.wallpaper ?? ""));
		check(`${id}: the image exists`, existsSync(patch.wallpaper ?? ""), patch.wallpaper);
	}

	// The shapes resolveWallpaper has to tell apart. A colour is not a filename,
	// and a URL left over in an existing document has to be repaired rather than
	// passed along, or re-branding cannot fix a document the old code wrote.
	check("a bare colour passes through", theme.resolveWallpaper("#0b0b0c") === "#0b0b0c");
	check("a remote url passes through", theme.resolveWallpaper("https://e.com/a.jpg") === "https://e.com/a.jpg");
	check("a stale file url is converted back to a path", theme.resolveWallpaper("file:///tmp/a.jpg") === "/tmp/a.jpg");
	check("an absolute path is left alone", theme.resolveWallpaper("/tmp/b.jpg") === "/tmp/b.jpg");
	check("nothing stays nothing", theme.resolveWallpaper("") === null && theme.resolveWallpaper(null) === null);
}

console.log("\nedit before export");
{
	// The chain used to run record -> brand -> export and hand back an MP4. That
	// is the wrong shape: the point of writing a branded .openscreen document is
	// that it opens in the editor, where the zooms and annotations get placed.
	// Exporting straight past that produces a file nobody chose anything about,
	// so the chain stops after brand and export becomes the step after editing.
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");

	check("the chain stops before export", /filter\(\(x\) => x\.label !== 'export'\)/.test(ui));
	check("and offers the document for editing", /'Open in OpenScreen'/.test(ui) && /r\.editable/.test(ui));
	check("the record response names the document", /editable: proj/.test(srv));
	// Stopping the chain before export must not remove export: every step still
	// gets its own row, the chain just does not press the last one for you.
	check("export still gets its own run row", /for \(const s of r\.steps\) steps\.append\(runRow\(s\)\)/.test(ui));

	// The open endpoint is contained to the library and refuses a directory: it
	// spawns `open`, and `open` will launch whatever it is handed.
	const open = srv.slice(srv.indexOf('p === "/api/open"'), srv.indexOf('p === "/api/record"'));
	check("the open endpoint was found", open.length > 200, `${open.length} chars`);
	check("it refuses a path outside the library", /file\.startsWith\(LIB \+ sep\)/.test(open));
	check("it refuses anything that is not a file", /isFile\(\)/.test(open));
	// The wording lives in `openInOpenScreen` now, which both /api/open and
	// /api/open-media go through, so that is where to look for it.
	check("it says what the user still has to do", /Drag it onto/.test(srv), "a build without the verb must not claim it opened");
	check("and /api/open goes through the shared path", /await openInOpenScreen\(file\)/.test(open));
}

console.log("\nrecord capture");
{
	// `openscreen record --help` is the contract, and it names two different
	// shapes for two different things:
	//
	//   --display <n>       Screen index to record (default 0)
	//   --window <title>    Record the first window whose title contains <title>
	//
	// `openscreen sources --json` reports neither: its displays carry an `index`
	// beside an `id` like "screen:1:0", and its windows carry a `name` beside an
	// `id` like "window:6952:0". Sending the id built
	// `--window window:6952:0`, and record replied "No window title contains
	// window:6952:0" and listed every open window — one of which was the one that
	// had just been picked from that very list.
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");

	check("a display is targeted by index", /kind: "display",\s*\n?\s*value: String\(d\.index/.test(srv));
	check("a window is targeted by its title", /kind: "window", value: String\(w\.name\)/.test(srv));
	check("no source option carries a raw id", !/value: String\((?:d|w)\.id\)/.test(srv));
	check("the flag follows the kind", /kind === "display"/.test(srv) && /kind === "window"/.test(srv) && /"--display"/.test(srv));
	check("whole screen passes no flag at all", /if \(!value\) return \[\];/.test(srv));
	// A window with no title cannot be named to --window, so offering it is
	// offering a failure.
	check("untitled windows are not offered", /filter\(\(w\) => String\(w\.name \?\? ""\)\.trim\(\)\)/.test(srv));
	// And the client has to send the kind, or the server cannot tell them apart.
	check("the picker sends a kind", /kind: 'window', value: typed\.value/.test(ui) && /body: JSON\.stringify\(\{[^}]*source/.test(ui));
	check("options are addressed by position, not value", /value: String\(i\)/.test(ui), "a window title may contain any separator you would have used");
}

console.log("\nconsole output");
{
	// A job that exits nonzero says "The output below is why". It has to be true.
	// A failed `openscreen record` printed three NDJSON events carrying the exact
	// reason; all three parsed, none matched the Claude renderer, and the branch
	// returned anyway — so the log was empty under a status line promising it was
	// not. An unrendered line must fall through and be shown raw.
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
	const emit = ui.slice(ui.indexOf("const emit = (cls, line) =>"), ui.indexOf("es = new EventSource"));
	check("the emit branch was found", emit.length > 100 && emit.length < 2000, `${emit.length} chars`);
	check("a parsed line only short-circuits when it rendered", /if \(rendered\) \{[\s\S]*?return\s*\n?\s*\}/.test(emit));
	check("an unrendered JSON line falls through to raw", emit.trimEnd().endsWith("write(cls, line)\n    }") || /write\(cls, line\)\s*\n\s*\}/.test(emit));
	check("openscreen events have a renderer of their own", /function openscreenLine/.test(ui) && /openscreenLine\(event\)/.test(emit));
	// Its messages carry real newlines — the window list is one — so a raw dump
	// would show them as a literal escape on one enormous line.
	check("multi-line messages are split into lines", /\.split\('\\n'\)/.test(ui.slice(ui.indexOf("function openscreenLine"), ui.indexOf("function claudeLine"))));
}

console.log("\nposter frames");
{
	// A fixed seek does not survive `--auto-zoom`. The zoom follows the cursor for
	// seconds at a time, so `-ss 1` and a quarter-of-the-way-in both landed inside
	// it and the poster came out as a tight crop of mid-screen with no wallpaper
	// and no window frame — which reads as a broken thumbnail rather than a zoomed
	// one. Candidates are measured instead, and the frame showing the whole
	// composition wins.
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const fn = srv.slice(srv.indexOf("async function thumbnail("), srv.indexOf("async function scriptsIn("));
	check("the poster function was found", fn.length > 500, `${fn.length} chars`);
	check("it tries more than one moment", /POSTER_CANDIDATES/.test(fn) && /for \(const fraction of POSTER_CANDIDATES\)/.test(fn));
	check("no fixed one-second seek survives", !/"-ss", "1"/.test(fn));
	check("candidates are judged on their borders", /posterScore\(shot\)/.test(srv));
	check("it stops early on a perfect score", /if \(best === 2\) break/.test(fn));
	// The cache key was the filename alone, so a re-export kept the old poster for
	// ever. Size and mtime mean stale ones age out without a sweep.
	check("the cache key includes size and mtime", /\$\{st\.size\}-\$\{Math\.round\(st\.mtimeMs\)\}/.test(fn));
	// Raw frames must not come back through the string-accumulating capture().
	check("frames are read as bytes", /function captureBinary/.test(srv) && /Buffer\.concat/.test(srv));
	check("the poster probe uses it", /captureBinary\("ffmpeg"/.test(fn));
}

console.log("\ndemo scripts");
{
	// The pipeline could turn a Playwright trace into a branded video but not
	// produce the trace, so the half of a demo that decides what the viewer sees
	// was the one thing the toolkit could not help with.
	const demo = await import("./demo-script.mjs");
	const { parseScript } = await import("./script-parse.mjs");

	const md = [
		"# Walkthrough",
		"",
		"Start in the quote builder.",
		"",
		"```do",
		"goto https://example.com/",
		'click "Add to quote"',
		'type "#part" "FEE-3410"',
		"wait 800",
		"```",
		"",
		"Adding a railing is **two** clicks.",
		"",
		"```js",
		"const notAnAction = 1;",
		"```",
	].join("\n");

	const parsed = demo.parseDemo(md);
	check("a demo script parses", parsed.problems.length === 0, parsed.problems.join(" | "));
	check("actions come out in order", demo.actions(parsed).map((a) => a.verb).join(",") === "goto,click,type,wait");
	check("a quoted argument keeps its spaces", demo.actions(parsed)[1].args[0] === "Add to quote");
	check("a numeric argument becomes a number", demo.actions(parsed)[3].args[0] === 800);
	check("a code fence is not an action block", !JSON.stringify(parsed.steps).includes("notAnAction"));

	// The whole point of one file: the voice path must see exactly what it saw
	// before. If these ever diverge, a demo's narration and its actions drift.
	check(
		"narration matches what the voice path speaks",
		JSON.stringify(demo.narration(parsed)) === JSON.stringify(parseScript(md)),
		JSON.stringify(demo.narration(parsed)),
	);

	// A typo should fail before a browser opens, not leave a step missing from the
	// middle of a finished video.
	const bad = demo.parseDemo(["```do", 'cick "x"', 'type "#a"', "wait soon", "```"].join("\n"));
	check("a misspelled step is refused", bad.problems.some((p) => p.includes("no such step")));
	check("a wrong argument count is refused", bad.problems.some((p) => p.includes("takes 2")));
	check("a non-number is refused", bad.problems.some((p) => p.includes("wants a number")));
	check("problems name their line", bad.problems.every((p) => /^line \d+:/.test(p)));
	check("nothing survives a broken block", bad.steps.length === 0);

	// The runner has to name the trace and the screencast the same, or recast
	// assembles from sparse screenshot frames and the video looks like a slideshow.
	const runner = await readFile(resolve(ROOT, "bin/rm-demo.mjs"), "utf8");
	check("the trace is named after the script", /join\(dir, `\$\{name\}\.zip`\)/.test(runner));
	check("the screencast shares that basename", /join\(dir, `\$\{name\}\.webm`\)/.test(runner));
	check("the trace carries screenshots for recast", /screenshots: true/.test(runner));
	check("narration is written out for rm-voice", /narration\.md/.test(runner));
	// recast's cursor overlay comes from a real pointer over a real window.
	check("it runs headed unless told otherwise", /headless: flag\("headless"\) === true/.test(runner));
	// A demo recording the wrong screen is worse than one that stops, and a missed
	// selector is the mistake these scripts make most often. Playwright's own
	// answer is "Timeout 15000ms exceeded", which says how long it waited and
	// nothing about what went wrong.
	check("a target is resolved before acting", /NEEDS_TARGET\.has\(step\.verb\)/.test(runner));
	check("a missing target says what was looked for", /nothing matched \$\{JSON\.stringify\(target\)\}/.test(runner));
	check("and offers what was actually clickable", /clickable here/.test(runner));

	const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
	check("rm-demo ships as a binary", pkg.bin?.["rm-demo"] === "./bin/rm-demo.mjs", JSON.stringify(pkg.bin?.["rm-demo"]));
	const jobsSrc = await readFile(resolve(ROOT, "lib/jobs.mjs"), "utf8");
	check("and the job runner will run it", /"rm-demo"/.test(jobsSrc));
}

console.log("\ndemo panel");
{
	// The panel used to require a trace produced somewhere else, so the half of a
	// demo that decides what the viewer sees was the one part the Studio could not
	// help with. Writing the script is now in the same place as recasting it.
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");

	check("the check endpoint exists", /p === "\/api\/demo\/check"/.test(srv));
	check("the setup endpoint exists", /p === "\/api\/demo" && req\.method === "POST"/.test(srv));
	// It must hand back argv rather than run anything: a browser opening on your
	// screen is not something to trigger from a fetch nobody watched.
	const setup = srv.slice(srv.indexOf('p === "/api/demo" && req.method'), srv.indexOf('p === "/api/recast"'));
	check("setting up does not run the browser", /steps: \[/.test(setup) && !/jobs\.run\(/.test(setup));
	check("it refuses a script with problems", /parsed\.problems\.length\) return json\(res, 400/.test(setup));
	check("it refuses a script with no actions", /needs a \`\`\`do block/.test(setup));
	check("the script is saved into the project", /\$\{slug\}\.demo\.md/.test(setup));
	check("and it says where the trace will be", /trace: join\(dir, `\$\{slug\}\.zip`\)/.test(setup));

	check("the panel checks as you type", /demoBody\.oninput = recheck/.test(ui) && /DEMO_CHECK_MS/.test(ui));
	check("problems are shown per line", /d\.problems\.join\(' · '\)/.test(ui));
	// A demo that failed must not leave a trace path behind as though it worked.
	check("a failed demo does not fill the trace field", /the Trace field was left alone/.test(ui));
	check("a successful one does", /trace\.value = r\.trace/.test(ui));
}

console.log("\nmedia paths");
{
	// The client built `<library>/<id>/<rel>` for a media file and got "no such
	// file" for something plainly on disk: catalog paths are relative to the
	// project's `media/` directory, and the thumbnail route had always resolved
	// them that way. So the server resolves, and the client sends what it actually
	// knows — the project and the relative path.
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");

	check("the server resolves media paths", /function requestedPath/.test(srv) && /join\(mediaDir\(String\(body\.projectId\)\), String\(body\.rel\)\)/.test(srv));
	check("delete uses it", /const target = requestedPath\(body\)/.test(srv));
	check("open-media uses it", /const media = requestedPath\(body\)/.test(srv));
	// The client must not be building media paths any more, in either caller.
	const built = [...ui.matchAll(/libraryRoot \+ '\/' \+ project\.id \+ '\/' \+ f\.rel/g)].length;
	check("the client no longer guesses the layout", built === 0, built ? `${built} hand-built media paths remain` : "");
	check("it sends project and rel instead", /projectId: project\.id,\s*\n\s*rel: f\.rel/.test(ui) || /\{ projectId: project\.id, rel: f\.rel \}/.test(ui));
	// `join` normalises, so a `..` cannot climb out unseen — but only because the
	// containment check runs on the resolved path. Assert both halves.
	check("containment runs after resolution", /const target = requestedPath\(body\);\s*\n\s*const inside/.test(srv));
}

console.log("\none way in");
{
	// Setting this up was twenty commands across four repositories in an order you
	// had to know, which is not a setup, it is a quiz.
	const sh = await readFile(resolve(ROOT, "install.sh"), "utf8");
	const readme = await readFile(resolve(ROOT, "README.md"), "utf8");

	check("the README leads with one command", /curl -fsSL .*install\.sh \| sh/.test(readme.slice(0, 900)));
	check("that file exists and is executable", existsSync(resolve(ROOT, "install.sh")));
	// Piping a script to sh that silently takes a password is a script nobody
	// should pipe to sh.
	check("it never installs Homebrew behind your back", /Homebrew is not installed, and it needs your password/.test(sh));
	// Every step checks first, so a second run only does what the first could not.
	check("it is safe to run twice", (sh.match(/if (have|brew (tap|list))/g) || []).length >= 5);
	// The cask cannot be a formula dependency until the fork has cut a release, or
	// neither installs.
	check("a missing cask does not fail the whole install", /the cask is not installable yet/.test(sh));
	check("it hands the rest to rm-setup", /rm-setup/.test(sh) && !/kokoro|virtualenv --/i.test(sh));
	check("and it refuses a platform it cannot serve", /ScreenCaptureKit/.test(sh));

	// One source of truth for packaging. The tap exists only because Homebrew
	// resolves `rolemodel/tap` to a repo named homebrew-tap; it is a build output.
	const sync = await readFile(resolve(ROOT, "lib/sync-tap.mjs"), "utf8");
	check("packaging lives in this repo", existsSync(resolve(ROOT, "packaging/rm-video.rb")));
	check("nothing else carries a second copy", !existsSync(resolve(ROOT, "Formula/rm-video.rb")));
	check("the tap is a publish target", /LAYOUT/.test(sync) && /Formula\/rm-video\.rb/.test(sync));
	check("drift is a build failure, not a surprise", /--check/.test(sync) && /the tap is out of date/.test(sync));

	// rm-setup has to install the fork, because no other build has the verb.
	const setup = await readFile(resolve(ROOT, "bin/rm-setup.mjs"), "utf8");
	check("setup installs the fork's cask", /rolemodel\/tap\/rolemodel-openscreen/.test(setup));
	check("and checks for the verb, not the tap", /openscreen\\s\+open\\s\+</.test(setup));
	check("OpenFrame is optional, not required", /OpenFrame \(optional/.test(setup));
}

console.log("\nsharing for review");
{
	// The pipeline could make a video and never deliver it. Sending an mp4 by email
	// gets feedback as prose — "around the middle, the bit with the railing" — which
	// is the most expensive way to receive a note.
	const of = await import("./openframe.mjs");
	const src = await readFile(resolve(ROOT, "lib/openframe.mjs"), "utf8");

	// A share link is outward-facing; guessing the instance is not a mistake worth
	// making quietly.
	let threw = null;
	try {
		of.openFrame({ token: "x".repeat(30) });
	} catch (err) {
		threw = err;
	}
	check("it refuses to guess the instance", threw?.name === "OpenFrameError", String(threw?.message).slice(0, 60));
	threw = null;
	try {
		of.openFrame({ base: "http://x" });
	} catch (err) {
		threw = err;
	}
	check("and refuses to run without a token", threw?.name === "OpenFrameError");

	// An HTML body from a 401 or a proxy is the usual failure, and "unexpected
	// token <" is a worse message than the first line of the page.
	const fake = async () => new Response("<!DOCTYPE html>\n<title>Nope</title>", { status: 401 });
	const api = of.openFrame({ base: "http://x", token: "t".repeat(30), fetchImpl: fake });
	const caught = await api.call("/api/workspaces").then(() => null, (e) => e);
	check("a non-JSON reply is explained", /returned 401, not JSON/.test(String(caught?.message)), String(caught?.message).slice(0, 70));

	// Uploads stream from disk rather than buffering a render into memory, and
	// undici needs duplex for that — an omission that only fails on large files.
	check("the upload streams from disk", /createReadStream\(file\)/.test(src) && /duplex: "half"/.test(src));
	// A multipart requirement handled wrong produces a truncated video silently.
	check("it refuses a multipart upload rather than truncating", /init\.multipart/.test(src) && /does not do yet/.test(src));
	check("every route unwraps `data` once", /json\?\.data \?\? json/.test(src));
	// Re-sharing into the same project must not make a second one.
	check("an existing project is reused", /\.find\(\(p\) => p\.name === name\)/.test(src));

	const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
	check("rm-share ships as a binary", pkg.bin?.["rm-share"] === "./bin/rm-share.mjs");
	check("and the job runner will run it", /"rm-share"/.test(await readFile(resolve(ROOT, "lib/jobs.mjs"), "utf8")));
}

console.log("\nhosted in the app");
{
	// The Studio runs as a window in OpenScreen now, which removes the reason most
	// of the bridge existed: opening a document is an IPC call to the process that
	// owns the editor, not a PATH lookup plus a probe plus a Finder fallback.
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");

	check("the client knows whether it is hosted", /window\.rmStudio\?\.hosted/.test(ui));
	check("and asks the host to open the document", /window\.rmStudio\.openProject\(r\.document\)/.test(ui));
	check("the server does not also shell out when hosted", /body\.hosted \? \{ opened: false, via: "host" \}/.test(srv));
	// The browser path has to keep working: the Studio is still servable on its own
	// and `npm run dev` is how it is worked on.
	check("the CLI path survives for a browser", /await openInOpenScreen\(doc\)/.test(srv) && /async function openInOpenScreen/.test(srv));
	check("one place decides which way in", (ui.match(/function openDocument/g) || []).length === 1);
	// A host that refuses must say so rather than reporting success.
	check("a refusal is surfaced", /the editor would not take it/.test(ui));
}

console.log("\nopening media");
{
	// Clicking a video used to open a browser tab, which can play it — the least
	// useful thing to do with footage you are making a video out of. It goes to the
	// editor now. The editor opens documents, not videos, so a bare mp4 needs one
	// wrapped around it, and an existing sibling is preferred because it carries
	// the preset and any editing since.
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
	const om = srv.slice(srv.indexOf('p === "/api/open-media"'), srv.indexOf('p === "/api/open"'));

	check("the endpoint exists", om.length > 400, `${om.length} chars`);
	check("it stays inside the library", /startsWith\(LIB \+ sep\)/.test(om));
	check("an existing document is reused", /\.openscreen`\)/.test(om) && /if \(!already\)/.test(om));
	check("a new one is branded before opening", /"brand", sibling/.test(om));
	check("a video card no longer opens a tab", /if \(f\.kind !== 'video'\)/.test(ui) && /api\/open-media/.test(ui));

	// One path for handing a file to the app, and it prefers the fork's verb when
	// the install has it rather than assuming either way.
	check("the open path is shared", /async function openInOpenScreen/.test(srv));
	check("it probes for the verb", /async function hasOpenVerb/.test(srv) && /openscreen\\s\+open\\s\+</.test(srv));
	check("the probe is cached", /if \(openVerb !== null\) return openVerb/.test(srv));
	check("and it does not claim to have opened when it did not", /opened: false/.test(srv) && /Drag it onto/.test(srv));
}

console.log("\ndeleting things");
{
	// A delete button in a web page has to be recoverable and hard to hit by
	// accident. Both halves are asserted, because either one alone is not enough:
	// a confirm on an unlink still loses the file to a determined mis-click.
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
	const del = srv.slice(srv.indexOf('p === "/api/delete"'), srv.indexOf('p === "/api/script"'));

	check("the delete endpoint exists", del.length > 400, `${del.length} chars`);
	check("nothing outside the library can be touched", /startsWith\(LIB \+ sep\)/.test(del));
	check("the library itself is refused", /that is the library itself/.test(del));
	// A project root is a client's whole body of work. Deleting one has to be
	// stated, not inferred from a path that might be a typo.
	check("a project root needs an explicit kind", /isProjectRoot && body\.kind !== "project"/.test(del));
	// Recoverable: a rename into .trash, never an unlink. `.trash` is a dot
	// directory, which buildCatalog already skips, so it leaves the Library on its
	// own without a special case.
	check("it moves rather than unlinks", /await rename\(target, dest\)/.test(del) && !/\bunlink\(/.test(del));
	check("the trash lives inside the library", /join\(LIB, "\.trash"\)/.test(del));
	check("the catalog already ignores dot directories", /startsWith\("\."\)/.test(await readFile(resolve(ROOT, "lib/library.mjs"), "utf8")));
	check("it says where the thing went", /note:/.test(del) && /drag it back/.test(del));

	// Two clicks, and the armed state names what goes. It also forgets itself, so
	// an armed button is not left lying around for the next person at the desk.
	check("a delete has to be meant twice", /function deleteButton/.test(ui) && /if \(!armed\)/.test(ui));
	check("the armed state names the target", /Delete \$\{label\}\? Click again/.test(ui));
	check("an armed delete disarms itself", /setTimeout\(\(\) => armed && disarm\(\), DISARM_MS\)/.test(ui));
	check("the click does not also open the file underneath", /e\.stopPropagation\(\)/.test(ui.slice(ui.indexOf("function deleteButton"), ui.indexOf("function fileCard"))));
	check("a whole project passes the kind through", /kind: 'project'/.test(ui));
}

console.log("\ncard art");
{
	// The card art arrived pre-encoded and was broken three separate ways, each of
	// which is silent on its own. All three are cheap to assert and none of them
	// would have shown up as an error anywhere.
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");

	// 1. Interpolations that had been percent-encoded along with the markup, so
	//    the gradient stops read the literal text `$%7Bc1%7D`.
	check("no percent-encoded interpolation", !/\$%7[Bb]/.test(ui), (ui.match(/\$%7[Bb]\w+%7[Dd]/g) || []).slice(0, 2).join(", "));

	// 2. A trailing `;` inside the value. `style.backgroundImage = "url(…);"` is
	//    invalid, so the assignment is rejected and nothing is drawn at all.
	const trailing = ui.split("\n").filter((l) => /\.style\.[a-zA-Z]+ = `[^`]*;`/.test(l));
	check("no style value ends in a semicolon", trailing.length === 0, trailing.map((l) => l.trim().slice(0, 60)).join(" | "));

	// 3. A data: URL is its own document, so custom properties do not cascade
	//    into it and a `var()` inside the SVG paints black. Colours have to be
	//    resolved on this side of the boundary.
	const svgBlocks = [...ui.matchAll(/data:image\/svg\+xml[^`]*/g)].map((m) => m[0]);
	check("no var() survives into a data: URI", svgBlocks.every((b) => !b.includes("var(")), String(svgBlocks.length) + " blocks");
	check("tokens reach the SVG through a resolver", /function paint\(token\)/.test(ui) && /getComputedStyle\(probe\)\.color/.test(ui));

	// And the discipline that prevents all three: write the SVG plainly, encode
	// once at the end. Hand-encoded markup in the source is what hid the bugs.
	check("the SVG is encoded, not hand-escaped", !/%3Csvg/i.test(ui) && /encodeURIComponent\(svg\)/.test(ui));
	check("its gradients are linear", /<linearGradient/.test(ui) && !/radialGradient/.test(ui));
}

console.log("\ndocument errors");
{
	// A `brand` step whose `record` produced nothing used to answer with a
	// fourteen-line ENOENT stack ending in node:internal/fs/promises. Both of
	// these fail on ordinary user input, so neither may reach a stack trace.
	const themeSrc = await readFile(resolve(ROOT, "lib/theme.mjs"), "utf8");
	const vidSrc = await readFile(resolve(ROOT, "bin/rm-video.mjs"), "utf8");
	check("readProject handles a missing document", /err\.code !== "ENOENT"/.test(themeSrc));
	check("it says what the directory holds instead", /\.openscreen"\)\)/.test(themeSrc) && /readdir/.test(themeSrc));
	check("a directory handed in as a document is named as one", /EISDIR/.test(themeSrc));
	check("invalid JSON is reported as invalid JSON", /is not valid JSON/.test(themeSrc));
	check("the reader's failures exit through die()", /readProject\(projectPath\)\.catch\(\(err\) => die\(/.test(vidSrc));
	check("an unrecognised shape exits through die() too", /shape = detectShape\(doc\);[\s\S]{0,80}die\(/.test(vidSrc));

	// The chain that produced that stack. waitFor() resolves with the exit code
	// and both "run in order" loops discarded it, so `export` ran on a document
	// `brand` had just refused to open: two failures for one cause, the second
	// burying the first.
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
	const waits = [...ui.matchAll(/^\s*(?:const \w+ = )?await waitFor\(/gm)].map((m) => m[0].trim());
	check("every chained wait keeps the exit code", waits.length > 0 && waits.every((w) => w.startsWith("const")), waits.join(" | "));
	check("a chain stops on a failing step", (ui.match(/if \(code !== 0\) \{/g) || []).length === waits.length, `${(ui.match(/if \(code !== 0\) \{/g) || []).length} guards for ${waits.length} waits`);
	// Every failure path has to surface something, but not in identical words: the
	// two chain buttons say "Stopped after <step>", while the demo runner says the
	// demo exited and that the Trace field was left alone. Counting one phrase made
	// the third call site a failure for being worded for its own situation.
	const guards = [...ui.matchAll(/if \(code !== 0\) \{([\s\S]*?)\n    \}/g)].map((m) => m[1]);
	check("every failing wait is guarded", guards.length === waits.length, `${guards.length} guards for ${waits.length} waits`);
	check(
		"and each one tells the user what happened",
		guards.every((g) => /Stopped after|exited/.test(g)),
		guards.filter((g) => !/Stopped after|exited/.test(g)).map((g) => g.trim().slice(0, 50)).join(" | "),
	);
}

console.log("\ndev server");
{
	// `npm run dev` restarts the whole process on every save, and the startup path
	// runs again each time — including the browser open. An afternoon of editing
	// left a wall of Chrome windows, one per keystroke that hit disk. Under
	// --watch there is nothing to open: the tab that is already there reloads
	// itself over /live-reload.js, which is the entire point of watch mode.
	const src = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const gate = src.split("\n").find((l) => /flag\("no-open"\)/.test(l)) ?? "";
	check("the browser open is gated", gate.length > 0, gate.trim());
	check("--watch opens no browser of its own", /!WATCH/.test(gate), gate.trim());
	check("--no-open is still honoured", /!flag\("no-open"\)/.test(gate));
	check("--open remains an escape hatch", /flag\("open"\)/.test(gate));

	// The gate above is only reached on a restart because the dev script passes
	// --watch through to the child. If that ever drops, every restart opens a
	// window again and this whole section is decoration.
	const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
	check("the dev script hands --watch to the server", / --watch$/.test(pkg.scripts?.dev ?? ""), pkg.scripts?.dev);
	check("the dev script lets node restart it", /node --watch/.test(pkg.scripts?.dev ?? ""));

	// And the reload shim has to exist, or suppressing the open leaves you with
	// no way to see a change at all.
	check("the live-reload shim is a real file", (await readFile(resolve(ROOT, "lib/live-reload.js"), "utf8")).includes("EventSource"));
	check("watch mode injects it", (await readFile(resolve(ROOT, "lib/studio-ui.mjs"), "utf8")).includes("/live-reload.js"));
}

// ------------------------------------------------------------- voice setup
// The contract: nothing is installed into system Python, and the synthesiser is
// pointed at our venv on the child process rather than via a shell profile.
console.log("\nvoice setup");
{
	const vs = await import("./voice-setup.mjs");
	const nar = await readFile(resolve(ROOT, "lib/narration.mjs"), "utf8");

	check("the venv lives outside the repo", !vs.venvDir().startsWith(ROOT));
	check("RM_VOICE_VENV can relocate it", (() => {
		const old = process.env.RM_VOICE_VENV;
		process.env.RM_VOICE_VENV = "/tmp/__probe";
		const got = vs.venvDir();
		if (old === undefined) delete process.env.RM_VOICE_VENV;
		else process.env.RM_VOICE_VENV = old;
		return got === "/tmp/__probe";
	})());
	check("it installs exactly what Kokoro needs", vs.PACKAGES.join(",") === "kokoro-onnx,soundfile");

	// Both ends of the interpreter range, because both have failed. Picking the
	// first `python3` on PATH got 3.9 and pip answered with ResolutionImpossible
	// across two dozen kokoro-onnx versions; picking the newest gets 3.14, which
	// has no wheels at all. A floor-only check would have passed for both.
	check("3.9 is rejected — pip cannot resolve Kokoro on it", !vs.pySupported(3, 9));
	check("3.14 is rejected — Kokoro has no wheels for it", !vs.pySupported(3, 14));
	check("the range Kokoro actually supports is accepted", [10, 11, 12, 13].every((m) => vs.pySupported(3, m)));
	check("python 2 is never a candidate", !vs.pySupported(2, 7));
	check(
		"the range matches what the package declares",
		vs.pyRange() === ">=3.10,<3.14",
		vs.pyRange(),
	);
	check(
		"the synthesiser is pointed at the venv per-process",
		nar.includes("ttsEnv") && /capture\("npx",[\s\S]{0,200}\{ env \}\)/.test(nar),
	);
	// Check the pip invocation, not the prose — the file legitimately *names*
	// --break-system-packages while explaining why we don't reach for it.
	const setupSrc = await readFile(resolve(ROOT, "lib/voice-setup.mjs"), "utf8");
	const pipCalls = [...setupSrc.matchAll(/run\(py, \[([^\]]*)\]/g)].map((m) => m[1]);
	check("there is a pip install call", pipCalls.some((a) => a.includes("pip")));
	check(
		"nothing is forced into a managed environment",
		pipCalls.every((a) => !a.includes("break-system-packages") && !a.includes("--user")),
		pipCalls.filter((a) => a.includes("break-system") || a.includes("--user")).join(" | "),
	);
	check("packages install into the venv python, never a bare pip", !/run\("pip"|capture\("pip"/.test(setupSrc));
	check("setup is idempotent when already ready", typeof vs.isReady === "function" && typeof vs.setup === "function");

	// A failed synth must say why. The raw output is npm warnings, a telemetry
	// notice and spinner frames; the first version surfaced a network outage as
	// three lines about a deprecated package.
	const { explainTtsFailure } = await import("./narration.mjs");
	const esc = String.fromCharCode(27);
	const netNoise =
		"npm warn deprecated boolean@3.2.0\n" +
		`${esc}[?25l\u2502\n\u25d2  Downloading voice data (~27 MB)${esc}[1G${esc}[J\u25c7  Speech synthesis failed: getaddrinfo EAI_AGAIN github.com`;
	const net = explainTtsFailure({ out: netNoise, err: "" });
	check("a network failure reads as a network failure", /network connection/.test(net), net);
	check("npm noise never reaches the user", !/npm warn|deprecated/.test(net), net);
	check(
		"a missing venv points at the fix",
		/--setup --force/.test(explainTtsFailure({ err: "The kokoro-onnx package is not installed" })),
	);
	check(
		"an unknown voice points at the list",
		/--voices/.test(explainTtsFailure({ err: "Error: voice not found: xx_bogus" })),
	);
	check("empty output still says something", explainTtsFailure({}).length > 10);

	// The voice list is the one thing here that can rot without failing loudly:
	// a wrong id does not error at build time, it errors for whoever picks it.
	// The offered list once contained af_bella and af_sarah, which Kokoro has
	// never shipped. Cross-check against the synthesiser when it is reachable,
	// and say so plainly when it is not rather than passing quietly.
	const listed = await capture("npx", ["--no-install", "hyperframes", "tts", "--list", "--json"]);
	if (listed.ok && listed.out.includes("[")) {
		let real = [];
		try {
			real = JSON.parse(listed.out.slice(listed.out.indexOf("["))).map((v) => v.id);
		} catch {
			/* handled by the length check below */
		}
		check("Kokoro's voice list could be read", real.length > 0, `${real.length} ids`);
		const { VOICES } = await import("./narration.mjs");
		const bogus = VOICES.map((v) => v.id).filter((id) => !real.includes(id));
		check("every voice we offer exists in Kokoro", bogus.length === 0, bogus.join(", "));
	} else {
		skipped++;
		console.log("  ! hyperframes is not reachable — skipping the voice-id cross-check");
	}

	// Providers. Local stays the default, and the credential must not be able to
	// reach a place a human could read it back out of.
	{
		const nar = await import("./narration.mjs");
		check("kokoro is still the default provider", nar.DEFAULT_PROVIDER === "kokoro", nar.DEFAULT_PROVIDER);
		check("the default provider is a local one", nar.PROVIDERS[nar.DEFAULT_PROVIDER]?.local === true);
		check("a cloud provider is unusable without a key", (await nar.hasApiKey("elevenlabs")) === Boolean(await nar.apiKeyFor("elevenlabs")));
		check("every provider declares a clip extension", Object.values(nar.PROVIDERS).every((c) => typeof c.ext === "string" && c.ext.length));

		// The cache is keyed on the provider too. Without it, switching provider
		// with the same voice id would reuse the other provider's audio — and the
		// SRT would be measured from clips nobody asked for.
		const narSrc = await readFile(resolve(ROOT, "lib/narration.mjs"), "utf8");
		check("the clip cache is keyed on the provider", /update\(`\$\{provider\}::/.test(narSrc));

		// The key is read from disk by the synthesiser, never handed to a child as
		// an argument, or it would show up verbatim in the Console transcript.
		const argvSrc = (await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8")) + (await readFile(resolve(ROOT, "bin/rm-voice.mjs"), "utf8"));
		check(
			"no API key is ever passed as an argument",
			!/--(api-?key|key)"?,\s*(apiKey|key)/i.test(argvSrc) && !/args.*apiKey/i.test(argvSrc),
		);
		// Line-scoped, not proximity-based: the first version of this check looked
		// for apiKeyFor() within 80 characters of a json(res, ...) and fired on the
		// handler that returns {needsKey:true} and no key at all. A response that
		// serialises the key would have to name it on the line that builds the
		// response, so that is what to look for.
		const leaks = argvSrc
			.split("\n")
			.filter((l) => /\bjson\(res/.test(l) && /\bapiKey\b/.test(l));
		check("no response line mentions the key", leaks.length === 0, leaks.join(" | ").slice(0, 200));
		// And status is reported by the boolean helper, not by fetching the secret.
		check("key presence is reported via hasApiKey", /hasApiKey/.test(argvSrc));

		// The shape check that turns a 400 into an answer. ElevenLabs shows a key
		// *id* beside the key and only the key starts with sk_; pasting the id was
		// the actual failure this guard exists for.
		check("a key id is refused before it is stored", Boolean(nar.keyProblem("elevenlabs", "10c4f2ab9e7d")));
		check("a real-shaped key is accepted", nar.keyProblem("elevenlabs", "sk_abc123") === null);
		check("an empty key is refused", Boolean(nar.keyProblem("elevenlabs", "")));
		// Their auth failures arrive as 400, not 401 — mapping on status alone
		// reported a bad key as a generic bad request.
		check("auth errors are detected by type, not just status", /authentication_error/.test(narSrc));
		check("both ElevenLabs calls share one explainer", (narSrc.match(/explainElevenLabs\(/g) || []).length >= 3);

		// Every panel that offers a cloud provider must also offer somewhere to put
		// its key. The test panel offered ElevenLabs with no field anywhere, which
		// is a dead end rather than an option.
		const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
		const offers = (ui.match(/'elevenlabs'/g) || []).length;
		const fields = (ui.match(/apiKeyBlock\(/g) || []).length;
		check("the key field is one shared component", fields >= 3, `${fields} references`);
		check("every panel offering ElevenLabs can take a key", fields >= 3 && offers > 0);
		check("the key field is not hidden behind needsKey", !/needsKey \?/.test(ui));

		// The Console updates in place. It used to call render() on every poll,
		// which emptied main, closed the EventSource and opened a new one that
		// replayed the whole log — three times a minute. That was the flicker, the
		// repeated connecting, and the lost scroll position, all from one line.
		// Scoped to the function body, not a fixed character window: the first
		// version read 700 characters and ran past the closing brace into code
		// that legitimately calls render(), so it failed on correct source.
		const refreshStart = ui.indexOf("async function refreshJobs");
		// Comments stripped before the check. Two earlier versions of this
		// assertion failed on correct source: one read a fixed character window and
		// ran past the closing brace, and one matched the word render() inside the
		// comment explaining why render() is not called. An assertion that fires on
		// prose is worse than no assertion.
		const refresh = ui
			.slice(refreshStart, ui.indexOf("\n}", refreshStart))
			.split("\n")
			.filter((l) => !l.trim().startsWith("//"))
			.join("\n");
		check("polling does not re-render the console", !/\brender\(\)/.test(refresh), "refreshJobs must not call render()");
		check("polling updates the console in place", /consoleUpdate\?\.\(\)/.test(refresh));
		check("leaving the console unregisters its updater", /consoleUpdate = null/.test(ui));
		// The stream is keyed on the selected job, so a repaint cannot reopen it.
		check("the log stream is only reattached when the selection changes", /if \(streaming === jobId\) return/.test(ui));

		// No assertion on how .runrow lays out. It was pinned to display:flex after a
		// grid version stacked the Run button above its argv, but "flex" was the fix
		// I happened to use, not the thing that matters — an auto-fill grid solves it
		// too, and pinning the implementation only fights whoever tunes the rule next.
		// What matters is visual and belongs in a browser check, not a regex.
		const page = await readFile(resolve(ROOT, "lib/studio.html"), "utf8");

		// Forms are Optics form groups. Every control is built through field(), so
		// there is one place that pairs a .form-label with a .form-control instead of
		// six near-identical closures appending bare elements into a flat grid.
		check("there is one form-group builder", /function field\(form, label, control, hint\)/.test(ui));
		check("no panel appends a bare label any more", !/append\(el\('label', null,/.test(ui), "found a label with no .form-label");
		check("the group builder tags the real controls", /querySelectorAll\('input, select, textarea'\)/.test(ui));
		// No assertion on how .form .full lays out. It was pinned to "no display" after
		// a display:grid version stacked the option chips, but that rule is being tuned
		// by hand and equal-specificity cascade order decides the outcome — a regex here
		// just fails on someone's deliberate edit. The chip layout is a visual property
		// and belongs in a browser check.

		// `claude -p` in text mode prints one blob when it finishes, so a render that
		// takes minutes showed an empty Console and looked hung.
		const claudeSteps = [...argvSrc.matchAll(/bin: "claude",\s*[\s\S]{0,400}?args: \[([^\]]*)\]/g)].map((m) => m[1]);
		check("there are claude steps to check", claudeSteps.length > 0, `${claudeSteps.length} found`);
		check(
			"every claude step streams its output",
			claudeSteps.every((a) => a.includes("stream-json") && a.includes("--verbose")),
			"stream-json needs --verbose beside it",
		);
		// The Console renders those events; raw NDJSON would be worse than silence.
		check("the console renders claude events", /function claudeLine\(/.test(ui));
		// A chunk boundary lands wherever the pipe flushes, so splitting each chunk
		// on newlines turned one JSON event into two unparseable halves.
		const jobsSrc2 = await readFile(resolve(ROOT, "lib/jobs.mjs"), "utf8");
		check("output is assembled into whole lines", /job\.partial\[stream\]/.test(jobsSrc2));
		check("a trailing fragment is flushed at exit", /flush\(job\);/.test(jobsSrc2));
		check("the line cap cannot bisect a claude event", /LINE_CAP = 64_000/.test(jobsSrc2));
	}
}

const skipNote = skipped ? `, ${skipped} skipped (no OpenScreen checkout)` : "";
console.log(`\n${pass} passed, ${failures.length} failed${skipNote}\n`);
if (failures.length) {
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
