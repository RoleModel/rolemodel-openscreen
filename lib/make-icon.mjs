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
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

/*
 * Sources live in brand/icon/source/. Outputs land in brand/icon/.
 *
 * They used to share a directory, and that cost an icon: an Icon Composer export
 * dropped into brand/icon/ landed exactly on `icon.icns` and `png/` — the two things
 * this script writes — so the next run would have overwritten the artwork with a
 * rasterised mark. Separate directories mean a source cannot be clobbered by its
 * own build.
 *
 *   brand/icon/mark.svg           REQUIRED. The mark the interface uses: the
 *                                 Studio's sidebar and favicon, the editor's top
 *                                 bar. A vector, because it is drawn at 22px in one
 *                                 place and 180 in another.
 *   brand/icon/source/macos.icns  OPTIONAL. A finished .icns, used byte for byte.
 *   brand/icon/source/macos.png   OPTIONAL. macOS artwork to rasterise.
 *   brand/icon/source/app.png     OPTIONAL. Artwork for every platform's icon set.
 *   brand/icon/source/*.icon      OPTIONAL. The Icon Composer document itself.
 *
 * An .icns wins over a PNG for macOS, and it is copied rather than rebuilt. Icon
 * Composer emits per-size artwork — small sizes are redrawn, not downsampled — and
 * unpacking that to re-render it from the 1024 would throw away the only part of the
 * export that cannot be reconstructed.
 *
 * The .icon document is where the icon is actually drawn, so it is the source of
 * record and belongs in the repository. It is not, on its own, enough to build
 * from. `actool` compiles it, but the .icns it writes stops at 256px: on macOS 26
 * the real artwork lives in the Assets.car beside it, keyed by CFBundleIconName,
 * and the .icns is only there for older systems. electron-builder does not build
 * asset catalogs, so shipping the Assets.car would mean an afterPack hook and full
 * Xcode on every build machine, CI included, to gain a Dock icon on 26 and nothing
 * anywhere else.
 *
 * What the document is used for instead is completing the export. Icon Composer's
 * File → Export writes eight of the ten slots an .icns can hold — it omits
 * icon_16x16 and icon_32x32, the two non-Retina sizes — while actool renders the
 * 16px one. So the export supplies everything from 32px up, the compile fills the
 * gap at the bottom, and the result is a complete set from one drawing. When Xcode
 * is not installed the export is copied through unchanged, which is what CI does.
 */
const iconDir = join(ROOT, "brand", "icon");
const srcDir = join(iconDir, "source");

const raster = async (...names) => {
	for (const name of names) {
		const bytes = await readFile(join(srcDir, name)).catch(() => null);
		if (bytes) return { kind: "png", bytes, from: `brand/icon/source/${name}` };
	}
	return null;
};

/** The interface's mark. Vector, and not optional — the UI imports the file itself. */
async function markSource() {
	const svg = await readFile(join(iconDir, "mark.svg"), "utf8").catch(() => null);
	if (!svg) throw new Error("brand/icon/mark.svg is missing — it is the one required input");
	return { kind: "svg", svg, from: "brand/icon/mark.svg" };
}

/**
 * What the macOS icon comes from: a finished .icns, artwork to rasterise, or the mark.
 */
async function macIconSource() {
	// `icon.icns` is what Icon Composer's exporter names its output, so it is
	// accepted as-is rather than asking for a rename that only this script cares about.
	for (const name of ["macos.icns", "icon.icns"]) {
		const path = join(srcDir, name);
		if (existsSync(path)) return { kind: "icns", path, from: `brand/icon/source/${name}` };
	}
	return await raster("macos.png", "macos@1024.png");
}

/** The Icon Composer document, if one has been saved into source/. */
async function iconDocument() {
	const names = await readdir(srcDir).catch(() => []);
	const name = names.find((n) => n.endsWith(".icon"));
	return name ? { path: join(srcDir, name), from: `brand/icon/source/${name}` } : null;
}

/**
 * Where actool is.
 *
 * Inside Xcode, not the Command Line Tools — `xcrun --find actool` fails on a
 * machine with only the CLT installed, which is the normal state of a CI runner.
 * Absent means the export is used unchanged, not that the build fails.
 */
