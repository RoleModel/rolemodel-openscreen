/*
 * A storyboard: what the video needs, what we shot for it, and which take won.
 *
 * WHY THIS EXISTS
 *
 * Cut asks one question — which clips, in what order — and answers it with a
 * list. That is the right shape for assembling a cut and the wrong shape for
 * deciding one, because deciding happens before there is an order: you shoot a
 * thing four times, you look at the four, you keep one. A list cannot hold three
 * rejected takes without pretending they are part of the video.
 *
 * So this model has a middle layer Cut does not:
 *
 *   SLOT   a hole in the video the brief says must be filled. Ordered, named,
 *          with a target length. Exists before any footage does.
 *   TAKE   a candidate for one slot — a span of one file. Many per slot.
 *   PICK   which take won its slot. One per slot, or none yet.
 *
 * The picks ARE the cut list. That is the load-bearing idea here: choosing a take
 * per slot is not a step before editing, it IS the edit decision, so `toCutlist`
 * is a projection rather than an export. Nothing is copied, nothing can drift,
 * and a board with every slot picked is a finished assembly by construction.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No UI, no disk, no network, no clock. Ratings arrive with their timestamps
 * already stamped, ids derive from content, and every function is pure — which is
 * what lets the assertions check a board's arithmetic without a browser, a
 * project folder or a running server.
 *
 * TWO COORDINATE SYSTEMS, as in cutlist.mjs and for the same reason:
 *
 *   SOURCE time    where a take sits inside its own file — `inSec`/`outSec`.
 *   TIMELINE time  where the winning take sits in the finished video.
 *
 * A board only ever states source time. Timeline time is derived by laying the
 * picks end to end in slot order, because that is what a cut is.
 */

import { clipsFor, cutlistToDocument } from "./cutlist.mjs";

/** Bumped when a stored board can no longer be read by this file. */
export const BOARD_VERSION = 1;

/**
 * Ids derive from what they identify, exactly as in cutlist.mjs.
 *
 * A board is written to disk on every rating, and two people rating the same take
 * a second apart must produce the same take id or the merge has nothing to match
 * on. Random ids would make every sync a conflict.
 */
export const idFor = (prefix, seed) => `${prefix}_${Buffer.from(String(seed)).toString("base64url").slice(-16)}`;

/**
 * The rating scale, named rather than numbered at the edges.
 *
 * Five stars invites a 3, and a 3 is not a decision — the point of rating takes
 * is to narrow, so the scale is the four answers people actually give about a
 * take. `reject` is kept rather than deleted: a take somebody argued against is
 * evidence, and hiding it means re-litigating it next week.
 */
export const RATINGS = [
	{ score: 3, id: "hero", label: "Hero", hint: "the one to build around" },
	{ score: 2, id: "good", label: "Good", hint: "usable, not the best" },
	{ score: 1, id: "maybe", label: "Maybe", hint: "only if nothing better" },
	{ score: 0, id: "reject", label: "Reject", hint: "argued against, kept as evidence" },
];

const SCORES = new Map(RATINGS.map((r) => [r.id, r.score]));

/** A slot's id comes from the brief position and name, so re-reading a brief is a no-op. */
export const slotId = (boardId, order, name) => idFor("slot", `${boardId}:${order}:${name}`);

/**
 * A take's id is its span. The same span offered twice is the same take.
 *
 * Keyed on `rel` — the file's place in the project — and never on an absolute
 * path. A board is meant to be read by other people, and "/Users/dallas/RoleModel
 * Library/..." identifies nothing on their machine; two people offering the same
 * footage would produce two takes that no merge could reconcile.
 */
export const takeId = (slot, rel, inSec, outSec) => idFor("take", `${slot}:${rel}@${inSec}->${outSec}`);

/**
 * An empty board for a project.
 *
 * `brief` is carried whole rather than summarised. A board explains itself six
 * months later only if it still says what was asked for, and the brief is the
 * only record of that — the slots are an interpretation of it.
 */
export function emptyBoard({ projectId, title = "", brief = null }) {
	return {
		version: BOARD_VERSION,
		projectId,
		title,
		brief,
		slots: [],
		takes: [],
		ratings: [],
		comments: [],
		picks: {},
	};
}

/**
 * Turn a brief's shot list into slots.
 *
 * The brief owns the shape of the video, so re-reading an edited brief must
 * update the board without orphaning work. Ids derive from order and name, so a
 * slot whose wording changed is a NEW slot and its takes stay attached to the old
 * one rather than silently transferring to a shot that means something else.
 * Renaming therefore costs a re-link, which is the honest price of the guarantee
 * that a take never ends up under a shot nobody offered it for.
 */
