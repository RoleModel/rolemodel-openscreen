/**
 * Emit real Optics CSS from the Figma export.
 *
 * The Studio was styled with a dozen hand-picked hexes in a `:root` block —
 * `--panel:#161d27`, `--accent:#00b871`, and so on. Those were eyeballed against
 * Optics, which means they were already slightly wrong and would drift further
 * every time Optics shipped. RoleModel has a design system; a RoleModel tool
 * should use it rather than a sketch of it.
 *
 * The export carries both the WEB variable name and the resolved value for each
 * of the two modes, so this writes one custom property per token as
 * `light-dark(<light>, <dark>)`. Which one resolves is then a `color-scheme`
 * declaration, not a rebuild.
 *
 * Note the direction of the ramps, because it is the reason this works at all:
 * in Optics, `plus` runs toward the page background and `minus` toward the
 * foreground, in BOTH modes. `neutral-plus-max` is #ffffff in light and #1f1f1f
 * in dark. So a mapping written once ("panels are plus-eight, body text is
 * minus-max") is correct in both, and there is no second palette to maintain.
 *
 *   node lib/optics-css.mjs [--check]
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Flatten one mode of the export into [cssVarName, hex] pairs. */
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

export async function buildOpticsCSS(root = ROOT) {
	const raw = JSON.parse(await readFile(resolve(root, "brand/optics-tokens.json"), "utf8"));
	const styles = raw["0"]?.["Color Styles"]?.modes;
	if (!styles?.Light || !styles?.Dark) {
		throw new Error("brand/optics-tokens.json has no Color Styles Light/Dark modes");
	}

	const light = collect(styles.Light, "", new Map());
	const dark = collect(styles.Dark, "", new Map());

	const lines = [];
	for (const [name, l] of light) {
		const d = dark.get(name);
		lines.push(`  ${name}: ${d && d !== l ? `light-dark(${l}, ${d})` : l};`);
	}

	const body = [
		"/*",
		" * GENERATED — do not edit.",
		" *   node lib/optics-css.mjs      (or npm run build)",
		" *",
		" * Optics colour tokens, from brand/optics-tokens.json. One custom property",
		" * per token, resolved per mode with light-dark(). Set `color-scheme` on the",
		" * page to pick a side; the Studio pins dark.",
		" */",
		":root {",
		`  /* ${lines.length} tokens */`,
		...lines,
		"}",
		"",
	].join("\n");

	return { css: body, count: lines.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { css, count } = await buildOpticsCSS();
	const dest = resolve(ROOT, "brand/optics.css");
	if (process.argv.includes("--check")) {
		const current = await readFile(dest, "utf8").catch(() => null);
		if (current !== css) {
			console.error("brand/optics.css is stale — run `node lib/optics-css.mjs`");
			process.exit(1);
		}
		console.log(`brand/optics.css is up to date (${count} tokens).`);
	} else {
		await writeFile(dest, css, "utf8");
		console.log(`  brand/optics.css  —  ${count} tokens`);
	}
}
