/**
 * Bring Optics in as Optics, not as a copy of it.
 *
 * What this used to do: read a 791KB Figma variables export and flatten it into
 * 1160 static hexes, one `light-dark()` pair per token. That produced something
 * that *looked* like Optics and behaved like a photograph of it. Real Optics
 * does not ship hexes at all — every ramp is computed in CSS from three
 * numbers:
 *
 *   --op-color-primary-plus-eight: light-dark(
 *     hsl(var(--op-color-primary-h) var(--op-color-primary-s) 98%),
 *     hsl(var(--op-color-primary-h) var(--op-color-primary-s) 14%)
 *   );
 *
 * So the flattened version lost the thing that makes the system a system: set
 * `--op-color-primary-h` and all 480-odd tokens re-tint. Flattened, they cannot
 * move, and every Optics release silently widened the gap between our palette
 * and the real one. `light-dark()` and `color-scheme: light dark` were already
 * in the package — the generator was reimplementing them.
 *
 * What this does now:
 *
 *   1. Vendors `@rolemodel/optics` verbatim into brand/optics/optics.css. Byte
 *      for byte, never edited. `--check` compares hashes, so a hand-edit is a
 *      failed build rather than a mystery.
 *   2. Generates brand/optics/rolemodel-scales.css from the Figma export — and
 *      *only* the tokens the published package does not define. Today that is
 *      the sub-brand scales (academy, lcad, docks, decks, railing, building,
 *      airfield, flow), which are RoleModel's and are not in the open-source
 *      release. The filter reads the vendored file, so as Optics publishes more,
 *      this file shrinks on its own instead of shadowing the real tokens.
 *
 * Why vendored rather than resolved from node_modules at runtime: the Homebrew
 * formula does `libexec.install Dir["*"]` and never runs `pnpm install`, so a
 * brew install has no node_modules. The committed CSS is what ships. The
 * package is a devDependency because it is a build input, not a runtime one.
 *
 * Upgrading Optics is now the normal thing:
 *
 *   pnpm run optics:latest      # is there a newer one?
 *   pnpm add -D @rolemodel/optics@latest && pnpm run optics
 *
 *   node lib/optics-css.mjs [--check]
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// The no_icons build: nothing here uses Material Symbols, and that variant is
// the same tokens without pulling an icon font over the network on every video
// render. The Noto @import it does keep is Optics' own and is left alone —
// our own CSS sets font-family from brand/tokens.json, so nothing depends on it.
const UPSTREAM = "dist/css/optics+no_icons.css";
const PKG = "@rolemodel/optics";

export const VENDORED = "brand/optics/optics.css";
export const SUPPLEMENT = "brand/optics/rolemodel-scales.css";
export const MANIFEST = "brand/optics/manifest.json";

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Flatten one mode of the Figma export into [cssVarName, hex] pairs. */
function collect(node, prefix, out) {
	for (const [key, value] of Object.entries(node)) {
		if (!value || typeof value !== "object") continue;
		if (value.$value !== undefined) {
			// Prefer the name Optics itself publishes; fall back to the tree path so
			// a token missing $codeSyntax still lands somewhere sensible.
			const web = value.$codeSyntax?.WEB;
			const name = web ? web.replace(/^var\(|\)$/g, "") : `--op-color-${prefix}-${key}`.replace(/-{2,}/g, "-");
			out.set(name, String(value.$value).toLowerCase());
			continue;
		}
		collect(value, prefix ? `${prefix}-${key}` : key, out);
	}
	return out;
}

/** Every custom property the published package defines. */
function definedBy(css) {
	const names = new Set();
	for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) names.add(m[1]);
	return names;
}

/**
 * The families in the export that published Optics does not carry. Derived, not
 * hardcoded: a name is ours if the package never defines it.
 */
function familyOf(name) {
	return name.replace(/^--op-color-/, "").split("-")[0];
}