function findActool() {
	try {
		const found = execFileSync("xcrun", ["--find", "actool"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (found && existsSync(found)) return found;
	} catch {
		/* no actool on the xcrun path; try the usual place */
	}
	const inXcode = "/Applications/Xcode.app/Contents/Developer/usr/bin/actool";
	return existsSync(inXcode) ? inXcode : null;
}

/**
 * Compile a .icon into an .icns, returning its path or null.
 *
 * The document is copied to `AppIcon.icon` first because actool takes the icon's
 * name from the file's basename and has to be told the same name with --app-icon;
 * copying is cheaper than making the flag agree with whatever the file is called.
 */
async function compileIconDocument(doc, actool, staging) {
	const work = join(staging, "actool");
	const out = join(work, "out");
	await mkdir(out, { recursive: true });
	const named = join(work, "AppIcon.icon");
	await cp(doc.path, named, { recursive: true });
	try {
		execFileSync(
			actool,
			[
				"--compile", out,
				"--app-icon", "AppIcon",
				"--minimum-deployment-target", "26.0",
				"--platform", "macosx",
				"--output-partial-info-plist", join(work, "partial.plist"),
				named,
			],
			{ stdio: "pipe" },
		);
	} catch (err) {
		// actool reports failures as a plist on stdout, which is more use than the
		// exit status on its own.
		console.log(`  actool could not compile ${doc.from}:`);
		console.log(String(err.stdout ?? err.message).trim().split("\n").map((l) => `    ${l}`).join("\n"));
		return null;
	}
	const icns = join(out, "AppIcon.icns");
	return existsSync(icns) ? icns : null;
}

/** Unpack an .icns, indexed by iconutil's slot name and by pixel size. */
async function slots(path, dir) {
	execFileSync("iconutil", ["-c", "iconset", path, "-o", dir], { stdio: "pipe" });
	const byName = new Map();
	const byPx = new Map();
	for (const file of await readdir(dir)) {
		const px = ICONSET.find((i) => i.name === file)?.px;
		byName.set(file, join(dir, file));
		if (px && !byPx.has(px)) byPx.set(px, join(dir, file));
	}
	return { byName, byPx };
}

/**
 * Fill an export's empty slots from a compile of the same drawing.
 *
 * The export always wins where it has the slot — it is the artwork that was
 * approved, and it carries the sizes above 256 that the compile does not have at
 * all. A gap is filled first from another slot of the export at the same pixel
 * size (icon_32x32 and icon_16x16@2x are both 32px, so one file serves both), and
 * only then from the compile. Nothing to fill means the export is already complete
 * and is passed straight through to be copied byte for byte.
 */
async function completeIcns(exported, compiled, staging, target) {
	const from = await slots(exported, join(staging, "exported.iconset"));
	const also = compiled ? await slots(compiled, join(staging, "compiled.iconset")) : null;
	const merged = join(staging, "merged.iconset");
	await mkdir(merged, { recursive: true });
	const filled = [];
	const missing = [];
	for (const { px, name } of ICONSET) {
		const pick = from.byName.get(name) ?? from.byPx.get(px) ?? also?.byName.get(name) ?? also?.byPx.get(px);
		if (!pick) {
			missing.push(`${name} (${px}px)`);
			continue;
		}
		await copyFile(pick, join(merged, name));
		if (!from.byName.has(name)) filled.push({ name, px, own: from.byPx.has(px) });
	}
	if (!filled.length) return { path: exported, filled, missing };
	execFileSync("iconutil", ["-c", "icns", merged, "-o", target], { stdio: "pipe" });
	return { path: target, filled, missing };
}

const { chromium } = await import("playwright").catch(() => {
	throw new Error("playwright is not installed — npm install");
});

const mark = await markSource();
const macSource = (await macIconSource()) ?? (await raster("app.png", "app@1024.png")) ?? mark;
const pngSource = (await raster("app.png", "app@1024.png")) ?? mark;
const doc = await iconDocument();
const actool = doc ? findActool() : null;

console.log("");
console.log(`  mark      ${mark.from}`);
console.log(`  mac icon  ${macSource.from}${macSource === mark ? "  (nothing in brand/icon/source — using the mark)" : ""}`);
console.log(`  png set   ${pngSource.from}${pngSource === mark ? "  (no app.png — using the mark)" : ""}`);
if (doc) {
	const why =
		macSource.kind !== "icns"
			? "  (no .icns beside it — export from Icon Composer to use it)"
			: actool
				? ""
				: "  (no Xcode — the export is used as it is)";
	console.log(`  document  ${doc.from}${why}`);
}
console.log("");
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
/**
 * Render one source at one size.
 *
 * A viewport of exactly `px` with the drawing filling it, rather than a scaled-up
 * small render: a 1024 render is genuinely 1024 samples. Transparent background,
 * because an icon has corners.
 *
 * A raster goes down the same path so both kinds get the same `iconutil` treatment
 * and the same nine names. Worth saying out loud: a 16px icon downsampled from a
 * 1024 PNG is softer than one drawn from a vector. That is the cost of supplying a
 * raster, and it is the right trade when the raster is the finished artwork.
 */
const page4 = (src) =>
	src.kind === "svg"
		? `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${src.svg}`
		: `<style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:100%;height:100%;image-rendering:auto}</style><img alt="" src="data:image/png;base64,${src.bytes.toString("base64")}">`;

async function render(src, px) {
	await page.setViewportSize({ width: px, height: px });
	await page.setContent(page4(src), { waitUntil: "load" });
	return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
}

/** Every distinct size one source needs, rendered once each. */
async function renderAll(src, sizes) {
	const out = new Map();
	for (const px of [...new Set(sizes)].sort((a, b) => a - b)) {
		out.set(px, await render(src, px));
		process.stdout.write(`  ${px}`);
	}
	return out;
}

// The Mac set and the flat PNG set come from different sources when a Mac icon has
// been supplied, so they are rendered separately rather than sharing one cache.
/*
 * One render per (source, size), and the union of sizes when both sets come from
 * the same drawing.
 *
 * The first version of this rendered the Mac sizes and then reused that cache for
 * the flat PNGs, which need 24 and 48 as well — sizes no .iconset name asks for. It
 * fell through to a second render after the browser had already been closed.
 */
const macIsIcns = macSource.kind === "icns";
const shared = !macIsIcns && macSource === pngSource;
const macSizes = ICONSET.map((i) => i.px);

// A finished .icns needs no rendering at all, so the browser only opens for the
// sizes something actually has to draw.
if (macIsIcns) process.stdout.write("  png ");
else process.stdout.write("  mac ");
const macPx = macIsIcns ? null : await renderAll(macSource, shared ? [...macSizes, ...PNGS] : macSizes);
const pngPx = shared ? macPx : await renderAll(pngSource, PNGS);
if (shared) process.stdout.write("   (one source for both sets)");
console.log("");
await browser.close();

if (!macIsIcns) for (const { px, name } of ICONSET) await writeFile(join(iconset, name), macPx.get(px));

const pngDir = join(OUT, "png");
await mkdir(pngDir, { recursive: true });
for (const px of PNGS) await writeFile(join(pngDir, `${px}x${px}.png`), pngPx.get(px));

/*
 * iconutil is the only thing that writes a real .icns — a renamed zip of PNGs is
 * not one, and macOS shows a generic document icon for it. Skipped entirely when a
 * finished .icns was supplied: that file is the artwork, and rebuilding it from its
 * own contents can only lose per-size detail.
 */
const icns = join(OUT, "icon.icns");
if (macIsIcns) {
	const compiled = doc && actool ? await compileIconDocument(doc, actool, staging) : null;
	const built = await completeIcns(macSource.path, compiled, staging, join(staging, "complete.icns"));
	await copyFile(built.path, icns);
	for (const { name, px, own } of built.filled) {
		console.log(`  filled    ${name.padEnd(21)} ${String(px).padStart(4)}px  from ${own ? macSource.from : doc.from}`);
	}
	if (built.missing.length) console.log(`  missing   ${built.missing.join(", ")}`);
} else {
	execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
}
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
		await mkdir(join(fork, "src", "assets"), { recursive: true });
		await writeFile(join(fork, "src", "assets", "rolemodel-mark.svg"), mark.svg);
		console.log(`\n  installed into ${fork}`);
		console.log(`    icons/icons/mac/icon.icns`);
		console.log(`    icons/icons/png/  (${PNGS.length} sizes)`);
		console.log(`    src/assets/rolemodel-mark.svg`);
		console.log("\n  win/icon.ico is left alone — .ico needs a different tool and we ship macOS.");
	}
}
console.log("");