export function slotsFromBrief(boardId, brief) {
	const shots = Array.isArray(brief?.shots) ? brief.shots : [];
	return shots.map((shot, i) => {
		const name = String(shot?.name ?? `Shot ${i + 1}`).trim() || `Shot ${i + 1}`;
		return {
			id: slotId(boardId, i, name),
			order: i,
			name,
			/** What this shot has to show. The thing you judge a take against. */
			intent: String(shot?.intent ?? "").trim(),
			/** Target length. Advisory — a take is not rejected for missing it. */
			seconds: Number(shot?.seconds) > 0 ? Number(shot.seconds) : null,
			notes: String(shot?.notes ?? "").trim(),
		};
	});
}

/** Slots in the order the video plays, whatever order they were stored in. */
export const orderedSlots = (board) => [...(board?.slots ?? [])].sort((a, b) => a.order - b.order);

/** Every take offered for one slot, newest first — the last thing shot is the thing being judged. */
export const takesFor = (board, slot) =>
	(board?.takes ?? []).filter((t) => t.slotId === slot).sort((a, b) => String(b.addedAt ?? "").localeCompare(String(a.addedAt ?? "")));

/**
 * What a take scores, and who said so.
 *
 * The mean, not the sum: four people calling something Good must not beat one
 * person calling it Hero purely by turnout. `count` is returned alongside so the
 * UI can say "one opinion" rather than presenting a single vote as consensus.
 *
 * One rating per person per take — the last one they gave wins. Rating something
 * twice is changing your mind, not voting twice.
 */
export function scoreOf(board, take) {
	const latest = new Map();
	for (const r of board?.ratings ?? []) {
		if (r.takeId !== take) continue;
		const prev = latest.get(r.by);
		if (!prev || String(r.at ?? "") >= String(prev.at ?? "")) latest.set(r.by, r);
	}
	const votes = [...latest.values()];
	if (!votes.length) return { mean: null, count: 0, votes: [] };
	const total = votes.reduce((n, v) => n + (SCORES.get(v.rating) ?? 0), 0);
	return { mean: total / votes.length, count: votes.length, votes };
}

/**
 * The take a slot would pick for itself.
 *
 * Used to suggest, never to decide. An explicit pick always wins — the whole
 * point of rating is to inform a person, and a board that quietly overrode their
 * choice the moment somebody else rated something would be worse than no
 * suggestion at all.
 *
 * Ties break toward the take added first, so a suggestion does not move around
 * while people are still rating.
 */
export function suggestedTake(board, slot) {
	const ranked = takesFor(board, slot)
		.map((t) => ({ take: t, ...scoreOf(board, t.id) }))
		.filter((r) => r.count > 0 && r.mean > 0);
	if (!ranked.length) return null;
	ranked.sort((a, b) => b.mean - a.mean || String(a.take.addedAt ?? "").localeCompare(String(b.take.addedAt ?? "")));
	return ranked[0].take;
}

/** The take that will actually be cut: what somebody chose, else what the ratings suggest. */
export function chosenTake(board, slot) {
	const picked = board?.picks?.[slot];
	if (picked) {
		const t = (board.takes ?? []).find((x) => x.id === picked);
		if (t) return t;
	}
	return suggestedTake(board, slot);
}

/**
 * How far along this is, in the terms somebody actually asks about.
 *
 * Not a percentage. "68% complete" on a storyboard is a number nobody can act on;
 * "three slots have nothing in them" is a list of what to shoot tomorrow.
 */
export function boardProgress(board) {
	const slots = orderedSlots(board);
	const empty = slots.filter((s) => !takesFor(board, s.id).length);
	const undecided = slots.filter((s) => takesFor(board, s.id).length && !chosenTake(board, s.id));
	const settled = slots.filter((s) => chosenTake(board, s.id));
	return {
		slots: slots.length,
		empty,
		undecided,
		settled,
		takes: (board?.takes ?? []).length,
		/** The running time of what is settled so far, which is what a client asks. */
		seconds: settled.reduce((n, s) => {
			const t = chosenTake(board, s.id);
			return n + Math.max(0, (t?.outSec ?? 0) - (t?.inSec ?? 0));
		}, 0),
	};
}

/**
 * The picks, as the cut list they already are.
 *
 * Slot order is timeline order, so no arrangement step exists or should. A slot
 * with nothing chosen is skipped rather than filled with a placeholder: a hole in
 * a rough cut is information, and a black slug pretending to be footage is not.
 *
 * `reason` carries the slot name into the editor, which is what makes a clip on
 * the timeline legible as "the price reveal" rather than as capture-1787.mp4.
 *
 * Emits `rel`, not `path`. Resolving a project-relative name to a real file is
 * the server's job and its boundary check — this file must not be able to name a
 * location outside the library, because it cannot check one.
 */
