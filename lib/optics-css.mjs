/**
 * Bring Optics in as Optics, not as a copy of it.
 *
 * What this used to do: read a 791KB Figma variables export and flatten it into
 * 1160 static hexes, one `light-dark()` pair per token. That produced something
 * that *looked* like Optics and behaved like a photograph of it. Real Optics
 * does not ship hexes at all — every ramp is computed in CSS from three
 * numbers. Since 2.6 those numbers are OKLCH:
 *
 *   --op-color-primary-plus-eight: light-dark(
 *     oklch(98.2% calc(var(--op-color-primary-c) * 0.04) var(--op-color-primary-h)),
 *     oklch(24.2% calc(var(--op-color-primary-c) * 0.36) var(--op-color-primary-h))
 *   );
 *
 * So the flattened version lost the thing that makes the system a system: set
 * `--op-color-primary-h` and all 480-odd tokens re-tint. Flattened, they cannot
 * move, and every Optics release silently widened the gap between our palette
 * and the real one.
 *
 * What this does now:
 *
 *   1. Vendors `@rolemodel/optics`' OKLCH build verbatim into
 *      brand/optics/optics.css. Byte for byte, never edited. `--check` compares
 *      hashes, so a hand-edit is a failed build rather than a mystery.
 *   2. Generates brand/optics/rolemodel-scales.css from brand/optics/theme.css,
 *      the Optics Theme Builder's export of RoleModel's palette. The theme
 *      writes every family out whole; this keeps the part the package does not
 *      already say:
 *        - every family's -h/-c/-l seeds, which are the tinting API;
 *        - every step for the families Optics does not publish (the sub-brands,
 *          accent, secondary, tertiary, the AI swatches);
 *        - a published step only where the theme's value differs. Those are the
 *          ink steps the Theme Builder re-tuned so each pair passes 4.5:1 for
 *          *our* seeds, and they are still computed from the seeds, so they
 *          re-tint like the rest.
 *      A step identical to the package's is dropped, so as Optics publishes
 *      more, this file shrinks on its own.
 *
 * To change the palette, change it in the Theme Builder, paste its export over
 * brand/optics/theme.css, and run `pnpm run optics`. The preset code at the top
 * of the theme reopens it in the builder.
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

// The OKLCH, no_icons build: nothing here uses Material Symbols, and that
// variant is the same tokens without pulling an icon font over the network on
// every video render. The Noto @import it does keep is Optics' own and is left
// alone — our own CSS sets font-family, so nothing depends on it.
const UPSTREAM = "dist/css/optics-oklch+no_icons.css";
const PKG = "@rolemodel/optics";

export const VENDORED = "brand/optics/optics.css";
export const THEME = "brand/optics/theme.css";
export const SUPPLEMENT = "brand/optics/rolemodel-scales.css";
export const MANIFEST = "brand/optics/manifest.json";

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** A seed is Optics' input: the hue, chroma and lightness of one family. */
const isSeed = (name) => /^--op-color-[a-z0-9-]+-(h|c|l)$/.test(name);

/** Same value, whatever the line breaks: Optics wraps light-dark(), the theme does not. */
const normalize = (value) =>
	value
		.replace(/\s+/g, " ")
		.replace(/\(\s+/g, "(")
		.replace(/\s+\)/g, ")")
		.replace(/\s*,\s*/g, ", ")
		.trim();

/** Every custom property the published package defines, with its value. */
function definedBy(css) {
	const names = new Map();
	const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const m of bare.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
		if (!names.has(m[1])) names.set(m[1], normalize(m[2]));
	}
	return names;
}

/**
 * The declarations in the theme's `:root` rules, in the order it wrote them.
 *
 * The Theme Builder export is flat — `:root { … }` blocks and @imports, no
 * nesting — so a regex over the comment-free text is enough. The @imports are
 * dropped: one is a bare `@rolemodel/optics` specifier no browser can resolve,
 * and the fonts and icons they load are served by the Studio itself.
 */
function themeDeclarations(css) {
	const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const out = [];
	for (const block of bare.matchAll(/:root\s*\{([^{}]*)\}/g)) {
		for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.push([m[1], normalize(m[2])]);
	}
	return out;
}

/**
 * Build the supplement.
 *
 * Three kinds of thing end up in here, and the difference is the whole point:
 *
 *   1. The seeds — `--op-color-<family>-h/c/l` — for *every* family in the
 *      theme, including the ones Optics publishes. These are not a copy of
 *      anything; they are the tinting API. Optics computes 486 tokens from
 *      `--op-color-primary-h/c/l`, and `--op-color-neutral-h` is defined as
 *      `var(--op-color-primary-h)`, so setting these numbers is how RoleModel's
 *      palette reaches the published ramps at all. The supplement loads after
 *      the package, so ours win.
 *
 *   2. The steps for families Optics does *not* publish, as the theme computed
 *      them from their seeds.
 *
 *   3. A published step only where the theme says something different, which
 *      in practice is the contrast-tuned ink. Identical ones are dropped: a
 *      second copy of a value the package already computes is noise.
 *
 * A theme value that is not computed from its seeds is refused rather than
 * written. A literal colour cannot re-tint, and that is the failure this split
 * exists to undo.
 */
