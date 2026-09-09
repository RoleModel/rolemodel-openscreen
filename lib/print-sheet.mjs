/*
 * A sheet, as a print shop wants it: one sticker per page, CMYK, still vector.
 *
 * WHY ONE PER PAGE AND NOT THE GRID
 *
 * The sheet SVG is for looking at. A die-cutter wants each sticker alone on
 * its own page with its own cut line, and a grid means the shop has to take it
 * apart again — which is where a sticker gets scaled by a hair and stops
 * matching the others.
 *
 * WHY TWO TOOLS
 *
 * rsvg-convert turns an SVG into a PDF whose paths are still paths, which is
 * the whole reason to send a vector at all — but everything it writes is RGB.
 * Ghostscript is the only thing here that changes a PDF's colour without
 * flattening it to pixels, and it merges the pages in the same pass. So: one
 * PDF per sticker, then one Ghostscript run that both joins and converts.
 *
 * WHY THE PROFILE MATTERS
 *
 * "CMYK" on its own is not a colour space; the numbers only mean ink once a
 * profile says which press. US Web Coated (SWOP) is what American sheet-fed
 * shops assume, so it is looked for first — including inside Affinity, which
 * ships it and which this Studio already opens stickers in.
 */
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { SVG_ROOT, XML_HEAD, isolateIds, svgBox } from "./stickers.mjs";

const has = (p) => access(p).then(() => true).catch(() => false);

/** Run something and hand back what it said. stdin is closed. */
function capture(cmd, args) {
	return new Promise((done) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => done({ ok: false, out, err: e.message }));
		child.on("close", (code) => done({ ok: code === 0, out, err }));
	});
}

/* Where a US Web Coated profile is found on a Mac, in the order worth trying. */
export const SWOP_PATHS = [
	"/Applications/Affinity.app/Contents/Resources/USWebCoatedSWOP.icc",
	"/Library/Application Support/Adobe/Color/Profiles/Recommended/USWebCoatedSWOP.icc",
	"/Library/Application Support/Adobe/Color/Profiles/USWebCoatedSWOP.icc",
	"/Library/ColorSync/Profiles/USWebCoatedSWOP.icc",
];

/** The CMYK profile to print through, or null to let Ghostscript pick. */
export async function findProfile(preferred = "") {
	if (preferred && (await has(preferred))) return preferred;
	for (const p of SWOP_PATHS) if (await has(p)) return p;
	return null;
}

/** What is missing before any of this can run. */
export async function printProblem() {
	const missing = [];
	if (!(await capture("rsvg-convert", ["--version"])).ok) missing.push("rsvg-convert (brew install librsvg)");
	if (!(await capture("gs", ["--version"])).ok) missing.push("ghostscript (brew install ghostscript)");
	return missing.length ? `Print needs ${missing.join(" and ")}.` : null;
}

/**
 * One sticker, alone on its own page.
 *
 * The page is the sticker's own shape scaled to fit `size`, plus `bleed` on
 * every side — not a square, because a square page around a wide sticker tells
 * the cutter nothing and wastes stock. Physical units on the wrapper, so the
 * PDF comes out at the size asked rather than at whatever the artwork's
 * internal grid happened to be.
 */
