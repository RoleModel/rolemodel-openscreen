/*
 * Making the timeline editable.
 *
 * Three gestures and no more, because these are the three an edit is actually
 * made of: move a clip, trim an edge, scrub. Everything else — ripple, roll,
 * slip, razor — is a variation on them and can wait until these feel right.
 *
 * The rule this file follows is the model's: it changes `in`, `out` and `at` and
 * nothing else. There is no duration to keep in step, no end to recompute, no
 * transition field to update when two clips start overlapping — a dissolve is
 * what an overlap means, so dragging one clip onto another creates one and
 * dragging it away removes one, with nothing written down either time.
 *
 * It does not paint. It reports that something changed and lets the owner
 * decide when to draw, so a drag coalesces into one paint per frame rather than
 * one per mouse event — which is the difference between 60fps and whatever the
 * mouse happens to fire at.
 */
import { HEAD_W, lanesOf, RULER_H, timeToX, xToTime } from "./timeline-canvas.js";

/** How close to an edge counts as reaching for it, in pixels at any zoom. */
export const EDGE_PX = 7;
/** How close a drag has to come before it snaps, also in pixels. */
export const SNAP_PX = 8;

const clipSeconds = (clip) => Math.max(0, clip.out - clip.in);
const clipEnd = (clip) => clip.at + clipSeconds(clip);

/**
 * What is under the pointer: a clip and which part of it, or the ruler.
 *
 * Edges win over the body, and the last clip drawn wins over an earlier one —
 * both match what you see, since a later clip paints over an earlier one and an
 * edge is the thing you were obviously reaching for when you got close to it.
 */
export function hitTest(cut, view, x, y) {
	if (y <= RULER_H) return { kind: "ruler" };
	if (x < HEAD_W) return { kind: "head" };
	for (const lane of lanesOf(cut)) {
		if (y < lane.y || y > lane.y + lane.h) continue;
		const clips = lane.track.clips ?? [];
		for (let i = clips.length - 1; i >= 0; i -= 1) {
			const clip = clips[i];
			const left = timeToX(view, clip.at);
			const right = timeToX(view, clipEnd(clip));
			if (x < left - EDGE_PX || x > right + EDGE_PX) continue;
			if (Math.abs(x - left) <= EDGE_PX) return { kind: "trim-in", clip, track: lane.track };
			if (Math.abs(x - right) <= EDGE_PX) return { kind: "trim-out", clip, track: lane.track };
			return { kind: "move", clip, track: lane.track };
		}
	}
	return { kind: "empty" };
}

/*
 * Everything worth snapping to, in seconds.
 *
 * Other clips' edges and zero. The playhead too, because "cut here" is the
 * commonest thing anybody wants and it is tedious to hit by eye.
 *
 * The clip being dragged is excluded — a clip that snaps to its own edge cannot
 * be moved off it.
 */
function snapPoints(cut, moving, playhead) {
	const points = [0, playhead];
	for (const track of cut.tracks ?? []) {
		for (const clip of track.clips ?? []) {
			if (clip === moving) continue;
			points.push(clip.at, clipEnd(clip));
		}
	}
	return points;
}

/** Snap in pixel space, so the pull feels identical at every zoom. */
function snap(seconds, points, view) {
	let best = null;
	let bestPx = SNAP_PX;
	for (const point of points) {
		const px = Math.abs((seconds - point) * view.pxPerSecond);
		if (px <= bestPx) {
			bestPx = px;
			best = point;
		}
	}
	return best === null ? { seconds, snapped: null } : { seconds: best, snapped: best };
}

/**
 * Attach the three gestures to a canvas.
 *
 * `onChange` fires when the cut has been mutated; `onView` when only the
 * playhead or the hover moved. Both are advisory — the owner paints when it
 * likes. `commit` fires once at the end of a drag, which is where an undo entry
 * or a save belongs: one per gesture, not one per pixel.
 */
