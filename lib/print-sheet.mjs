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
 * How heavy a cut line is, in user units.
 *
 * A page here carries no viewBox, so a user unit is a CSS pixel at 96 to the
 * inch — not a point. `stroke-width="0.25"` was therefore 0.19pt, thinner than
 * the 0.25pt hairline it was meant to be and, on the navy ground, thin enough
 * to read as a faint glow rather than a line anybody would cut to. Three quarters of a
 * point is still a hairline to a press and is actually visible on the navy.
 */
/*
 * Bumped whenever the geometry of a trace changes.
 *
 * A cached die is keyed by the file, its date, and the two numbers that shape
 * it — none of which move when this file does. So every fix to the placement
 * kept being judged against traces made by the code before it, and the same
 * misalignment came back from a cache after it had been fixed. The version is
 * part of the key now.
 */
export const DIE_VERSION = 4;

export const CUT_PT = 0.75;

/* The furthest a distance transform can express, in pixels — see dieLine. */
const DISTANCE_MAX_PX = 250;
const CUT_UNITS = (CUT_PT / 72) * 96;

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

/*
 * The RoleModel sticker sheet, rebuilt as shapes.
 *
 * assets/sticker-sheet-template.pdf is the design: a sheet on the deep
 * navy, the name and "Sticker Sheet" along the foot, the R mark opposite, and
 * a lavender strip running off the bottom edge. It is followed here rather than
 * placed, because placing it means rasterising somebody else's PDF and printing
 * the wordmark as pixels — and because a placed 6 × 8 cannot become a 4 × 6.
 * Drawn, it is the same sheet at any size the shops sell.
 *
 * Measured off the template at 300dpi rather than guessed.
 */
export const SHEET_SKIN = {
	ground: "#0a242a",
	name: "#ffffff",
	kind: "#89d4e8",
	mark: "#4a7abe",
	strip: "#aa97c8",
	/* As fractions of the trim height, so a 4 × 6 keeps the proportions. */
	footFrac: 13 / 203.2,
	stripFrac: 2.2 / 203.2,
};

export const SHEET_PAGES = Object.entries(PAGES).map(([id, p]) => ({ id, ...p }));

/**
 * A printable sheet: stickers in a grid, a cut line around each, crop marks at
 * the corners, and the brand along the foot.
 *
 * Answers the SVG. `logo` is the mark's own SVG markup, or null for no brand.
 */
/*
 * `bleedMm` is the sheet's own trim bleed — how far the navy and the lavender
 * run past the edge of the paper. `stickerBleedMm` is a different thing
 * entirely: how far each sticker's ink runs past its own cut. One number was
 * doing both jobs, so setting a sticker's bleed moved the page size, and
 * setting the page's moved every cut.
 */