/**
 * Optics' own lightness ladder, read out of the vendored package.
 *
 * Every Optics ramp step is the family's hue and saturation at a fixed
 * lightness, one value per mode:
 *
 *   --op-color-primary-base: light-dark(
 *     hsl(var(--op-color-primary-h) var(--op-color-primary-s) 40%),
 *     hsl(var(--op-color-primary-h) var(--op-color-primary-s) 38%)
 *   );
 *
 * Reading the ladder from the package rather than hardcoding it means an Optics
 * release that retunes its steps retunes ours on the next `pnpm run optics`.
 */
function readLadder(css) {
	const ladder = new Map();
	const re =
		/--op-color-primary-([a-z-]+):\s*light-dark\(\s*hsl\(var\(--op-color-primary-h\) var\(--op-color-primary-s\) ([\d.]+)%\),\s*hsl\(var\(--op-color-primary-h\) var\(--op-color-primary-s\) ([\d.]+)%\)\s*\)/g;
	for (const m of css.matchAll(re)) ladder.set(m[1], [Number(m[2]), Number(m[3])]);
	return ladder;
}

/** #rrggbb to [h, s, l] in CSS units. */
function hexToHsl(hex) {
	const m = /^#([0-9a-f]{6})$/.exec(hex);
	if (!m) return null;
	const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16) / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	let h = 0;
	let sat = 0;
	if (max !== min) {
		const d = max - min;
		sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
	}
	return [h, sat * 100, l * 100];
}

/** Read Figma's one-value H/S/L primitive for each colour family. */
function readPrimitiveSeeds(doc) {
	const primitives = doc?.[0]?.["Primitive Colors"]?.modes?.["Light Theme"];
	if (!primitives) throw new Error("brand/optics-tokens.json has no Primitive Colors / Light Theme mode");
	const seeds = new Map();
	for (const [name, values] of Object.entries(primitives)) {
		if (!name.startsWith("op-color-") || !values?.h || !values?.s || !values?.l) continue;
		const h = Number.parseFloat(String(values.h.$value));
		const s = Number.parseFloat(String(values.s.$value));
		const l = Number.parseFloat(String(values.l.$value));
		if ([h, s, l].some(Number.isNaN) || s < 1) continue;
		seeds.set(name.slice("op-color-".length), [h, s, l]);
	}
	return seeds;
}

const round = (n) => Math.round(n * 10) / 10;
const precise = (n) => String(Math.round(n * 10_000) / 10_000);
/** How far a step may sit from its family's seed and still be called the same colour. */
const HUE_TOLERANCE = 2;
const SAT_TOLERANCE = 2;

/**
 * Build the supplement.
 *
 * Two kinds of thing end up in here, and the difference is the whole point:
 *
 *   1. The HSL primitives — `--op-color-<family>-h/s/l` — for *every* family in
 *      the export, including the ones Optics publishes. These are not a copy of
 *      anything; they are the tinting API. Optics computes 486 tokens from
 *      `--op-color-primary-h/s/l`, and `--op-color-neutral-h` is defined as
 *      `var(--op-color-primary-h)`, so setting these three numbers is how
 *      RoleModel's palette reaches the published ramps at all. The supplement
 *      loads after the package, so ours win.
 *
 *   2. The ramp steps for families Optics does *not* publish — the eight
 *      sub-brands plus accent, secondary and tertiary. A step whose exported
 *      value really is the family's hue at some lightness is emitted computed,
 *      so it re-tints with its seed. A step that is not — the `on-*` ink
 *      tokens, mostly, where the export drops to a near-black `#001910` that no
 *      lightness ladder would predict — keeps its literal value, because
 *      guessing there flips text from black to white.
 *
 * Never a step name the package already defines. That is what the split is for,
 * and `--check` fails the build over it.
 */