export function pageSvg({ svg = null, bytes = null, type = "image/png", sizeMm = 76.2, bleedMm = 3 }) {
	const box = svg ? svgBox(svg) : { x: 0, y: 0, w: 1000, h: 1000 };
	const long = Math.max(box.w, box.h) || 1;
	const wMm = (box.w / long) * sizeMm;
	const hMm = (box.h / long) * sizeMm;
	const pw = wMm + bleedMm * 2;
	const ph = hMm + bleedMm * 2;
	/* The root tag is matched, not trimmed by hand: a hand-rolled `^<svg[^>]*>`
	   stops at the first ">" inside an attribute and leaves a torn document that
	   rsvg refuses with "premature end of data". */
	const inner = svg ? isolateIds(String(svg).replace(XML_HEAD, ""), "k-").match(SVG_ROOT) : null;
	const attrs = (inner?.[1] ?? "").replace(/\s(width|height|x|y|viewBox|preserveAspectRatio)\s*=\s*["'][^"']*["']/gi, "");
	const art = svg
		? `<svg x="${bleedMm}mm" y="${bleedMm}mm" width="${wMm}mm" height="${hMm}mm" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" preserveAspectRatio="xMidYMid meet"${attrs.includes("xmlns=") ? "" : ' xmlns="http://www.w3.org/2000/svg"'}${attrs}>${inner?.[2] ?? ""}</svg>`
		: `<image x="${bleedMm}mm" y="${bleedMm}mm" width="${wMm}mm" height="${hMm}mm" preserveAspectRatio="xMidYMid meet" href="data:${type};base64,${Buffer.from(bytes).toString("base64")}"/>`;
	/*
	 * No viewBox on the page.
	 *
	 * With one, the millimetres inside resolve against CSS's 96-per-inch rather
	 * than against the box — so a page laid out in points came out a third too
	 * big and every sticker was cut off at the edge. Without it, a millimetre is
	 * a millimetre and the page is the size it says.
	 */
	return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${pw}mm" height="${ph}mm">${art}</svg>\n`;
}

/**
 * Every sticker on a sheet, as one CMYK PDF with a page each.
 *
 * `items` are `{ name, svg }` or `{ name, bytes, type }` — the same shapes the
 * sheet builder already reads. Answers the file written and what went into it.
 */
export async function sheetToCmykPdf({ items, out, work, sizeMm = 76.2, bleedMm = 3, profile = "", fetchImpl = fetch }) {
	const stop = await printProblem();
	if (stop) throw new Error(stop);
	if (!items.length) throw new Error("there are no stickers on that sheet");
	await rm(work, { recursive: true, force: true });
	await mkdir(work, { recursive: true });
	const pages = [];
	for (const [i, item] of items.entries()) {
		const svg = pageSvg({ ...item, sizeMm, bleedMm });
		const src = join(work, `p${String(i).padStart(3, "0")}.svg`);
		const pdf = join(work, `p${String(i).padStart(3, "0")}.pdf`);
		await writeFile(src, svg, "utf8");
		const made = await capture("rsvg-convert", ["-f", "pdf", "-o", pdf, src]);
		if (!made.ok) throw new Error(`${item.name ?? `sticker ${i + 1}`} would not draw: ${made.err.trim().slice(0, 160)}`);
		pages.push(pdf);
	}
	const icc = await findProfile(profile);
	const args = [
		/*
		 * SAFER, on by default since Ghostscript 9.5, confines reads to the
		 * input's own directory — so a profile that lives in an application
		 * bundle is refused with nothing but "Permission denied" and an
		 * unrecoverable error. The directory is granted rather than SAFER
		 * dropped: this runs on files a page named.
		 */
		...(icc ? [`--permit-file-read=${dirname(icc)}/`] : []),
		"-dNOPAUSE",
		"-dBATCH",
		"-dSAFER",
		"-sDEVICE=pdfwrite",
		"-dProcessColorModel=/DeviceCMYK",
		"-sColorConversionStrategy=CMYK",
		...(icc ? [`-sOutputICCProfile=${icc}`] : []),
		`-sOutputFile=${out}`,
		...pages,
	];
	const joined = await capture("gs", args);
	if (!joined.ok || !(await has(out))) throw new Error(`Ghostscript would not write the PDF: ${joined.err.trim().slice(0, 200)}`);
	await rm(work, { recursive: true, force: true });
	return { file: out, pages: pages.length, profile: icc, profileName: icc ? basename(icc, extname(icc)) : "Ghostscript's own CMYK", sizeMm, bleedMm };
}