export function cutSheetSvg({ items, page = "letter", stickerMm = 50.8, gapMm = 4, marginMm = 10, bleedMm = 3.175, stickerBleedMm = 1, radiusMm = 3, logo = null, title = "Stickers", skin = true }) {
	const p = PAGES[page] ?? PAGES.letter;
	const W = p.wMm;
	const H = p.hMm;
	/* The foot carries the legend and the brand, so the grid stops above it. */
	const footMm = skin ? H * SHEET_SKIN.footFrac + 4 : logo ? 14 : 9;
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
		/* The square the artwork was drawn in, when a trace measured one: the
		   declared viewBox is not where the ink is, and using it here put the
		   drawing and its cut line in different places. */
		const box = item.die?.art ?? (item.svg ? svgBox(item.svg) : { x: 0, y: 0, w: 1, h: 1 });
		const long = Math.max(box.w, box.h) || 1;
		const w = (box.w / long) * stickerMm;
		const h = (box.h / long) * stickerMm;
		/*
		 * A traced sticker is drawn into the whole cell, because that is the
		 * square its silhouette was traced in and the two have to agree to the
		 * pixel. Only an untraced one is fitted to its own shape.
		 */
		/*
		 * The artwork is drawn larger than the cut, by the bleed.
		 *
		 * A cut sitting exactly on the edge of the ink has nothing to be wrong
		 * by: a die drifts, and where it drifts outward it lands on bare stock
		 * and the sticker comes back with a white hairline down one side. So
		 * the drawing is grown past the cut on every side and the cut stays
		 * where it was — which is what bleed is, and why every shop asks for it.
		 *
		 * Grown rather than skirted, because the outer edge of these stickers is
		 * a solid keyline: enlarging the whole sticker puts more keyline outside
		 * the cut, which is exactly the colour that should be there. Everything
		 * else the enlargement moves is outside the cut and gets thrown away.
		 */
		/*
		 * The art and the cut share one frame.
		 *
		 * They had two: the drawing was placed in the square the ink was
		 * measured in, the cut in the slightly larger square it was traced in,
		 * and each was centred on the cell separately. Both are centred, so it
		 * ought to have worked — but the ink is not centred inside its own
		 * square by exactly the amount the trim rounded, and that error lands
		 * on one and not the other. Different per sticker, up to a couple of
		 * millimetres, and no arithmetic here could see it.
		 *
		 * So the drawing is placed in the cut's frame and made bigger with a
		 * transform about the cell's centre. One frame cannot drift from
		 * itself, and the bleed becomes a scale rather than a second placement.
		 */
		const aw = item.die?.d ? stickerMm : w;
		const ah = item.die?.d ? stickerMm : h;
		const ax = item.die?.d ? cx : cx + (stickerMm - w) / 2;
		const ay = item.die?.d ? cy : cy + (stickerMm - h) / 2;
		const bleedScale = item.die?.d && stickerMm > 0 ? 1 + (stickerBleedMm * 2) / stickerMm : 1;
		const midX = ((cx + stickerMm / 2) / 25.4) * 96;
		const midY = ((cy + stickerMm / 2) / 25.4) * 96;
		const bleedWrap = bleedScale === 1 ? null : `translate(${midX} ${midY}) scale(${bleedScale}) translate(${-midX} ${-midY})`;

		if (item.svg) {
			const inner = isolateIds(String(item.svg).replace(XML_HEAD, ""), `c${i}-`).match(SVG_ROOT);
			const attrs = (inner?.[1] ?? "").replace(/\s(width|height|x|y|viewBox|preserveAspectRatio)\s*=\s*["'][^"']*["']/gi, "");
			/* The cut's own square when there is a trace, so the two cannot drift. */
			const frame = item.die?.d ? item.die.square : box;
			const one = `<svg x="${ax}mm" y="${ay}mm" width="${aw}mm" height="${ah}mm" viewBox="${frame.x} ${frame.y} ${frame.w} ${frame.h}" preserveAspectRatio="xMidYMid meet"${attrs.includes("xmlns=") ? "" : ' xmlns="http://www.w3.org/2000/svg"'}${attrs}>${inner?.[2] ?? ""}</svg>`;
			art.push(bleedWrap ? `<g transform="${bleedWrap}">${one}</g>` : one);
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
			/*
			 * The cut was traced in a square larger than the artwork's — it had
			 * to be, so the line had room to grow outward — and it is laid down
			 * concentric with the cell at that same ratio. Scaling it as though
			 * the two squares matched put the line inside the drawing.
			 */
			/* The same cell the drawing was placed in — one frame, no spread. */
			const ox = cx;
			const oy = cy;
			const k = stickerMm / item.die.size;
			cuts.push(`<g transform="translate(${(ox / 25.4) * 96} ${(oy / 25.4) * 96}) scale(${(k / 25.4) * 96})"><g${item.die.transform ? ` transform="${item.die.transform}"` : ""}><path d="${item.die.d}" fill="none" stroke="${CUT_MAGENTA}" stroke-width="${CUT_UNITS / ((k / 25.4) * 96)}"/></g></g>`);
		} else {
			const cw = item.svg ? w + bleedMm : stickerMm;
			const ch = item.svg ? h + bleedMm : stickerMm;
			const kx = cx + (stickerMm - cw) / 2;
			const ky = cy + (stickerMm - ch) / 2;
			cuts.push(`<rect x="${kx}mm" y="${ky}mm" width="${cw}mm" height="${ch}mm" rx="${Math.min(radiusMm, cw / 2, ch / 2)}mm" ry="${Math.min(radiusMm, cw / 2, ch / 2)}mm" fill="none" stroke="${CUT_MAGENTA}" stroke-width="${CUT_UNITS}"/>`);
		}
	});

	/*
	 * Crop marks, in the bleed and only in the bleed.
	 *
	 * They were drawn a margin's width inside the trim, which puts them on the
	 * sheet somebody keeps — a printed crop mark across the footer. A crop mark
	 * belongs entirely outside the trim, pointing at the corner, so trimming
	 * takes it away.
	 */
	const markLen = Math.max(2, bleedMm * 0.8);
	const gap = Math.max(0.8, bleedMm * 0.25);
	const marks = [
		[-gap, 0, -gap - markLen, 0],
		[0, -gap, 0, -gap - markLen],
		[W + gap, 0, W + gap + markLen, 0],
		[W, -gap, W, -gap - markLen],
		[-gap, H, -gap - markLen, H],
		[0, H + gap, 0, H + gap + markLen],
		[W + gap, H, W + gap + markLen, H],
		[W, H + gap, W, H + gap + markLen],
	]
		.map(([x1, y1, x2, y2]) => `<line x1="${x1}mm" y1="${y1}mm" x2="${x2}mm" y2="${y2}mm" stroke="#000" stroke-width="${CUT_UNITS}"/>`)
		.join("");

	/*
	 * The brand, drawn on the sheet the way the template has it: the ground
	 * behind everything, the name and what it is on the left, the mark on the
	 * right, and the lavender strip running off the bottom edge so the trim
	 * never leaves a white line.
	 *
	 * No rule above the foot. There was one, a white hairline the width of the
	 * sheet, and on the navy it read as a scratch rather than as a divider —
	 * the gap under the stickers already separates the two.
	 */
	const sk = SHEET_SKIN;
	const stripMm = H * sk.stripFrac;
	const footTop = H - footMm;
	const nameSize = Math.max(3.4, footMm * 0.34);
	const skinBack = skin
		? `<rect x="${-bleedMm}mm" y="${-bleedMm}mm" width="${W + bleedMm * 2}mm" height="${H + bleedMm * 2}mm" fill="${sk.ground}"/>` +
			`<rect x="${-bleedMm}mm" y="${H - stripMm}mm" width="${W + bleedMm * 2}mm" height="${stripMm + bleedMm}mm" fill="${sk.strip}"/>`
		: `<rect width="${W}mm" height="${H}mm" fill="#fff"/>`;
	/*
	 * The foot is set from the strip upward, not from its own top downward.
	 *
	 * Measured down from the rule, the second line's descenders finished about
	 * a millimetre above the lavender and the whole block looked pushed into
	 * it. Anchoring to the strip keeps a real gap under the words at every
	 * sheet size, which is what the template has.
	 */
	const stripTop = H - stripMm;
	/* Room under the words before the strip, the way the template has it. */
	const gapMm2 = Math.max(4, footMm * 0.28);
	const kindBase = stripTop - gapMm2;
	const nameBase = kindBase - nameSize * 0.95;
	const markMm = Math.min(footMm * 0.42, nameBase - footTop + nameSize);
	const markTop = (nameBase - nameSize * 0.8 + kindBase - markMm) / 2;
	const skinFore = skin
		? `<text x="${marginMm}mm" y="${nameBase}mm" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${nameSize}mm" fill="${sk.name}">RoleModel Software</text>` +
			`<text x="${marginMm}mm" y="${kindBase}mm" font-family="Helvetica, Arial, sans-serif" font-size="${nameSize * 0.62}mm" fill="${sk.kind}">Sticker Sheet</text>` +
			`<rect x="${W - marginMm - markMm}mm" y="${markTop}mm" width="${markMm}mm" height="${markMm}mm" rx="${markMm * 0.12}mm" fill="${sk.mark}"/>` +
			`<text x="${W - marginMm - markMm / 2}mm" y="${markTop + markMm * 0.72}mm" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${markMm * 0.72}mm" fill="${sk.name}">R</text>`
		: logo
			? `<g transform="translate(${(marginMm / 25.4) * 96}, ${((H - footMm + 2) / 25.4) * 96})"><svg width="${(34 / 25.4) * 96}" height="${(6 / 25.4) * 96}" viewBox="0 0 204 36" preserveAspectRatio="xMinYMid meet">${String(logo).replace(XML_HEAD, "").match(SVG_ROOT)?.[2] ?? ""}</svg></g>`
			: "";
	/* The legend goes outside the trim, in the bleed, so it is cut away with it
	   — a shop needs to read it, a customer must never see it. */
	const legend = `<text x="${W}mm" y="${-bleedMm * 0.3}mm" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="2.2" fill="#000">${esc(title)} · ${used.length} on a ${p.label} sheet · cut lines are 100% magenta, do not print</text>`;

	/*
	 * The page is the trim plus bleed on every side, and carries no viewBox —
	 * with one, the millimetres inside resolve against CSS's 96-per-inch instead
	 * of the box and the whole sheet lands at the wrong scale. The trim's origin
	 * is reached with a translate in user units instead, which are px at 96dpi
	 * and sit happily beside millimetre children.
	 */
	const off = (bleedMm / 25.4) * 96;
	return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W + bleedMm * 2}mm" height="${H + bleedMm * 2}mm">\n<g transform="translate(${off} ${off})">\n${skinBack}\n${marks}\n<g id="art">${art.join("\n")}</g>\n<g id="CutContour">${cuts.join("\n")}</g>\n${skinFore}${legend}\n</g></svg>\n`;
}

