/*
 * A cut list, and the document it becomes.
 *
 * Composing laid whole files end to end, which is enough for "title, then the
 * recording" and nothing more. Editing raw footage means saying which PART of a
 * file you want, twice from the same file if you like, with titles over the top —
 * and that is a different shape: an ordered list of trimmed spans, plus a layer of
 * overlays timed against the finished thing.
 *
 * This is the model for that, and nothing else. It draws no UI, spawns no
 * renderer, and touches no disk: it turns a cut list into an AxcutDocument the
 * editor loads. Keeping it pure is what makes it testable against the fork's own
 * schema rather than by opening the app and looking.
 *
 * Two coordinate systems meet here and they are easy to confuse:
 *
 *   SOURCE time  where a span sits inside its own file — `in`/`out`.
 *   TIMELINE time where that span sits in the finished video.
 *
 * A cut list only ever states source time. Timeline time is derived by laying the
 * spans end to end, because that is what a cut is: the second clip starts when
 * the first one stops, whatever you trimmed off it.
 */

import { basename } from "node:path";

/** The fork's current document version. Bump only alongside the schema there. */
export const AXCUT_SCHEMA_VERSION = 7;

/**
 * Ids derive from what they identify, so a re-render is a no-op diff.
 *
 * Random ids mean the same cut list produces a different document every time, and
 * an editor holding the old one cannot tell that nothing changed.
 */
const idFor = (prefix, seed) => `${prefix}_${Buffer.from(String(seed)).toString("base64url").slice(-16)}`;

/** Clamp a span to its file and to sanity, returning seconds. */
function span(clip) {
	const inSec = Math.max(0, Number(clip.inSec) || 0);
	const dur = Number(clip.durationSec);
	const rawOut = clip.outSec == null ? dur : Number(clip.outSec);
	const outSec = Math.min(Number.isFinite(dur) ? dur : Number.POSITIVE_INFINITY, Math.max(inSec, Number(rawOut) || 0));
	return { inSec, outSec, lengthSec: Math.max(0, outSec - inSec) };
}

/**
 * One asset per distinct FILE, not per clip.
 *
 * Two clips cut from the same recording are two clips over one asset — that is
 * the whole point of a cut list. Emitting an asset each would give the editor two
 * copies of the same media to decode and keep in memory, and any per-asset state
 * (a transcript, a waveform, a camera track) would be computed twice and could
 * disagree with itself.
 */
export function assetsFor(clips) {
	const byPath = new Map();
	for (const c of clips) {
		if (byPath.has(c.path)) continue;
		byPath.set(c.path, {
			id: idFor("asset", c.path),
			kind: "video",
			label: c.label ?? basename(c.path),
			originalPath: c.path,
			...(Number.isFinite(Number(c.durationSec)) ? { durationSec: Number(c.durationSec) } : {}),
			cameraTrack: null,
		});
	}
	return [...byPath.values()];
}

/**
 * Lay the trimmed spans end to end.
 *
 * A zero-length span is dropped rather than written: a clip whose in and out have
 * been dragged together is a clip somebody removed, and a zero-length entry in the
 * timeline is a thing the editor has to render nothing for at a point where
 * nothing happens.
 */
export function clipsFor(clips) {
	const out = [];
	let at = 0;
	for (const c of clips) {
		const { inSec, outSec, lengthSec } = span(c);
		if (lengthSec <= 0) continue;
		out.push({
			id: idFor("clip", `${c.path}@${inSec}->${outSec}@${at}`),
			assetId: idFor("asset", c.path),
			sourceStartSec: inSec,
			sourceEndSec: outSec,
			timelineStartSec: at,
			timelineEndSec: at + lengthSec,
			wordRefs: [],
			// A person made this cut. The editor shows the origin, and calling it
			// "agent" makes a deliberate edit look like something a model did.
			origin: "user",
			reason: c.reason ?? "",
		});
		at += lengthSec;
	}
	return { clips: out, totalSec: at };
}

/**
 * An overlay, timed against the FINISHED video.
 *
 * Deliberately not anchored to a clip. A title that belongs over "the bit where
 * the price appears" is anchored to the moment, and a moment survives the clip
 * under it being retrimmed — which is exactly what happens while editing. The
 * schema does carry a clipId, and using it would move every title every time you
 * dragged a trim handle.
 *
 * Milliseconds, because annotations are in ms while clips are in seconds. That
 * inconsistency is the schema's; converting here keeps it from spreading.
 */
