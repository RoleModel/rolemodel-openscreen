/*
 * Put a title into a recording that already exists.
 *
 * Composing builds a video out of parts from nothing. This is the other half and
 * the one that was actually being asked for: a capture you already have, with a
 * title card dropped in at the front, or between two moments, without rebuilding
 * the whole thing.
 *
 * It writes the document rather than asking the editor to do it. `insert_asset_clip`
 * is declared in the fork's schema — assetId, beforeClipId, afterClipId, a source
 * range — and implemented NOWHERE: no applier, no caller, no UI. The operation can
 * be described and nothing performs it. A document with the clip already in its
 * timeline needs none of that, because loading a timeline is the one thing the
 * editor definitely does.
 *
 * The output is an AxcutDocument (schemaVersion 7), not the legacy v2 shape. v2
 * names a single `screenVideoPath` and has no clip list at all, so it cannot
 * express "these two things, in this order" — which is the whole point here.
 */

import { basename } from "node:path";

/** The fork's current document version. Bump only alongside the schema there. */
export const AXCUT_SCHEMA_VERSION = 7;

/**
 * Ids are stable for the same inputs.
 *
 * A random id per run means re-inserting the same title produces a document that
 * diffs against its predecessor everywhere, and an editor that has the old one
 * open cannot tell the two apart. Deriving from the path keeps a re-run idempotent.
 */
const idFor = (prefix, seed) => `${prefix}_${Buffer.from(seed).toString("base64url").slice(-16)}`;

/** One video file as a document asset. */
export function assetFor(path, { durationSec, label } = {}) {
	return {
		id: idFor("asset", path),
		kind: "video",
		label: label ?? basename(path),
		originalPath: path,
		...(durationSec == null ? {} : { durationSec }),
		cameraTrack: null,
	};
}

/**
 * Lay a list of pieces onto a timeline, end to end.
 *
 * `pieces` is [{ path, ms, label }] in order. Each becomes one asset and one clip
 * that plays the whole file. Times are seconds because the schema is in seconds;
 * everything upstream is in ms, and this is the one place that converts.
 */
export function timelineFor(pieces) {
	const assets = [];
	const clips = [];
	let at = 0;
	for (const piece of pieces) {
		const asset = assetFor(piece.path, { durationSec: piece.ms / 1000, label: piece.label });
		assets.push(asset);
		const sec = piece.ms / 1000;
		clips.push({
			id: idFor("clip", `${piece.path}@${at}`),
			assetId: asset.id,
			sourceStartSec: 0,
			sourceEndSec: sec,
			timelineStartSec: at,
			timelineEndSec: at + sec,
			wordRefs: [],
			// "user", not "agent": a person asked for this cut. The editor shows the
			// origin, and mislabelling it makes an edit look like something a model
			// did unprompted.
			origin: "user",
			reason: piece.reason ?? "",
		});
		at += sec;
	}
	return { assets, clips, totalSec: at };
}

/**
 * A document whose timeline is `pieces`, in order.
 *
 * `primaryAssetId` is the first piece, which is what the editor opens on. Putting
 * a title first therefore also changes the poster frame, which is usually what
 * somebody inserting a title wanted anyway.
 */
export function documentFor({ id, title, pieces, createdAt, updatedAt }) {
	if (!pieces.length) throw new Error("a document needs at least one piece");
	const { assets, clips } = timelineFor(pieces);
	const now = updatedAt ?? createdAt;
	return {
		schemaVersion: AXCUT_SCHEMA_VERSION,
		project: {
			id,
			title,
			createdAt,
			updatedAt: now,
			primaryAssetId: assets[0].id,
		},
		assets,
		transcript: null,
		transcripts: [],
		timeline: {
			clips,
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
	};
}

/**
 * Where a new piece goes, given the pieces already there.
 *
 * `atSec` is a position on the finished timeline. It lands on a boundary rather
 * than mid-clip: splitting a recording to fit a title in is a different edit with
 * different consequences (two clips from one asset, a cut nobody asked for), and
 * doing it silently because the number happened to fall inside a clip is how you
 * get a video with a hole in it. The nearest boundary is chosen and reported.
 */
export function insertAt(pieces, piece, atSec) {
	// No position means the front. A title card belongs before the thing it
	// titles, and appending it — which is what "no position" meant in the first
	// version — puts it after the video has finished, where nobody sees it.
	if (atSec == null) return [piece, ...pieces];
	let bound = 0;
	let index = 0;
	for (const [i, p] of pieces.entries()) {
		const end = bound + p.ms / 1000;
		// Closer to this clip's start than its end means "before this one".
		if (atSec <= bound + (end - bound) / 2) {
			index = i;
			break;
		}
		bound = end;
		index = i + 1;
	}
	const out = [...pieces];
	out.splice(index, 0, piece);
	// Where it actually landed, so a request that was moved says so. With one clip
	// there are only two boundaries, and asking for 40s of a 72s recording puts the
	// card at the end — correct, and surprising if nobody mentions it.
	out.landedAtSec = bound === 0 && index === 0 ? 0 : bound;
	return out;
}

/**
 * A still, laid OVER the video rather than cut into it.
 *
 * This is the way past the timeline's flat clip list. `timelineSchema` has no
 * layers and `assetSchema.kind` is `z.literal("video")`, so nothing that is not
 * video can sit above a clip — which is where "a title over the footage" kept
 * dying. But `document.annotations` already is a layer: it carries a time range,
 * a position and size in percent, a zIndex the compositor draws in ascending
 * order, and a `type: "image"` whose `content` is a path or a data URI. It
 * crosses the bridge to the native compositor in sceneDescription.ts, so it
 * survives export and is not a preview-only trick.
 *
 * The picture has to be transparent everywhere the design does not paint, or it
 * is a rectangle over the video rather than a title on it. See render-still.mjs.
 *
 * Full-frame by default: the card is composed at 1920×1080 with its own layout,
 * so the overlay is the whole frame and the transparency does the positioning.
 */
export function imageOverlay({ path, startMs, endMs, zIndex = 1, position, size }) {
	if (endMs <= startMs) throw new Error("an overlay needs a duration");
	return {
		id: idFor("ann", `${path}@${startMs}`),
		startMs,
		endMs,
		type: "image",
		// Both slots: sceneDescription reads `content || imageContent`, and the
		// inspector round-trips the typed slot. Writing one and not the other is
		// how an overlay renders in the preview and vanishes on export.
		content: path,
		imageContent: path,
		position: position ?? { x: 0, y: 0 },
		size: size ?? { width: 100, height: 100 },
		style: {},
		zIndex,
	};
}
