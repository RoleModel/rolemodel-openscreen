/**
 * Trim a clip to the speech in it, from the transcript that already exists.
 *
 * Every silence in the CCC Days cut came from one default: a take spanned its
 * whole file. Jamey's clip carried 49.6s of him sitting still after his last
 * word, and the transcript had said "speech ends at 18.0s" all along. Nothing
 * errored; the render simply contained a minute of nobody talking, and the
 * only way to find out was to watch it.
 *
 * These are pure functions over the transcript's word list — `{ id, text,
 * startSec, endSec }` as `lib/paper-edit.mjs` stores it — so they can be run
 * from the assembly builder, a CLI, or a test without touching disk.
 *
 * Two rules keep this from second-guessing an editor:
 *
 *   - It only ever TIGHTENS. A clip edge that somebody placed inside the file
 *     is a decision; only an edge sitting on the file's own boundary (the
 *     whole-file default) is moved, and only inward.
 *   - It never trusts the transcript past the file. Caption-timed transcripts
 *     interpolate word times inside each cue, and a trailing cue can run past
 *     the end of a recording that was trimmed on disk afterwards.
 */

/** A word that carries speech, as opposed to a `-` or `…` the transcriber emitted. */
const spoken = (word) => /[\p{L}\p{N}]/u.test(String(word?.text ?? ""));

const timed = (word) => Number.isFinite(Number(word?.startSec)) && Number.isFinite(Number(word?.endSec));

/** First word to last word, in seconds, or null when nothing was said. */
export function speechSpan(words) {
	const said = (Array.isArray(words) ? words : []).filter((word) => spoken(word) && timed(word));
	if (!said.length) return null;
	return {
		startSec: Math.min(...said.map((word) => Number(word.startSec))),
		endSec: Math.max(...said.map((word) => Number(word.endSec))),
		words: said.length,
	};
}

/**
 * Tighten a clip's in and out points to its speech.
 *
 * `clip` is `{ mediaStartMs, durationMs }` as the assembly builder holds it;
 * `sourceMs` is the probed length of the file (0 when unknown — then the tail
 * is left alone, because "sits on the end of the file" cannot be decided).
 *
 * Returns the adjusted clip and a `trimmed` record of what moved, or
 * `trimmed: null` when nothing did. `leadMs` is the room kept before the first
 * word, `tailMs` the breath kept after the last one.
 */
export function trimToSpeech(clip, words, sourceMs = 0, { leadMs = 250, tailMs = 500, edgeMs = 60, minGainMs = 150 } = {}) {
	const mediaStartMs = Math.max(0, Math.round(Number(clip?.mediaStartMs) || 0));
	const durationMs = Math.max(0, Math.round(Number(clip?.durationMs) || 0));
	const untouched = { mediaStartMs, durationMs, trimmed: null };
	const span = speechSpan(words);
	if (!span || durationMs <= 0) return untouched;

	const source = Math.max(0, Math.round(Number(sourceMs) || 0));
	const endMs = mediaStartMs + durationMs;
	const onHead = mediaStartMs <= edgeMs;
	const onTail = source > 0 && endMs >= source - edgeMs;

	let start = mediaStartMs;
	if (onHead) {
		const speechStart = Math.round(span.startSec * 1000) - leadMs;
		if (speechStart - mediaStartMs >= minGainMs) start = speechStart;
	}

	let end = endMs;
	if (onTail) {
		const speechEnd = Math.round(span.endSec * 1000) + tailMs;
		if (endMs - speechEnd >= minGainMs) end = speechEnd;
	}
	if (source > 0) end = Math.min(end, source);

	// A transcript that disagrees with the picture this badly is not evidence.
	if (end - start < 500) return untouched;
	if (start === mediaStartMs && end === endMs) return untouched;

	return {
		mediaStartMs: start,
		durationMs: end - start,
		trimmed: { headMs: start - mediaStartMs, tailMs: endMs - end },
	};
}

/**
 * Words that open a take without saying anything.
 *
 * Matched on the whole first word after punctuation is stripped, so "Okay,"
 * and "okay." both count and "okayed" does not.
 */
export const FILLERS = new Set(["okay", "ok", "alright", "so", "um", "uh", "er", "erm", "hmm", "mm", "yeah", "well", "right", "anyway", "anyways"]);

const bare = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * The filler a clip opens on, if it opens on one.
 *
 * `inSec` is the clip's in point in source time. The clip "opens on" the first
 * spoken word that ends after that point. Finding the filler is mechanical;
 * cutting it is an editorial call — so this returns a suggestion, with the
 * point to trim to, and never applies it.
 */
export function leadingFiller(words, inSec = 0, { windowSec = 0.6 } = {}) {
	const said = (Array.isArray(words) ? words : []).filter((word) => spoken(word) && timed(word)).sort((a, b) => a.startSec - b.startSec);
	const from = Number(inSec) || 0;
	const index = said.findIndex((word) => Number(word.endSec) > from);
	if (index === -1) return null;
	const first = said[index];
	// The clip starts well before the word: whatever it opens on, it is not this.
	if (Number(first.startSec) - from > windowSec) return null;
	if (!FILLERS.has(bare(first.text))) return null;
	const next = said[index + 1];
	// A lone filler is the whole clip; there is nothing to trim it off the front of.
	if (!next) return null;
	return {
		id: first.id ?? null,
		text: String(first.text),
		startSec: Number(first.startSec),
		endSec: Number(first.endSec),
		trimToSec: Number(first.endSec),
		followedBy: String(next.text),
	};
}
