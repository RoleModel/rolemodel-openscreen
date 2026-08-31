#!/usr/bin/env node
/**
 * rm-resync — put every composition's staged copies back in line with the code.
 *
 * A composition keeps its own copy of the components, the theme, the fonts and
 * the brand marks so it renders with no network and survives being zipped. The
 * copy is taken when it is built, though, and never again — so a cut made last
 * week runs last week's components, and a fix landed since is not in it. The
 * lower thirds in canvas-rough-cut were wrong for exactly that reason: its
 * runtime was seven hundred lines behind.
 *
 * This re-stages, which is the same copy taken again. Nothing about a
 * composition's own content is touched: the markup, the timings, the images and
 * the hand-tuning are its own, and only the material that came from the
 * codebase is replaced.
 *
 *   rm-resync <projectId> [folder]     one project, or one composition in it
 *   rm-resync --all                    every project in the library
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultRoot } from "../lib/library.mjs";
import { stageRenderAssets, stagedRuntime } from "../lib/render-assets.mjs";
import { ROOT as TOOLKIT } from "../lib/theme.mjs";

const args = process.argv.slice(2);
const all = args.includes("--all");
const [projectId, only] = args.filter((a) => !a.startsWith("--"));
if (!all && !projectId) {
	console.error("usage: rm-resync <projectId> [folder]   |   rm-resync --all");
	process.exit(1);
}

const LIB = defaultRoot();
const source = join(TOOLKIT, "components", "rm-video.js");
const runtime = await readFile(source, "utf8");

/* The same substitution the server stages with — shared, because two copies of
   it meant a change to how marks resolve reached one stager and not the other. */
const staged = stagedRuntime(runtime);

const projects = all
	? (await readdir(LIB, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name)
	: [projectId];

let touched = 0;
for (const id of projects) {
	const manifest = await readFile(join(LIB, id, "library.json"), "utf8").then(JSON.parse).catch(() => null);
	if (!manifest) continue;
	const renders = join(LIB, id, "media", "Renders");
	const folders = (await readdir(renders, { withFileTypes: true }).catch(() => []))
		.filter((e) => e.isDirectory() && (!only || e.name === only))
		.map((e) => e.name);

	for (const folder of folders) {
		const dir = join(renders, folder);
		// A directory under Renders is only a composition if it has one.
		if (!(await stat(join(dir, "index.html")).catch(() => null))) continue;

		const componentPath = join(dir, "assets", "canvas-components", "rm-video.js");
		const before = await readFile(componentPath, "utf8").catch(() => null);
		const behind = before === null ? "staged for the first time" : before === staged ? "" : `${before.split("\n").length} → ${staged.split("\n").length} lines`;

		await stageRenderAssets(dir, {
			brand: manifest.brand ?? "rolemodel",
			wallpaper: manifest.wallpaper ?? null,
			quiet: true,
		});
		const { writeFile, mkdir, copyFile } = await import("node:fs/promises");
		await mkdir(join(dir, "assets", "canvas-components"), { recursive: true });
		await writeFile(componentPath, staged, "utf8");
		await mkdir(join(dir, "assets", "brand"), { recursive: true });
		await copyFile(join(TOOLKIT, "brand", "logos", "standard-icon.svg"), join(dir, "assets", "brand", "standard-icon.svg"));

		touched += 1;
		console.log(`  ${id}/${folder}${behind ? `  ${behind}` : "  already current"}`);
	}
}
console.log("");
console.log(`  ${touched} composition${touched === 1 ? "" : "s"} back in line with the codebase`);
