/**
 * Branded annotation and zoom builders for OpenScreen projects.
 *
 * OpenScreen annotations are free-form: position, size, and a text style bag.
 * That freedom is exactly why demos drift — every recording invents its own
 * lower-third. These builders fix the type scale, colour, and placement so a
 * craftsman (or an agent) asks for "a lower third saying X" and gets the same
 * thing every time.
 *
 * Coordinates are percentages of the composed frame. Font sizes are pixels
 * against a 1920x1080 canvas — pass `scale` for other output sizes.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(await readFile(resolve(HERE, "../brand/tokens.json"), "utf8"));
const { palette, type, annotationScale } = tokens;

let counter = 0;
const nextId = (prefix) => `rm-${prefix}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

function style(overrides = {}) {
	return {
		color: palette.light,
		backgroundColor: "transparent",
		fontSize: annotationScale.callout,
		fontFamily: type.display,
		fontWeight: "bold",
		fontStyle: "normal",
		textDecoration: "none",
		textAlign: "left",
		...overrides,
	};
}

function text({ content, startMs, endMs, position, size, style: s, zIndex = 1 }) {
	return {
		id: nextId("ann"),
		startMs,
		endMs,
		type: "text",
		content,
		textContent: content,
		position,
		size,
		style: s,
		zIndex,
	};
}

/**
 * Full-width title over the capture. Use at the head of a demo, not mid-flow.
 * `eyebrow` renders in mono above the title, per the brand's eyebrow convention.
 */
export function title({ text: body, eyebrow, startMs = 0, endMs = 3200, scale = 1 }) {
	const out = [];
	if (eyebrow) {
		out.push(
			text({
				content: eyebrow.toUpperCase(),
				startMs,
				endMs,
				position: { x: 8, y: 34 },
				size: { width: 60, height: 6 },
				style: style({
					fontSize: annotationScale.eyebrow * scale,
					fontFamily: type.mono,
					fontWeight: "normal",
					color: palette.primary,
				}),
				zIndex: 3,
			}),
		);
	}
	out.push(
		text({
			content: body,
			startMs,
			endMs,
			position: { x: 8, y: 42 },
			size: { width: 78, height: 18 },
			style: style({
				fontSize: annotationScale.title * scale,
				textAnimation: "fade",
			}),
			zIndex: 3,
		}),
	);
	return out;
}

/**
 * Lower third. Title line plus optional subtitle, bottom-left, out of the way
 * of most app chrome. Two regions rather than one so the type scale is real.
 */
export function lowerThird({ name, sub, startMs, endMs, scale = 1 }) {
	const out = [
		text({
			content: name,
			startMs,
			endMs,
			position: { x: 6, y: 74 },
			size: { width: 46, height: 8 },
			style: style({
				fontSize: annotationScale.lowerThirdTitle * scale,
				textAnimation: "slide-up",
			}),
			zIndex: 2,
		}),
	];
	if (sub) {
		out.push(
			text({
				content: sub,
				startMs,
				endMs,
				position: { x: 6, y: 82 },
				size: { width: 46, height: 6 },
				style: style({
					fontSize: annotationScale.lowerThirdSub * scale,
					fontFamily: type.mono,
					fontWeight: "normal",
					color: palette.tertiary,
				}),
				zIndex: 2,
			}),
		);
	}
	return out;
}

/**
 * Callout pinned near a point of interest. `at` is the frame position the text
 * sits beside — pair it with `zoomTo` at the same coordinates for the standard
 * "zoom in and name the thing" beat.
 */
export function callout({
	text: body,
	at = { x: 50, y: 50 },
	startMs,
	endMs,
	accent = palette.primary,
	scale = 1,
}) {
	const x = Math.min(Math.max(at.x - 16, 3), 64);
	const y = Math.min(Math.max(at.y + 8, 5), 88);
	return [
		text({
			content: body,
			startMs,
			endMs,
			position: { x, y },
			size: { width: 33, height: 9 },
			style: style({
				fontSize: annotationScale.callout * scale,
				color: palette.light,
				backgroundColor: accent,
				textAlign: "center",
				textAnimation: "pop",
			}),
			zIndex: 4,
		}),
	];
}

/** Persistent brand mark, bottom-right, matching the HyperFrames logo placement. */
export function watermark({ text: body = "RoleModel Software", startMs = 0, endMs, scale = 1 }) {
	return [
		text({
			content: body,
			startMs,
			endMs,
			position: { x: 74, y: 90 },
			size: { width: 24, height: 5 },
			style: style({
				fontSize: annotationScale.eyebrow * scale,
				fontFamily: type.mono,
				fontWeight: "normal",
				color: palette.light,
				textAlign: "right",
			}),
			zIndex: 5,
		}),
	];
}

/**
 * Zoom beat. Depth is 1–6; 3 is the house default — enough to read a form field
 * without the surrounding context falling away.
 *
 * Zooms shorter than ~1.2s read as a twitch rather than emphasis, so the
 * builder enforces a floor.
 */
export function zoomTo({ at = { x: 0.5, y: 0.5 }, startMs, endMs, depth = 3 }) {
	const MIN_MS = 1200;
	const end = Math.max(endMs, startMs + MIN_MS);
	return {
		id: nextId("zoom"),
		startMs,
		endMs: end,
		depth,
		focus: { cx: at.x, cy: at.y },
		focusMode: "manual",
		source: "manual",
	};
}

/**
 * House zoom rhythm for a demo: hold wide, push in on each beat, release.
 * `beats` are `{ atMs, at: {x,y}, holdMs?, depth? }`.
 */
export function zoomRhythm(beats, { holdMs = 2600, depth = 3 } = {}) {
	return beats.map((b) =>
		zoomTo({
			at: b.at ?? { x: 0.5, y: 0.5 },
			startMs: b.atMs,
			endMs: b.atMs + (b.holdMs ?? holdMs),
			depth: b.depth ?? depth,
		}),
	);
}

export const brand = { palette, type, annotationScale };
