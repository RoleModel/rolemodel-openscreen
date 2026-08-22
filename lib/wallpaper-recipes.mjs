/**
 * The default wallpaper set, derived from brand/tokens.json.
 *
 * These are *starting points*, not the source of truth. `brand/wallpapers.json`
 * is, and the Studio's wallpaper editor writes to it. This file exists so that
 * (a) a fresh checkout has a full set without anyone opening an editor, and
 * (b) a new sub-brand landing in the Optics export gets boards for free.
 *
 * Everything here is linear. See lib/wallpaper.mjs for why.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalize } from "./wallpaper.mjs";

/** Base plate every board shares: near-black RoleModel navy, top-lit. */
const PLATE = { base: "#141d27", from: "#233140", to: "#101821", angle: 152 };

const dots = (opacity = 0.055) => ({
	type: "dots",
	color: "#f2f2f2",
	opacity,
	size: 16,
	weight: 1.4,
});

function board({ name, label, tint = null, alpha = 0.16, texture = dots() }) {
	return normalize({
		name,
		label,
		base: PLATE.base,
		gradient: { angle: PLATE.angle, stops: [{ color: PLATE.from, at: 0 }, { color: PLATE.to, at: 1 }] },
		tint: tint ? { color: tint, alpha, angle: 168 } : { alpha: 0 },
		texture,
	});
}

export async function defaultRecipes(root) {
	const tokens = JSON.parse(await readFile(resolve(root, "brand/tokens.json"), "utf8"));
	const { palette, unitSignatures = {}, subBrands = {} } = tokens;

	const out = [
		board({ name: "rm-dark-dotgrid", label: "RoleModel · dark dot-grid board" }),
		board({
			name: "rm-grid",
			label: "RoleModel · fine line grid",
			texture: { type: "grid", color: "#f2f2f2", opacity: 0.05, size: 48, weight: 1 },
		}),
		normalize({
			name: "rm-ascii",
			label: "RoleModel · ascii gradient panel",
			base: palette.primary,
			gradient: {
				angle: 118,
				stops: [
					{ color: palette.primary, at: 0 },
					{ color: palette.tertiary, at: 0.46 },
					{ color: palette.secondary, at: 1 },
				],
			},
			texture: { type: "ascii", color: "#ffffff", opacity: 0.13, size: 16, weight: 2 },
		}),
		normalize({
			name: "rm-light",
			label: "RoleModel · near-white board",
			base: palette.light,
			gradient: { angle: 160, stops: [{ color: "#ffffff", at: 0 }, { color: "#e6e8ea", at: 1 }] },
			texture: { type: "dots", color: palette.dark, opacity: 0.07, size: 16, weight: 1.4 },
		}),
		board({ name: "rm-brand", label: "RoleModel · brand-tinted board", tint: palette.primary }),
	];

	// Academy curriculum units — wayfinding inside one sub-brand.
	for (const [unit, hex] of Object.entries(unitSignatures)) {
		if (unit.startsWith("$") || !hex) continue;
		out.push(
			board({
				name: `academy-${unit}`,
				label: `Academy · ${unit[0].toUpperCase()}${unit.slice(1)} unit`,
				tint: hex,
			}),
		);
	}

	// One board per sub-brand, tinted with its real Optics signature.
	for (const [id, b] of Object.entries(subBrands)) {
		if (id === "academy") continue; // covered by the unit boards above
		out.push(board({ name: `${id}-board`, label: `${b.label} · tinted board`, tint: b.hex, alpha: 0.18 }));
	}

	return out;
}