export function buildSupplement(upstream, theme) {
	const published = definedBy(upstream);
	const rows = [];
	const stats = { seeds: 0, steps: 0, tuned: 0, other: 0, same: 0, kept: 0, families: new Set() };

	for (const [name, value] of themeDeclarations(theme)) {
		const theirs = published.get(name);
		// Seeds Optics defines as a reference rather than a number. `neutral-h` is
		// `var(--op-color-primary-h)` on purpose: the greys follow the brand hue, so
		// one change re-tints every surface. Writing a number over that does not
		// shadow a value, it severs a relationship. So these are left to the
		// package no matter what the theme says.
		if (theirs?.startsWith("var(")) {
			stats.kept++;
			continue;
		}
		if (isSeed(name)) {
			rows.push([name, value]);
			stats.seeds++;
			continue;
		}
		if (theirs === value) {
			stats.same++;
			continue;
		}
		if (name.startsWith("--op-color-") && /#[0-9a-f]{3,8}\b|\b(rgb|hsl)a?\(/i.test(value)) {
			throw new Error(`${THEME}: ${name} is a literal colour (${value}). Export the theme with its steps computed from the seeds.`);
		}
		rows.push([name, value]);
		if (!name.startsWith("--op-color-")) stats.other++;
		else if (theirs === undefined) {
			stats.steps++;
			const family = /var\(--op-color-([a-z0-9-]+)-h\)/.exec(value)?.[1];
			if (family) stats.families.add(family);
		} else stats.tuned++;
	}

	const families = [...stats.families].sort();
	const head = [
		"/*",
		" * GENERATED by lib/optics-css.mjs from brand/optics/theme.css — do not edit.",
		" *",
		" * Three things live here, and the difference matters:",
		" *",
		" *   1. --op-color-<family>-h/c/l for every family in the theme. These are",
		" *      the tinting API, not a copy: Optics computes its ramps from these",
		" *      three numbers, and --op-color-neutral-h is literally",
		" *      var(--op-color-primary-h). This file loads after the package, so",
		" *      these are what RoleModel's palette actually is.",
		" *",
		" *   2. Ramp steps for the families the open-source release does not ship.",
		` *      ${families.length} of them: ${families.join(", ")}.`,
		" *",
		" *   3. Published steps the Theme Builder re-tuned for contrast, and the",
		" *      theme's type, spacing and radius settings.",
		" *",
		` * ${stats.seeds} seeds · ${stats.steps} RoleModel steps · ${stats.tuned} tuned steps · ${stats.other} other settings`,
		` * ${stats.same} steps left to the package, which computes the same thing.`,
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
	const theme = await readFile(resolve(root, THEME), "utf8");
	const supplement = buildSupplement(upstream, theme);
	const ours = definedBy(supplement).size;

	const manifest = {
		$comment: `GENERATED by lib/optics-css.mjs. ${VENDORED} is ${PKG} verbatim and ${SUPPLEMENT} is built from ${THEME} — do not edit either by hand.`,
		package: PKG,
		version,
		upstreamFile: UPSTREAM,
		vendoredSha256: sha(upstream),
		supplementSha256: sha(supplement),
		tokens: { published: definedBy(upstream).size, rolemodelOnly: ours },
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
 * manifest's hashes must match the two CSS files beside it, and the supplement
 * must be what the theme builds against the vendored package. Comparing against
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
			problems.push(`${file} does not match ${MANIFEST} (${key}) — it was hand-edited, or the theme changed.`);
		}
	}

	const vendored = await read(VENDORED).catch(() => "");
	const theme = await read(THEME).catch(() => null);
	const supplement = await read(SUPPLEMENT).catch(() => "");
	if (theme === null) problems.push(`${THEME} is missing — it is the source of ${SUPPLEMENT}.`);
	else if (vendored && supplement) {
		try {
			if (buildSupplement(vendored, theme) !== supplement) {
				problems.push(`${SUPPLEMENT} is not what ${THEME} builds — run \`pnpm run optics\`.`);
			}
		} catch (error) {
			problems.push(error.message);
		}
	}

	// A step the supplement shares with the package must still be computed from
	// its seeds. A seed is Optics' *input* — redefining `--op-color-primary-h` is
	// the documented way to tint the system. A step written as a literal colour
	// would sit on top of the live one and stop it re-tinting. One steers, the
	// other freezes.
	if (vendored && supplement) {
		const published = definedBy(vendored);
		const frozen = [...definedBy(supplement)].filter(
			([n, v]) => published.has(n) && n.startsWith("--op-color-") && !isSeed(n) && !/var\(--op-color-[a-z0-9-]+-h\)/.test(v),
		);
		if (frozen.length) {
			problems.push(`${SUPPLEMENT} freezes ${frozen.length} computed Optics tokens: ${frozen.slice(0, 5).map(([n]) => n).join(", ")}`);
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
				`${manifest.tokens.rolemodelOnly} RoleModel-only from the theme.`,
		);
	}
}