/** How many fit on one page, from the geometry rather than by counting output. */
export function perPage({ page = "letter", stickerMm = 50.8, gapMm = 4, marginMm = 10, logo = null, skin = true }) {
	const p = PAGES[page] ?? PAGES.letter;
	const footMm = skin ? p.hMm * SHEET_SKIN.footFrac + 4 : logo ? 14 : 9;
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

/*
 * What the artwork actually covers, which is not what it says it covers.
 *
 * These stickers declare a viewBox and then draw outside it — "Craft" says
 * `0 0 391 262` and its ink runs from -15,-11 to 390,262. Every earlier fault
 * traces back to trusting that number: the sticker was clipped when it was
 * drawn for the die trace, so the cut line followed a cropped silhouette and
 * ran straight through the letters; and it was clipped again when placed on
 * the sheet.
 *
 * So the box is measured, in the browser, from the geometry itself. One page
 * does the measuring and the drawing together, because the expensive part is
 * starting the browser, not either job.
 */
/*
 * `page` is passed in when there are many to do.
 *
 * Starting a browser is most of what a trace costs — six stickers traced with
 * six browsers took over a minute, and the drawing itself is a fraction of a
 * second. So a caller with a list opens one and lends it.
 */
export async function renderInk(svg, { size = 1024, padFrac = 0.18, page: lent = null } = {}) {
	const { chromium } = await import("playwright");
	const browser = lent ? null : await (await import("playwright")).chromium.launch();
	const dir = await mkdtemp(join(tmpdir(), "ink-"));
	try {
		const page = lent ?? (await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 }));
		await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${String(svg).replace(XML_HEAD, "")}</body></html>`, { waitUntil: "load" });
		const seen = await page.evaluate(() => {
			const s = document.querySelector("svg");
			if (!s) return null;
			const b = s.getBBox();
			return b.width > 0 && b.height > 0 ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
		});
		const guess = seen ?? svgBox(svg);
		/*
		 * `getBBox` is where the geometry is, not where the ink is: it excludes
		 * stroke width, and these stickers are mostly thick strokes. So the
		 * guess is drawn with room around it and then the transparency is
		 * trimmed away — a trim counts pixels, and pixels include the stroke,
		 * the filter and everything else that actually printed.
		 */
		const pad = Math.max(guess.w, guess.h) * padFrac;
		const wide = { x: guess.x - pad, y: guess.y - pad, w: guess.w + pad * 2, h: guess.h + pad * 2 };
		const long0 = Math.max(wide.w, wide.h);
		const vb = { x: wide.x - (long0 - wide.w) / 2, y: wide.y - (long0 - wide.h) / 2, w: long0, h: long0 };
		const body = String(svg).replace(XML_HEAD, "").match(SVG_ROOT)?.[2] ?? "";
		await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}">${body}</svg></body></html>`, { waitUntil: "load" });
		const shot = join(dir, "wide.png");
		await writeFile(shot, await page.locator("svg").screenshot({ type: "png", omitBackground: true }));
		/* Where the ink sits inside that square, in pixels, then in user units. */
		const info = await capture("magick", [shot, "-format", "%@", "info:"]);
		const m = String(info.out).match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
		if (!m) return null;
		const [, tw, th, tx, ty] = m.map(Number);
		const per = vb.w / size;
		const ink = { x: vb.x + tx * per, y: vb.y + ty * per, w: tw * per, h: th * per };
		/* A square around the ink with a hair of margin, so a die line grown
		   outward has somewhere to go. */
		const long = Math.max(ink.w, ink.h) * 1.12;
		const square = { x: ink.x + ink.w / 2 - long / 2, y: ink.y + ink.h / 2 - long / 2, w: long, h: long };
		await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${square.x} ${square.y} ${square.w} ${square.h}">${body}</svg></body></html>`, { waitUntil: "load" });
		const bytes = await page.locator("svg").screenshot({ type: "png", omitBackground: true });
		/* Where the ink lands in that render, in pixels — the other half of the
		   pair the cut is laid onto. */
		const square_png = join(dir, "sq.png");
		await writeFile(square_png, bytes);
		const at2 = await capture("magick", [square_png, "-alpha", "extract", "-threshold", "30%", "-format", "%@", "info:"]);
		const mm = String(at2.out).match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
		const inkPx = mm ? { w: +mm[1], h: +mm[2], x: +mm[3], y: +mm[4] } : null;
		return { bytes, ink, square, inkPx, size };
	} catch {
		return null;
	} finally {
		await rm(dir, { recursive: true, force: true });
		await browser?.close();
	}
}

