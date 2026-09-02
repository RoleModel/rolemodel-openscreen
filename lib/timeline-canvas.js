/*
 * The timeline, drawn.
 *
 * One canvas, one paint per frame, and nothing in here ever opens a video. The
 * pictures along a clip are filmstrip JPEGs made once at import; the waveform is
 * an array of numbers; a transition is a shape. That is the whole reason a
 * timeline can feel instant with twenty clips on it — not a faster renderer, but
 * a renderer that was never asked to decode anything.
 *
 * Canvas rather than DOM. Twenty clips at six visible filmstrip frames each is a
 * hundred and twenty elements before the ruler and the waveform, and a drag that
 * has to reflow that many boxes is a drag you can feel. One paint has no layout.
 *
 * This module draws and measures. It does not own the cut, it does not mutate
 * it, and it does not listen to the mouse — those belong to whatever mounts it,
 * so this stays something you can point at a fixture and screenshot.
 */

/** Row heights, in CSS pixels. The ruler is thin because it is a reference. */
export const RULER_H = 26;
export const VIDEO_H = 76;
export const AUDIO_H = 44;
/* A graphic has no picture to show, so it needs only enough room for its name. */
export const GRAPHIC_H = 40;
export const ROW_GAP = 6;
export const HEAD_W = 116;
/*
 * How wide one filmstrip frame is drawn, everywhere.
 *
 * A constant rather than a calculation, because there were two calculations and
 * they disagreed by three pixels: the painter derived it from the drawn height
 * (VIDEO_H minus its border) and the loader from VIDEO_H itself. Three pixels
 * per slot compounds along a clip, so by its tail the painter was asking for a
 * frame the loader had never fetched and the lane colour showed through. The
 * shared frameIndex was not enough — the slot has to be shared too, because it
 * is what decides which moment each slot asks about.
 */
export const SLOT_W = Math.round((VIDEO_H * 16) / 9);

/*
 * Colour comes off the page, never out of this file.
 *
 * Optics tokens are the brand, they answer to light and dark, and a canvas
 * cannot read a custom property — so they are resolved once against a probe
 * element and handed over as strings. A hex here would be a fourth place the
 * palette lives and the first one to go stale.
 */
export function paletteFrom(host) {
	const probe = document.createElement("span");
	probe.style.display = "none";
	host.append(probe);
	const read = (token, fallback) => {
		probe.style.color = `var(${token}, ${fallback})`;
		return getComputedStyle(probe).color || fallback;
	};
	const palette = {
		ink: read("--op-color-neutral-plus-max", "#0b0f14"),
		panel: read("--op-color-neutral-plus-seven", "#141a21"),
		line: read("--op-color-neutral-plus-five", "#28313b"),
		muted: read("--op-color-neutral-plus-two", "#7c8894"),
		text: read("--op-color-neutral-minus-max", "#f2f2f2"),
		accent: read("--op-color-primary-base", "#00b871"),
		accentSoft: read("--op-color-primary-plus-five", "#134b34"),
	};
	probe.remove();
	return palette;
}

/** A view is where we are looking: seconds per pixel, and the left edge. */
export const defaultView = () => ({ pxPerSecond: 14, scrollSeconds: 0 });

export const timeToX = (view, seconds) => HEAD_W + (seconds - view.scrollSeconds) * view.pxPerSecond;
export const xToTime = (view, x) => (x - HEAD_W) / view.pxPerSecond + view.scrollSeconds;

/**
 * Where each lane sits, top to bottom.
 *
 * Exported because the painter and the hit-tester must agree to the pixel. Two
 * copies of this loop is how you get a clip that highlights on hover one row
 * above the one that actually moves, and the bug is invisible until somebody
 * drags the wrong thing.
 */
/** One place that decides how tall a lane is, so the painter and the hit-tester
    cannot disagree about which row the pointer is in. */
export const laneHeight = (track) => (track.kind === "audio" ? AUDIO_H : track.kind === "graphic" ? GRAPHIC_H : VIDEO_H);

export function lanesOf(cut) {
	const lanes = [];
	let y = RULER_H + ROW_GAP;
	for (const track of cut.tracks ?? []) {
		const h = laneHeight(track);
		lanes.push({ track, y, h });
		y += h + ROW_GAP;
	}
	return lanes;
}

/** How tall the whole thing wants to be for a given cut. */
export function heightFor(cut) {
	const last = lanesOf(cut).at(-1);
	return last ? last.y + last.h + ROW_GAP : RULER_H + ROW_GAP;
}