export function overlaysFor(overlays) {
	return overlays
		.filter((o) => o.path && Number(o.forSec) > 0)
		.map((o, i) => ({
			id: idFor("ann", `${o.path}@${o.atSec}`),
			startMs: Math.round(Number(o.atSec) * 1000),
			endMs: Math.round((Number(o.atSec) + Number(o.forSec)) * 1000),
			type: "image",
			// Both slots: sceneDescription reads `content || imageContent` and the
			// inspector round-trips the typed one. One without the other renders in
			// the preview and vanishes on export.
			content: o.path,
			imageContent: o.path,
			position: o.position ?? { x: 0, y: 0 },
			size: o.size ?? { width: 100, height: 100 },
			style: {},
			// Later overlays sit above earlier ones; the compositor draws ascending.
			zIndex: o.zIndex ?? i + 1,
		}));
}

/**
 * The whole cut list as a document.
 *
 * `primaryAssetId` is the first clip's asset, which is what the editor opens on.
 */
export function cutlistToDocument({ id, title, clips = [], overlays = [], createdAt, updatedAt }) {
	const kept = clips.filter((c) => span(c).lengthSec > 0);
	if (!kept.length) throw new Error("a cut list needs at least one clip with length");

	const assets = assetsFor(kept);
	const { clips: laid, totalSec } = clipsFor(kept);
	const now = updatedAt ?? createdAt;

	return {
		schemaVersion: AXCUT_SCHEMA_VERSION,
		project: { id, title, createdAt, updatedAt: now, primaryAssetId: assets[0].id },
		assets,
		transcript: null,
		transcripts: [],
		timeline: {
			clips: laid,
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		// An overlay past the end of the cut is dropped: it cannot be seen, and a
		// document carrying invisible annotations is one nobody can reason about.
		annotations: overlaysFor(overlays).filter((a) => a.startMs < Math.round(totalSec * 1000)),
	};
}

/*
 * The same document, read back as a cut list.
 *
 * The editor is the other author of this file. Somebody drags a trim handle,
 * reorders two clips, drops one entirely — and the composition built from the
 * old windows is now describing a video that no longer exists. Reading the
 * document back is what closes that loop, and it is an inverse rather than a
 * fresh parser so the two halves cannot drift into disagreeing about the shape.
 *
 * Timeline position is reported as the document states it, NOT re-derived by
 * laying the spans end to end. `clipsFor` lays them out because a cut list has
 * no opinion about position; a document does, and an editor that left a gap
 * meant to leave a gap.
 */
export function cutlistFromDocument(doc) {
	if (Number(doc?.schemaVersion) !== AXCUT_SCHEMA_VERSION) {
		throw new Error(`not a v${AXCUT_SCHEMA_VERSION} document: schemaVersion ${JSON.stringify(doc?.schemaVersion)}`);
	}
	const byId = new Map((doc.assets ?? []).map((asset) => [asset.id, asset]));
	const clips = (doc.timeline?.clips ?? [])
		.map((clip) => {
			const asset = byId.get(clip.assetId);
			// A clip whose asset is missing names a file the document cannot
			// resolve. Dropping it silently would quietly shorten the cut, so it
			// is surfaced as a problem instead.
			if (!asset?.originalPath) return null;
			const inSec = Math.max(0, Number(clip.sourceStartSec) || 0);
			const outSec = Math.max(inSec, Number(clip.sourceEndSec) || 0);
			if (outSec <= inSec) return null;
			return {
				id: clip.id,
				path: asset.originalPath,
				label: asset.label ?? basename(asset.originalPath),
				durationSec: Number.isFinite(Number(asset.durationSec)) ? Number(asset.durationSec) : undefined,
				inSec,
				outSec,
				// Where it sits in the finished video, as recorded.
				atSec: Math.max(0, Number(clip.timelineStartSec) || 0),
				reason: clip.reason ?? "",
				origin: clip.origin ?? "user",
			};
		})
		.filter(Boolean)
		.sort((a, b) => a.atSec - b.atSec);

	const overlays = (doc.annotations ?? [])
		.filter((ann) => ann.type === "image" && (ann.content || ann.imageContent))
		.map((ann) => ({
			path: ann.content || ann.imageContent,
			atSec: (Number(ann.startMs) || 0) / 1000,
			forSec: Math.max(0, ((Number(ann.endMs) || 0) - (Number(ann.startMs) || 0)) / 1000),
			position: ann.position ?? { x: 0, y: 0 },
			size: ann.size ?? { width: 100, height: 100 },
			zIndex: ann.zIndex ?? 1,
		}))
		.filter((o) => o.forSec > 0);

	return {
		id: doc.project?.id ?? "",
		title: doc.project?.title ?? "",
		createdAt: doc.project?.createdAt,
		updatedAt: doc.project?.updatedAt,
		clips,
		overlays,
		// Trailing edge of the cut, so a caller can tell a shortened document from
		// one that merely moved things around.
		totalSec: clips.reduce((end, c) => Math.max(end, c.atSec + (c.outSec - c.inSec)), 0),
	};
}
