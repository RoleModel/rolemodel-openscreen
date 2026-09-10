/*
 * What a sheet would cost to print, from more than one shop.
 *
 * THERE IS NO SHARED PRICING API
 *
 * Sticker printers do not agree on anything, least of all a way to ask what
 * something costs. Sticker Mule says outright that it has no API. Prodigi has
 * a real quotes endpoint. Printful and Gelato have APIs behind an account. So
 * a vendor here is one of three kinds, and the kind is part of the answer:
 *
 *   api   — asked live, exact, needs a key
 *   page  — read off the shop's own public price list
 *   table — written down by hand, and going stale from the day it was written
 *
 * EVERY PRICE CARRIES WHERE IT CAME FROM AND WHEN
 *
 * A number scraped in March and shown in September as though it were a quote
 * is worse than no number: it is a decision made on something that is not true
 * any more. So nothing here returns a bare price. Every quote says its `kind`,
 * its `checkedAt`, and what it could not account for — and the caller is
 * expected to show that beside the money.
 */

const USD = (n) => Math.round(Number(n) * 100) / 100;

/** Nearest size a shop actually sells, since none of them cut to the millimetre. */
export const nearestSize = (mm, offered) => offered.reduce((best, s) => (Math.abs(s.mm - mm) < Math.abs(best.mm - mm) ? s : best), offered[0]);

/* ── Sticker Mule ─────────────────────────────────────────────────────────
 *
 * No API, and their own FAQ says so. The price ladder is plain text on the
 * product page, so it is read from there — which is a real dependency on
 * their markup, and says so in `note` rather than pretending otherwise.
 *
 * The ladder on the page is the one for the size the page loads with; the
 * other sizes are chosen in the browser and never reach the HTML. So only
 * that ladder is quoted live, and bigger sizes fall back to the table.
 */
/*
 * Two products, not one.
 *
 * A die-cut sticker is sold one at a time; a sticker sheet is a page of many,
 * priced per page. Comparing a sheet's page price against a single sticker's
 * unit price is how somebody talks themselves into the wrong order, so the
 * product is chosen and every vendor is asked about the same one.
 */
export const PRODUCTS = [
	{ id: "die-cut", label: "Die-cut singles", per: "sticker" },
	{ id: "sheet", label: "Sticker sheets", per: "sheet" },
];

export const STICKER_MULE_URL = {
	"die-cut": "https://www.stickermule.com/products/die-cut-stickers",
	sheet: "https://www.stickermule.com/products/sticker-sheets",
};

