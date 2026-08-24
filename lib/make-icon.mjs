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
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/**
 * The mark, from the one file that defines it.
 *
 * This used to scrape a percent-encoded data: URI out of `lib/studio.html` with a
 * regex, which is why the drawing could not be edited without hand-encoding it and
 * why three copies of it existed. `brand/icon/mark.svg` is the source now, and the
 * Studio serves that same file at /brand-mark.svg.
 *
 * A raster source wins if one is present. Icon Composer and anything else that
 * exports a finished app icon produce a PNG rather than an SVG, and re-drawing that
 * from a vector would be second-guessing whoever exported it.
 */
async function brandSource() {
	for (const name of ["source.png", "source@1024.png"]) {
		const png = join(ROOT, "brand", "icon", name);
		const bytes = await readFile(png).catch(() => null);
		if (bytes) return { kind: "png", bytes, from: `brand/icon/${name}` };
	}
	const svg = await readFile(join(ROOT, "brand", "icon", "mark.svg"), "utf8").catch(() => null);
	if (!svg) {
		throw new Error("no brand/icon/mark.svg, and no brand/icon/source.png to use instead");
	}
	return { kind: "svg", svg, from: "brand/icon/mark.svg" };
}

const { chromium } = await import("playwright").catch(() => {
	throw new Error("playwright is not installed — npm install");
});

const source = await brandSource();
console.log(`\n  source  ${source.from}\n`);
await mkdir(OUT, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), "rm-icon-"));
const iconset = join(staging, "icon.iconset");
await mkdir(iconset, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

/**
 * Render the mark at one size.
 *
 * A viewport of exactly `px` and the drawing sized to fill it, rather than a
 * scaled-up small render: a 1024 render is genuinely 1024 samples. Transparent
 * background, because an icon has corners.
 *
 * A PNG source goes through the same path so that both kinds get the same
 * `iconutil` treatment and the same nine names. `image-rendering: auto` on the way
 * down from 1024 is the sharper of the options Chromium offers; a 16px icon
 * downsampled from a 1024 PNG is softer than one drawn from a vector, which is the
 * cost of supplying a raster and is worth saying out loud.
 */
const body =
	source.kind === "svg"
		? `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${source.svg}`
		: `<style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:100%;height:100%;image-rendering:auto}</style><img alt="" src="data:image/png;base64,${source.kind === "png" ? source.bytes.toString("base64") : ""}">`;

async function render(px) {
	await page.setViewportSize({ width: px, height: px });
	await page.setContent(body, { waitUntil: "load" });
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

/*
 * Install into the fork, which is what actually ships.
 *
 * The old last line of this script said "packaging/ copies these into the fork's
 * icons/ directory". Nothing did. The icons got there by hand, which is why the
 * three places the mark appears had drifted apart. These are the exact paths
 * electron-builder.json5 names — mac.icon, linux.icon and win.icon — plus the SVG
 * the editor's top bar imports.
 *
 * `--no-install` skips it, for building the set without touching a checkout.
 */
if (!argv.includes("--no-install")) {
	const fork = resolve(argv.indexOf("--openscreen") === -1 ? join(ROOT, "..", "openscreen") : argv[argv.indexOf("--openscreen") + 1]);
	if (!existsSync(fork)) {
		console.log(`\n  no OpenScreen checkout at ${fork} — set --openscreen <path>, or --no-install\n`);
	} else {
		const macDir = join(fork, "icons", "icons", "mac");
		const forkPng = join(fork, "icons", "icons", "png");
		await mkdir(macDir, { recursive: true });
		await mkdir(forkPng, { recursive: true });
		await copyFile(icns, join(macDir, "icon.icns"));
		for (const px of PNGS) await copyFile(join(pngDir, `${px}x${px}.png`), join(forkPng, `${px}x${px}.png`));
		// The editor's top bar and the app's favicon import this one; see
		// EditorTopBar.tsx. Same drawing, so it comes from the same place.
		if (source.kind === "svg") {
			await mkdir(join(fork, "src", "assets"), { recursive: true });
			await writeFile(join(fork, "src", "assets", "rolemodel-mark.svg"), source.svg);
		}
		console.log(`\n  installed into ${fork}`);
		console.log(`    icons/icons/mac/icon.icns`);
		console.log(`    icons/icons/png/  (${PNGS.length} sizes)`);
		if (source.kind === "svg") console.log(`    src/assets/rolemodel-mark.svg`);
		console.log("\n  win/icon.ico is left alone — .ico needs a different tool and we ship macOS.");
	}
}
console.log("");
