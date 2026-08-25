#!/usr/bin/env node
/**
 * Renders the RoleModel wallpaper set for OpenScreen.
 *
 * OpenScreen composes the screen recording on top of a "wallpaper" — the visible
 * padding around the capture. That backdrop is the single largest branded surface
 * in a demo video, and the stock set is generic. These are ours.
 *
 * Design intent: a backdrop is not a slide. It sits behind a bright screen
 * recording for the whole runtime, so it stays quiet — low-contrast texture,
 * no focal point, nothing that competes with the content in front of it. And it
 * is linear: no radial gradients, no vignette. The vignette in the first version
 * was an ellipse that fell outside a 16:9 frame along the bottom, which read as a
 * thick dark border under every recording.
 *
 *   node lib/make-wallpapers.mjs                 # render brand/wallpapers.json
 *   node lib/make-wallpapers.mjs --reset         # rewrite recipes from tokens first
 *   node lib/make-wallpapers.mjs --only rm-ascii # one recipe
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { installWallpapersIntoFork } from "./wallpaper-install.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withRenderer } from "./render-wallpaper.mjs";
import { css, normalize } from "./wallpaper.mjs";
import { defaultRecipes } from "./wallpaper-recipes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const OUT = resolve(ROOT, arg("out", "brand/wallpapers"));
const RECIPES = resolve(ROOT, "brand/wallpapers.json");
const W = Number(arg("width", 3840));
const H = Number(arg("height", 2160));

/** Recipes live in brand/wallpapers.json; the token-derived set seeds it. */
export async function loadRecipes(root = ROOT) {
	const path = resolve(root, "brand/wallpapers.json");
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return (Array.isArray(parsed) ? parsed : parsed.wallpapers).map(normalize);
	} catch {
		return await defaultRecipes(root);
	}
}

