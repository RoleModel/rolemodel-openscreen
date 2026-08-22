/**
 * Wallpaper recipes — one drawing implementation, used in three places.
 *
 * A wallpaper used to be a hand-written block of CSS inside the build script,
 * which meant the only way to change one was to edit JavaScript and re-run a
 * Playwright render. Now a wallpaper is *data*: a small JSON recipe. The same
 * `draw()` below renders it in the Studio's live preview, renders the 4K JPEG
 * the Studio saves, and renders the batch set from `brand/wallpapers.json`.
 * If those three ever disagreed, the preview would be lying — so they share
 * this file rather than each owning a copy.
 *
 * Zero dependencies and no Node built-ins on purpose: the Studio serves this
 * module straight to the browser as an ES module.
 *
 * NO RADIAL GRADIENTS. RoleModel's brand is linear — direction, not blobs. The
 * old set used a radial vignette to "settle" the edges, and at 16:9 that ellipse
 * fell outside the frame along the bottom, which read as a thick dark border
 * under every recording. The edge, when a board wants one, is a solid border.
 */

export const TEXTURES = ["none", "dots", "grid", "ascii"];

export const DEFAULT_RECIPE = {
	name: "untitled",
	label: "Untitled",
	base: "#1a2432",
	gradient: { angle: 146, stops: [{ color: "#22303f", at: 0 }, { color: "#141d27", at: 1 }] },
	// A tint is a *directional* band of colour, not a glow. Alpha 0 disables it.
	tint: { color: "#0bc9ef", alpha: 0, angle: 180 },
	texture: { type: "dots", color: "#ffffff", opacity: 0.06, size: 16, weight: 1.4 },
	// The edge is a solid border, not a soft scrim. A gradient edge was the wrong
	// idea twice over: as a radial it produced the dark band along the bottom, and
	// as a linear scrim it was still a fade where the brand calls for a line.
	// Width is in px at 1920 and scales with the output.
	border: { width: 0, color: "#00c278", inset: 0, radius: 0 },
};

/** Deep-merge a partial recipe onto the defaults so old files keep loading. */
export function normalize(r = {}) {
	const d = DEFAULT_RECIPE;
	return {
		name: r.name ?? d.name,
		label: r.label ?? r.name ?? d.label,
		base: r.base ?? d.base,
		gradient: {
			angle: num(r.gradient?.angle, d.gradient.angle),
			stops: (r.gradient?.stops?.length ? r.gradient.stops : d.gradient.stops).map((s, i, a) => ({
				color: s.color ?? "#000000",
				at: num(s.at, a.length === 1 ? 0 : i / (a.length - 1)),
			})),
		},
		tint: {
			color: r.tint?.color ?? d.tint.color,
			alpha: clamp(num(r.tint?.alpha, d.tint.alpha), 0, 1),
			angle: num(r.tint?.angle, d.tint.angle),
		},
		texture: {
			type: TEXTURES.includes(r.texture?.type) ? r.texture.type : d.texture.type,
			color: r.texture?.color ?? d.texture.color,
			opacity: clamp(num(r.texture?.opacity, d.texture.opacity), 0, 1),
			size: clamp(num(r.texture?.size, d.texture.size), 4, 512),
			weight: clamp(num(r.texture?.weight, d.texture.weight), 0.25, 24),
		},
		border: {
			width: clamp(num(r.border?.width, d.border.width), 0, 64),
			color: r.border?.color ?? d.border.color,
			inset: clamp(num(r.border?.inset, d.border.inset), 0, 160),
			radius: clamp(num(r.border?.radius, d.border.radius), 0, 160),
		},
	};
}

/**
 * Seeded PRNG. Textures that need variation must still be reproducible: the
 * same recipe has to render the same JPEG on every machine and every CI run,
 * or the wallpaper files churn in every diff.
 */
