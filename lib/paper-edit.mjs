/*
 * The paper edit: a plan, a transcript, and a first assembly.
 *
 * WHAT THIS IS
 *
 * The oldest move in documentary editing. Before touching a timeline you print
 * the transcript, read it with the plan beside you, and mark which passages
 * answer which beat. What comes out is a running order of things somebody
 * actually said. Only then does anyone open an editor.
 *
 * That is a job a model is genuinely good at — read a lot of text, find the
 * passages that answer a question — and it is one of the few editing jobs where
 * a wrong answer is cheap, because the output is a selection you can read back
 * in thirty seconds.
 *
 * THE LOAD-BEARING DECISION: IT SELECTS, IT NEVER WRITES
 *
 * The model returns RANGES OF WORD IDS, not timecodes and not text.
 *
 *   Not timecodes, because a model will produce "00:03:21.5" with complete
 *   confidence and no relationship to the audio. An id either exists in the
 *   transcript or it does not, so a hallucination fails validation instead of
 *   rendering as a cut of something nobody said.
 *
 *   Not text, because then it could paraphrase — and a video of somebody saying
 *   a slightly better version of what they said is the one failure mode that
 *   matters here. The output space is "which existing spans", so the worst it
 *   can do is choose badly, which a person can see.
 *
 *   Ranges rather than word lists, because a selection of scattered words is
 *   Frankenstein speech. A contiguous range is a thing a person said in one
 *   breath, and every range is checked for contiguity.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No network, no prompt execution, no disk. This builds the prompt, validates
 * what comes back, and compiles a valid selection into a cut list. Running the
 * agent is lib/agents.mjs's job; every rule about what makes an edit legitimate
 * is here, where it can be checked against real transcripts without a model.
 */

/** Bumped when a stored paper edit can no longer be read by this file. */
export const PAPER_EDIT_VERSION = 1;

/**
 * How much to keep either side of a chosen range.
 *
 * Cutting exactly on the first and last word is too tight: whisper's word
 * boundaries land on the vowel, so a cut on them clips the consonant that starts
 * the phrase and the breath that ends it. 120ms in and 250ms out is the
 * asymmetry speech actually has — you start talking faster than you stop.
 *
 * Advisory: `selectionToCutlist` clamps padding to the gap before the previous
 * word and after the next, so padding can never swallow a neighbour's speech.
 */
export const LEAD_SEC = 0.12;
export const TAIL_SEC = 0.25;

/**
 * Words, in the order they were said, with the ids the model will answer in.
 *
 * The id is the transcript's own — not an index — so a selection stays valid if
 * the transcript is re-read, and so a returned id can be looked up rather than
 * trusted.
 */
export const orderedWords = (transcript) =>
	[...(transcript?.words ?? [])].sort((a, b) => a.startSec - b.startSec || String(a.id).localeCompare(String(b.id)));

/**
 * The transcript as the model reads it.
 *
 * One line per sentence-ish run, each word tagged with its id. The alternative —
 * a JSON array of word objects — spends most of its tokens on punctuation and
 * reads nothing like prose, which is the thing the model is good at.
 *
 * Ids inline rather than a separate legend: a legend means the model has to hold
 * a mapping in its head while reading, and that is exactly where it starts
 * inventing.
 *
 * `maxChars` truncates rather than failing, because a two-hour recording is a
 * real input and half a paper edit beats an error. The caller is told what was
 * dropped so it can say so.
 */
export function transcriptForPrompt(transcript, { maxChars = 120_000 } = {}) {
	const words = orderedWords(transcript);
	const lines = [];
	let line = [];
	let used = 0;
	let dropped = 0;

	const flush = () => {
		if (!line.length) return;
		lines.push(line.join(" "));
		line = [];
	};

	for (const w of words) {
		const text = String(w.text ?? "").trim();
		if (!text) continue;
		const token = `${text}⟨${w.id}⟩`;
		if (used + token.length > maxChars) {
			dropped++;
			continue;
		}
		used += token.length + 1;
		line.push(token);
		// A new line at sentence ends and at a real pause. Paragraphing is what
		// makes this readable as speech rather than as a wall of tokens, and the
		// model's sense of "a passage" follows the shape it is shown.
		if (/[.!?]$/.test(text) || line.length >= 40) flush();
	}
	flush();

	return {
		text: lines.join("\n"),
		words: words.length,
		dropped,
		/** The first and last id, so a caller can say what range was offered. */
		firstId: words[0]?.id ?? null,
		lastId: words[words.length - 1]?.id ?? null,
	};
}

/**
 * What the model is asked to produce.
 *
 * Stated as prose rather than a JSON Schema because it is going to a coding
 * agent through `lib/agents.mjs`, which takes a prompt and writes a file — not
 * to a structured-output endpoint. The shape is small enough to describe exactly,
 * and `parseSelection` is tolerant of the ways a model wraps JSON.
 */
