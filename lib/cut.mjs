/*
 * The cut: what the video is, as data.
 *
 * One rule decides the shape of this file, and it was paid for. A composition
 * used to be markup that people and tools both edited, and every derived number
 * in it — a caption's cue, a phrase's fade, a clip's end, the root's duration —
 * was written down somewhere and had to be kept in step by hand. It never was.
 * Cutting one line out of a take meant editing four tables, and getting three
 * of them right produced a caption that went blank across a dissolve and a
 * closing line that flashed for half a second before its clip ended.
 *
 * So: nothing derived is stored. A clip has a source, an in point, an out
 * point, and a position. Its duration is `out - in`. The cut's length is the
 * furthest clip end. A caption's cue is a word's timestamp minus the clip's in
 * point. None of those are fields, all of them are functions, and none of them
 * can drift because there is no second copy to drift from.
 *
 * The other rule: this file knows nothing about HTML, canvas, or ffmpeg. It is
 * the model. The renderer reads it, the timeline draws it, and neither one gets
 * to be the place the truth lives.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CUT_FILE = "cut.json";
export const CUT_VERSION = 1;

/** A new cut, with the shape everything else expects. */
export function emptyCut({ width = 1920, height = 1080, fps = 60 } = {}) {
	return { version: CUT_VERSION, width, height, fps, sources: {}, tracks: [] };
}

/*
 * A clip is four numbers and a reference.
 *
 *   source   which cached take the pictures come from
 *   in/out   the piece of that take, in its own seconds
 *   at       where that piece sits on the timeline
 *
 * `out` rather than `duration`, because trimming the tail of a clip is one
 * number changing and the material it shows is unchanged. With a duration
 * field, a trim is two edits that have to agree — and that is the same trap as
 * storing a derived value, one level down.
 */
export const clipSeconds = (clip) => Math.max(0, (clip.out ?? 0) - (clip.in ?? 0));
export const clipEnd = (clip) => (clip.at ?? 0) + clipSeconds(clip);

/** Every clip in the cut, with its track, in timeline order. */
export function allClips(cut) {
	return (cut.tracks ?? [])
		.flatMap((track) => (track.clips ?? []).map((clip) => ({ track, clip })))
		.sort((a, b) => (a.clip.at ?? 0) - (b.clip.at ?? 0));
}

/** How long the cut is: the furthest thing in it, and nothing else. */
export function cutSeconds(cut) {
	return allClips(cut).reduce((longest, { clip }) => Math.max(longest, clipEnd(clip)), 0);
}

/*
 * Where two neighbours overlap, which is the only way a transition exists.
 *
 * A transition is not a property somebody sets — it is what an overlap means.
 * Store it as a field and you can have a clip claiming a one-second dissolve
 * with nothing to dissolve into, which is a state the renderer then has to have
 * an opinion about. Overlap the clips and the length of the dissolve is a fact
 * about the timeline that both the picture and the editor can read.
 */
export function overlapAt(cut, trackId) {
	const track = (cut.tracks ?? []).find((t) => t.id === trackId);
	const clips = [...(track?.clips ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
	const joins = [];
	for (let i = 0; i < clips.length - 1; i += 1) {
		const over = clipEnd(clips[i]) - (clips[i + 1].at ?? 0);
		if (over > 0) joins.push({ from: clips[i].id, to: clips[i + 1].id, seconds: over, at: clips[i + 1].at });
	}
	return joins;
}

/*
 * What is wrong with this cut, in sentences.
 *
 * Returned rather than thrown, and every problem rather than the first: a cut
 * with three bad clips should say so once, not three times over three saves.
 * Nothing here repairs anything — a model that quietly fixes its own data is a
 * model you cannot trust to have told you what you asked it to store.
 */
export function cutProblems(cut) {
	const problems = [];
	if (cut?.version !== CUT_VERSION) problems.push(`this cut is version ${cut?.version ?? "unknown"}, and this build reads ${CUT_VERSION}`);
	const seen = new Set();
	for (const { track, clip } of allClips(cut ?? {})) {
		const where = `${track.id}/${clip.id ?? "unnamed"}`;
		if (!clip.id) problems.push(`a clip on ${track.id} has no id, so nothing can refer to it`);
		else if (seen.has(clip.id)) problems.push(`two clips share the id ${clip.id}`);
		seen.add(clip.id);
		const source = cut.sources?.[clip.source];
		if (!source) problems.push(`${where} points at source ${clip.source}, which this cut does not list`);
		/*
		 * A frame of slack, not a millisecond.
		 *
		 * An out point is a rounded number and a take's duration is whatever the
		 * container says, so they disagree in the third decimal constantly — a
		 * clip ending 4ms past a 23.836s take is not asking for a frame that does
		 * not exist, it is asking for the same last frame. A hard compare here
		 * rejected a real edit for a difference a quarter the size of one frame.
		 *
		 * The same mistake cost a render earlier: a 20ms threshold that a 0.020s
		 * gap squeaked past in floating point, producing a degenerate segment
		 * that concat could not carry. A frame is the smallest thing that can be
		 * shown, so a frame is the smallest disagreement worth having.
		 */
		else if (source.seconds && clip.out > source.seconds + 1 / (cut.fps || 60)) {
			problems.push(`${where} runs to ${clip.out.toFixed(3)}s of a ${source.seconds.toFixed(3)}s take`);
		}
		if (clipSeconds(clip) <= 0) problems.push(`${where} has no length: in ${clip.in} out ${clip.out}`);
		if ((clip.at ?? 0) < 0) problems.push(`${where} starts before the timeline does`);
	}
	return problems;
}

export async function readCut(dir) {
	return JSON.parse(await readFile(join(dir, CUT_FILE), "utf8"));
}

/*
 * Written whole, and pretty.
 *
 * A cut is small — a hundred clips is a few KB — and it is going to be read by
 * people in diffs for as long as it exists. Tabs and one clip per line costs
 * nothing and makes "what changed in this edit" a question git can answer.
 */
export async function writeCut(dir, cut) {
	const problems = cutProblems(cut);
	if (problems.length) throw new Error(`refusing to write a cut with problems:\n  ${problems.join("\n  ")}`);
	await writeFile(join(dir, CUT_FILE), `${JSON.stringify(cut, null, "\t")}\n`, "utf8");
	return join(dir, CUT_FILE);
}