function lcg(seed) {
	let s = 2166136261;
	for (const ch of String(seed)) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

const num = (v, f) => (Number.isFinite(Number(v)) ? Number(v) : f);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function hexA(hex, alpha) {
	const h = String(hex).replace("#", "");
	const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
	const n = Number.parseInt(full, 16);
	if (!Number.isFinite(n)) return `rgba(0,0,0,${alpha})`;
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * CSS gradient angles: 0deg points to the top, and they run clockwise. Canvas
 * wants two endpoints. Project the box onto the gradient axis so the stops land
 * exactly where CSS would put them at any angle, not just the axis-aligned ones.
 */
function axis(ctx, angle, w, h) {
	const a = ((angle % 360) + 360) % 360;
	const rad = (a * Math.PI) / 180;
	const dx = Math.sin(rad);
	const dy = -Math.cos(rad);
	const len = Math.abs(w * dx) + Math.abs(h * dy);
	const cx = w / 2;
	const cy = h / 2;
	return ctx.createLinearGradient(
		cx - (dx * len) / 2,
		cy - (dy * len) / 2,
		cx + (dx * len) / 2,
		cy + (dy * len) / 2,
	);
}

/**
 * Draw a recipe into a Canvas2D context at w×h.
 *
 * `unit` scales texture with output size: recipes are authored against a
 * 1920-wide canvas, so a 16px dot grid stays a 16px-looking dot grid whether
 * it renders into a 480px preview or a 3840px export.
 */
export function draw(ctx, recipe, w, h) {
	const r = normalize(recipe);
	const unit = w / 1920;

	ctx.clearRect(0, 0, w, h);
	ctx.fillStyle = r.base;
	ctx.fillRect(0, 0, w, h);

	const g = axis(ctx, r.gradient.angle, w, h);
	for (const s of r.gradient.stops) g.addColorStop(clamp(s.at, 0, 1), s.color);
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, w, h);

	if (r.tint.alpha > 0) {
		const t = axis(ctx, r.tint.angle, w, h);
		t.addColorStop(0, hexA(r.tint.color, r.tint.alpha));
		t.addColorStop(0.72, hexA(r.tint.color, 0));
		ctx.fillStyle = t;
		ctx.fillRect(0, 0, w, h);
	}

	texture(ctx, r, w, h, unit);
	border(ctx, r, w, h, unit);
}

function texture(ctx, r, w, h, unit) {
	const { type, color, opacity, size, weight } = r.texture;
	if (type === "none" || opacity <= 0) return;
	const step = Math.max(4, size * unit);

	if (type === "dots") {
		const rad = Math.max(0.5, weight * unit);
		ctx.fillStyle = hexA(color, opacity);
		for (let y = step / 2; y < h + step; y += step) {
			for (let x = step / 2; x < w + step; x += step) {
				ctx.beginPath();
				ctx.arc(x, y, rad, 0, Math.PI * 2);
				ctx.fill();
			}
		}
		return;
	}

	if (type === "grid") {
		ctx.strokeStyle = hexA(color, opacity);
		ctx.lineWidth = Math.max(0.5, weight * unit * 0.5);
		ctx.beginPath();
		for (let x = step; x < w; x += step) {
			ctx.moveTo(Math.round(x) + 0.5, 0);
			ctx.lineTo(Math.round(x) + 0.5, h);
		}
		for (let y = step; y < h; y += step) {
			ctx.moveTo(0, Math.round(y) + 0.5);
			ctx.lineTo(w, Math.round(y) + 0.5);
		}
		ctx.stroke();
		return;
	}

	if (type === "ascii") {
		// Measure, don't guess. Tiling a fixed-width cell and drawing "1 0 1 0" into
		// it leaves whatever the string doesn't fill as a gap, so the rows came out
		// as clumps with ragged ends. Build one string long enough to overrun the
		// frame and draw it in a single fillText per row — the row is then
		// continuous by construction, and the canvas clips the overhang.
		const glyph = Math.max(8, size * unit * 1.6);
		ctx.fillStyle = hexA(color, opacity);
		ctx.font = `${glyph}px ui-monospace, SFMono-Regular, Menlo, monospace`;
		ctx.textBaseline = "alphabetic";

		// `weight` is the gap between digits, in spaces. 1 reads as dense data,
		// 4 as a sparse field.
		const gap = " ".repeat(Math.max(1, Math.round(weight)));
		const cellW = ctx.measureText(`1${gap}`).width || glyph;
		const cells = Math.ceil(w / cellW) + 2;
		const lineH = glyph * 2;

		// Alternating 1 0 1 0 tiles into a stripe once the rows are continuous.
		// Deterministic bits instead: the same recipe renders the same frame every
		// time — which matters, because CI diffs these JPEGs.
		const rnd = lcg(r.name ?? "ascii");
		let row = 0;
		for (let y = lineH; y < h + lineH; y += lineH, row++) {
			let line = "";
			for (let i = 0; i < cells; i++) line += (rnd() < 0.5 ? "0" : "1") + gap;
			// Half-cell stagger so digits don't lock into a visible column lattice.
			// Both ends overrun the frame, so the stagger costs nothing at the edges.
			ctx.fillText(line, -cellW * (row % 2 ? 1 : 0.5), y);
		}
	}
}

/**
 * A solid border, stroked inside the frame.
 *
 * Stroked at half-width inset so the whole line lands inside the canvas — a
 * centred stroke on the frame edge loses half of itself to the clip, which is
 * why a 6px border used to render as 3px along every side.
 */
function border(ctx, r, w, h, unit) {
	const { width, color, inset, radius } = r.border;
	if (!width) return;
	const lw = width * unit;
	const off = inset * unit + lw / 2;
	ctx.strokeStyle = color;
	ctx.lineWidth = lw;
	ctx.beginPath();
	const rad = Math.min(radius * unit, (Math.min(w, h) - off * 2) / 2);
	if (rad > 0 && ctx.roundRect) ctx.roundRect(off, off, w - off * 2, h - off * 2, rad);
	else ctx.rect(off, off, w - off * 2, h - off * 2);
	ctx.stroke();
}

/**
 * A CSS approximation, for anywhere a canvas is overkill (catalog thumbnails,
 * the contact sheet). Texture is omitted — at thumbnail size it is invisible
 * anyway, and faking it in CSS is how the old code drifted from the render.
 */
export function css(recipe) {
	const r = normalize(recipe);
	const stops = r.gradient.stops.map((s) => `${s.color} ${(s.at * 100).toFixed(1)}%`).join(", ");
	const parts = [`linear-gradient(${r.gradient.angle}deg, ${stops})`];
	if (r.tint.alpha > 0) {
		parts.unshift(
			`linear-gradient(${r.tint.angle}deg, ${hexA(r.tint.color, r.tint.alpha)} 0%, ${hexA(r.tint.color, 0)} 72%)`,
		);
	}
	return `background-color:${r.base};background-image:${parts.join(", ")}`;
}

export function slug(s) {
	return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
}