export const OUTPUT_SHAPE = `{
  "shots": [
    {
      "shot": "<the shot's exact name from the plan>",
      "ranges": [
        { "from": "<word id>", "to": "<word id>", "why": "<why this passage answers this shot>" }
      ]
    }
  ],
  "unused": "<anything important that was said but fits no shot, in one sentence>"
}`;

/**
 * The prompt.
 *
 * Three things, in the order that matters: what the video has to be, what was
 * said, and what to hand back. The plan comes FIRST — a model reading twenty
 * minutes of transcript before it knows what it is looking for reads it as
 * summary, and summary is not selection.
 */
export function buildPrompt({ plan, transcript, notes = "" } = {}) {
	const shots = Array.isArray(plan?.shots) ? plan.shots : [];
	if (!shots.length) throw new Error("a paper edit needs a plan — at least one shot for the model to fill");
	const rendered = transcriptForPrompt(transcript);
	if (!rendered.words) throw new Error("a paper edit needs a transcript with words in it");

	const shotLines = shots.map((s, i) => {
		const target = Number(s.seconds) > 0 ? ` — aim for about ${s.seconds}s` : "";
		return `  ${i + 1}. ${s.name}${s.intent ? `: ${s.intent}` : ""}${target}`;
	});

	return [
		"You are making the first assembly of a video from a recording. This is a paper edit:",
		"you choose which passages of what was actually said go where. You do not write anything.",
		"",
		"THE PLAN — the video needs these shots, in this order:",
		...shotLines,
		notes ? `\nNOTES: ${notes}` : "",
		"",
		"THE TRANSCRIPT — every word carries its id in ⟨angle brackets⟩:",
		"",
		rendered.text,
		rendered.dropped ? `\n[${rendered.dropped} words past the length limit were not shown]` : "",
		"",
		"RULES",
		"",
		"1. Choose RANGES of word ids. A range is a passage somebody actually said, start to",
		"   finish. `from` and `to` are ids that appear above, and `from` must come before `to`.",
		"2. Never invent an id. If nothing in the transcript fits a shot, give it no ranges and",
		"   say so — a missing shot is useful information and a wrong one is not.",
		"3. Prefer one clean range per shot. Several is fine when the good version of a thought",
		"   is split by a false start; do not stitch together half-sentences.",
		"4. Cut on complete thoughts. Ending a range mid-clause reads as a mistake on screen.",
		"5. You may leave a shot empty. You may not reorder the shots.",
		"",
		"Reply with ONLY this JSON, and nothing before or after it:",
		"",
		OUTPUT_SHAPE,
	]
		.filter((l) => l !== "")
		.join("\n");
}

/**
 * Pull the JSON out of whatever the model wrapped it in.
 *
 * Fenced blocks, a preamble, a trailing "Let me know if…" — all of these are
 * normal and none of them is worth failing a five-minute run over. The first
 * balanced object containing a "shots" key wins.
 */
export function parseSelection(raw) {
	const text = String(raw ?? "");
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidates = [fenced?.[1], text].filter(Boolean);
	for (const c of candidates) {
		const start = c.indexOf("{");
		if (start === -1) continue;
		// Balance braces rather than regex: a "why" containing a brace is not a
		// reason to fail, and a greedy match would swallow trailing prose.
		let depth = 0;
		for (let i = start; i < c.length; i++) {
			if (c[i] === "{") depth++;
			else if (c[i] === "}") depth--;
			if (depth === 0) {
				try {
					const parsed = JSON.parse(c.slice(start, i + 1));
					if (parsed && Array.isArray(parsed.shots)) return parsed;
				} catch {
					/* try the next candidate */
				}
				break;
			}
		}
	}
	throw new Error("the agent did not return a paper edit — no JSON object with a `shots` array");
}

/**
 * Check a selection against the transcript and the plan, and say exactly what is
 * wrong with it.
 *
 * Every problem is reported rather than the first, because a model that got two
 * ids wrong will get them wrong again on a retry that only mentions one. The
 * returned `ranges` are the ones that survived — a partly-good paper edit is
 * worth having, and dropping it whole because one range was bad wastes the run.
 */
