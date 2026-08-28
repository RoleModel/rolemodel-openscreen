#!/usr/bin/env node
/**
 * Splits the canonical Optics/Figma export into direct-import Light and Dark
 * files. The export stays the only source of truth; these files are outputs.
 *
 * Figma's Variables import accepts DTCG token objects, but a CSS hex string is
 * not a DTCG colour value. It needs the sRGB object Figma exports itself. The
 * source is optimised for the Studio and carries CSS code syntax/scopes, so this
 * step deliberately produces the smaller native-import dialect instead.
 *
 *   pnpm run figma-tokens
 *   pnpm run figma-tokens:check
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "brand/optics-tokens.json");
const OUTPUT = resolve(ROOT, "brand/figma");
const CHECK = process.argv.includes("--check");

const targets = [
	{ files: ["light.tokens.json", "Color Styles.Light.tokens.json"], styleMode: "Light" },
	{ files: ["dark.tokens.json", "Color Styles.Dark.tokens.json"], styleMode: "Dark" },
];

const HEX = /^#?([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;

function figmaColor(value, path) {
	const matched = String(value ?? "").trim().match(HEX);
	if (!matched) throw new Error(`${path} must be a hex colour to export for Figma; received ${JSON.stringify(value)}.`);
	const compact = matched[1];
	const hex = compact.length <= 4 ? [...compact].map((part) => part + part).join("") : compact;
	const byte = (start) => Number.parseInt(hex.slice(start, start + 2), 16);
	return {
		colorSpace: "srgb",
		components: [byte(0) / 255, byte(2) / 255, byte(4) / 255],
		alpha: hex.length === 8 ? byte(6) / 255 : 1,
		hex: `#${hex.toUpperCase()}`,
	};
}

function figmaTokens(node, path = []) {
	if (node && typeof node === "object" && "$value" in node) {
		// Primitive Colors also carries the H/S/L implementation values used to
		// derive a scale in CSS. They are not part of the colour collection and
		// would make a Figma colour import reject the file, so leave them behind.
		if (node.$type !== "color") return null;
		return { $type: "color", $value: figmaColor(node.$value, path.join(".")) };
	}
	const result = {};
	for (const [name, value] of Object.entries(node ?? {})) {
		if (name.startsWith("$")) continue;
		const child = figmaTokens(value, [...path, name]);
		if (child && Object.keys(child).length) result[name] = child;
	}
	return result;
}

function split(doc, { styleMode }) {
	const root = doc[0];
	const styles = root?.["Color Styles"];
	const primitives = root?.["Primitive Colors"];
	if (!styles?.modes?.[styleMode]) throw new Error(`The canonical export has no Color Styles / ${styleMode} mode.`);
	if (!primitives?.modes?.["Light Theme"]) throw new Error("The canonical export has no Primitive Colors / Light Theme mode.");

	/*
	 * Both files carry the exact same paths and types. Figma uses that matching
	 * shape to create one collection with Light and Dark modes when both files are
	 * dropped into a new collection; each file also works alone with Import mode.
	 *
	 * Do not carry `com.figma.variableId` across. IDs belong to the file that was
	 * exported, and stale IDs are precisely what makes a clean re-import fail.
	 */
	return {
		// The primitive-mode document already has an `op-color` group. Preserve
		// that shape so its exported paths remain `op-color/white` and
		// `op-color/black`, matching the live Figma collection.
		...figmaTokens(primitives.modes["Light Theme"], ["Primitive Colors"]),
		...figmaTokens(styles.modes[styleMode]),
	};
}

const source = JSON.parse(await readFile(SOURCE, "utf8"));
if (!Array.isArray(source) || source.length !== 1 || !source[0]) throw new Error("brand/optics-tokens.json must be a one-document Figma export.");

let stale = false;
for (const target of targets) {
	const output = `${JSON.stringify(split(source, target), null, 2)}\n`;
	for (const file of target.files) {
		const path = resolve(OUTPUT, file);
		const current = await readFile(path, "utf8").catch(() => null);
		if (current === output) continue;
		if (CHECK) {
			console.error(`${path.replace(`${ROOT}/`, "")} is out of date — run \`pnpm run figma-tokens\`.`);
			stale = true;
			continue;
		}
		await mkdir(OUTPUT, { recursive: true });
		await writeFile(path, output, "utf8");
		console.log(`wrote ${path.replace(`${ROOT}/`, "")}`);
	}
}

if (CHECK && stale) process.exit(1);
if (CHECK) console.log("Figma Light and Dark token files are up to date.");