export async function saveRecipes(recipes, root = ROOT) {
	await writeFile(
		resolve(root, "brand/wallpapers.json"),
		`${JSON.stringify(recipes.map(normalize), null, 2)}\n`,
		"utf8",
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const recipes = has("reset") ? await defaultRecipes(ROOT) : await loadRecipes();
	if (has("reset")) await saveRecipes(recipes);
	else await writeFile(RECIPES, `${JSON.stringify(recipes, null, 2)}\n`, "utf8").catch(() => {});

	const only = arg("only", null);
	const set = only ? recipes.filter((r) => r.name === only) : recipes;
	if (!set.length) {
		console.error(`no recipe named "${only}"`);
		process.exit(1);
	}

	await mkdir(OUT, { recursive: true });

	/*
	 * Renders whose recipe is gone, gone too.
	 *
	 * This only ever wrote. Removing a recipe left its JPEG sitting in the output
	 * directory with nothing referencing it — not the recipes, not index.json, not the
	 * contact sheet — so the file stayed on disk and in git for ever and the only way
	 * to be rid of it was to know it was there and delete it by hand. Reported as "I
	 * can't remove any of the wallpapers", which was exactly right.
	 *
	 * Skipped when --only names one recipe: that run knows about one wallpaper and has
	 * no business deciding the other twelve are orphans.
	 */
	if (!only) {
		const want = new Set(recipes.map((r) => `${r.name}.jpg`));
		for (const file of await readdir(OUT).catch(() => [])) {
			if (!file.endsWith(".jpg") || file.startsWith("_") || want.has(file)) continue;
			await rm(resolve(OUT, file));
			console.log(`  removed ${file}  —  no recipe named it any more`);
		}
	}

	const renderer = await withRenderer({ width: W, height: H });
	for (const r of set) {
		const jpeg = await renderer.render(r, { w: W, h: H });
		await writeFile(resolve(OUT, `${r.name}.jpg`), jpeg);
		console.log(`  ${r.name}.jpg  —  ${r.label}`);
	}

	/*
	 * Install into the fork, so the editor's picker can actually offer these.
	 *
	 * The picker builds its list from a count and a filename convention —
	 * `/wallpapers/wallpaper${i}.jpg` for i in 1..18 — so a wallpaper that is not in
	 * public/wallpapers under that name does not exist as far as the editor is
	 * concerned. Ours lived only here, which is why "the editor still doesn't show our
	 * wallpapers" stayed true through three rounds of branding work.
	 *
	 * They go into their own subdirectory rather than being renumbered into the stock
	 * run: `wallpaper19.jpg` would put them last, lose their names, and collide the
	 * moment upstream adds one. src/lib/brandWallpapers.ts is generated beside them so
	 * the fork builds in CI with no toolkit checkout, the same reason
	 * optics-tokens.css is committed there.
	 *
	 * Thumbs at 240x240 because that is what the picker grid loads — the full renders
	 * are 3840x2160 and decoding thirteen of them to paint a swatch is what made the
	 * stock picker slow enough to be reported.
	 */
	if (!has("no-install") && !only) {
		const fork = resolve(arg("openscreen", resolve(ROOT, "..", "openscreen")));
		const { installed, reason } = await installWallpapersIntoFork({ recipes, out: OUT, fork });
		if (reason) {
			console.log(`\n  ${reason} — skipping the editor install\n`);
		} else {
			console.log(`\n  installed into ${fork}`);
			console.log(`    public/wallpapers/brand/  (${installed} + thumbs)`);
			console.log("    src/lib/brandWallpapers.ts");
		}
	}

	// A contact sheet so a human can pick one without opening the whole set. Built from
	// the rendered JPEGs, not by re-running the recipe: re-rendering into a small
	// cell shows texture at the wrong scale and makes the sheet actively misleading.
	const tokens = JSON.parse(await readFile(resolve(ROOT, "brand/tokens.json"), "utf8"));
	const cells = recipes
		.map(
			(r) => `
  <figure style="margin:0">
    <div style="width:100%;aspect-ratio:16/9;border-radius:10px;background:#0e141b url('${r.name}.jpg') center/cover no-repeat"></div>
    <figcaption style="font:500 15px/1.4 ui-sans-serif,system-ui;color:${tokens.palette.light};opacity:.72;padding-top:10px">
      ${r.label}<br><code style="opacity:.6;font-size:13px">${r.name}.jpg</code>
    </figcaption>
  </figure>`,
		)
		.join("");

	const sheet = resolve(OUT, "_sheet.html");
	await writeFile(
		sheet,
		`<!doctype html><html><body style="margin:0;background:#161d27;padding:56px">
   <h1 style="font:800 34px/1 ui-sans-serif,system-ui;color:${tokens.palette.light};letter-spacing:-.03em;margin:0 0 8px">RoleModel wallpapers for OpenScreen</h1>
   <p style="font:400 16px/1.5 ui-sans-serif,system-ui;color:${tokens.palette.light};opacity:.6;margin:0 0 40px">Backdrops behind the screen recording. Rendered at ${W}×${H}, JPEG q92. Edit them in <code>rm-studio</code> → Wallpapers.</p>
   <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:36px">${cells}</div>
   </body></html>`,
		"utf8",
	);
	const { chromium } = await import("playwright");
	const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
	const p = await b.newPage({ viewport: { width: 1680, height: 1400 } });
	await p.goto(pathToFileURL(sheet).href, { waitUntil: "networkidle" });
	await p.screenshot({ path: resolve(OUT, "_contact-sheet.jpg"), type: "jpeg", quality: 90, fullPage: true });
	await b.close();
	await rm(sheet, { force: true });
	await renderer.close();

	await writeFile(
		resolve(OUT, "index.json"),
		`${JSON.stringify(
			recipes.map((r) => ({ name: r.name, label: r.label, file: `${r.name}.jpg`, css: css(r) })),
			null,
			2,
		)}\n`,
	);
	console.log(`\n${set.length} wallpapers + contact sheet -> ${OUT}`);
}
