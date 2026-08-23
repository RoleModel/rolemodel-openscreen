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