function buildSupplement(light, dark, published, ladder, upstream = "", primitiveSeeds = new Map()) {
	// Seeds Optics defines as a reference rather than a number. `neutral-h` is
	// `var(--op-color-primary-h)` on purpose: the greys follow the brand hue, so
	// one change re-tints every surface. Writing a number over that does not
	// shadow a value, it severs a relationship — the greys stop following
	// anything. So these are left to the package no matter what the export says.
	const relational = new Set(
		[...upstream.matchAll(/(--op-color-[a-z-]+-[hsl]):\s*var\(/g)].map((m) => m[1]),
	);
	const steps = [...ladder.keys()].sort((a, b) => b.length - a.length);
	const groups = new Map();
	const loose = [];

	for (const name of light.keys()) {
		const bare = name.replace(/^--op-color-/, "");
		// Longest suffix first, or `on-base` would be read as `base`.
		const step = steps.find((k) => bare.endsWith(`-${k}`));
		if (!step) {
			loose.push(name);
			continue;
		}
		const prefix = bare.slice(0, -(step.length + 1));
		if (!groups.has(prefix)) groups.set(prefix, new Map());
		groups.get(prefix).set(step, name);
	}
	/*
	 * Every primitive gets its H/S/L seed in CSS. A standalone colour does not
	 * imply a full ramp: when Figma has no matching Color Style steps, its group
	 * stays empty and we emit only the three seeds. That is how the AI palette
	 * remains five named swatches instead of five invented colour scales.
	 */
	for (const prefix of primitiveSeeds.keys()) {
		if (groups.has(prefix)) continue;
		groups.set(prefix, new Map());
	}

	const rows = [];
	const stats = { seeds: 0, computed: 0, literal: 0, skipped: 0, families: [] };

	for (const [prefix, byStep] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
		const seed = hexToHsl(light.get(byStep.get("base")) ?? "") ?? primitiveSeeds.get(prefix) ?? null;
		// A grey base carries no hue to seed with. Optics gives its neutrals a
		// deliberate 4% of the brand hue — "not grey" is the point — and the
		// export resolves them to flat grey, so deriving a seed from it would
		// write 0% over that and flatten every surface in the interface.
		const chromatic = seed !== null && seed[1] >= 1;
		if (seed && chromatic) {
			// -l records the family's own lightness, which is what Optics feeds into
			// --op-color-*-original. The ramp takes its lightness from the ladder, so
			// only h and s do work downstream.
			for (const [k, v] of [
				["h", precise(seed[0])],
				["s", `${precise(seed[1])}%`],
				["l", `${precise(seed[2])}%`],
			]) {
				const name = `--op-color-${prefix}-${k}`;
				if (relational.has(name)) continue;
				rows.push([name, v]);
				stats.seeds++;
			}
		}

		const value = (hex) => {
			const hsl = hexToHsl(hex);
			// No seed emitted means nothing to reference, so the literal stands.
			if (!hsl || !seed || !chromatic) return hex;
			const [h, sat, l] = hsl;
			// Pure white and pure black are the seed hue at 100% / 0% whatever the
			// hue is, so those stay computed for free.
			if (l >= 99.5 || l <= 0.5) {
				stats.computed++;
				return `hsl(var(--op-color-${prefix}-h) var(--op-color-${prefix}-s) ${round(l)}%)`;
			}
			const dh = Math.min(Math.abs(h - seed[0]), 360 - Math.abs(h - seed[0]));
			if (dh > HUE_TOLERANCE || Math.abs(sat - seed[1]) > SAT_TOLERANCE) {
				stats.literal++;
				return hex;
			}
			stats.computed++;
			return `hsl(var(--op-color-${prefix}-h) var(--op-color-${prefix}-s) ${round(l)}%)`;
		};

		let emitted = 0;
		for (const [step, name] of [...byStep].sort((a, b) => a[1].localeCompare(b[1]))) {
			if (published.has(name)) {
				stats.skipped++; // Optics owns this step. Never shadow it.
				continue;
			}
			const l = light.get(name);
			const d = dark.get(name) ?? l;
			if (!l && seed && chromatic && ladder.has(step)) {
				const [lightness, darkness] = ladder.get(step);
				const fromSeed = (lightness) => `hsl(var(--op-color-${prefix}-h) var(--op-color-${prefix}-s) ${round(lightness)}%)`;
				const lv = fromSeed(lightness);
				const dv = fromSeed(darkness);
				rows.push([name, lv === dv ? lv : `light-dark(${lv}, ${dv})`]);
				stats.computed++;
				emitted++;
				continue;
			}
			const lv = value(l);
			const dv = d === l ? lv : value(d);
			rows.push([name, lv === dv ? lv : `light-dark(${lv}, ${dv})`]);
			emitted++;
		}
		if (emitted) stats.families.push(prefix);
	}

	for (const name of loose.sort()) {
		if (published.has(name)) {
			stats.skipped++;
			continue;
		}
		const l = light.get(name);
		const d = dark.get(name) ?? l;
		rows.push([name, d && d !== l ? `light-dark(${l}, ${d})` : l]);
		stats.literal++;
	}

	const head = [
		"/*",
		" * GENERATED by lib/optics-css.mjs — do not edit.",
		" *",
		" * Two things live here, and the difference matters:",
		" *",
		" *   1. --op-color-<family>-h/s/l for every family in the Figma export.",
		" *      These are the tinting API, not a copy: Optics computes its ramps",
		" *      from these three numbers, and --op-color-neutral-h is literally",
		" *      var(--op-color-primary-h). This file loads after the package, so",
		" *      these are what RoleModel's palette actually is.",
		" *",
		" *   2. Ramp steps for the families the open-source release does not ship.",
		` *      ${stats.families.length} of them: ${stats.families.join(", ")}.`,
		" *      Steps that are genuinely the family hue at some lightness are",
		" *      computed, so they re-tint with their seed. The rest keep their",
		" *      exported value — mostly on-* ink, where the export drops to a",
		" *      near-black no lightness ladder would predict.",
		" *",
		` * ${stats.seeds} seeds · ${stats.computed} computed steps · ${stats.literal} literal steps`,
		` * ${stats.skipped} steps left to the package, which owns them.`,
		" *",
		" * The lightness ladder comes from the vendored package, so an Optics",
		" * release that retunes its steps retunes these on the next `pnpm run optics`.",
		" */",
		":root {",
	];
	return [...head, ...rows.map(([n, v]) => `  ${n}: ${v};`), "}", ""].join("\n");
}

export async function buildOptics(root = ROOT) {
	const pkgDir = resolve(root, "node_modules", PKG);
	if (!existsSync(pkgDir)) {
		throw new Error(
			`${PKG} is not installed. It is a devDependency and the source for brand/optics/.\n` +
				"  pnpm install",
		);
	}
	const version = JSON.parse(await readFile(resolve(pkgDir, "package.json"), "utf8")).version;
	const upstream = await readFile(resolve(pkgDir, UPSTREAM), "utf8");
	const published = definedBy(upstream);

	const raw = JSON.parse(await readFile(resolve(root, "brand/optics-tokens.json"), "utf8"));
	const styles = raw["0"]?.["Color Styles"]?.modes;
	if (!styles?.Light || !styles?.Dark) {
		throw new Error("brand/optics-tokens.json has no Color Styles Light/Dark modes");
	}
	const light = collect(styles.Light, "", new Map());
	const dark = collect(styles.Dark, "", new Map());
	const primitiveSeeds = readPrimitiveSeeds(raw);

	const supplement = buildSupplement(light, dark, published, readLadder(upstream), upstream, primitiveSeeds);
	const ours = [...supplement.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].length;

	const manifest = {
		$comment: `GENERATED by lib/optics-css.mjs. ${VENDORED} is ${PKG} verbatim — do not edit either by hand.`,
		package: PKG,
		version,
		upstreamFile: UPSTREAM,
		vendoredSha256: sha(upstream),
		supplementSha256: sha(supplement),
		tokens: { published: published.size, rolemodelOnly: ours },
	};

	return {
		version,
		files: {
			[VENDORED]: upstream,
			[SUPPLEMENT]: supplement,
			[MANIFEST]: `${JSON.stringify(manifest, null, "\t")}\n`,
		},
		manifest,
	};
}

/**
 * Verifies what is committed without needing node_modules — release.yml runs
 * node directly and never installs. So this checks the repo against itself: the
 * manifest's hashes must match the two CSS files beside it. Comparing against
 * the *installed* package is an extra assertion, made only when it is there.
 */
export async function checkOptics(root = ROOT) {
	const read = (p) => readFile(resolve(root, p), "utf8");
	const problems = [];

	let manifest;
	try {
		manifest = JSON.parse(await read(MANIFEST));
	} catch {
		return [`${MANIFEST} is missing or unparseable — run \`pnpm run optics\`.`];
	}

	for (const [file, key] of [
		[VENDORED, "vendoredSha256"],
		[SUPPLEMENT, "supplementSha256"],
	]) {
		const body = await read(file).catch(() => null);
			if (body === null) problems.push(`${file} is missing — run \`pnpm run optics\`.`);
		else if (sha(body) !== manifest[key]) {
			problems.push(`${file} does not match ${MANIFEST} (${key}) — it was hand-edited, or the export changed.`);
		}
	}

	// The supplement must never define a ramp *step* the vendored package already
	// computes; that is the whole contract of the split, and it is cheap to assert.
	//
	// The h/s/l seeds are the deliberate exception, and the distinction is not a
	// loophole: a step is Optics' output, and a second copy of it here would sit
	// on top of the live one and stop it re-tinting. A seed is Optics' *input* —
	// redefining `--op-color-primary-h` is the documented way to tint the system,
	// and the whole ramp moves with it. One shadows, the other steers.
	const vendored = await read(VENDORED).catch(() => "");
	const supplement = await read(SUPPLEMENT).catch(() => "");
	if (vendored && supplement) {
		const published = definedBy(vendored);
		const isSeed = (n) => /-(h|s|l)$/.test(n);
		const shadowed = [...definedBy(supplement)].filter((n) => published.has(n) && !isSeed(n));
		if (shadowed.length) {
			problems.push(`${SUPPLEMENT} shadows ${shadowed.length} computed Optics tokens: ${shadowed.slice(0, 5).join(", ")}`);
		}
	}

	if (existsSync(resolve(root, "node_modules", PKG))) {
		const built = await buildOptics(root);
		if (built.version !== manifest.version) {
			problems.push(`brand/optics/ is Optics ${manifest.version}, but ${built.version} is installed — run \`pnpm run optics\`.`);
		}
		for (const [file, body] of Object.entries(built.files)) {
			const on = await read(file).catch(() => null);
			if (on !== null && on !== body) problems.push(`${file} is stale — run \`pnpm run optics\`.`);
		}
	}
	return problems;
}

/** Ask npm what the newest Optics is. The only network call in here. */
async function latestVersion() {
	const res = await fetch(`https://registry.npmjs.org/${PKG.replace("/", "%2f")}`);
	if (!res.ok) throw new Error(`npm registry said ${res.status}`);
	return (await res.json())["dist-tags"].latest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const check = process.argv.includes("--check");

	if (process.argv.includes("--latest")) {
		const m = JSON.parse(await readFile(resolve(ROOT, MANIFEST), "utf8"));
		const latest = await latestVersion();
		if (latest === m.version) {
			console.log(`Optics ${m.version} is the latest.`);
		} else {
			console.log(`Optics ${latest} is out; brand/optics/ is on ${m.version}.`);
			console.log(`  pnpm add -D ${PKG}@${latest} && pnpm run optics`);
			process.exitCode = 1;
		}
	} else if (check) {
		const problems = await checkOptics();
		if (problems.length) {
			for (const p of problems) console.error(`  ✗ ${p}`);
			process.exit(1);
		}
		const m = JSON.parse(await readFile(resolve(ROOT, MANIFEST), "utf8"));
		console.log(
			`brand/optics/ is up to date (Optics ${m.version}: ${m.tokens.published} published tokens, ` +
				`${m.tokens.rolemodelOnly} RoleModel-only).`,
		);
	} else {
		const { files, manifest } = await buildOptics();
		await mkdir(resolve(ROOT, "brand/optics"), { recursive: true });
		for (const [file, body] of Object.entries(files)) {
			await writeFile(resolve(ROOT, file), body);
			console.log(`wrote ${file}`);
		}
		console.log(
			`Optics ${manifest.version}: ${manifest.tokens.published} tokens from the package, ` +
				`${manifest.tokens.rolemodelOnly} RoleModel-only from the Figma export.`,
		);
	}
}