export function toCutlist(board) {
	const out = [];
	for (const slot of orderedSlots(board)) {
		const take = chosenTake(board, slot.id);
		if (!take) continue;
		out.push({
			rel: take.rel,
			label: slot.name,
			inSec: take.inSec,
			outSec: take.outSec,
			durationSec: take.durationSec,
			reason: slot.intent || slot.name,
		});
	}
	return out;
}

/**
 * What the finished assembly runs to, and where each pick lands in it.
 *
 * `resolve` turns a project-relative name into a real file. It defaults to
 * identity so that the arithmetic can be checked without a library on disk; the
 * server passes the real resolver, which is also the thing that refuses a path
 * outside the library.
 */
export const boardTimeline = (board, resolve = (rel) => rel) =>
	clipsFor(toCutlist(board).map((c) => ({ ...c, path: resolve(c.rel) })));

/**
 * The board as a document the editor opens.
 *
 * Throws when nothing is settled, and says which slots are empty rather than
 * "a cut list needs at least one clip" — the caller knows it has a board, and the
 * useful answer is which shots are missing.
 */
export function boardToDocument(board, { id, title, createdAt, updatedAt, resolve = (rel) => rel } = {}) {
	const clips = toCutlist(board).map((c) => ({ ...c, path: resolve(c.rel) }));
	if (!clips.length) {
		const p = boardProgress(board);
		throw new Error(
			p.slots
				? `nothing is chosen yet — ${p.empty.length} of ${p.slots} shot(s) have no takes, and none of the rest has a pick`
				: "this board has no shots yet — the brief has to say what the video needs first",
		);
	}
	return cutlistToDocument({
		id: id ?? idFor("doc", `${board.projectId}:${board.title}`),
		title: title ?? board.title ?? "Storyboard",
		clips,
		overlays: [],
		createdAt,
		updatedAt,
	});
}

/**
 * Merge two boards that were edited apart.
 *
 * Needed the moment ratings leave one machine, and written here rather than in
 * the sync adapter because it is arithmetic, not transport — a file-based merge
 * and a hosted one have to agree on the answer or the two disagree about what
 * won.
 *
 * The rules, and why each is the way round it is:
 *
 *   ratings   union, last-write-wins per (person, take). Nobody's opinion is
 *             dropped, and changing your mind is respected.
 *   takes     union by id. Ids are spans, so the same span offered by two people
 *             collapses to one take rather than appearing twice.
 *   comments  union by id, never overwritten. Losing what somebody said is worse
 *             than showing two similar things.
 *   picks     last-write-wins per slot, by `at`. A pick is a decision and the
 *             most recent decision stands — this is the one place a merge can
 *             genuinely lose information, which is why picks carry a timestamp
 *             and ratings are kept whole underneath them.
 *   slots     the brief's, not the union. Two people cannot both be right about
 *             what the video needs, so slots follow whichever board carries the
 *             newer brief rather than accumulating every shot anyone imagined.
 */
export function mergeBoards(mine, theirs) {
	if (!theirs) return mine;
	if (!mine) return theirs;

	const newerBrief = String(theirs.brief?.drafted ?? "") > String(mine.brief?.drafted ?? "") ? theirs : mine;

	const byId = (list) => new Map((list ?? []).map((x) => [x.id, x]));
	const takes = byId(mine.takes);
	for (const t of theirs.takes ?? []) if (!takes.has(t.id)) takes.set(t.id, t);

	const comments = byId(mine.comments);
	for (const c of theirs.comments ?? []) if (!comments.has(c.id)) comments.set(c.id, c);

	const ratings = new Map();
	for (const r of [...(mine.ratings ?? []), ...(theirs.ratings ?? [])]) {
		const key = `${r.by}::${r.takeId}`;
		const prev = ratings.get(key);
		if (!prev || String(r.at ?? "") >= String(prev.at ?? "")) ratings.set(key, r);
	}

	const picks = { ...(mine.picks ?? {}) };
	const pickAt = { ...(mine.pickedAt ?? {}) };
	for (const [slot, take] of Object.entries(theirs.picks ?? {})) {
		const theirAt = String(theirs.pickedAt?.[slot] ?? "");
		if (!(slot in picks) || theirAt >= String(pickAt[slot] ?? "")) {
			picks[slot] = take;
			pickAt[slot] = theirAt;
		}
	}

	return {
		...mine,
		version: BOARD_VERSION,
		title: newerBrief.title ?? mine.title,
		brief: newerBrief.brief,
		slots: newerBrief.slots ?? [],
		takes: [...takes.values()],
		comments: [...comments.values()],
		ratings: [...ratings.values()],
		picks,
		pickedAt: pickAt,
	};
}