/*
 * A tick every 1, 5, 10, 30 or 60 seconds — whichever first gives ticks far
 * enough apart to read. Fixed intervals rather than a computed "nice" number,
 * because a ruler that relabels itself continuously while you zoom is harder to
 * read than one that steps.
 */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];
function tickStep(pxPerSecond) {
	for (const step of STEPS) if (step * pxPerSecond >= 64) return step;
	return STEPS.at(-1);
}

const clock = (seconds) => {
	const s = Math.max(0, seconds);
	const m = Math.floor(s / 60);
	const rest = Math.floor(s % 60);
	return `${m}:${String(rest).padStart(2, "0")}`;
};

/**
 * Which cached frame covers a moment in a take, never one past the end.
 *
 * Shared by the painter and the loader on purpose: if they disagree about which
 * frame a slot wants, the loader fetches one image and the painter asks for
 * another, and every slot is empty for reasons that look like a network problem.
 */
const frameIndex = (seconds, source) => {
	const raw = Math.max(0, Math.round(seconds / (source?.interval || 0.5)));
	return source?.count ? Math.min(raw, source.count - 1) : raw;
};

/*
 * The filmstrip along a clip.
 *
 * Only the frames that land inside the clip's own in/out are drawn, and only
 * those whose slot is on screen — a two-minute take cached every half second is
 * two hundred and forty frames, and a clip showing four seconds of it should
 * cost four. Frames are drawn at their natural aspect and clipped by the clip's
 * box, so a trim reveals more of the strip rather than restretching it.
 */
function drawStrip(ctx, { clip, source, images, x, y, w, h, view }) {
	if (!source?.interval || w <= 2) return;
	const slot = SLOT_W;
	/*
	 * Walk the clip in frame-wide slots and pick the nearest cached frame for
	 * each, rather than placing every cached frame at its own moment.
	 *
	 * Placing by moment is the obvious reading of "filmstrip" and it is wrong at
	 * any zoom where a frame is wider than its interval: at 90px/s a half-second
	 * frame is 45px apart and 131px wide, so each one paints over two thirds of
	 * the last and the strip reads as grey vertical stripes instead of faces.
	 *
	 * Slots tile by construction, so a frame is always whole and legible, and
	 * zooming in shows more distinct frames rather than more overlap.
	 */
	for (let sx = Math.max(x, HEAD_W - slot); sx < x + w; sx += slot) {
		const t = xToTime(view, sx + slot / 2) - clip.at + clip.in;
		/* Held at the last cached frame rather than left blank. A slot near the
		   very end of a take rounds to an index one past the strip, and a missing
		   image there shows the lane colour through the clip — which reads as a
		   hole in the footage rather than as the end of it. */
		const index = frameIndex(t, source);
		const img = images.get(`${clip.source}:${index}`);
		if (img?.complete && img.naturalWidth) ctx.drawImage(img, sx, y, slot, h);
	}
}

/*
 * The waveform, from peaks rather than audio.
 *
 * Two numbers per bucket, and a bucket is 1/PEAKS_PER_SECOND of a second — far
 * finer than a pixel at any zoom we draw, so several buckets collapse into each
 * column and the loudest of them wins. Taking the extreme rather than the mean
 * is what keeps a transient visible when it is one pixel wide.
 */
function drawWave(ctx, { clip, peaks, rate, x, y, w, h, view, colour }) {
	if (!peaks?.length || w <= 1) return;
	const mid = y + h / 2;
	const half = h / 2 - 2;
	ctx.fillStyle = colour;
	const from = Math.max(x, HEAD_W);
	const to = x + w;
	for (let px = Math.floor(from); px < to; px += 1) {
		const t = xToTime(view, px) - clip.at + clip.in;
		const a = Math.floor(t * rate) * 2;
		const b = Math.floor((xToTime(view, px + 1) - clip.at + clip.in) * rate) * 2;
		let min = 0;
		let max = 0;
		for (let i = a; i <= b && i + 1 < peaks.length; i += 2) {
			if (peaks[i] < min) min = peaks[i];
			if (peaks[i + 1] > max) max = peaks[i + 1];
		}
		if (min === 0 && max === 0) continue;
		ctx.fillRect(px, mid - max * half, 1, Math.max(1, (max - min) * half));
	}
}

/*
 * A rounded rect path, because every box in here has the same corner.
 *
 * Guarded, because a clip can be narrower than a pixel and the maths does not
 * care. `arcTo` throws on a negative radius, and the throw takes the whole paint
 * with it — one clip trimmed to its one-frame minimum at a low zoom, and the
 * timeline stops drawing entirely rather than drawing that clip badly. A minimum
 * width of one pixel is also the honest picture: the clip is still there.
 */