export function parseMuleLadder(html) {
	const rows = [];
	/* Split on the row markers rather than matching across them: one greedy
	   pattern over the whole page pairs each quantity with the next row's
	   price and every number comes out shifted by one. */
	for (const chunk of String(html).split(/id="qty-/).slice(1)) {
		const qty = Number(chunk.match(/^(\d+)-/)?.[1]);
		const price = chunk.match(/\$([\d,]+(?:\.\d+)?)/)?.[1];
		if (qty > 0 && price) rows.push({ quantity: qty, total: USD(price.replace(/,/g, "")) });
	}
	/* A quantity can appear twice if the page repeats a table; the first wins. */
	const seen = new Map();
	for (const r of rows) if (!seen.has(r.quantity)) seen.set(r.quantity, r);
	return [...seen.values()].sort((a, b) => a.quantity - b.quantity);
}

/*
 * Written down by hand, from each shop's public price list, on the date below.
 * Every one of these is a guess about today made on a different day — which is
 * exactly why `checkedAt` travels with it.
 */
export const TABLES = {
	stickermule: {
		checkedAt: "2026-09-09",
		sheet: [
			{ label: '4" × 6" sheet', page: "4x6", mm: 152.4, ladder: [[50, 119], [100, 177], [200, 278], [300, 371], [500, 540], [1000, 917], [2000, 1580], [3000, 2182], [5000, 3286]] },
			{ label: '8.5" × 11" sheet', page: "letter", mm: 279.4, ladder: [[50, 228], [100, 344], [200, 546], [300, 733], [500, 1072], [1000, 1828]] },
		],
		sizes: [
			{ label: '2" × 2"', mm: 50.8, ladder: [[50, 60], [100, 73], [200, 95], [300, 115], [500, 152], [1000, 232], [2000, 371], [3000, 496], [5000, 723], [10000, 1225]] },
			{ label: '3" × 3"', mm: 76.2, ladder: [[50, 79], [100, 97], [200, 129], [300, 155], [500, 208], [1000, 320], [2000, 517], [3000, 694], [5000, 1015]] },
			{ label: '4" × 4"', mm: 101.6, ladder: [[50, 104], [100, 129], [200, 173], [300, 209], [500, 283], [1000, 439], [2000, 713], [3000, 960]] },
			{ label: '5" × 5"', mm: 127, ladder: [[50, 133], [100, 166], [200, 224], [300, 272], [500, 370], [1000, 577], [2000, 941]] },
		],
	},
	stickergiant: {
		checkedAt: "2026-09-09",
		sheet: [{ label: '4" × 6" sheet', page: "4x6", mm: 152.4, ladder: [[100, 190], [250, 322], [500, 520], [1000, 880], [2500, 1875]] }],
		sizes: [
			{ label: '2" × 2"', mm: 50.8, ladder: [[100, 62], [250, 88], [500, 122], [1000, 180], [2500, 335], [5000, 545]] },
			{ label: '3" × 3"', mm: 76.2, ladder: [[100, 84], [250, 124], [500, 176], [1000, 268], [2500, 520], [5000, 870]] },
			{ label: '4" × 4"', mm: 101.6, ladder: [[100, 112], [250, 170], [500, 246], [1000, 382], [2500, 760], [5000, 1290]] },
		],
	},
	stickerapp: {
		checkedAt: "2026-09-09",
		sheet: [{ label: '4" × 6" sheet', page: "4x6", mm: 152.4, ladder: [[50, 96], [100, 148], [250, 268], [500, 432], [1000, 720]] }],
		sizes: [
			{ label: '2" × 2"', mm: 50.8, ladder: [[50, 45], [100, 58], [250, 92], [500, 138], [1000, 205], [2500, 420]] },
			{ label: '3" × 3"', mm: 76.2, ladder: [[50, 62], [100, 82], [250, 135], [500, 205], [1000, 312], [2500, 655]] },
			{ label: '4" × 4"', mm: 101.6, ladder: [[50, 84], [100, 113], [250, 190], [500, 292], [1000, 452]] },
		],
	},
};

/** The rung at or above the wanted count; the top rung if it is over. */
export const rungFor = (ladder, quantity) => ladder.find(([q]) => q >= quantity) ?? ladder[ladder.length - 1];

function fromTable(vendorId, { sizeMm, quantity, product = "die-cut", page = null }) {
	const t = TABLES[vendorId];
	const list = product === "sheet" ? t?.sheet : t?.sizes;
	if (!list?.length) return null;
	/*
	 * A sheet is matched by name, never by nearness.
	 *
	 * A die-cut sticker at 76mm is fairly quoted from a shop's 3" price. A
	 * sheet is not: 8.5x11 quoted from a 4x6 ladder is a different product for
	 * less than half the paper, and it looked like a real number. So a shop
	 * that does not list the size asked for has nothing to say about it.
	 */
	const size = product === "sheet" ? list.find((z) => z.page === page) : nearestSize(sizeMm, list);
	if (!size) return null;
	const [rungQty, total] = rungFor(size.ladder, quantity);
	return {
		size: size.label,
		sizeMm: size.mm,
		quantity: rungQty,
		total: USD(total),
		unit: USD(total / rungQty),
		checkedAt: t.checkedAt,
	};
}

/* ── Prodigi ──────────────────────────────────────────────────────────────
 *
 * The one shop here with a quotes endpoint. It answers in cents-exact money
 * for a SKU, a count and a country, which is what every other vendor here is
 * being approximated into.
 */
export const PRODIGI_QUOTES = "https://api.prodigi.com/v4.0/quotes";
export const PRODIGI_SANDBOX = "https://api.sandbox.prodigi.com/v4.0/quotes";
/*
 * Prodigi's real sticker SKUs, checked against their products endpoint rather
 * than guessed: every GLOBAL-STI- shape came back SkuNotFound. The size is the
 * long side in millimetres, so nearestSize picks the one a sticker fits.
 */
const PRODIGI_SKUS = [
	{ sku: "M-STI-3X4", label: '3" × 4" kiss-cut', mm: 101.6 },
	{ sku: "M-STI-5_5X5_5", label: '5.5" × 5.5" kiss-cut', mm: 139.7 },
	{ sku: "M-STI-8_5X8_5", label: '8.5" × 8.5" kiss-cut', mm: 215.9 },
	{ sku: "M-STI-14X14", label: '14" × 14" kiss-cut', mm: 355.6 },
];

async function fromProdigi({ key, sizeMm, quantity, product = "die-cut", country = "US", sandbox = false, fetchImpl = fetch }) {
	if (!key) return null;
	/* Prodigi sells kiss-cut singles, not sheets. Saying so beats a wrong number. */
	if (product === "sheet") throw new Error("Prodigi does not sell sticker sheets — singles only.");
	const pick = nearestSize(sizeMm, PRODIGI_SKUS);
	const res = await fetchImpl(sandbox ? PRODIGI_SANDBOX : PRODIGI_QUOTES, {
		method: "POST",
		headers: { "X-API-Key": key, "Content-Type": "application/json" },
		body: JSON.stringify({ destinationCountryCode: country, currencyCode: "USD", items: [{ sku: pick.sku, copies: quantity, attributes: {}, assets: [{ printArea: "default" }] }] }),
		signal: AbortSignal.timeout(20_000),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`Prodigi answered ${res.status}${json.issues ? ` — ${JSON.stringify(json.issues).slice(0, 160)}` : ""}`);
	const q = (json.quotes ?? [])[0];
	if (!q) throw new Error("Prodigi returned no quote for that size");
	const items = Number(q.costSummary?.items?.amount ?? 0);
	const ship = Number(q.costSummary?.shipping?.amount ?? 0);
	return { size: pick.label, sizeMm: pick.mm, quantity, total: USD(items + ship), unit: USD((items + ship) / quantity), shipping: USD(ship), checkedAt: new Date().toISOString().slice(0, 10) };
}

/** Every shop this knows, and how each one is asked. */
export const VENDORS = [
	{ id: "stickermule", name: "Sticker Mule", kind: "page", url: STICKER_MULE_URL["die-cut"], note: "Read off their public price list — they have no API, so this breaks when their page changes. Only the size their page opens on is live; the rest come from the table." },
	{ id: "prodigi", name: "Prodigi", kind: "api", url: "https://www.prodigi.com/print-api/", note: "A real quote, to the cent, including shipping. Needs an API key; the sandbox is free." },
	{ id: "stickergiant", name: "StickerGiant", kind: "table", url: "https://www.stickergiant.com/", note: "Written down by hand from their price list." },
	{ id: "stickerapp", name: "StickerApp", kind: "table", url: "https://stickerapp.com/", note: "Written down by hand from their price list." },
];

/**
 * Ask everyone, and rank by what a sticker actually costs.
 *
 * A vendor that fails is kept in the answer with its reason rather than
 * dropped, because a shop missing from a comparison reads as a shop that was
 * expensive.
 */
export async function quoteAll({ sizeMm = 76.2, quantity = 100, product = "die-cut", page = null, country = "US", prodigiKey = "", prodigiSandbox = false, cache = null, fetchImpl = fetch } = {}) {
	const out = await Promise.all(
		VENDORS.map(async (v) => {
			try {
				if (v.kind === "api" && v.id === "prodigi") {
					const q = await fromProdigi({ key: prodigiKey, sizeMm, quantity, product, country, sandbox: prodigiSandbox, fetchImpl });
					if (!q) return { ...v, error: "No Prodigi API key yet — add one under Stickers to get a live quote." };
					return { ...v, ...q };
				}
				if (v.kind === "page" && v.id === "stickermule") {
					const table = fromTable("stickermule", { sizeMm, quantity, product, page });
					/* Fetched once per product however many runs are asked about: a
					   comparison across four run sizes is one page, not four. */
					const key = `mule:${product}`;
					let ladder = cache?.get(key);
					if (!ladder) {
						const res = await fetchImpl(STICKER_MULE_URL[product] ?? STICKER_MULE_URL["die-cut"], { headers: { "User-Agent": "Mozilla/5.0 RoleModelStudio" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
						ladder = res?.ok ? parseMuleLadder(await res.text()) : [];
						cache?.set(key, ladder);
					}
					/* The live ladder is the page's own default size; it only
					   replaces the table when that is the size being asked about. */
					const liveSize = (product === "sheet" ? TABLES.stickermule.sheet : TABLES.stickermule.sizes)[0];
					if (ladder.length && Math.abs(liveSize.mm - table.sizeMm) < 0.5) {
						const rung = ladder.find((r) => r.quantity >= quantity) ?? ladder[ladder.length - 1];
						return { ...v, size: liveSize.label, sizeMm: liveSize.mm, quantity: rung.quantity, total: rung.total, unit: USD(rung.total / rung.quantity), checkedAt: new Date().toISOString().slice(0, 10), live: true };
					}
					return { ...v, ...table, live: false };
				}
				const t = fromTable(v.id, { sizeMm, quantity, product, page });
				if (!t) return { ...v, error: `${v.name} has no price on file for that size.` };
				return { ...v, ...t };
			} catch (err) {
				return { ...v, error: err.message };
			}
		}),
	);
	const priced = out.filter((r) => Number.isFinite(r.unit));
	priced.sort((a, b) => a.unit - b.unit);
	return { asked: { sizeMm, quantity, product, page, country }, best: priced[0] ?? null, quotes: [...priced, ...out.filter((r) => !Number.isFinite(r.unit))] };
}


/**
 * Both shapes of order, side by side.
 *
 * Singles and sheets are priced by different units and must never be ranked
 * against each other — but "which should we order" is the question somebody
 * actually has, and answering it means seeing both. So they are gathered
 * together and kept apart: two lists, each with its own cheapest.
 */
export async function quoteBoth({ sizeMm = 76.2, sheetMm = 152.4, quantity = 250, ...rest } = {}) {
	const [singles, sheets] = await Promise.all([
		quoteAll({ ...rest, sizeMm, quantity, product: "die-cut" }),
		quoteAll({ ...rest, sizeMm: sheetMm, quantity, product: "sheet" }),
	]);
	return { singles, sheets };
}


/**
 * The sheet sizes somebody will actually print, and who prints them.
 *
 * WHY THE PAPER LIST IS NOT A LIST OF PAPER
 *
 * A4 is a size of paper. It is not a size of sticker sheet anyone here sells,
 * and laying artwork on it produces a file every shop will come back on. So
 * the sizes offered are the ones the price tables say are sold, each carrying
 * the shops that sell it — which also means the list grows when a vendor is
 * added and cannot drift away from what is quotable.
 */
export function sheetSizes(extra = []) {
	const byPage = new Map();
	/* Sizes the Studio can lay out but nobody here quotes — the 6 × 8 the
	   template is drawn at, for one. Offered, and honest about the gap. */
	for (const e of extra) byPage.set(e.id, { id: e.id, label: e.label, mm: e.mm, vendors: [] });
	for (const v of VENDORS) {
		for (const size of TABLES[v.id]?.sheet ?? []) {
			if (!size.page) continue;
			const at = byPage.get(size.page) ?? { id: size.page, label: size.label.replace(/ sheet$/, ""), mm: size.mm, vendors: [] };
			at.vendors.push(v.name);
			byPage.set(size.page, at);
			at.quoted = true;
		}
	}
	return [...byPage.values()].sort((a, b) => a.mm - b.mm);
}


/** The run sizes worth asking about. Small enough to try, big enough to matter. */
export const RUNS = [50, 100, 250, 500, 1000];

/**
 * Every shop, across several run sizes at once.
 *
 * WHY MORE THAN ONE RUN
 *
 * The answer to "what does this cost" is a curve, not a number: 50 of
 * something is often barely cheaper than 100 of it, and seeing that side by
 * side is what stops somebody ordering fifty. So one row per shop, one column
 * per run, and each column marked with whoever is cheapest at that size —
 * because the cheapest at 50 is regularly not the cheapest at 500.
 */
export async function quoteRuns({ runs = RUNS, product = "die-cut", page = null, ...rest } = {}) {
	const cache = new Map();
	const each = await Promise.all(runs.map((quantity) => quoteAll({ ...rest, product, page, quantity, cache })));
	const names = new Map();
	for (const r of each) for (const q of r.quotes) if (!names.has(q.id)) names.set(q.id, q);
	const vendors = [...names.values()].map((v) => ({
		id: v.id,
		name: v.name,
		kind: v.kind,
		cells: each.map((r) => {
			const q = r.quotes.find((x) => x.id === v.id);
			return q && Number.isFinite(q.unit) ? { quantity: q.quantity, total: q.total, unit: q.unit, size: q.size, checkedAt: q.checkedAt, live: q.live } : null;
		}),
		error: each.map((r) => r.quotes.find((x) => x.id === v.id)?.error).find(Boolean) ?? null,
	}));
	/* Cheapest per column, not overall: the winner changes with the run. */
	const best = runs.map((_, i) => {
		let win = null;
		for (const v of vendors) if (v.cells[i] && (!win || v.cells[i].unit < win.unit)) win = { id: v.id, unit: v.cells[i].unit };
		return win?.id ?? null;
	});
	return { runs, product, page, vendors, best };
}

/**
 * Both products, each across the runs — and sheets at every size that is sold.
 *
 * WHY A TABLE PER SHEET SIZE
 *
 * A sheet's price is mostly its size, so one number for "sticker sheets" is
 * not an answer to anything: 4x6 at StickerApp and 8.5x11 at Sticker Mule are
 * different products at different money, and stacking them in one table
 * invites reading down a column that does not mean one thing.
 *
 * WHY A SHOP THAT DOES NOT SELL THEM IS LEFT OUT
 *
 * Prodigi sells kiss-cut singles and no sheets at all. A row of dashes and an
 * apology is noise on a page somebody is reading to make a decision — it says
 * nothing that the shop's absence does not say better. A shop that could not
 * be reached is different, and still shown: that one might have had a price.
 */
export async function quoteRunsBoth({ sizeMm = 76.2, ...rest } = {}) {
	const sizes = sheetSizes(rest.sheetSizes ?? []);
	const [singles, ...sheets] = await Promise.all([
		quoteRuns({ ...rest, sizeMm, product: "die-cut" }),
		...sizes.map((z) => quoteRuns({ ...rest, sizeMm: z.mm, product: "sheet", page: z.id })),
	]);
	return {
		singles,
		/* A size nobody quotes is left out rather than shown empty: a heading
		   over "no printer here quotes this size" is a row of nothing to read. */
		sheets: sizes
			.map((z, i) => ({
				id: z.id,
				label: z.label,
				mm: z.mm,
				vendors: z.vendors,
				/* Only shops that priced it: a shop that does not sell sheets is
				   absent rather than apologising in a row of dashes. */
				group: { ...sheets[i], vendors: sheets[i].vendors.filter((v) => v.cells.some(Boolean)) },
			}))
			.filter((z) => z.group.vendors.length),
	};
}
