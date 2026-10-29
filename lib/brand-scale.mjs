/**
 * An Optics scale for every colour a brand names.
 *
 * Optics' OKLCH build computes each family's ramp from three seeds:
 *
 *   --op-color-primary-base: light-dark(
 *     oklch(47.3% calc(var(--op-color-primary-c) * 0.86) var(--op-color-primary-h)),
 *     …
 *   );
 *
 * so a new family is the primary ladder, renamed, over its own seeds. The ladder
 * is read out of the vendored package rather than restated here, so an Optics
 * release that retunes its steps retunes every brand's scale with it.
 *
 * A brand's colours become families named `<brand>-<colour>`: a brand called
 * dock-designer with a primary gets `--op-color-dock-designer-primary-base` and
 * every other step, the same shape as the families rolemodel-scales.css ships.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./theme.mjs";

const VENDORED = resolve(ROOT, "brand/optics/optics.css");
let ladder = null;

/** The primary family's steps, as [suffix, value], seeds excluded. */
function primaryLadder() {
	if (ladder) return ladder;
	const css = readFileSync(VENDORED, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const seen = new Map();
	for (const m of css.matchAll(/--op-color-primary-([a-z0-9-]+)\s*:\s*([^;{}]+);/g)) {
		if (/^[hcl]$/.test(m[1]) || seen.has(m[1])) continue;
		seen.set(m[1], m[2].replace(/\s+/g, " ").trim());
	}
	ladder = [...seen];
	return ladder;
}

/** #rrggbb to [lightness %, chroma, hue°] in OKLCH (Björn Ottosson's OKLab). */
export function hexToOklch(hex) {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) return null;
	const lin = [0, 2, 4].map((i) => {
		const c = Number.parseInt(m[1].slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	const [r, g, b] = lin;
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
	const C = Math.sqrt(A * A + B * B);
	const H = C < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
	return [Math.round(L * 1000) / 10, Math.round(C * 1000) / 1000, Math.round(H * 10) / 10];
}

/** The family a brand colour lives in. */
export const brandFamily = (presetId, key) => `${presetId}-${key}`;

/** One family's declarations: its seeds, then every step of the ladder. */
export function familyScale(family, hex) {
	const lch = hexToOklch(hex);
	if (!lch) return [];
	const [l, c, h] = lch;
	return [
		[`--op-color-${family}-h`, String(h)],
		[`--op-color-${family}-c`, String(c)],
		[`--op-color-${family}-l`, `${l}%`],
		...primaryLadder().map(([step, value]) => [`--op-color-${family}-${step}`, value.replaceAll("--op-color-primary-", `--op-color-${family}-`)]),
	];
}

/** Every scale for every brand that names colours, as one `:root` rule. */
export function brandScalesCss(presets) {
	const rows = [];
	for (const preset of presets ?? []) {
		for (const [key, hex] of Object.entries(preset?.colors ?? {})) rows.push(...familyScale(brandFamily(preset.id, key), hex));
	}
	if (!rows.length) return "";
	return `/* Brand scales, generated from the brands made on the Brand page (lib/brand-scale.mjs). */\n:root {\n${rows.map(([n, v]) => `  ${n}: ${v};`).join("\n")}\n}\n`;
}

/**
 * What a scene sets on the stage for a brand: its colour, the ink that reads on
 * it, the colour as text on a dark board, and its type.
 *
 * The same three the accent picker sets on a single part, for the same reasons,
 * but as the stage's default. The components read --rm-brand and friends as
 * fallbacks, so a part with its own picked accent still wins.
 */
export function brandStageCss(preset) {
	const vars = [];
	if (preset?.colors?.primary) {
		const f = brandFamily(preset.id, "primary");
		vars.push(`--rm-brand: var(--op-color-${f}-original)`, `--rm-on-brand: var(--op-color-${f}-on-base)`, `--rm-brand-text: var(--op-color-${f}-minus-two)`);
	}
	if (preset?.fonts?.display) vars.push(`--rm-font: "${preset.fonts.display}"`);
	if (preset?.fonts?.mono) vars.push(`--rm-mono: "${preset.fonts.mono}"`);
	return vars.length ? `:root { ${vars.join("; ")}; }` : "";
}