export function attachTimeline(canvas, opts) {
	const { cut, view, state, onChange = () => {}, onView = () => {}, commit = () => {} } = opts;

	/* Drag state lives here rather than in `state`, because it is about this
	   gesture and not about the cut — nothing outside needs to render it. */
	let drag = null;

	const pointAt = (event) => {
		const rect = canvas.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};

	const cursorFor = (hit) =>
		hit.kind === "trim-in" || hit.kind === "trim-out" ? "ew-resize" : hit.kind === "move" ? "grab" : hit.kind === "ruler" ? "col-resize" : "default";

	const onDown = (event) => {
		const { x, y } = pointAt(event);
		const hit = hitTest(cut, view, x, y);

		if (hit.kind === "ruler") {
			state.playhead = Math.max(0, xToTime(view, x));
			drag = { kind: "scrub" };
			onView();
			canvas.setPointerCapture(event.pointerId);
			return;
		}
		if (!hit.clip) {
			state.selection = null;
			onView();
			return;
		}

		state.selection = hit.clip.id;
		/* The grab offset, so a clip does not jump its own left edge to the
		   cursor the moment you touch it anywhere but that edge. */
		drag = {
			kind: hit.kind,
			clip: hit.clip,
			track: hit.track,
			grabbedAt: xToTime(view, x) - hit.clip.at,
			before: { in: hit.clip.in, out: hit.clip.out, at: hit.clip.at },
			points: snapPoints(cut, hit.clip, state.playhead),
			moved: false,
		};
		canvas.setPointerCapture(event.pointerId);
		canvas.style.cursor = hit.kind === "move" ? "grabbing" : cursorFor(hit);
		onView();
	};

	const onMove = (event) => {
		const { x, y } = pointAt(event);

		if (!drag) {
			const hit = hitTest(cut, view, x, y);
			const cursor = cursorFor(hit);
			if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
			const hovered = hit.clip?.id ?? null;
			if (state.hover !== hovered) {
				state.hover = hovered;
				onView();
			}
			return;
		}

		const t = xToTime(view, x);

		if (drag.kind === "scrub") {
			state.playhead = Math.max(0, t);
			onView();
			return;
		}

		const { clip } = drag;
		const source = cut.sources?.[clip.source];
		const limit = source?.seconds ?? Number.POSITIVE_INFINITY;
		/* A frame, as the smallest move and the smallest clip. Anything finer is
		   a number the render cannot show. */
		const frame = 1 / (cut.fps || 60);

		if (drag.kind === "move") {
			const wanted = t - drag.grabbedAt;
			const { seconds, snapped } = snap(wanted, drag.points, view);
			clip.at = Math.max(0, Number(seconds.toFixed(3)));
			state.snapped = snapped;
		} else if (drag.kind === "trim-in") {
			/*
			 * Trimming the head moves `in` and `at` together.
			 *
			 * The material has to stay where it is on the timeline — dragging the
			 * left edge right should reveal less of the take, not slide the whole
			 * clip. So both move by the same amount, and `out` never does.
			 */
			const { seconds, snapped } = snap(t, drag.points, view);
			const shift = seconds - drag.before.at;
			const nextIn = Math.min(Math.max(0, drag.before.in + shift), clip.out - frame);
			clip.at = Math.max(0, Number((drag.before.at + (nextIn - drag.before.in)).toFixed(3)));
			clip.in = Number(nextIn.toFixed(3));
			state.snapped = snapped;
		} else if (drag.kind === "trim-out") {
			const { seconds, snapped } = snap(t, drag.points, view);
			const wanted = drag.before.in + (seconds - drag.before.at);
			clip.out = Number(Math.min(Math.max(wanted, clip.in + frame), limit).toFixed(3));
			state.snapped = snapped;
		}

		drag.moved = true;
		onChange();
	};

	const onUp = (event) => {
		if (!drag) return;
		const finished = drag;
		drag = null;
		state.snapped = null;
		canvas.releasePointerCapture?.(event.pointerId);
		canvas.style.cursor = cursorFor(hitTest(cut, view, ...Object.values(pointAt(event))));
		/* One commit per gesture. A drag that never moved is a selection, and
		   turning a click into an undo entry is how undo stops being useful. */
		if (finished.moved && finished.kind !== "scrub") commit(finished);
		onView();
	};

	/*
	 * Wheel pans. Zoom is a modifier.
	 *
	 * Binding plain wheel to zoom looked reasonable and is wrong in use: a
	 * timeline is wider than the window, so scrolling is the thing you do
	 * constantly and zooming is occasional — and having taken the scroll gesture
	 * for zoom, there was then no way to move along the timeline at all. You
	 * could only zoom out until everything fit, which is not navigation.
	 *
	 * So: wheel scrolls, cmd or ctrl zooms, which is what a map, a canvas and
	 * every editor already taught everyone. A trackpad's horizontal delta pans
	 * too, so a two-finger swipe sideways works without a modifier.
	 */
	const onWheel = (event) => {
		event.preventDefault();
		if (event.ctrlKey || event.metaKey) {
			/* Keep the instant under the cursor under the cursor — a zoom that
			   drifts is a zoom you have to chase. */
			const at = xToTime(view, event.offsetX);
			const next = view.pxPerSecond * (event.deltaY < 0 ? 1.12 : 1 / 1.12);
			view.pxPerSecond = Math.min(400, Math.max(2, next));
			view.scrollSeconds = Math.max(0, at - (event.offsetX - HEAD_W) / view.pxPerSecond);
		} else {
			/* Whichever axis the device is actually reporting: a mouse sends only
			   deltaY, a trackpad sends both, and a timeline scrolls sideways. */
			const along = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
			view.scrollSeconds = Math.max(0, view.scrollSeconds + along / view.pxPerSecond);
		}
		onView();
	};
	canvas.addEventListener("wheel", onWheel, { passive: false });

	canvas.addEventListener("pointerdown", onDown);
	canvas.addEventListener("pointermove", onMove);
	canvas.addEventListener("pointerup", onUp);
	canvas.addEventListener("pointercancel", onUp);

	return {
		detach() {
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("pointerdown", onDown);
			canvas.removeEventListener("pointermove", onMove);
			canvas.removeEventListener("pointerup", onUp);
			canvas.removeEventListener("pointercancel", onUp);
		},
	};
}