export async function dieLine(svg, { size = 1024, offsetPx = 14, roundPx = null, page = null, drawn: given = null, fetchImpl = fetch } = {}) {
	if ((await capture("potrace", ["--version"])).ok === false) return null;
	/*
	 * Grow past the offset, then shrink back — a closing.
	 *
	 * Growing alone traces every notch the artwork has: the gaps between the
	 * letters of a word each became a spike in the cut line, and the corners
	 * came out as stepped right angles no die is bent to. Growing by
	 * offset + R and shrinking by R lands the line at exactly `offset` but with
	 * every concave corner rounded to R and every gap narrower than 2R bridged.
	 * That is the border radius a die-cut sticker has, and it is why the same
	 * two operations are what a prepress department reaches for.
	 */
	/*
	 * No rounding unless somebody asks for it.
	 *
	 * These stickers are drawn with their keyline already on them, and that
	 * keyline is the die: whatever corners it has are the corners somebody
	 * chose. Closing the silhouette rounds them off, and a cut that rounds a
	 * hard corner crosses into the ink — the sticker comes back with dark
	 * showing where the white border should have been.
	 *
	 * So the default is zero, and zero means no closing at all: the outline is
	 * traced as it is. The control stays, for artwork with no keyline of its
	 * own, where bridging the gaps between letters is what you want.
	 */
	const round = Math.max(0, Math.round(roundPx ?? 0));
	const dir = await mkdtemp(join(tmpdir(), "die-"));
	try {
		const png = join(dir, "a.png");
		/*
		 * The drawing does not depend on the offset or the radius, only the
		 * growing does. A caller changing a slider hands back the render it
		 * already has, and what is paid again is a second of morphology rather
		 * than a browser and three page loads.
		 */
		const drawn = given ?? (await renderInk(svg, { size, page }));
		if (!drawn) return null;
		await writeFile(png, drawn.bytes);
		const mask = join(dir, "m.png");
		const holes = join(dir, "h.png");
		const solid = join(dir, "s.png");
		const pgm = join(dir, "s.pgm");
		const out = join(dir, "d.svg");
		/*
		 * Room to grow into.
		 *
		 * A dilation cannot expand past the edge of its bitmap, and a sticker
		 * that fills its frame — a square tile of text, say — was being dilated
		 * against the border and came back with the corners it started with.
		 * The line was correct and looked like nobody had rounded anything. So
		 * the mask is bordered by more than the growth, and shaved after.
		 */
		const room = Math.round(offsetPx) + round + 4;
		/*
		 * The offset is a distance transform, not a morphology.
		 *
		 * A dilation with a disk costs the kernel's area times the image's, so
		 * the only way to keep it affordable was to shrink the mask — and
		 * shrinking the mask is exactly what stopped the line following the
		 * outline. A distance transform costs the same whatever the radius:
		 * every pixel is told how far it is from the ink, once, and a threshold
		 * at the offset is the offset. Exactly, at full size, in under a second.
		 *
		 * Growing then shrinking by the radius is still what rounds the corners
		 * and bridges the gaps between letters; it is only the arithmetic that
		 * changed. The erode is a dilate of the background and a complement,
		 * which is the same identity a morphology uses.
		 *
		 * The distance is stored as pixels over 255 of the quantum range, so it
		 * cannot express more than 255px. When the radius asked for is larger
		 * than that, and only then, the mask is worked smaller.
		 */
		const need = Math.round(offsetPx) + round;
		const scale = Math.min(1, DISTANCE_MAX_PX / Math.max(1, need));
		const at = (n) => Math.max(1, Math.round(n * scale));
		const q = (px) => Math.round(at(px) * 257);
		/* With no offset and no radius there is nothing to grow or shrink, and
		   the silhouette is already the answer — every morphology after this
		   point would only move it. */
		const plain = need === 0;
		const shaping = plain
			? []
			: [
					/* Grow: every pixel within (offset + radius) of the ink joins it. */
					"-negate",
					"-morphology",
					"Distance",
					"Euclidean:1",
					"-threshold",
					`${q(need)}`,
					"-negate",
					/*
					 * Shrink: on the grown shape, a distance transform measures how
					 * far each of its pixels is from the outside, and keeping only
					 * those further than the radius is the erode. No inversion
					 * afterwards — one there turned the answer inside out and drew
					 * a rectangle round the whole cell, which is what a complement
					 * looks like.
					 */
					"-morphology",
					"Distance",
					"Euclidean:1",
					"-threshold",
					`${q(round)}`,
				];
		const grown = await capture("magick", [
			png,
			"-alpha",
			"extract",
			"-threshold",
			"30%",
			...(scale < 1 ? ["-resize", `${(scale * 100).toFixed(4)}%`] : []),
			"-bordercolor",
			"black",
			"-border",
			`${at(room)}`,
			/* A border leaves a virtual canvas behind it, and the offset rides
			   along into the PGM: the traced path came out shifted by the whole
			   border width, which looked like the cut being misplaced on the
			   sheet. */
			"+repage",
			...shaping,
			mask,
		]);
		if (!grown.ok) return null;
		/* Anything white the background cannot reach is a hole, and a hole is not
		   somewhere to cut. Found by flooding the outside and keeping what is
		   left, then painted back in. */
		await capture("magick", [mask, "-negate", "-bordercolor", "white", "-border", "1", "-fill", "black", "-floodfill", "+0+0", "white", "-shave", "1x1", holes]);
		await capture("magick", [mask, holes, "-compose", "Lighten", "-composite", solid]);
		await capture("magick", [solid, "-negate", "-depth", "8", pgm]);
		/*
		 * Faithful, now that the mask is faithful. The smoothing was cranked up
		 * to hide a coarse silhouette; with the outline exact, hard smoothing
		 * only rounds off the shape somebody drew. `-t 8` still drops specks —
		 * a stray anti-aliased pixel is its own contour, and a cutter asked to
		 * cut a 2mm circle out of nothing jams.
		 */
		const traced = await capture("potrace", [pgm, "-s", "-a", "1.0", "-O", "0.2", "-t", "8", "-o", out]);
		if (!traced.ok) return null;
		const text = await readFile(out, "utf8");
		const ds = [...text.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
		if (!ds.length) return null;
		/* potrace writes its own flip; carried through rather than unpicked. */
		const g = text.match(/<g([^>]*)>/)?.[1] ?? "";
		const transform = (g.match(/transform="([^"]*)"/) ?? [])[1] ?? "";
		const joined = ds.join(" ");
		/* The square the trace was made in travels with it, so the sheet places the
		   artwork in exactly the same frame and the two line up. */
		/*
		 * The trace happened in a bitmap `room` px bigger on every side, so the
		 * square it belongs in is bigger by the same amount in user units — the
		 * sheet scales by this, not by `size`, or the cut line lands short.
		 */
		/* Half size plus half the border, in half-size pixels — and the square it
		   maps to in user units is worked out from the same halves, so the cut
		   lands where the artwork is however coarse the mask was. */
		/*
		 * Where the cut's own shape sits in its bitmap, and where the ink sits
		 * in the drawing's — both measured, not derived.
		 *
		 * The placement had been worked out through three chained frames: the
		 * square the ink was measured in, the square it was traced in, and the
		 * cell. Each step was defensible and the error still came out at a
		 * millimetre or two, differently per sticker, because a trim rounds and
		 * potrace's own margin is not zero. Measuring both boxes and laying one
		 * on the other has no chain to accumulate.
		 */
		const boxOf = async (file) => {
			const g = await capture("magick", [file, "-format", "%@", "info:"]);
			const m = String(g.out).match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
			return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
		};
		const grownSize = Math.round(size * scale) + at(room) * 2;
		const shapeBox = await boxOf(mask);
		/*
		 * And where the traced path lands, which is not where the mask did.
		 *
		 * potrace's own output sits a few units off the bitmap it came from —
		 * its coordinates are tenths of a pixel with a margin of its own — and
		 * that few units is a millimetre on a printed sticker. Measured in the
		 * browser that is already open, so the cut can be laid on the drawing
		 * by what it is rather than by what it should have been.
		 */
		let pathBox = null;
		if (page) {
			try {
				await page.setContent(
					`<!doctype html><html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="${grownSize}" height="${grownSize}" viewBox="0 0 ${grownSize} ${grownSize}"><g id="m"><g transform="${transform}"><path d="${joined}"/></g></g></svg></body></html>`,
					{ waitUntil: "load" },
				);
				pathBox = await page.evaluate(() => {
					const g = document.getElementById("m");
					const b = g.getBBox();
					return b.width > 0 && b.height > 0 ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
				});
			} catch {
				/* Without it the old derivation still applies. */
			}
		}
		const per = drawn.square.w / (size * scale);
		const square = { x: drawn.square.x - at(room) * per, y: drawn.square.y - at(room) * per, w: drawn.square.w + at(room) * 2 * per, h: drawn.square.h + at(room) * 2 * per };
		return { d: joined, transform, size: grownSize, square, art: drawn.square, shapeBox, pathBox, inkBox: drawn.inkPx, artSize: drawn.size ?? size };
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
export async function withDieLines(items, { offsetPx = 14, roundPx = null, size = 1024, lanes = 4 } = {}) {
	const out = new Array(items.length);
	if (!items.some((i) => i.svg)) return items.slice();
	const { chromium } = await import("playwright");
	/* One browser, a page per lane: the launch is the expensive part and it is
	   paid once rather than once per sticker. */
	const browser = await chromium.launch();
	try {
		let next = 0;
		const worker = async () => {
			const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
			try {
				while (next < items.length) {
					const i = next++;
					const item = items[i];
					out[i] = item.svg ? { ...item, die: await dieLine(item.svg, { offsetPx, roundPx, size, page }) } : item;
				}
			} finally {
				await page.close();
			}
		};
		await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, worker));
	} finally {
		await browser.close();
	}
	return out;
}


/**
 * The biggest sticker that still fits them all on one sheet.
 *
 * WHY ONE SHEET
 *
 * A sticker sheet is priced by the sheet. Spilling onto a second one doubles
 * the bill for nothing, and it is the kind of thing you only notice when the
 * quote comes back — so the size is worked out from the count rather than set
 * by hand and hoped over.
 *
 * Searched downward from the largest a sheet could hold, in quarter
 * millimetres, because the number of columns and rows only changes in steps
 * and there is no formula that inverts cleanly.
 */
export function fitStickerMm({ page = "4x6", count = 1, gapMm = 4, marginMm = 10, skin = true, maxMm = 120, minMm = 8 } = {}) {
	const n = Math.max(1, Math.round(count));
	for (let mm = maxMm; mm >= minMm; mm -= 0.25) {
		if (perPage({ page, stickerMm: mm, gapMm, marginMm, skin }).fits >= n) return Math.round(mm * 4) / 4;
	}
	return minMm;
}
