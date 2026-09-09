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

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

/*
 * The other thing a shop prints: a sheet, with the cut lines drawn on it.
 *
 * WHY A CUT LINE IS DRAWN AND NOT DERIVED
 *
 * A true die line follows the artwork's silhouette, offset outward. Deriving
 * that from arbitrary paths means an outset of a union of everything on the
 * sticker, which is a geometry library's job and gets it wrong on exactly the
 * shapes that matter — a thin tail, a dot over an "i". So the line here is an
 * honest rounded rectangle around each sticker, which is what a kiss-cut sheet
 * uses anyway and which no shop has to guess at.
 *
 * WHY MAGENTA
 *
 * There is no way to put a real spot colour in a PDF through this pipeline, so
 * the convention every sticker shop already reads is used instead: cut lines in
 * 100% magenta, hairline, and a legend on the sheet saying so in words. A shop
 * that wants a named CutContour separation can make one from a magenta layer in
 * seconds; a shop given an unlabelled black outline cannot do anything at all.
 */
export const CUT_MAGENTA = "#ec008c";

const PAGES = {
	"4x6": { label: '4" × 6"', wMm: 101.6, hMm: 152.4 },
	"letter": { label: '8.5" × 11"', wMm: 215.9, hMm: 279.4 },
	a4: { label: "A4", wMm: 210, hMm: 297 },
};

export const SHEET_PAGES = Object.entries(PAGES).map(([id, p]) => ({ id, ...p }));

/**
 * A printable sheet: stickers in a grid, a cut line around each, crop marks at
 * the corners, and the brand along the foot.
 *
 * Answers the SVG. `logo` is the mark's own SVG markup, or null for no brand.
 */
export function cutSheetSvg({ items, page = "letter", stickerMm = 50.8, gapMm = 4, marginMm = 10, bleedMm = 3, radiusMm = 3, logo = null, title = "Stickers" }) {
	const p = PAGES[page] ?? PAGES.letter;
	const W = p.wMm;
	const H = p.hMm;
	/* The foot carries the legend and the brand, so the grid stops above it. */
	const footMm = logo ? 14 : 9;
	const usableW = W - marginMm * 2;
	const usableH = H - marginMm * 2 - footMm;
	const cols = Math.max(1, Math.floor((usableW + gapMm) / (stickerMm + gapMm)));
	const rows = Math.max(1, Math.floor((usableH + gapMm) / (stickerMm + gapMm)));
	const perPage = cols * rows;
	const used = items.slice(0, perPage);
	/* Centred in what is left, so a grid that does not fill the page is not
	   shoved into a corner. */
	const gridW = cols * stickerMm + (cols - 1) * gapMm;
	const gridH = Math.ceil(used.length / cols) * stickerMm + (Math.ceil(used.length / cols) - 1) * gapMm;
	const x0 = (W - gridW) / 2;
	const y0 = marginMm + (usableH - gridH) / 2;

	const art = [];
	const cuts = [];
	used.forEach((item, i) => {
		const cx = x0 + (i % cols) * (stickerMm + gapMm);
		const cy = y0 + Math.floor(i / cols) * (stickerMm + gapMm);
		/* The cut line sits on the sticker's edge; the art is inset by the bleed
		   so colour runs past the cut rather than stopping short of it. */
		/*
		 * Sized by the sticker's own shape, then centred — not stretched to a
		 * square viewport and left to `preserveAspectRatio` to sort out. Some of
		 * this artwork draws outside its own viewBox, and a nested <svg> that
		 * ought to clip does not always, so a wide sticker escaped its cell and
		 * ran over its neighbour's cut line.
		 */
		const box = item.svg ? svgBox(item.svg) : { x: 0, y: 0, w: 1, h: 1 };
		const long = Math.max(box.w, box.h) || 1;
		const w = (box.w / long) * stickerMm;
		const h = (box.h / long) * stickerMm;
		const ax = cx + (stickerMm - w) / 2;
		const ay = cy + (stickerMm - h) / 2;
		if (item.svg) {
			const inner = isolateIds(String(item.svg).replace(XML_HEAD, ""), `c${i}-`).match(SVG_ROOT);
			const attrs = (inner?.[1] ?? "").replace(/\s(width|height|x|y|viewBox|preserveAspectRatio)\s*=\s*["'][^"']*["']/gi, "");
			art.push(`<svg x="${ax}mm" y="${ay}mm" width="${w}mm" height="${h}mm" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" preserveAspectRatio="xMidYMid meet"${attrs.includes("xmlns=") ? "" : ' xmlns="http://www.w3.org/2000/svg"'}${attrs}>${inner?.[2] ?? ""}</svg>`);
		} else if (item.bytes) {
			art.push(`<image x="${cx}mm" y="${cy}mm" width="${stickerMm}mm" height="${stickerMm}mm" preserveAspectRatio="xMidYMid meet" href="data:${item.type ?? "image/png"};base64,${Buffer.from(item.bytes).toString("base64")}"/>`);
		}
		/* The cut hugs the drawing with the bleed outside it, so what is trimmed
		   away is ink rather than white paper. */
		const cw = item.svg ? w + bleedMm : stickerMm;
		const ch = item.svg ? h + bleedMm : stickerMm;
		const kx = cx + (stickerMm - cw) / 2;
		const ky = cy + (stickerMm - ch) / 2;
		cuts.push(`<rect x="${kx}mm" y="${ky}mm" width="${cw}mm" height="${ch}mm" rx="${Math.min(radiusMm, cw / 2, ch / 2)}mm" ry="${Math.min(radiusMm, cw / 2, ch / 2)}mm" fill="none" stroke="${CUT_MAGENTA}" stroke-width="0.25"/>`);
	});

	/* Crop marks: outside the trim, so trimming removes them. */
	const m = marginMm / 2;
	const marks = [
		[m, marginMm, marginMm, marginMm],
		[marginMm, m, marginMm, marginMm],
		[W - m, marginMm, W - marginMm, marginMm],
		[W - marginMm, m, W - marginMm, marginMm],
		[m, H - marginMm, marginMm, H - marginMm],
		[marginMm, H - m, marginMm, H - marginMm],
		[W - m, H - marginMm, W - marginMm, H - marginMm],
		[W - marginMm, H - m, W - marginMm, H - marginMm],
	]
		.map(([x1, y1, x2, y2]) => `<line x1="${x1}mm" y1="${y1}mm" x2="${x2}mm" y2="${y2}mm" stroke="#000" stroke-width="0.25"/>`)
		.join("");

	const brand = logo
		? `<g transform="translate(${(marginMm / 25.4) * 96}, ${((H - footMm + 2) / 25.4) * 96})"><svg width="${(34 / 25.4) * 96}" height="${(6 / 25.4) * 96}" viewBox="0 0 204 36" preserveAspectRatio="xMinYMid meet">${String(logo).replace(XML_HEAD, "").match(SVG_ROOT)?.[2] ?? ""}</svg></g>`
		: "";
	const legend = `<text x="${W - marginMm}mm" y="${H - footMm + 6}mm" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="6.5">${esc(title)} · ${used.length} on a ${p.label} sheet · cut lines are 100% magenta, do not print</text>`;

	return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}mm" height="${H}mm">\n<rect width="${W}mm" height="${H}mm" fill="#fff"/>\n${marks}\n<g id="art">${art.join("\n")}</g>\n<g id="CutContour">${cuts.join("\n")}</g>\n${brand}${legend}\n</svg>\n`;
}

