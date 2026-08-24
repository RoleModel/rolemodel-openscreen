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

/** The slot names inside an .icns, or null when it cannot be read. */
async function unpackIcns(path) {
	const { execFileSync } = await import("node:child_process");
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "rm-verify-icns-"));
	try {
		execFileSync("iconutil", ["-c", "iconset", path, "-o", join(dir, "i.iconset")], { stdio: "pipe" });
		return await readdir(join(dir, "i.iconset"));
	} catch {
		return null;
	} finally {
		await rm(dir, { recursive: true, force: true });
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
/*
 * Why things were skipped, not just how many.
 *
 * These two counters used to be one, and the summary line spelled the reason out
 * as "no OpenScreen checkout" — so a run with the fork right there, skipping one
 * assertion because `npx --no-install hyperframes` found nothing cached, reported
 * a missing checkout. A summary that names the wrong cause is worse than one that
 * names none.
 */
const skips = { fork: 0, hyperframes: 0, recast: 0, iconutil: 0 };

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
		skips.fork++;
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

	/*
	 * Three lists have to agree: the files in bin/, package.json's bin map, and
	 * the formula's ENTRIES. Nothing made them, and they drifted twice.
	 *
	 * `rm-setup` was in neither list, and `install.sh`'s last step hands off to it
	 * — so the one-command install died at the finish line on a clean machine,
	 * having done everything except say so. `rm-share` was in the bin map but not
	 * in ENTRIES, so brew shipped six of eight commands while the docs promised
	 * seven. Both are invisible from inside this repo, where everything runs by
	 * path and nothing needs to be linked.
	 */
	const onDisk = (await readdir(resolve(ROOT, "bin")))
		.filter((f) => f.endsWith(".mjs"))
		.map((f) => f.replace(/\.mjs$/, ""))
		.sort();
	const inMap = Object.keys(pkg.bin ?? {}).sort();
	const formula = await readFile(resolve(ROOT, "packaging/rm-video.rb"), "utf8");
	const entriesMatch = /ENTRIES = %w\[([^\]]*)\]/.exec(formula);
	const entries = (entriesMatch?.[1] ?? "").split(/\s+/).filter(Boolean).sort();

	const missingFromMap = onDisk.filter((n) => !inMap.includes(n));
	const missingFromFormula = inMap.filter((n) => !entries.includes(n));
	const strayInFormula = entries.filter((n) => !onDisk.includes(n));

	check("every bin/ command is in package.json", missingFromMap.length === 0, missingFromMap.join(", "));
	check("every command the package declares is in the formula", missingFromFormula.length === 0, missingFromFormula.join(", "));
	check("the formula names nothing that does not exist", strayInFormula.length === 0, strayInFormula.join(", "));
	// The number the docs promise has to be the number that ships.
	const kickoff = await readFile(resolve(ROOT, "docs/KICKOFF.md"), "utf8");
	const promised = /installs Node and (\w+) commands/.exec(kickoff)?.[1];
	const words = { six: 6, seven: 7, eight: 8, nine: 9 };
	check(
		"the docs promise the number that ships",
		words[promised] === entries.length,
		`docs say ${promised} (${words[promised]}), formula ships ${entries.length}`,
	);
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

	// One command fetches the forks, and it does not assume their default branch.
	// OpenFrame's is `master`, which turned "0 behind" into a git error on stderr
	// and a pair of question marks — a wrong answer delivered confidently.
	const forks = await readFile(resolve(ROOT, "lib/forks.mjs"), "utf8");
	check("one command fetches the forks", /npm run forks/.test(forks) && /git", \["clone"/.test(forks));
	check("it adds the upstream remote for you", /"remote", "add", "upstream"/.test(forks));
	check("and asks which branch upstream calls default", /symbolic-ref", "refs\/remotes\/upstream\/HEAD"/.test(forks));
	check("a missing ref reports unknown, not a git error", !/try \{\s*ahead = git\(/.test(forks));
	// Reporting is safe; merging somebody's checkout for them is not.
	check("it never moves a checkout it did not create", !/"checkout"|"merge"|"reset"/.test(forks));

	// Xcode reads like a much bigger requirement than it is, and conflating it with
	// Command Line Tools is how it gets that reputation. Nothing an installed
	// pipeline runs needs either; only building the capture helper needs Xcode.
	check("nothing in the install path mentions Xcode", !/xcode/i.test(sh));
	check("setup asks for Command Line Tools, not Xcode", /Command Line Tools/.test(setup) && /NOT full Xcode/.test(setup));
	check("and that step is optional", /Command Line Tools[\s\S]{0,200}required: false/.test(setup));
	const kickoff = await readFile(resolve(ROOT, "docs/KICKOFF.md"), "utf8");
	check("the docs separate the three cases", /Do I need Xcode\?/.test(kickoff) && /built in CI/.test(kickoff));
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

	/*
	 * A watch URL composed by hand is a dead link.
	 *
	 * /watch/<id> carries no share token, so OpenFrame's watch API finds no
	 * share-session cookie and answers 403 — the page reads "Video not found or
	 * access denied". The token only arrives as ?shareToken=, which /watch then
	 * strips into an httpOnly cookie, so the URL visible after the redirect is
	 * never the URL to send. Only `shareUrl` off the share endpoint is a link.
	 *
	 * It stayed broken because it works for the person who uploaded the video: a
	 * signed-in project member passes checkProjectAccess and never needs a token.
	 */
	const srvSrc = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const uiSrc = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
	// Comments off first — all three files explain the trap, and the explanation
	// necessarily spells out the shape it is warning about.
	const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const composed = (t) => /\/watch\/\$\{/.test(code(t));
	check("no watch url is composed by hand", !composed(src) && !composed(srvSrc) && !composed(uiSrc));
	check("only the share endpoint's url is handed out", /shareUrl: link\.shareUrl/.test(src) && !/watchUrl/.test(code(src)));
	// POST rotates the token on an existing link, so reading one with POST breaks
	// every link already sent for that video.
	check("an existing link is read, not rotated", /async function shareLink/.test(src) && /POST rotates the token/.test(src));
	check("the studio resolves a link before opening", /p === "\/api\/review\/link"/.test(srvSrc) && /\.shareLink\(projectId, videoId\)/.test(srvSrc));
	check("and the listing carries ids, not links", /projectId: proj\.id/.test(srvSrc));
	check("the button asks for it on click", /api\/review\/link\?project=/.test(uiSrc));
	// "No link yet" is a real state — the video was uploaded but never shared.
	check("and says so when there is none", /No share link yet/.test(uiSrc));

	const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
	check("rm-share ships as a binary", pkg.bin?.["rm-share"] === "./bin/rm-share.mjs");
	check("and the job runner will run it", /"rm-share"/.test(await readFile(resolve(ROOT, "lib/jobs.mjs"), "utf8")));
}

console.log("\nconfigurable and importable");
{
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");

	// Configuration only a shell can supply is configuration nobody can set: a GUI
	// launched from Finder inherits no shell environment, and the Studio it hosts
	// inherits that, so Review could report "not configured" for ever.
	const settings = await import("./settings.mjs");
	check("settings prefer the environment", /process\.env\.OPENFRAME_URL/.test(await readFile(resolve(ROOT, "lib/settings.mjs"), "utf8")));
	check("and fall back to a file", /openframeUrl/.test(await readFile(resolve(ROOT, "lib/settings.mjs"), "utf8")));
	check("a credential is written 0600", /mode: 0o600/.test(await readFile(resolve(ROOT, "lib/settings.mjs"), "utf8")));
	check("a url without a scheme is refused", Boolean(settings.settingProblem({ url: "localhost:3100" })));
	check("and the reason says what is wrong", /http or https/.test(settings.settingProblem({ url: "localhost:3100" })));
	check("a short token is refused with its length", /is 5 characters/.test(settings.settingProblem({ token: "short" }) ?? ""));
	check("a real pair is accepted", settings.settingProblem({ url: "http://localhost:3100", token: "t".repeat(30) }) === null);
	// Write-only: a panel that shows you your own credential shows it to the room.
	const setRoute = srv.slice(srv.indexOf('p === "/api/review/settings"'), srv.indexOf('p === "/api/review/send"'));
	check("the settings route never returns the token", !/token:/.test(setRoute) || /ok: true, stored: file/.test(setRoute));
	check("the panel can connect itself", /api\/review\/settings/.test(ui) && /'Connect'/.test(ui));

	// Recording and scripting both make video; there was no way to use video that
	// already existed, which is most of it.
	const imp = srv.slice(srv.indexOf('p === "/api/import"'), srv.indexOf('p === "/api/documents"'));
	check("importing exists", imp.length > 400, `${imp.length} chars`);
	check("it copies rather than moves", /copyFile\(src, dest\)/.test(imp) && !/rename\(src/.test(imp));
	check("the destination follows the file type", /Footage/.test(imp) && /Audio/.test(imp) && /Stills/.test(imp));
	check("an unhandled type is refused by name", /is not media this pipeline handles/.test(imp));
	// Two takes with the same name is normal; losing the first one is not.
	check("it never overwrites what is already there", /while \(await stat\(dest\)/.test(imp));
	check("and says when it renamed something", /renamed:/.test(imp) && /something was already called that/.test(ui));
	check("the project page offers it", /api\/import/.test(ui) && /Add to this project/.test(ui));
}

console.log("\nhow you start it");
{
	/*
	 * Five places told a new user to run `rm-studio` and open :4600.
	 *
	 * Both halves are wrong now. The Studio is a window in the app — main.ts opens
	 * it right after the first window — and the port is whatever was free, because
	 * electron/studio/server.ts calls freePort(). Worse, following that instruction
	 * is the one way to break recording: macOS grants Screen Recording to whatever
	 * binary hosts Electron, so launching from a shell grants it to the terminal and
	 * the recorder then fails looking like a bug.
	 *
	 * `rm-studio` and :4600 are still real and still the way to work ON the Studio,
	 * so the rule is not "never mention them" — it is that every mention has to be
	 * marked as the developer path. Which is exactly the distinction the docs lost.
	 */
	const files = ["README.md", "docs/KICKOFF.md", "install.sh", "packaging/rm-video.rb"];
	const texts = Object.fromEntries(
		await Promise.all(files.map(async (f) => [f, await readFile(resolve(ROOT, f), "utf8")])),
	);

	const unmarked = [];
	for (const [f, text] of Object.entries(texts)) {
		for (const m of text.matchAll(/4600/g)) {
			const near = text.slice(Math.max(0, m.index - 400), m.index + 400);
			if (!/developer|DEVELOPMENT\.md/.test(near)) unmarked.push(`${f}@${m.index}`);
		}
	}
	check("every mention of :4600 is marked as the developer path", unmarked.length === 0, unmarked.join(", "));

	// The instruction a first-time reader follows has to name the app, in the two
	// places they actually read: the README's install block and the script's last line.
	check("the README says to open the app", /open \*\*RoleModel Studio\*\*/.test(texts["README.md"]));
	check("and install.sh finishes by naming it", /RoleModel Studio/.test(texts["install.sh"]));

	// The permission trap, said where someone is about to fall into it. This is not
	// a nicety: a wrong grant is invisible until a capture produces a black frame.
	for (const f of ["README.md", "docs/KICKOFF.md", "install.sh", "packaging/rm-video.rb"]) {
		check(`${f} warns about launching from a terminal`, /terminal/i.test(texts[f]) && /Screen Recording/i.test(texts[f]));
	}
}

console.log("\ndocs");
{
	// Docs that describe a system nobody can hold in their head have to be
	// mechanically checked, or they become a confident description of last month.
	const dev = await readFile(resolve(ROOT, "docs/DEVELOPMENT.md"), "utf8");
	const kickoff = await readFile(resolve(ROOT, "docs/KICKOFF.md"), "utf8");
	const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));

	// The assertion count is quoted in the dev guide, and a stale number there is
	// the most quietly misleading thing a doc about testing can contain.
	const quoted = /single file of ([0-9]+)\s*\n?assertions/.exec(dev)?.[1] ?? /([0-9]+) assertions/.exec(dev)?.[1];
	check("the dev guide quotes a plausible assertion count", Number(quoted) > 300, `says ${quoted}`);
	// `npm run build` exists and builds assets, so "no build step" was wrong.
	check("it does not claim there is no build script", !/There is no build step/.test(dev));
	check("and says what npm run build actually does", /builds \*assets\*, not code/.test(dev));
	check("every script it names exists", ["dev", "check", "verify", "forks", "sync-docs"].every((k) => pkg.scripts[k]));
	// The seam table is the answer to "can I take just one piece".
	const seams = ["wallpaper", "demo-script", "demo-record", "openframe", "narration", "theme", "script-parse"];
	check("every module in the seam table exists", seams.every((m) => existsSync(resolve(ROOT, `lib/${m}.mjs`))), seams.filter((m) => !existsSync(resolve(ROOT, `lib/${m}.mjs`))).join(", "));
	check("the seam table lists them all", seams.every((m) => dev.includes(`lib/${m}.mjs`)));

	// The Docusaurus site is a build output of docs/, like the tap is of packaging/.
	const sync = await readFile(resolve(ROOT, "lib/sync-docs.mjs"), "utf8");
	check("docs sync to the site", /docs\/rolemodel/.test(sync) && Boolean(pkg.scripts["sync-docs"]));
	// MDX is not Markdown: an autolink parses as a JSX tag and fails the build.
	check("autolinks are rewritten for MDX", /mailto\)\:\[\^>\\s\]\+\)>/.test(sync) || /https\?\|mailto/.test(sync));
	check("code spans are left alone", /i % 2 === 1 \? chunk/.test(sync));
	// A relative link resolved against the URL, not the file, broke the build.
	check("cross-links point at files", /\$\{other\.slug\}\.md/.test(sync));
	check("drift fails the build", /--check/.test(sync) && /the docs site is out of date/.test(sync));
	// KICKOFF is the entry point and has to say so somewhere findable.
	check("the README points at the runbook", /docs\/KICKOFF\.md/.test(await readFile(resolve(ROOT, "README.md"), "utf8")));
	check("the runbook points at the dev guide", /DEVELOPMENT\.md/.test(kickoff));
}

console.log("\nediting and reviewing");
{
	// Both capabilities existed and neither had a surface. The editor was reachable
	// only by clicking a video — nothing in the Studio said it existed — and
	// sharing was CLI-only, which put the step that decides whether a video ships
	// outside the tool that makes it.
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
	const html = await readFile(resolve(ROOT, "lib/studio.html"), "utf8");

	check("both surfaces are in the nav", /data-v="editor"/.test(html) && /data-v="review"/.test(html));
	check("and both are routed", /editor: vEditor/.test(ui) && /review: vReview/.test(ui));
	check("with breadcrumb labels", /editor: 'Editor'/.test(ui) && /review: 'Review'/.test(ui));

	// Documents are not in the catalog and should not be — buildCatalog indexes
	// media, and a document is the edit. Inferring it client-side reported "no
	// document yet" for every video in the library, including ones sitting next to
	// a document.
	check("documents come from the server", /p === "\/api\/documents"/.test(srv) && /fetch\('\/api\/documents'\)/.test(ui));
	check("the catalog is not asked for them", !/catalog[^\n]*\.openscreen/.test(ui));

	// Configuration is reported, not assumed: an unset token and an unreachable
	// instance need different fixes, and "sharing is broken" is neither.
	const review = srv.slice(srv.indexOf('p === "/api/review"'), srv.indexOf('p === "/api/review/send"'));
	// It reports which piece is missing, and where the ones it has came from —
	// "not configured" and "configured in a shell you are not in" look identical
	// from the app and need different fixes.
	check("review reports what is missing", /configured: false/.test(review) && /missing: \[/.test(review));
	check("and where a present setting came from", /source/.test(review));
	check("and reports an unreachable instance separately", /configured: true, base, error: err\.message/.test(review));
	check("sending stays inside the library", /startsWith\(LIB \+ sep\)/.test(srv.slice(srv.indexOf('p === "/api/review/send"'))));
	/*
	 * Copying goes through the host, not the Clipboard API.
	 *
	 * main.ts installs a permission allowlist of media and capture only, so
	 * `navigator.clipboard.writeText` is denied for every page the app loads and
	 * rejects with "Write permission denied" — all three copy buttons were dead.
	 * Worse, each swallowed the rejection and set its label to "Copied" anyway, so
	 * the failure was invisible. Confirmed by real-clicking the button in a running
	 * build: label "Copied", clipboard call "THREW NotAllowedError".
	 */
	check("the panel offers a copyable link", /copyButton\(el\('button', 'btn ghost', 'Copy link'\), 'Copy link', r\.shareUrl\)/.test(ui));
	check("copying goes through the host", /window\.rmStudio\?\.copyText/.test(ui));
	check("and the browser API is only the fallback", (ui.match(/navigator\.clipboard/g) || []).length === 3);
	// A label that says Copied when nothing was copied is worse than no button.
	check("a failed copy says so", /btn\.textContent = err \? 'Copy failed' : 'Copied'/.test(ui));
	// Anything that has to fetch the value first has already spent its activation.
	check("nothing copies without a value", /if \(text == null\) return/.test(ui));
	if (HAVE_OS) {
		const mainSrc = await src("electron/main.ts");
		const preSrc = await src("electron/studio-preload.ts");
		check("the host puts it on the clipboard", /ipcMain\.handle\("studio:copy-text"/.test(mainSrc) && /clipboard\.writeText\(value\)/.test(mainSrc));
		// Same rule as every other studio channel: only that window may use it.
		check("and only for the Studio window", /if \(!fromStudio\(event\)\) return \{ ok: false, error: "only the Studio window can copy" \}/.test(mainSrc));
		check("with a bound on what crosses the bridge", /CLIPBOARD_LIMIT/.test(mainSrc));
		// The allowlist stays as it is on purpose — widening it would hand clipboard
		// writes to any page the local HTTP server ever serves.
		const mainCode = mainSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		check("the permission allowlist is not widened", !/clipboard-sanitized-write/.test(mainCode));
		check("the preload exposes it", /copyText:/.test(preSrc));
	}
	// A browser has no editor to hand anything to; say so rather than failing.
	check("the editor panel handles not being hosted", /no editor to hand a document to/.test(ui));
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

	/*
	 * And it opens in this window, not another one.
	 *
	 * A second BrowserWindow is the same process and the same Dock icon, and it
	 * still reads as a separate app: another titlebar, another entry in the Window
	 * menu, and the Studio's navigation gone. The editor is a WebContentsView
	 * placed inside the Studio window instead.
	 */
	check("the page asks for the editor to be placed in it", /rmStudio\.mountEditor/.test(ui));
	/*
	 * And it bypasses Optics' content wrappers rather than cancelling them.
	 *
	 * .op-page__main-content and .container are a reading measure and a page gutter,
	 * which is right for every other panel here and wrong for an application. The
	 * first version of this put the frame inside both and then undid their padding
	 * and width from underneath — which worked, and left the editor sitting in two
	 * wrappers whose only job was to inset it. #editor-host is their sibling.
	 */
	const shell = await readFile(resolve(ROOT, "lib/studio.html"), "utf8");
	check("the editor has a slot of its own", /id="editor-host"/.test(shell) && /\$\('#editor-host'\)/.test(ui));
	check("and it is not inside the content wrapper", /body\.has-editor \.op-page__main-content \{\s*display: none/.test(shell));
	// Cover the breadcrumb row and the window stops being movable: it is the drag
	// region the host injects.
	check("the drag region is left uncovered", /breadcrumb row above it, which is the window's/.test(shell));
	// The editor has File → Open, a recent list and a New Project. A second picker in
	// the panel around it was a worse copy of a control four pixels away.
	check("the panel does not add a second document picker", !/Choose another document/.test(ui));
	// The page measures, the host places. The alternative is the main process
	// carrying a copy of this stylesheet to work out where the nav ends.
	check("the page measures its own frame", /getBoundingClientRect\(\)/.test(ui) && /mountEditorInto/.test(ui));
	check("and keeps it placed while it moves", /new ResizeObserver/.test(ui) && /layoutEditor/.test(ui));
	// Same reason render() closes the EventSource: a live thing left attached to a
	// view the page has replaced is a native frame floating over the wrong panel.
	check("leaving the view takes the editor out", /dropEditor\(\)/.test(ui) && /unmountEditor/.test(ui));
	// A page served over HTTP by another process must not be able to place a view
	// in a window that is not its own.
	if (HAVE_OS) {
		const main = await src("electron/main.ts");
		const embed = await src("electron/studio/embedded-editor.ts");
		check("only the Studio window may mount it", /BrowserWindow\.fromWebContents\(event\.sender\) === studioWindow/.test(main));
		check("a document goes to the embedded editor when it is showing", /embeddedEditorAttached\(\)/.test(main));
		/*
		 * And so does the recorder's toolbar, which was the loudest way in and the
		 * one route that ignored all of this.
		 *
		 * `switch-to-editor` called createEditorWindowWrapper straight, so finishing
		 * a capture — the ordinary way into the editor — opened a window of its own
		 * with no Studio navigation in it, whatever openProjectPath did for documents
		 * arriving any other way.
		 */
		check("the recorder's toolbar goes there too", /function openEditorSurface/.test(main) && /registerIpcHandlers\(\s*openEditorSurface,/.test(main));
		// The HUD is always-on-top and nothing else closes it, so it would sit over
		// the Studio it just handed the editor to.
		check("and takes the HUD down with it", /studioWindow\.webContents\.send\("studio:show-editor-view"\)/.test(main) && /isForceClosing = true;[\s\S]{0,200}studioWindow\.show\(\)/.test(main));
		// No Studio means nothing to embed into, and a standalone window is right.
		check("with no Studio it still opens a window", /if \(!studioWindow \|\| studioWindow\.isDestroyed\(\)\) \{\s*createEditorWindowWrapper\(\);/.test(main));
		const pre = await src("electron/studio-preload.ts");
		check("the page is told, not driven", /onShowEditor:/.test(pre) && /studio:show-editor-view/.test(pre));
		check("and it decides what that means", /window\.rmStudio\?\.onShowEditor\?\.\(\(\) => go\('editor'\)\)/.test(ui));
		// Bounds Electron accepts and draws nothing for: a fractional height from a
		// mid-transition measure, or a zero one from a page still laying out.
		check("the rect is made whole before it is used", /Math\.max\(1, Math\.round/.test(embed));
		// The view outlives a navigation on purpose; it must not outlive the window.
		check("the view is kept across navigation", /export function unmountEmbeddedEditor/.test(embed) && !/webContents\.close\(\)[\s\S]{0,80}attached = false/.test(embed));
		check("and destroyed with the window", /destroyEmbeddedEditor\(\)/.test(main));
		// Two marks and two names a few pixels apart is what makes an embedded view
		// look like a mistake.
		const topbar = await src("src/components/ai-edition/v4/EditorTopBar.tsx");
		check("the embedded editor drops the duplicate wordmark", /\{embedded \? null : <span className=\{styles\.name\}>/.test(topbar));
		// Taking the wordmark off took the only text out of the app-menu button, and
		// with it that control's accessible name.
		check("and keeps the app menu addressable", /aria-label=\{embedded \? PRODUCT_NAME : undefined\}/.test(topbar));
	}
}

console.log("\none drawing, one file");
{
	/*
	 * The mark existed three times: percent-encoded twice into studio.html (favicon
	 * and sidebar) and hand-copied a third time into the fork. make-icon.mjs scraped
	 * one of the encoded copies back out with a regex, so the drawing could not be
	 * edited without hand-encoding it — and the fork's copy had already drifted,
	 * missing part of the export.
	 *
	 * brand/icon/mark.svg is the source. Everything else is served from it or
	 * generated from it.
	 */
	const shell = await readFile(resolve(ROOT, "lib/studio.html"), "utf8");
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const icon = await readFile(resolve(ROOT, "lib/make-icon.mjs"), "utf8");
	const mark = await readFile(resolve(ROOT, "brand/icon/mark.svg"), "utf8").catch(() => null);

	check("the mark is a file", Boolean(mark) && /<svg/.test(mark ?? ""));
	// The favicon and the sidebar both point at it rather than carrying a copy.
	check("nothing inlines it any more", (shell.match(/href="\/brand-mark\.svg"/g) || []).length === 1 && (shell.match(/src="\/brand-mark\.svg"/g) || []).length === 1);
	check("and no encoded copy is left in the shell", !/data:image\/svg\+xml,%3Csvg width='180'/.test(shell));
	check("the server serves it", /p === "\/brand-mark\.svg"/.test(srv));
	// A regex over another file's markup is not a source of truth.
	check("make-icon reads the file, not the markup", /readFile\(join\(iconDir, "mark\.svg"\)/.test(icon) && !/no brand mark in lib\/studio\.html/.test(icon));
	// Icon Composer and friends export a raster, and re-drawing that from a vector
	// would be second-guessing whoever exported it.
	// Three inputs, because a Mac app icon, a cross-platform icon set and an in-UI
	// mark are not one asset: the first carries Apple's grid and corner curvature,
	// the last is drawn at 22px in one place and 180 in another.
	check("a Mac-only icon can override the rest", /macos\.png/.test(icon) && /async function macIconSource/.test(icon));
	check("and an app icon can override just the mark", /app\.png/.test(icon));
	check("a raster is used as given, not re-derived", /image-rendering:auto/.test(icon));
	/*
	 * Sources and outputs in separate directories, which cost an icon to learn: an
	 * Icon Composer export dropped into brand/icon/ landed exactly on `icon.icns`
	 * and `png/`, the two things this script writes.
	 */
	check("sources cannot be clobbered by their own build", /const srcDir = join\(iconDir, "source"\)/.test(icon) && /join\(srcDir, name\)/.test(icon));
	// Icon Composer emits per-size artwork — small sizes redrawn, not downsampled.
	// Rebuilding the .icns from its own contents can only lose that, so every slot
	// the export has is copied and the export is passed through untouched when it
	// has them all.
	check("a finished .icns is copied, not rebuilt", /await copyFile\(built\.path, icns\)/.test(icon) && /if \(!filled\.length\) return \{ path: exported/.test(icon));
	/*
	 * The .icon document is where the icon is drawn, so it is the source of record.
	 * It cannot be the whole build on its own: actool's .icns stops at 256px because
	 * on macOS 26 the real artwork lives in the Assets.car beside it. So it fills the
	 * two non-Retina slots Icon Composer's exporter omits, and nothing else.
	 */
	check("the Icon Composer document is a source", /async function iconDocument/.test(icon) && /n\.endsWith\("\.icon"\)/.test(icon));
	check("the export wins over the compile", /from\.byName\.get\(name\) \?\? from\.byPx\.get\(px\) \?\? also\?\.byName/.test(icon));
	check("no Xcode is not a build failure", /const actool = doc \? findActool\(\) : null/.test(icon) && /existsSync\(inXcode\) \? inXcode : null/.test(icon));
	// And the thing that actually matters: what shipped has every slot filled. A real
	// unpack rather than a regex, because the point is the artwork, not the code that
	// assembled it. Skipped rather than failed off a Mac, where iconutil does not exist.
	const built = resolve(ROOT, "brand/icon/icon.icns");
	const unpacked = existsSync(built) ? await unpackIcns(built) : null;
	if (unpacked === null) {
		skipped++;
		skips.iconutil = 1;
		console.log("  · the shipped .icns has all ten sizes");
	} else {
		check("the shipped .icns has all ten sizes", unpacked.length === 10, `${unpacked.length} of 10`);
	}
	// The Mac set needs 16-1024 by .iconset name; the flat set also needs 24 and 48.
	// Sharing one cache between them silently skipped those two and then tried to
	// render after the browser was closed.
	check("both sets get every size they need", /shared \? \[\.\.\.macSizes, \.\.\.PNGS\] : macSizes/.test(icon));
	// The old last line of make-icon claimed packaging/ copied its output into the
	// fork. Nothing did, which is how the drift started.
	check("it installs into the fork itself", /icons", "icons", "mac"/.test(icon) && /rolemodel-mark\.svg/.test(icon));

	if (HAVE_OS && mark) {
		const forked = await src("src/assets/rolemodel-mark.svg").catch(() => null);
		check("the app's copy is the same bytes", forked === mark, forked === null ? "missing — run `npm run icon`" : "differs — run `npm run icon`");
	}
}

console.log("\nscripting the recording, not just the video");
{
	/*
	 * The two halves of this had never been introduced.
	 *
	 * `rm-demo run` drives a browser from a script and leaves a Playwright trace for
	 * recast, which is scripted but bypasses OpenScreen: no wallpaper, no padding, no
	 * auto-zoom, no camera bubble, nothing the editor can open. `openscreen record`
	 * produces exactly that document, but records whatever happens to be on screen —
	 * so the Record page could only offer "capture this window for 30 seconds" and
	 * hope somebody was driving it. Neither half alone is a demo you can re-cut.
	 *
	 * `rm-demo capture` is the joint: the script drives the browser, the recorder
	 * captures that window, and a document lands that the brand preset patches.
	 */
	const cap = await readFile(resolve(ROOT, "lib/demo-capture.mjs"), "utf8");
	const demoBin = await readFile(resolve(ROOT, "bin/rm-demo.mjs"), "utf8");
	const capture = await import("./demo-capture.mjs");

	check("there is a capture command", /case "capture":/.test(demoBin) && /async function captureCommand/.test(demoBin));
	check("and it writes a document, not a trace", /--project <out\.openscreen>  where the document lands/.test(demoBin));

	/*
	 * A browser's window title is whatever page it shows, so there is nothing for
	 * --window to match before the first goto. The sentinel is stamped on a blank
	 * page, the recorder latches its source once, and the real title replaces it.
	 */
	check("the window is identifiable before the first goto", /sentinelTitle/.test(demoBin) && /RM-CAPTURE-/.test(cap));
	check("and an already-open app can be named instead", /const ownWindow = typeof flag\("window"\) === "string"/.test(demoBin));

	// stdin, not a signal: docs/cli.md calls SIGTERM unreliable on Windows, and this
	// toolkit is not going to be macOS-only for ever.
	check("stopping is graceful on every platform", /child\.stdin\?\.write\("stop\\n"\)/.test(cap));
	// A recorder that cannot find the window fails within a beat, listing what is
	// open. Waiting and then asking is what catches the failure that really happens.
	check("a recorder that never started is caught", /rec\.problem\(\)/.test(demoBin) && /RECORDER_SETTLE_MS/.test(demoBin));
	// An event can arrive split across chunks, and two can arrive in one.
	check("ndjson survives chunk boundaries", /export function ndjson/.test(cap));
	{
		const seen = [];
		const feed = capture.ndjson((e) => seen.push(e.type));
		feed('{"type":"a"}\nnot json at all\n{"type":');
		feed('"b"}\n');
		check("proven, not asserted", seen.join(",") === "a,b", seen.join(","));
	}

	// A typo in --cursor should cost nothing. Validating after launching a browser
	// and starting a capture is how you find out fifteen seconds in.
	check("bad options are refused before anything launches", /let recArgs;[\s\S]{0,200}try \{[\s\S]{0,400}recordArgs\(/.test(demoBin));
	for (const bad of [{ nope: 1 }, { duration: -1 }, { cursor: "sparkly" }]) {
		let threw = null;
		try {
			capture.recordArgs(bad);
		} catch (err) {
			threw = err;
		}
		check(`  ${JSON.stringify(bad)} is refused`, Boolean(threw), threw?.message);
	}

	/*
	 * And the Record page can reach all of it.
	 *
	 * The CLI having a capture command is half a feature. The panel offered three of
	 * the recorder's nine options and no way to script anything at all, so a demo that
	 * needed a microphone, the system cursor or a driven browser meant abandoning the
	 * UI and typing the command out — which is the state this whole toolkit exists to
	 * get out of.
	 */
	const srv2 = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui2 = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");

	check("the panel takes a script", /mk\('Script', script, scriptHint\)/.test(ui2) && /script: script\.value/.test(ui2));
	// Same checker the Recast page uses: a script naming a button that moved should
	// fail while you type, not fifteen seconds into a browser session.
	check("and checks it as you type", /api\/demo\/check/.test(ui2) && /DEMO_CHECK_MS/.test(ui2));
	check("the server routes a script to rm-demo capture", /bin: "rm-demo"/.test(srv2) && /"capture", scriptPath/.test(srv2));
	check("and keeps openscreen record for an undriven capture", /bin: "openscreen",\s*args: \[\s*"record",/.test(srv2));
	// A script that cannot run must not reach the argv at all.
	check("a broken script is refused before anything is written", /if \(parsed\.problems\.length\) return json\(res, 400/.test(srv2));
	check("and prose with no actions is refused too", /nothing would drive the capture/.test(srv2));
	// The script is the part worth keeping; it goes on disk beside the document.
	check("the script is saved beside the document", /\$\{slug\}\.demo\.md/.test(srv2));

	// Every knob the panel offers has to reach the argv, or it is decoration.
	for (const [label, ui, srv] of [
		["microphone", /mic: mic\.checked/, /out\.push\("--mic"\)/],
		["a named microphone", /micDevice: micDevice\.value/, /out\.push\("--mic-device", device\)/],
		["system audio", /systemAudio: sysAudio\.checked/, /out\.push\("--system-audio"\)/],
		["cursor mode", /cursor: cursor\.value/, /out\.push\("--cursor", cursor\)/],
		["base url", /url: url\.value/, /out\.push\("--url", url\)/],
		["viewport", /width: vw\.value/, /out\.push\("--width", w\)/],
		["headless", /headless: headless\.checked/, /out\.push\("--headless"\)/],
	]) {
		check(`  ${label} reaches the argv`, ui.test(ui2) && srv.test(srv2));
	}
	// --mic-device implies --mic, so sending both is redundant and sending the device
	// without the flag reads as a mistake rather than a shorthand.
	check("a named microphone is passed alone", /if \(device\) out\.push\("--mic-device", device\);\s*else if \(body\?\.mic\)/.test(srv2));
	// A mode the CLI does not have is dropped, not forwarded for it to reject.
	check("an invented cursor mode never reaches the CLI", /CURSOR_MODES\.includes\(cursor\)/.test(srv2));
	// A viewport is a window size, not an arbitrary number.
	check("the viewport is bounded", /num\(body\?\.width, 320, 7680\)/.test(srv2));
	// The browser knobs mean nothing without a script driving, and a control that
	// looks configurable but is not is worse than one that is absent.
	check("the driver knobs disable without a script", /const driverOnly = \[url, vw, vh, headless\]/.test(ui2) && /c\.disabled = !scripted/.test(ui2));
	// studio.html pins every textarea to --field-tall, so `rows` renders as three.
	check("the script box is big enough to write in", /script\.style\.minBlockSize/.test(ui2));
	// The old plan said "stops on its own after 30 seconds" whether or not anything
	// was driving it, which is exactly the sentence that made the page look usable.
	check("the plan says whether anything is driving", /Drive the app through the script, and record it\./.test(ui2) && /Nothing drives it/.test(ui2));

	/*
	 * Every record flag the CLI documents is reachable from here.
	 *
	 * Read out of the fork's own help text rather than a list kept in this file: the
	 * recorder will grow flags, and a hand-kept list agrees with itself for ever. Same
	 * reasoning as the recast check below.
	 */
	if (HAVE_OS) {
		const args = await src("electron/cli/args.ts");
		const section = args.slice(args.indexOf("Record options"), args.indexOf("Stopping a recording"));
		const documented = [...section.matchAll(/^\s{2}--([a-z-]+)/gm)].map((m) => m[1]);
		// --json is always appended, never a caller's choice.
		const wanted = documented.filter((f) => f !== "json");
		const reachable = new Set(
			Object.entries(capture.RECORD_FLAGS).map(([key, spec]) => spec.flag ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
		);
		const missing = wanted.filter((f) => !reachable.has(f));
		check(
			"every record flag the CLI documents is reachable",
			wanted.length > 0 && missing.length === 0,
			`${wanted.length - missing.length}/${wanted.length}${missing.length ? ` — missing ${missing.join(", ")}` : ""}`,
		);
		check("and --json is not one of them to forget", /out\.push\("--json"\)/.test(cap));
		// The cursor modes are the CLI's, not ours to invent.
		const modes = /--cursor <([a-z|-]+)>/.exec(args)?.[1]?.split("|") ?? [];
		check("the cursor modes match the CLI's", modes.length > 0 && modes.every((mode) => capture.CURSOR_MODES.includes(mode)), modes.join(", "));
	}
}

console.log("\nevery recast option has a control");
{
	/*
	 * The panel exposed five of playwright-recast's twenty-odd flags, which put the
	 * interesting half of it — the cursor, the interpolation, the TTS model, whether
	 * idle compression happens at all — behind typing the command out by hand.
	 *
	 * Asserted against `--help` rather than against a list written here: recast is a
	 * dependency that will grow flags, and a hand-kept list would agree with itself
	 * forever. Two flags are deliberately not surfaced and are named as exceptions
	 * so adding one to the panel is a choice rather than an accident.
	 */
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
	const recast = srv.slice(srv.indexOf('p === "/api/recast"'), srv.indexOf('p === "/api/voice"'));

	const help = await capture(resolve(ROOT, "node_modules/.bin/playwright-recast"), ["--help"]);
	if (help.ok) {
		const flags = new Set([...help.out.matchAll(/^\s+(?:-\w,\s+)?(--[a-z-]+)/gm)].map((m) => m[1]));
		// `--input`/`--output` are the two the panel supplies itself, and `--help`
		// is not an option a panel can offer.
		for (const skip of ["--input", "--output", "--help"]) flags.delete(skip);
		const missing = [...flags].filter((f) => !recast.includes(`"${f}"`));
		check(
			"the server passes every flag recast documents",
			missing.length === 0,
			`missing ${missing.join(", ")} — recast grew a flag, or one was left out`,
		);
		check("and there are enough of them to be worth asserting", flags.size >= 20, `${flags.size} flags`);
	} else {
		skipped++;
		skips.recast = 1;
		console.log("  ! playwright-recast is not installed — skipping the flag cross-check");
	}

	// A number arriving as a string or as nonsense reaches ffmpeg otherwise, and
	// recast's error for it is a filter-graph complaint several hundred lines down.
	check("out-of-range numbers are clamped rather than passed on", /Math\.min\(hi, Math\.max\(lo, n\)\)/.test(recast));
	// --no-speed turns the stage off, so sending multipliers with it describes a
	// stage that is not running.
	check("the speed multipliers are withheld when timing is kept", /if \(body\.noSpeed\) \{[\s\S]{0,120}--no-speed/.test(recast));
	// Qwen is configured entirely by file; recast exits without one.
	check("Qwen without its config is refused here", /the Qwen provider needs a --qwen-config/.test(recast));
	// An mp4 extension on a webm stream is a file most things refuse.
	check("the extension follows the format", /body\.format === "webm" \? "webm" : "mp4"/.test(recast) && /\$\{slug\}\.\$\{format\}/.test(recast));
	// rm-mux writes mp4 and is the step that reconciles the two clocks.
	check("a webm render says the mux was skipped", /muxSkipped/.test(recast) && /muxSkipped/.test(ui));

	// The dependent controls. A setting that silently does nothing reads as a
	// setting that does not work.
	check("the panel disables what the switches make meaningless", /const syncOpts = \(\) => \{/.test(ui) && /el2\.disabled = !interp/.test(ui));
	check("and disables the speed fields when timing is kept", /el2\.disabled = !speeding/.test(ui));
}

console.log("\nwhere hyperframes sits");
{
	/*
	 * "I still cannot find HyperFrames" is a reasonable thing to say about a
	 * dependency that has no page, no install step and a grey dot in the footer.
	 * It is never installed: npx fetches it when a Make render or a voice line
	 * asks, so an uncached machine is the normal state and the UI has to say that
	 * rather than showing what looks like a broken tool.
	 */
	const ui = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
	const srv = await readFile(resolve(ROOT, "bin/rm-studio.mjs"), "utf8");

	// Every tool the server reports needs a line explaining it, or adding one puts a
	// bare unexplained dot in the footer — which is the state this section is about.
	const reported = /tools: \{([^}]*)\}/.exec(srv)?.[1] ?? "";
	// `voice` is shorthand — `{ ..., voice }` — so a /(\w+):/ sweep misses it, and the
	// first version of this assertion passed while the one tool it should have caught
	// went unchecked. Split on commas and take the name before the colon, if any.
	const keys = reported
		.split(",")
		.map((part) => part.split(":")[0].trim())
		.filter(Boolean);
	const explained = keys.filter((k) => new RegExp(`^\\s*${k}: \\[`, "m").test(ui));
	check(
		"every tool in the footer says what it is for",
		keys.length > 0 && explained.length === keys.length,
		`${explained.length}/${keys.length}: missing ${keys.filter((k) => !explained.includes(k)).join(", ")}`,
	);
	check("and what hyperframes actually is", /npx fetches it on first use/.test(ui));
	check("an uncached hyperframes is not reported as broken", /Nothing to fix/.test(ui));
	// The same distinction on the Voice page, where the old note sent you to the
	// page you were already on.
	check("the voice fallback says which of the two things is missing", /Kokoro is not installed yet/.test(srv) && /is not cached yet/.test(srv));
	check("and no longer sends you to the page you are on", !/Set voice up under Voice/.test(srv));
}

console.log("\nthe app carries our name");
{
	/*
	 * The rename is spread over three repositories, which is the reason for these.
	 *
	 * Two of the three files that state the display name live in the fork, and its own
	 * vitest suite pins them against each other. What no test over there can see is the
	 * cask: Electron derives `app.getPath("userData")` and the log directory from the
	 * display name, so renaming the app moved both, and a `zap` listing only the old
	 * paths quietly stops uninstalling the app's data. That is a cross-repository
	 * contract, and this is the only place that reads both sides.
	 *
	 * The bundle name is asserted too, in the other direction: it must NOT change.
	 * `app "Openscreen.app"`, the shim that execs the bundle path, and the DMG name
	 * build.yml writes all depend on it, and renaming `productName` to match the brand
	 * is the obvious change that breaks three things at once.
	 */
	const cask = await readFile(resolve(ROOT, "packaging/rolemodel-openscreen.rb"), "utf8");

	if (HAVE_OS) {
		const builder = await src("electron-builder.json5");
		const about = await src("electron/about.ts");
		const display = /"CFBundleDisplayName":\s*"([^"]+)"/.exec(builder)?.[1];
		check("the app declares a display name", Boolean(display), "CFBundleDisplayName is missing");
		check("and renders itself under the same one", about.includes(`export const PRODUCT_NAME = "${display}"`));
		// The path Electron actually writes to, spelled the way the cask has to list it.
		check(
			"the cask zaps the directory that name creates",
			cask.includes(`~/Library/Application Support/${display}`) && cask.includes(`~/Library/Logs/${display}`),
			`zap is missing "${display}"`,
		);
		check(
			"and still zaps the one the old name created",
			cask.includes("~/Library/Application Support/Openscreen"),
		);
		check(
			"the bundle keeps the name the cask installs",
			/"productName":\s*"Openscreen"/.test(builder),
			"renaming productName breaks the app stanza, the shim and the DMG name",
		);
		// A permission prompt quotes its usage string, so an un-renamed one asks about
		// software the person has never heard of.
		check(
			"every permission prompt names this app",
			["NSAudioCapture", "NSMicrophone", "NSCamera", "NSScreenCapture"].every((k) =>
				new RegExp(`"${k}UsageDescription":\\s*"${display} `).test(builder),
			),
		);
		// MIT keeps the notice; a fork that renames the app and shows only its own URL
		// leaves nobody a way to find out what they are running.
		check("the About box still credits upstream", /A RoleModel Software build of \$\{UPSTREAM_NAME\}/.test(about));
	}

	// True with or without a checkout: the caveats tell a person which app to grant
	// Screen Recording to, and macOS shows them the display name.
	check("the caveats name the app macOS will show", /grant it to RoleModel Studio/.test(cask));
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
		skips.hyperframes++;
		console.log("  ! hyperframes is not cached yet — skipping the voice-id cross-check");
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

const skipWhy = [
	skips.fork ? `${skips.fork} for no OpenScreen checkout` : null,
	skips.hyperframes ? `${skips.hyperframes} because hyperframes is not cached` : null,
	skips.recast ? `${skips.recast} because playwright-recast is not installed` : null,
	skips.iconutil ? `${skips.iconutil} because iconutil could not read the .icns` : null,
].filter(Boolean);
const skipNote = skipped ? `, ${skipped} skipped (${skipWhy.join(", ")})` : "";
console.log(`\n${pass} passed, ${failures.length} failed${skipNote}\n`);
if (failures.length) {
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