function boxPath(ctx, x, y, w, h, r = 4) {
	const box = { w: Math.max(1, w), h: Math.max(1, h) };
	const rad = Math.max(0, Math.min(r, box.w / 2, box.h / 2));
	w = box.w;
	h = box.h;
	ctx.beginPath();
	ctx.moveTo(x + rad, y);
	ctx.arcTo(x + w, y, x + w, y + h, rad);
	ctx.arcTo(x + w, y + h, x, y + h, rad);
	ctx.arcTo(x, y + h, x, y, rad);
	ctx.arcTo(x, y, x + w, y, rad);
	ctx.closePath();
}

/**
 * Paint the whole timeline.
 *
 * Everything it needs is passed in: the cut, the resolved palette, the view, the
 * loaded filmstrip images and peak arrays. No fetching, no state, no clock — so
 * the same call draws a live editor and a fixture in a test, and the two cannot
 * diverge.
 */
export function paintTimeline(canvas, { cut, palette, view, images, peaks, playhead = 0, selection = null }) {
	const ratio = window.devicePixelRatio || 1;
	const cssW = canvas.clientWidth;
	const cssH = heightFor(cut);
	if (canvas.width !== Math.round(cssW * ratio) || canvas.height !== Math.round(cssH * ratio)) {
		canvas.width = Math.round(cssW * ratio);
		canvas.height = Math.round(cssH * ratio);
		canvas.style.height = `${cssH}px`;
	}
	const ctx = canvas.getContext("2d");
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	ctx.clearRect(0, 0, cssW, cssH);
	ctx.fillStyle = palette.ink;
	ctx.fillRect(0, 0, cssW, cssH);

	/* Ruler. Drawn first and full width so every track sits under its own time. */
	ctx.font = '11px ui-monospace, Menlo, monospace';
	ctx.textBaseline = "middle";
	const step = tickStep(view.pxPerSecond);
	const firstTick = Math.floor(view.scrollSeconds / step) * step;
	const lastTime = xToTime(view, cssW);
	for (let t = firstTick; t <= lastTime; t += step) {
		const x = timeToX(view, t);
		if (x < HEAD_W) continue;
		ctx.fillStyle = palette.line;
		ctx.fillRect(Math.round(x) + 0.5, RULER_H - 6, 1, 6);
		ctx.fillStyle = palette.muted;
		ctx.fillText(clock(t), Math.round(x) + 5, RULER_H / 2);
	}
	ctx.fillStyle = palette.line;
	ctx.fillRect(HEAD_W, RULER_H - 1, cssW - HEAD_W, 1);

	for (const { track, y, h } of lanesOf(cut)) {
		/* The lane, then its head. The head is opaque and drawn last so a clip
		   scrolled under it disappears behind the label rather than over it. */
		ctx.fillStyle = palette.panel;
		ctx.fillRect(HEAD_W, y, cssW - HEAD_W, h);

		for (const clip of track.clips ?? []) {
			const x = timeToX(view, clip.at);
			const w = ((clip.out ?? 0) - (clip.in ?? 0)) * view.pxPerSecond;
			if (x + w < HEAD_W || x > cssW) continue;
			const source = cut.sources?.[clip.source];

			ctx.save();
			boxPath(ctx, x, y + 1, w, h - 2);
			ctx.clip();
			ctx.fillStyle = palette.accentSoft;
			ctx.fillRect(x, y + 1, w, h - 2);
			if (track.kind === "graphic" || !clip.source) {
				/*
				 * A hatch, not a filmstrip.
				 *
				 * There is no footage to show and a flat block reads as an empty
				 * lane. Diagonal stripes are what every editor uses for a clip
				 * with no picture, and they make its length legible at a glance
				 * even where the name has run out of room.
				 */
				ctx.fillStyle = palette.accentSoft;
				ctx.fillRect(x, y + 1, w, h - 2);
				ctx.strokeStyle = "rgba(255,255,255,.07)";
				ctx.lineWidth = 1;
				for (let hx = x - h; hx < x + w; hx += 9) {
					ctx.beginPath();
					ctx.moveTo(hx, y + h - 1);
					ctx.lineTo(hx + h, y + 1);
					ctx.stroke();
				}
			} else if (track.kind === "audio") {
				const data = peaks.get(clip.source);
				drawWave(ctx, { clip, peaks: data?.peaks, rate: data?.rate ?? 100, x, y, w, h, view, colour: palette.accent });
			} else {
				drawStrip(ctx, { clip, source: { ...source, interval: source?.interval ?? 0.5 }, images, x, y: y + 1, w, h: h - 2, view });
			}
			/* The name last and over a scrim, so it stays readable on a bright
			   frame — the same reason the kind pill on a card has one. */
			ctx.fillStyle = "rgba(0,0,0,.55)";
			ctx.fillRect(x, y + h - 17, Math.min(w, 200), 16);
			ctx.fillStyle = palette.text;
			ctx.fillText(String(clip.name ?? clip.id), x + 6, y + h - 9);
			ctx.restore();

			ctx.strokeStyle = selection === clip.id ? palette.accent : palette.line;
			ctx.lineWidth = selection === clip.id ? 2 : 1;
			boxPath(ctx, x + 0.5, y + 1.5, w - 1, h - 3);
			ctx.stroke();
		}

		/*
		 * A dissolve, drawn where the overlap is.
		 *
		 * Two triangles meeting, which is the shape every editor uses for this —
		 * and it is drawn from the overlap rather than from a stored property,
		 * so it cannot claim a transition the timeline does not actually have.
		 */
		const ordered = [...(track.clips ?? [])].sort((a, b) => a.at - b.at);
		for (let i = 0; i < ordered.length - 1; i += 1) {
			const end = ordered[i].at + (ordered[i].out - ordered[i].in);
			const over = end - ordered[i + 1].at;
			if (over <= 0) continue;
			const x0 = timeToX(view, ordered[i + 1].at);
			const x1 = timeToX(view, end);
			ctx.fillStyle = "rgba(255,255,255,.16)";
			ctx.beginPath();
			ctx.moveTo(x0, y + h - 1);
			ctx.lineTo(x1, y + 1);
			ctx.lineTo(x1, y + h - 1);
			ctx.closePath();
			ctx.fill();
			ctx.strokeStyle = palette.accent;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x0, y + h - 1);
			ctx.lineTo(x1, y + 1);
			ctx.stroke();
		}

		ctx.fillStyle = palette.ink;
		ctx.fillRect(0, y, HEAD_W, h);
		ctx.fillStyle = palette.text;
		ctx.font = '12px ui-monospace, Menlo, monospace';
		ctx.fillText(track.id.toUpperCase(), 12, y + h / 2);
		ctx.font = '11px ui-monospace, Menlo, monospace';
	}

	/* The playhead over everything, including the heads — it is the one thing
	   that is always true regardless of which lane you are reading. */
	const px = Math.round(timeToX(view, playhead)) + 0.5;
	if (px >= HEAD_W) {
		ctx.strokeStyle = palette.accent;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(px, 0);
		ctx.lineTo(px, cssH);
		ctx.stroke();
		ctx.fillStyle = palette.accent;
		ctx.beginPath();
		ctx.moveTo(px - 5, 0);
		ctx.lineTo(px + 5, 0);
		ctx.lineTo(px, 8);
		ctx.closePath();
		ctx.fill();
	}
}