/** How many fit on one page, from the geometry rather than by counting output. */
export function perPage({ page = "letter", stickerMm = 50.8, gapMm = 4, marginMm = 10, logo = null }) {
	const p = PAGES[page] ?? PAGES.letter;
	const footMm = logo ? 14 : 9;
	const cols = Math.max(1, Math.floor((p.wMm - marginMm * 2 + gapMm) / (stickerMm + gapMm)));
	const rows = Math.max(1, Math.floor((p.hMm - marginMm * 2 - footMm + gapMm) / (stickerMm + gapMm)));
	return { cols, rows, fits: cols * rows };
}

/** Every page a set of stickers needs, as SVGs. */
export function cutSheetPages(opts) {
	const { fits } = perPage(opts);
	const pages = [];
	for (let i = 0; i < opts.items.length; i += fits) pages.push(cutSheetSvg({ ...opts, items: opts.items.slice(i, i + fits) }));
	return pages.length ? pages : [cutSheetSvg({ ...opts, items: [] })];
}

/**
 * The branded, cut-lined sheet as one CMYK PDF — as many pages as it takes.
 *
 * The same two-tool road as the singles: rsvg keeps the paths, Ghostscript
 * changes the colour and joins the pages.
 */
export async function cutSheetToCmykPdf({ items, out, work, profile = "", ...layout }) {
	const stop = await printProblem();
	if (stop) throw new Error(stop);
	if (!items.length) throw new Error("there are no stickers on that sheet");
	await rm(work, { recursive: true, force: true });
	await mkdir(work, { recursive: true });
	const svgs = cutSheetPages({ ...layout, items });
	const pdfs = [];
	for (const [i, svg] of svgs.entries()) {
		const src = join(work, `s${String(i).padStart(3, "0")}.svg`);
		const pdf = join(work, `s${String(i).padStart(3, "0")}.pdf`);
		await writeFile(src, svg, "utf8");
		const made = await capture("rsvg-convert", ["-f", "pdf", "-o", pdf, src]);
		if (!made.ok) throw new Error(`sheet ${i + 1} would not draw: ${made.err.trim().slice(0, 160)}`);
		pdfs.push(pdf);
	}
	const icc = await findProfile(profile);
	const joined = await capture("gs", [
		...(icc ? [`--permit-file-read=${dirname(icc)}/`] : []),
		"-dNOPAUSE",
		"-dBATCH",
		"-dSAFER",
		"-sDEVICE=pdfwrite",
		"-dProcessColorModel=/DeviceCMYK",
		"-sColorConversionStrategy=CMYK",
		...(icc ? [`-sOutputICCProfile=${icc}`] : []),
		`-sOutputFile=${out}`,
		...pdfs,
	]);
	if (!joined.ok || !(await has(out))) throw new Error(`Ghostscript would not write the PDF: ${joined.err.trim().slice(0, 200)}`);
	await rm(work, { recursive: true, force: true });
	const { cols, rows, fits } = perPage(layout);
	return { file: out, pages: pdfs.length, perSheet: fits, grid: `${cols} × ${rows}`, profile: icc, profileName: icc ? basename(icc, extname(icc)) : "Ghostscript's own CMYK" };
}
