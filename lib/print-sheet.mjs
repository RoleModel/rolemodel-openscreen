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
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { SVG_ROOT, XML_HEAD, isolateIds, svgBox, svgToPng } from "./stickers.mjs";

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
 * A TRUE DIE LINE, NOT A BOX
 *
 * A rounded rectangle round each sticker is not a die line, it is a rectangle;
 * a shop cutting to it hands back squares. The real thing follows the artwork's
 * own silhouette, offset outward by the bleed, and there is no way to get that
 * from the paths without unioning and outsetting them — which is a geometry
 * library's whole job and still goes wrong on a thin tail or the dot over an i.
 *
 * So it is found the way a prepress department finds it: draw the sticker,
 * take its alpha, grow that shape by the offset, close the gaps it leaves, fill
 * anything enclosed, and trace the result back to a curve. Pixels are a poor
 * way to store art and an excellent way to answer "what shape is this", because
 * a dilation is exact on a bitmap and miserable on a path.
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

/*
 * Only sizes a shop sells.
 *
 * A4 was here and should not have been: it is a size of paper, not a size of
 * sticker sheet anybody in lib/vendors.mjs prints, and laying artwork on it
 * makes a file every shop comes back on. These ids are the ones `sheetSizes()`
 * derives from the price tables, so the two cannot drift apart.
 */
const PAGES = {
	"4x6": { label: '4" × 6"', wMm: 101.6, hMm: 152.4 },
	letter: { label: '8.5" × 11"', wMm: 215.9, hMm: 279.4 },
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
		/*
		 * A traced sticker is drawn into the whole cell, because that is the
		 * square its silhouette was traced in and the two have to agree to the
		 * pixel. Only an untraced one is fitted to its own shape.
		 */
		const ax = item.die?.d ? cx : cx + (stickerMm - w) / 2;
		const ay = item.die?.d ? cy : cy + (stickerMm - h) / 2;
		const aw = item.die?.d ? stickerMm : w;
		const ah = item.die?.d ? stickerMm : h;
		if (item.svg) {
			const inner = isolateIds(String(item.svg).replace(XML_HEAD, ""), `c${i}-`).match(SVG_ROOT);
			const attrs = (inner?.[1] ?? "").replace(/\s(width|height|x|y|viewBox|preserveAspectRatio)\s*=\s*["'][^"']*["']/gi, "");
			art.push(`<svg x="${ax}mm" y="${ay}mm" width="${aw}mm" height="${ah}mm" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" preserveAspectRatio="xMidYMid meet"${attrs.includes("xmlns=") ? "" : ' xmlns="http://www.w3.org/2000/svg"'}${attrs}>${inner?.[2] ?? ""}</svg>`);
		} else if (item.bytes) {
			art.push(`<image x="${cx}mm" y="${cy}mm" width="${stickerMm}mm" height="${stickerMm}mm" preserveAspectRatio="xMidYMid meet" href="data:${item.type ?? "image/png"};base64,${Buffer.from(item.bytes).toString("base64")}"/>`);
		}
		/*
		 * The die line, if one was found for this sticker: the traced silhouette,
		 * placed over the same square the art was drawn in so the two line up
		 * exactly. A sticker whose trace failed keeps a rectangle — a plain cut
		 * beats no cut, and the legend says which is which.
		 */
		if (item.die?.d) {
			const k = stickerMm / item.die.size;
			cuts.push(`<g transform="translate(${(cx / 25.4) * 96} ${(cy / 25.4) * 96}) scale(${(k / 25.4) * 96})"><g${item.die.transform ? ` transform="${item.die.transform}"` : ""}><path d="${item.die.d}" fill="none" stroke="${CUT_MAGENTA}" stroke-width="${0.25 / ((k / 25.4) * 96)}"/></g></g>`);
		} else {
			const cw = item.svg ? w + bleedMm : stickerMm;
			const ch = item.svg ? h + bleedMm : stickerMm;
			const kx = cx + (stickerMm - cw) / 2;
			const ky = cy + (stickerMm - ch) / 2;
			cuts.push(`<rect x="${kx}mm" y="${ky}mm" width="${cw}mm" height="${ch}mm" rx="${Math.min(radiusMm, cw / 2, ch / 2)}mm" ry="${Math.min(radiusMm, cw / 2, ch / 2)}mm" fill="none" stroke="${CUT_MAGENTA}" stroke-width="0.25"/>`);
		}
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


/*
 * The silhouette of a sticker, grown by `offset` and traced back to a curve.
 *
 * Answers `{ d, size }` — one path in a square of `size` user units — or null
 * when the art is empty or the tools are missing. Never throws for a single
 * sticker: a sheet with one plain cut line on it beats no sheet at all.
 */
export async function dieLine(svg, { size = 1024, offsetPx = 14, smooth = 10 } = {}) {
	if ((await capture("potrace", ["--version"])).ok === false) return null;
	const dir = await mkdtemp(join(tmpdir(), "die-"));
	try {
		const png = join(dir, "a.png");
		await writeFile(png, await svgToPng(svg, { size }));
		const mask = join(dir, "m.png");
		const holes = join(dir, "h.png");
		const solid = join(dir, "s.png");
		const pgm = join(dir, "s.pgm");
		const out = join(dir, "d.svg");
		/* Grow, then close: dilation alone leaves the notches between two nearly
		   touching parts, and a cutter following those tears the sticker. */
		const grown = await capture("magick", [png, "-alpha", "extract", "-threshold", "30%", "-morphology", "Dilate", `Disk:${Math.round(offsetPx)}`, "-morphology", "Close", `Disk:${Math.round(smooth)}`, mask]);
		if (!grown.ok) return null;
		/* Anything white the background cannot reach is a hole, and a hole is not
		   somewhere to cut. Found by flooding the outside and keeping what is
		   left, then painted back in. */
		await capture("magick", [mask, "-negate", "-bordercolor", "white", "-border", "1", "-fill", "black", "-floodfill", "+0+0", "white", "-shave", "1x1", holes]);
		await capture("magick", [mask, holes, "-compose", "Lighten", "-composite", solid]);
		await capture("magick", [solid, "-negate", "-depth", "8", pgm]);
		/* `-t 40` drops specks: a stray anti-aliased pixel becomes its own tiny
		   contour, and a cutter asked to cut a 2mm circle out of nothing jams. */
		const traced = await capture("potrace", [pgm, "-s", "-a", "1.2", "-O", "0.5", "-t", "40", "-o", out]);
		if (!traced.ok) return null;
		const text = await readFile(out, "utf8");
		const ds = [...text.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
		if (!ds.length) return null;
		/* potrace writes its own flip; carried through rather than unpicked. */
		const g = text.match(/<g([^>]*)>/)?.[1] ?? "";
		return { d: ds.join(" "), transform: (g.match(/transform="([^"]*)"/) ?? [])[1] ?? "", size };
	} catch {
		return null;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}


/**
 * Trace a die line for each sticker, a few at a time.
 *
 * Chromium is started per sticker and that is most of the five seconds each
 * one takes, so they are run in a small pool: enough to keep the machine busy,
 * not so many that thirty browsers open at once.
 */
export async function withDieLines(items, { offsetPx = 14, size = 1024, lanes = 4 } = {}) {
	const out = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			const item = items[i];
			out[i] = item.svg ? { ...item, die: await dieLine(item.svg, { offsetPx, size }) } : item;
		}
	};
	await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, worker));
	return out;
}
