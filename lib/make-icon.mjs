/*
 * Build the app icon from the brand mark.
 *
 *   node lib/make-icon.mjs [--out <dir>]
 *
 * The app shipped OpenScreen's icon, which is the right icon for OpenScreen and
 * the wrong one for a RoleModel build sitting in a RoleModel dock next to the
 * real thing. Two apps with the same icon and nearly the same name is a mistake
 * waiting to be made, not a branding nicety.
 *
 * The mark is not a new asset. It is the same SVG the Studio uses for its own
 * brand in the sidebar — a #00B871 rounded square with a white play triangle —
 * read out of `lib/studio.html` so the two cannot drift. If the Studio's mark
 * changes, this regenerates from it.
 *
 * Rendered rather than hand-exported, because macOS wants nine sizes and a
 * hand-exported set is nine chances to ship one that is subtly off. Chromium
 * rasterises the SVG; `iconutil` assembles the .icns, which is the only tool
 * that makes a real one.
 *
 * The 16px and 32px renders come out of the same vector as the 1024, which is
 * the usual reason a small icon looks like mud: the play triangle is 40% of the
 * canvas here, so it survives the reduction. A mark with fine detail would need
 * a simplified variant at those sizes, and this one deliberately does not have
 * any.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** The sizes `iconutil` expects, and the names it insists on. */
const ICONSET = [
	{ px: 16, name: "icon_16x16.png" },
	{ px: 32, name: "icon_16x16@2x.png" },
	{ px: 32, name: "icon_32x32.png" },
	{ px: 64, name: "icon_32x32@2x.png" },
	{ px: 128, name: "icon_128x128.png" },
	{ px: 256, name: "icon_128x128@2x.png" },
	{ px: 256, name: "icon_256x256.png" },
	{ px: 512, name: "icon_256x256@2x.png" },
	{ px: 512, name: "icon_512x512.png" },
	{ px: 1024, name: "icon_512x512@2x.png" },
];

/** The flat PNGs electron-builder wants for Windows and Linux. */
const PNGS = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

const argv = process.argv.slice(2);
const outArg = argv.indexOf("--out");
const OUT = resolve(outArg === -1 ? join(ROOT, "brand", "icon") : argv[outArg + 1]);

/** The mark, from the one place it is defined. */
async function brandMark() {
	const html = await readFile(join(ROOT, "lib", "studio.html"), "utf8");
	const found = /src="data:image\/svg\+xml,([^"]+)"/.exec(html);
	if (!found) throw new Error("no brand mark in lib/studio.html — has the sidebar changed?");
	return decodeURIComponent(found[1]);
}

const { chromium } = await import("playwright").catch(() => {
	throw new Error("playwright is not installed — npm install");
});

const svg = await brandMark();
await mkdir(OUT, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), "rm-icon-"));
const iconset = join(staging, "icon.iconset");
await mkdir(iconset, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

/**
 * Render the mark at one size.
 *
 * `deviceScaleFactor` rather than a scaled viewport: the SVG is rasterised at
 * the device pixel ratio, so a 1024 render is genuinely 1024 samples rather than
 * a 180px render blown up. Transparent background, because an icon has corners.
 */
async function render(px) {
	await page.setViewportSize({ width: px, height: px });
	await page.setContent(
		`<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${px}px;height:${px}px}</style>${svg}`,
		{ waitUntil: "load" },
	);
	return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
}

// Rendered once per distinct size, then written to every name that wants it —
// `icon_16x16@2x` and `icon_32x32` are the same 32 pixels.
const byPx = new Map();
for (const px of new Set([...ICONSET.map((i) => i.px), ...PNGS])) {
	byPx.set(px, await render(px));
	process.stdout.write(`  ${px}px`);
}
console.log("");
await browser.close();

for (const { px, name } of ICONSET) await writeFile(join(iconset, name), byPx.get(px));

const pngDir = join(OUT, "png");
await mkdir(pngDir, { recursive: true });
for (const px of PNGS) await writeFile(join(pngDir, `${px}x${px}.png`), byPx.get(px));

// iconutil is the only thing that writes a real .icns. A renamed zip of PNGs is
// not one, and macOS shows a generic document icon for it.
const icns = join(OUT, "icon.icns");
execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
await rm(staging, { recursive: true, force: true });

console.log("");
console.log(`  ${icns}`);
console.log(`  ${pngDir}/  (${PNGS.length} sizes)`);
console.log("");
console.log("  Point the app at it:  packaging/ copies these into the fork's icons/ directory");
console.log("");
