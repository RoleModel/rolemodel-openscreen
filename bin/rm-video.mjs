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
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { title, watermark } from "../lib/annotations.mjs";
import {
	ROOT,
	annotationList,
	applyTheme,
	buildEditorPatch,
	detectPadding,
	detectShape,
	loadPreset,
	readProject,
	writeProject,
} from "../lib/theme.mjs";
// `rm-video presets | head` closes stdout early; without this Node raises an
// unhandled EPIPE and exits 1, which looks like the tool broke rather than the
// pipe ending normally.
process.stdout.on("error", (err) => {
	if (err.code === "EPIPE") process.exit(0);
	throw err;
});

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback = undefined) {
	const i = argv.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const next = argv[i + 1];
	return next && !next.startsWith("--") ? next : true;
}

/** Run something and keep stdout as bytes — pixels do not survive a string. */
function captureBytes(cmd, args) {
	return new Promise((done) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
		const chunks = [];
		child.stdout?.on("data", (d) => chunks.push(d));
		child.on("error", () => done(Buffer.alloc(0)));
		child.on("close", () => done(Buffer.concat(chunks)));
	});
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

	// die() prints one line and exits; a stack here would bury the reason. Both of
	// these fail on ordinary user input — a document that was never recorded, or
	// one this tool does not recognise — so neither deserves a stack trace.
	const doc = await readProject(projectPath).catch((err) => die(err.message));
	let shape;
	try {
		shape = detectShape(doc);
	} catch (err) {
		die(`${err.message}\n  ${projectPath}`);
	}
	applyTheme(doc, patch);

	// Trim a padded capture, if that is what this is.
	//
	// A window recorded on a HiDPI Mac can arrive drawn into a display-sized
	// buffer with a black band below the content. Compositing that faithfully
	// puts the band inside the framed window, where it reads as part of the
	// recording. `cropRegion` is a clip field the exporter already applies, so
	// this costs no re-encode. Skipped when there is nothing to trim, and never
	// overrides a crop somebody already set.
	// The identity region counts as "no crop", not as one somebody chose. The
	// preset writes it as part of its editor patch, so testing for the key alone
	// meant detection never ran once branding had been applied.
	const existing = doc.editor?.cropRegion;
	const hasRealCrop =
		existing &&
		!(existing.x === 0 && existing.y === 0 && existing.width === 1 && existing.height === 1);

	const source = doc.media?.screenVideoPath ?? doc.assets?.[0]?.originalPath;
	if (source && !flag("no-crop") && !hasRealCrop) {
		const region = await detectPadding(source, { probe: captureBytes }).catch(() => null);
		if (region) {
			doc.editor = { ...(doc.editor ?? {}), cropRegion: region };
			const pct = (1 - region.width * region.height) * 100;
			console.log(`  cropped   ${pct.toFixed(1)}% of the frame was black padding`);
		}
	}

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

/**
 * Install the HyperFrames skills.
 *
 * "Make a video" asks Claude to build the render `Using /hyperframes`, which
 * only resolves if that skill is on the machine. It is not vendored here: the
 * hyperframes CLI installs and versions its own skills, and a frozen copy in
 * this repo would rot exactly the way a flattened Optics export did — and would
 * not work anyway, because Claude looks in ~/.claude/skills or the project the
 * render runs in, never in this toolkit.
 *
 * Homebrew cannot do this at install time. `~/.claude/skills` is per-user, brew
 * may run as another user entirely, and a formula that reaches the network in
 * post_install fails on a locked-down machine and makes the install
 * non-deterministic. So it is one command, the same shape as `rm-voice --setup`.
 */
async function skillsCommand() {
	const check = argv.includes("--check");
	const args = ["--yes", "hyperframes", "skills", ...(check ? ["check"] : ["update"])];
	console.log(`\n  ${check ? "Checking" : "Installing"} the HyperFrames skills\n`);
	const { spawn } = await import("node:child_process");
	const code = await new Promise((done) => {
		// stdio inherit: this is a terminal command, and the installer is chatty
		// on purpose. stdin is /dev/null for the reason lib/jobs.mjs explains.
		const child = spawn("npx", args, { stdio: ["ignore", "inherit", "inherit"] });
		child.on("error", (e) => {
			console.error(`  could not run npx: ${e.message}`);
			done(1);
		});
		child.on("close", done);
	});
	if (code !== 0) process.exitCode = code ?? 1;
	else if (!check) console.log("\n  Installed into ~/.claude/skills — `Make a video` can find them now.\n");
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
	case "skills":
		await skillsCommand();
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
				"  skills                       install the HyperFrames skills Make a video needs",
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
