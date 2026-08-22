#!/usr/bin/env node
/**
 * rm-video — put RoleModel brand on an OpenScreen project.
 *
 *   rm-video presets
 *   rm-video theme demo.openscreen --preset academy --unit rails
 *   rm-video theme demo.openscreen --preset rolemodel --variant vertical
 *   rm-video brand demo.openscreen --preset rolemodel \
 *       --title "Dock Designer" --eyebrow "Product tour" --watermark
 *
 * Then hand it back to OpenScreen:
 *   openscreen export demo.openscreen -o demo.mp4 --auto-zoom --json
 */
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { title, watermark } from "../lib/annotations.mjs";
import {
	ROOT,
	annotationList,
	applyTheme,
	buildEditorPatch,
	detectShape,
	loadPreset,
	readProject,
	writeProject,
} from "../lib/theme.mjs";
const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback = undefined) {
	const i = argv.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const next = argv[i + 1];
	return next && !next.startsWith("--") ? next : true;
}

function die(msg) {
	console.error(`rm-video: ${msg}`);
	process.exit(1);
}

async function listPresets() {
	const files = (await readdir(resolve(ROOT, "presets"))).filter((f) => f.endsWith(".json"));
	console.log("\nPresets\n");
	for (const f of files) {
		const p = await loadPreset(f.replace(/\.json$/, ""));
		console.log(`  ${p.id.padEnd(12)} ${p.label}`);
		console.log(`  ${"".padEnd(12)} ${p.description}`);
		const names = (o) => Object.keys(o ?? {}).filter((k) => !k.startsWith("$"));
		const units = names(p.units);
		console.log(
			`  ${"".padEnd(12)} variants: ${names(p.variants).join(", ") || "—"}` +
				(units.length ? `  ·  units: ${units.join(", ")}` : ""),
		);
		if (p.open?.length) console.log(`  ${"".padEnd(12)} ⚠ open: ${p.open[0]}`);
		console.log("");
	}
}

async function themeCommand({ alsoBrand }) {
	const projectPath = argv[1];
	if (!projectPath || projectPath.startsWith("--")) die("give me a .openscreen file");

	const presetId = flag("preset", "rolemodel");
	const variant = flag("variant");
	const unit = flag("unit");
	const wallpaperDir = flag("wallpaper-dir", resolve(ROOT, "brand/wallpapers"));

	const preset = await loadPreset(presetId);
	const patch = buildEditorPatch(preset, {
		variant: typeof variant === "string" ? variant : undefined,
		unit: typeof unit === "string" ? unit : undefined,
		wallpaperDir,
	});

	const doc = await readProject(projectPath);
	const shape = detectShape(doc);
	applyTheme(doc, patch);

	const added = [];
	if (alsoBrand) {
		const titleText = flag("title");
		const eyebrow = flag("eyebrow");
		const holdMs = Number(flag("title-ms", 3200));
		const list = annotationList(doc);

		if (typeof titleText === "string") {
			const regions = title({
				text: titleText,
				eyebrow: typeof eyebrow === "string" ? eyebrow : undefined,
				startMs: 0,
				endMs: holdMs,
			});
			list.push(...regions);
			added.push(`title (${regions.length} regions, 0–${holdMs}ms)`);
		}
		if (flag("watermark")) {
			const endMs = Number(flag("duration-ms", 0)) || undefined;
			if (!endMs) {
				console.warn(
					"rm-video: --watermark needs --duration-ms <total video length> to know when to end; skipping.",
				);
			} else {
				list.push(...watermark({ endMs }));
				added.push(`watermark (0–${endMs}ms)`);
			}
		}
	}

	await writeProject(projectPath, doc);

	console.log(`\n  ${projectPath}`);
	console.log(`  preset    ${preset.id}${unit ? ` · unit ${unit}` : ""}${variant ? ` · ${variant}` : ""}`);
	console.log(`  shape     ${shape === "axcut" ? `AxcutDocument v${doc.schemaVersion}` : "legacy v2"}`);
	console.log(`  wallpaper ${patch.wallpaper ?? "(unchanged)"}`);
	console.log(
		`  applied   ${Object.keys(patch).length} editor fields${added.length ? `, + ${added.join(", ")}` : ""}`,
	);
	console.log(`\n  next:  openscreen export ${projectPath} --auto-zoom --json\n`);
}

switch (cmd) {
	case "root":
		// The skill needs an absolute path to the toolkit. Under Homebrew that is
		// inside the keg, not next to the `rm-video` symlink, so ask rather than guess:
		//   export RM_OPENSCREEN="$(rm-video root)"
		console.log(ROOT);
		break;
	case "presets":
		await listPresets();
		break;
	case "theme":
		await themeCommand({ alsoBrand: false });
		break;
	case "brand":
		await themeCommand({ alsoBrand: true });
		break;
	default:
		console.log(
			[
				"",
				"rm-video — RoleModel brand for OpenScreen projects",
				"",
				"  root                         print the toolkit's install path",
				"  presets                      list available brand presets",
				"  theme <file.openscreen>      apply a preset's appearance settings",
				"  brand <file.openscreen>      apply the preset, plus title / watermark",
				"",
				"Options",
				"  --preset <id>       rolemodel | academy | lightning     (default rolemodel)",
				"  --variant <id>      master | vertical | square | gif",
				"  --unit <id>         academy only: ruby | design | rails",
				"  --title <text>      opening title card text            (brand only)",
				"  --eyebrow <text>    mono label above the title         (brand only)",
				"  --watermark         persistent brand mark              (brand only)",
				"  --duration-ms <n>   total video length; required by --watermark",
				"  --wallpaper-dir <p> where the wallpaper PNGs live",
				"",
			].join("\n"),
		);
		if (cmd) process.exitCode = 1;
}