/**
 * Which filmstrip frames a view actually needs.
 *
 * The loader asks this rather than fetching a whole strip: a clip showing four
 * seconds of a two-minute take needs eight images, not two hundred and forty,
 * and the difference is the difference between a timeline that opens and one
 * that thinks about it.
 */
export function framesInView(cut, view, widthPx) {
	const want = [];
	const seen = new Set();
	for (const track of cut.tracks ?? []) {
		if (track.kind !== "video") continue;
		for (const clip of track.clips ?? []) {
			if (!clip.source) continue;
			const source = cut.sources?.[clip.source];
			const interval = source?.interval ?? 0.5;
			const x = timeToX(view, clip.at);
			const w = (clip.out - clip.in) * view.pxPerSecond;
			if (x + w < HEAD_W || x > widthPx) continue;
			/* The same slot walk the painter does, so the loader fetches exactly
			   the frames that will be drawn and not one more. */
			for (let sx = Math.max(x, HEAD_W - SLOT_W); sx < Math.min(x + w, widthPx); sx += SLOT_W) {
				const t = xToTime(view, sx + SLOT_W / 2) - clip.at + clip.in;
				const index = frameIndex(t, { interval, count: source?.count });
				const key = `${clip.source}:${index}`;
				if (seen.has(key)) continue;
				seen.add(key);
				want.push({ source: clip.source, index });
			}
		}
	}
	return want;
}