export function validateSelection(selection, { transcript, plan } = {}) {
	const words = orderedWords(transcript);
	const index = new Map(words.map((w, i) => [String(w.id), { word: w, i }]));
	const shotsByName = new Map((plan?.shots ?? []).map((s) => [String(s.name), s]));
	const problems = [];
	const kept = [];

	for (const entry of selection?.shots ?? []) {
		const name = String(entry?.shot ?? "").trim();
		if (!shotsByName.has(name)) {
			problems.push(`"${name}" is not a shot in the plan`);
			continue;
		}
		for (const r of entry?.ranges ?? []) {
			const from = index.get(String(r?.from));
			const to = index.get(String(r?.to));
			// An id that does not exist is the hallucination this design exists to
			// catch, so it is named as one rather than folded into "invalid range".
			if (!from) {
				problems.push(`${name}: no word has id ${JSON.stringify(r?.from)}`);
				continue;
			}
			if (!to) {
				problems.push(`${name}: no word has id ${JSON.stringify(r?.to)}`);
				continue;
			}
			if (to.i < from.i) {
				problems.push(`${name}: ${r.from} comes after ${r.to} — a range runs forwards`);
				continue;
			}
			kept.push({
				shot: name,
				from: from.word,
				to: to.word,
				fromIndex: from.i,
				toIndex: to.i,
				why: String(r?.why ?? "").trim(),
				text: words.slice(from.i, to.i + 1).map((w) => w.text).join(" ").trim(),
			});
		}
	}

	/*
	 * Overlaps are a problem, and only within one shot.
	 *
	 * The same passage answering two different shots is a legitimate choice — a
	 * line can open the video and come back at the end — so overlap ACROSS shots
	 * is left alone. Twice inside one shot is the model repeating itself.
	 */
	const byShot = new Map();
	for (const k of kept) {
		const list = byShot.get(k.shot) ?? [];
		if (list.some((o) => k.fromIndex <= o.toIndex && o.fromIndex <= k.toIndex)) {
			problems.push(`${k.shot}: two ranges cover the same words`);
			continue;
		}
		list.push(k);
		byShot.set(k.shot, list);
	}

	const filled = new Set([...byShot.keys()]);
	const empty = (plan?.shots ?? []).map((s) => String(s.name)).filter((n) => !filled.has(n));

	return { ranges: [...byShot.values()].flat(), problems, empty, ok: problems.length === 0 && kept.length > 0 };
}

/**
 * A validated selection, as a cut list.
 *
 * Shot order is timeline order, exactly as in storyboard.mjs — the plan states
 * the running order and the paper edit fills it, so nothing here decides
 * sequence. Within a shot, ranges keep the order the model gave them.
 *
 * Padding is clamped to the silence around the passage. Cutting on whisper's
 * word boundaries clips consonants and breath, but padding into the previous
 * word means the clip opens on half of a word nobody chose — so the lead can
 * only ever grow into the gap that is actually there.
 */
export function selectionToCutlist(validated, { transcript, plan, rel, durationSec, lead = LEAD_SEC, tail = TAIL_SEC } = {}) {
	const words = orderedWords(transcript);
	const order = new Map((plan?.shots ?? []).map((s, i) => [String(s.name), i]));
	const ranges = [...(validated?.ranges ?? [])].sort(
		(a, b) => (order.get(a.shot) ?? 0) - (order.get(b.shot) ?? 0) || a.fromIndex - b.fromIndex,
	);

	return ranges.map((r) => {
		const prev = words[r.fromIndex - 1];
		const next = words[r.toIndex + 1];
		// Grow into the gap, never into a neighbour. `?? lead` covers the ends of
		// the recording, where there is no neighbour to be crowded.
		const gapBefore = prev ? Math.max(0, r.from.startSec - prev.endSec) : lead;
		const gapAfter = next ? Math.max(0, next.startSec - r.to.endSec) : tail;
		const inSec = Math.max(0, r.from.startSec - Math.min(lead, gapBefore));
		const rawOut = r.to.endSec + Math.min(tail, gapAfter);
		const outSec = Number.isFinite(durationSec) ? Math.min(durationSec, rawOut) : rawOut;
		return {
			rel,
			label: r.shot,
			inSec,
			outSec,
			durationSec,
			// The model's own reason, carried onto the timeline. What makes a clip
			// legible six months later is why it was chosen, not which file it came
			// from — and this is the only moment that reason exists.
			reason: r.why || r.shot,
			/** Which words this clip is, so the editor can highlight them. */
			wordIds: words.slice(r.fromIndex, r.toIndex + 1).map((w) => w.id),
			text: r.text,
		};
	});
}

/** How much of the plan the paper edit actually answered, in the terms you would ask. */
export function coverage(validated, { plan } = {}) {
	const shots = (plan?.shots ?? []).map((s) => String(s.name));
	const filled = new Set((validated?.ranges ?? []).map((r) => r.shot));
	const seconds = (validated?.ranges ?? []).reduce((n, r) => n + Math.max(0, r.to.endSec - r.from.startSec), 0);
	return {
		shots: shots.length,
		filled: shots.filter((s) => filled.has(s)),
		empty: shots.filter((s) => !filled.has(s)),
		ranges: (validated?.ranges ?? []).length,
		seconds,
	};
}
