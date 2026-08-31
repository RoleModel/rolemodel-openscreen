#!/usr/bin/env node
/**
 * Build a PIP composition: the speaker in a circle, their words typed on beside.
 *
 * A different shape of cut from the assembly exporter. There the footage is the
 * frame and a lower third names who is talking; here the field is the frame, the
 * speaker is a small circle, and what they are saying is the thing you read.
 *
 * Words come from the transcripts the project already has. Worth knowing what
 * those are: `timing: "caption"` means the times were spread evenly across each
 * caption cue rather than measured per word, so a word lands within its line and
 * not on its own syllable. Good enough to read along with, not lip-sync.
 *
 *   node lib/make-pip.mjs <projectId> [folder]
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { defaultRoot } from "./library.mjs";
import { durationOf } from "./narration.mjs";
import { transcriptFromCaptions } from "./captions.mjs";

const esc = (value) =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

const seconds = (ms) => (Math.max(0, Math.round(Number(ms) || 0)) / 1000).toFixed(3);

/*
 * A phrase, measured in characters rather than words.
 *
 * The cap was twelve words, and a word is not a unit of width: twelve of them
 * came to 85 characters in one phrase and 120 in another, so eleven of
 * thirty-seven phrases ran past the bottom of the box they sit in. What fits is
 * three lines of 56cqw at 5.6cqw, which is about eighty characters — this stays
 * under it, and the word cap stays as a second bound so a phrase of very short
 * words does not become a paragraph.
 */
const GROUP_MIN = 5;
/* A bound on runaway short words, not the real limit — the character budget is.
   At twelve it was cutting "…that carry the setup" from "for you." when the
   whole clause was only sixty-four characters and fitted comfortably. */
const GROUP_MAX = 16;
const GROUP_CHARS = 72;

/*
 * Where a long sentence would rather be broken.
 *
 * With no punctuation to go on, the budget breaks wherever it runs out — which
 * gave "I handed over a voiceover script and a demo recording and got" followed
 * by "a finished video back." These are the words a clause tends to start with,
 * so a forced break looks back for the last one and cuts in front of it. It
 * reads as two phrases instead of one sentence severed mid-verb.
 */
const CLAUSE_OPENERS = new Set([
	"and", "or", "but", "so", "then", "because", "that", "which", "who",
	"when", "while", "after", "before", "with", "without", "for", "from",
	"into", "to", "of", "in", "on", "at", "by", "as", "if",
]);

/*
 * How the words move, which is mostly "as little as possible".
 *
 * The first version flipped each word to full and back to dim with `set`, at
 * exact times: 312 instant steps over a two-minute cut, each one an abrupt
 * change in a corner of the eye. Read as strobing, and no amount of a nicer
 * typeface fixes it.
 *
 * Two changes. Every transition is eased over a real duration instead of a
 * step; and a word that has been said STAYS lit, so a phrase fills left to
 * right like something being read rather than a highlight running along it.
 * That halves the number of transitions, and it is far kinder to the timing
 * data — these word times are interpolated across a caption cue, not measured,
 * so a word landing early only fills early. A flash landing early lands on the
 * wrong word.
 */
export const PHRASE_FADE = 0.32;
export const WORD_FILL = 0.2;
export const WORD_DIM = 0.45;
/*
 * How a speaker arrives and leaves.
 *
 * The clips lie end to end, and four of six have no handle at all — no frames
 * beyond their out point — so a true cross-dissolve is not available: there is
 * nothing of the outgoing take left to dissolve through. What is available, and
 * needs no handle, is a dip: the outgoing pip fades to nothing over its last
 * beat and the incoming one rises over its first, so the change reads through
 * the wallpaper rather than as a cut.
 *
 * The first pip gets longer, because it is not following a speaker — it is
 * following the opening card, and arriving at the same speed as a speaker change
 * makes the intro end in a jolt.
 */
export const PIP_FADE = 0.35;
export const PIP_FIRST_FADE = 0.7;

/*
 * A card leaves more slowly than it arrives.
 *
 * Its exit is a hand-off to whatever is underneath — wallpaper, then a speaker —
 * so it has further to travel than an arrival onto a ground that is already
 * there. Longer than PIP_FIRST_FADE on purpose: the opening shader dissolving
 * out while the first speaker fades up is one gesture, not two.
 */
export const COMPONENT_FADE_IN = 0.5;
export const COMPONENT_FADE_OUT = 0.9;

/*
 * The opening card leaves more slowly still, because it is crossing with the
 * first speaker rather than handing back to the wallpaper.
 *
 * Measured, not guessed. With the card's window ending exactly where the first
 * pip's began, the frame went bright card → wallpaper alone → speaker: mean
 * luma over the top of frame ran 59.5, dipped to 34.0, then climbed back to
 * 40. That dip is the abruptness — a hole between two gestures, not a hard cut.
 *
 * So an opening card's window is extended over the first pip's arrival and it
 * fades across the whole overlap. It is the first child of the composition, so
 * it paints under the pips: the speaker rises through the dissolving shader and
 * there is no frame where neither is carrying the picture.
 */
export const OPENING_FADE_OUT = 1.6;

/*
 * The body of the timeline, emitted verbatim into every composition.
 *
 * Shared with rm-retime-pip, which rewrites this block in place. It used to
 * hold its own copy, so a shape fixed in one was still broken in the other —
 * a retimed composition silently lost whatever the generator had learned.
 * One source, so a retime can only ever produce what a fresh build would.
 */
export const TIMELINE_LOOPS = `      /*
       * A cue's time is measured from its own clip, and the clip states where it
       * is. So the words and the take they belong to are one unit: move the clip
       * in HyperFrames and its words move with it, because this reads the window
       * the file has now rather than one baked in when it was generated.
       *
       * A clip that has been deleted takes its words with it — offset() returns
       * null and the cue is skipped, rather than firing at zero over whoever is
       * on screen at the time.
       */
      function offset(clip) {
        var el = document.getElementById('pip-' + clip);
        return el ? Number(el.dataset.start) || 0 : null;
      }

      PHRASE.forEach(function (p) {
        var base = offset(p[1]);
        if (base === null) return;
        var at = '#' + p[0];
        tl.set(at, { opacity: 0 }, 0)
          .to(at, { opacity: 1, duration: FADE, ease: 'power1.out' }, base + p[2])
          .to(at, { opacity: 0, duration: FADE, ease: 'power1.in' }, base + p[3])
          /* Hard-killed at the boundary its fade ends on: seeking past a fade
             that has started but not finished otherwise leaves it half-lit. */
          .set(at, { opacity: 0 }, base + p[4]);
      });
      WORD.forEach(function (w) {
        var base = offset(w[1]);
        if (base === null) return;
        var at = '#' + w[0];
        tl.set(at, { opacity: DIM }, 0).to(at, { opacity: 1, duration: FILL, ease: 'power1.out' }, base + w[2]);
      });
      OUT.forEach(function (o) {
        var base = offset(o[1]);
        if (base === null) return;
        var at = '#' + o[0];
        tl.to(at, { opacity: 0, duration: 0.4, ease: 'none' }, base + o[2]).set(at, { opacity: 0 }, base + o[3]);
      });

      /*
       * A speaker fades in and out, so a change reads as a dissolve through the
       * wallpaper rather than a cut. The envelope is also what keeps a pip off
       * screen outside its own window: it is stated here rather than left to
       * whatever is stepping the clips, which is why every speaker used to be
       * visible at once when the file was opened outside HyperFrames.
       */
      PIPS.forEach(function (p) {
        var el = document.getElementById('pip-' + p[0]);
        var base = offset(p[0]);
        if (!el || base === null) return;
        var span = Number(el.dataset.duration) || 0;
        var into = p[1];
        var at = '#pip-' + p[0];
        var leaves = Math.max(base + into, base + span - PIP_OUT);
        tl.set(at, { opacity: 0 }, 0)
          .to(at, { opacity: 1, duration: into, ease: 'power2.out' }, base)
          .to(at, { opacity: 0, duration: PIP_OUT, ease: 'power2.in' }, leaves)
          /* Hard off at the boundary its fade ends on, for the same reason a
             phrase is: seeking into a half-finished fade otherwise leaves a
             speaker faintly over the next one. */
          .set(at, { opacity: 0 }, base + span);
      });

      /*
       * The speaker's block is stated here too, for the same reason a pip is.
       *
       * Its phrases have cues and its name does not — the name is simply on
       * while its clip is on — so the block's visibility was left to whatever
       * was stepping the clips. Anything that does not step them showed all six
       * names at once, printed over each other in the corner: a thumbnail, a
       * still capture, the file opened on its own. Same envelope as the pip it
       * belongs to, so the two arrive and leave together.
       */
      PIPS.forEach(function (p) {
        var el = document.getElementById('say-' + p[0]);
        if (!el) return;
        var base = Number(el.dataset.start) || 0;
        var span = Number(el.dataset.duration) || 0;
        if (!span) return;
        var at = '#say-' + p[0];
        var into = p[1];
        tl.set(at, { opacity: 0 }, 0)
          .to(at, { opacity: 1, duration: into, ease: 'power2.out' }, base)
          .set(at, { opacity: 0 }, base + span);
      });

      /*
       * An opening or closing card dissolves rather than cuts.
       *
       * Without this a component's visibility simply flips at its window edge,
       * so the intro shader dropped off and the wallpaper was abruptly there.
       *
       * No table: these are not ours. Somebody adds, removes, and retimes cards
       * in HyperFrames, so the envelope is read off the file at load — the same
       * reason a pip's window is. A card that opens the piece is not faded up
       * from nothing, because the first frame of the video should be the card
       * rather than half a second of bare wallpaper.
       */
      var COMP_IN = ${COMPONENT_FADE_IN}, COMP_OUT = ${COMPONENT_FADE_OUT}, OPEN_OUT = ${OPENING_FADE_OUT};
      /* Descendants, not children: a card split into compositions/ is mounted
         inside its host element rather than sitting at the top level. */
      Array.prototype.forEach.call(document.querySelectorAll('main .clip[id]'), function (el) {
        if (/^(pip|say)-/.test(el.id)) return;
        var base = Number(el.dataset.start) || 0;
        var span = Number(el.dataset.duration) || 0;
        if (!span) return;
        var at = '#' + el.id;
        /* A card that opens the piece is not faded up from nothing — the first
           frame should be the card, not half a second of bare wallpaper — and
           it leaves across its overlap with the first speaker. */
        var opening = base === 0;
        var into = opening ? 0 : Math.min(COMP_IN, span / 3);
        var out = Math.min(opening ? OPEN_OUT : COMP_OUT, span / 3);
        var leaves = base + span - out;
        if (into > 0) {
          tl.set(at, { opacity: 0 }, 0).to(at, { opacity: 1, duration: into, ease: 'power1.out' }, base);
        } else {
          tl.set(at, { opacity: 1 }, 0);
        }
        /* An opening card sheds most of its opacity early and keeps a faint
           tail. Its overlap carries a headline over the speaker's transcript,
           and a slow-start ease left it at half strength exactly as the words
           arrived — two headlines printed over each other. Front-loading the
           fade keeps the hand-off continuous without the collision. */
        tl.to(at, { opacity: 0, duration: out, ease: opening ? 'power2.out' : 'power1.in' }, leaves)
          /* Hard off on the boundary, so seeking into a running fade cannot
             leave a card faintly over the speaker after it. */
          .set(at, { opacity: 0 }, base + span);
      });

      /*
       * Render the resting state once, now that every cue is on the timeline.
       *
       * A paused timeline sitting at 0 has applied nothing, and seeking it to 0
       * is not a change, so GSAP renders nothing: a consumer that never seeks —
       * or that asks for exactly the first frame, which a thumbnail does — saw
       * the document as authored, with all six speakers and all six names on at
       * once. A hair past zero is a real change, so everything at or before the
       * first frame is applied.
       */
      tl.seek(0.0001);`;

/**
 * The transcript for one media file, pulled back onto the media's real length.
 *
 * `timing: "caption"` word times are spread evenly across each caption cue, and
 * those cues routinely end after the recording does — becky's ran to 19.80s of
 * an 18.95s file, dallas's to 16.80s of 15.67s. Two things follow, and both
 * were visible in the cut: the highlight drifts later and later through a clip,
 * and the last word of the take falls outside the clip's own window and is
 * dropped, which is how Becky lost "afternoon."
 *
 * Where the words claim more time than the file has, every time is scaled by
 * the ratio. It does not make these times measured — they are still spread
 * across a cue — but it removes the one error whose size is known, and it is
 * the difference between a word landing inside its clip and not existing.
 */
/*
 * Brand names a transcriber cannot know.
 *
 * "RoleModel" is one word with two capitals, and no speech model spells it that
 * way — it comes back as "role model" or "Role Model", two words, and lands on
 * screen as somebody's employer misspelt in their own video. Correcting it in
 * the caption file would fix one clip and lose the fix the next time anything is
 * re-transcribed, so it is done where the words are read.
 *
 * A merge, not a substitution: two timed words become one, taking the first
 * one's start and the second one's end, so the word lights when "role" is said
 * and stays until "model" is finished.
 */
const BRAND_PAIRS = [
	[/^role$/i, /^model[.,!?;:]?$/i, "RoleModel"],
];

function brandWords(words) {
	const out = [];
	for (let i = 0; i < words.length; i += 1) {
		const pair = BRAND_PAIRS.find(([a, b]) => a.test(words[i].text) && words[i + 1] && b.test(words[i + 1].text));
		if (!pair) {
			out.push(words[i]);
			continue;
		}
		const [, , joined] = pair;
		const next = words[i + 1];
		/* Punctuation the second word carried belongs to the joined word. */
		const tail = (next.text.match(/[.,!?;:]$/) ?? [""])[0];
		out.push({ ...words[i], text: `${joined}${tail}`, endSec: next.endSec ?? words[i].endSec });
		i += 1;
	}
	return out;
}

async function wordsFor(projectDir, rel) {
	const key = Buffer.from(rel, "utf8").toString("base64url");
	const stem = join(projectDir, "paper-edits", key);
	const doc = await readFile(`${stem}.json`, "utf8").then(JSON.parse).catch(() => null);
	/*
	 * The captions, when there is no saved transcript beside them.
	 *
	 * A clip transcribed but not yet opened in the paper edit has a .vtt and no
	 * .json — which read as "this speaker says nothing" and dropped the whole
	 * segment's words with no complaint. Same parser the server uses, so a cue
	 * divides into words the same way wherever it is read.
	 */
	/*
	 * Whichever was written last, not whichever is a .json.
	 *
	 * The saved paper edit was preferred outright, so a freshly transcribed .vtt
	 * beside a three-day-old .json was ignored and the words came from the stale
	 * one — which reads as "the transcript is nothing like what I say", with
	 * nothing on screen to say a newer one exists. Re-transcribing had no effect
	 * at all.
	 *
	 * The paper edit still wins on a tie, because it is the edited one: a person
	 * has corrected it, and captions are only the machine's first guess.
	 */
	const captions = await readFile(`${stem}.vtt`, "utf8")
		.then((raw) => transcriptFromCaptions(raw).words)
		.catch(() => []);
	const at = async (file) => (await stat(file).then((info) => info.mtimeMs).catch(() => 0));
	const saved = doc?.transcript?.words?.length ? doc.transcript.words : [];
	const chosen = saved.length && (!captions.length || (await at(`${stem}.json`)) >= (await at(`${stem}.vtt`))) ? saved : captions;
	if (!chosen.length) return chosen;
	/* Brand names first, so everything downstream — grouping, phrase budgets,
	   word ids — counts the joined word once. */
	const words = brandWords(chosen);

	const media = await durationOf(join(projectDir, "media", rel)).catch(() => 0);
	const spoken = words.at(-1).endSec;
	if (!(media > 0) || !(spoken > media)) return words;

	const scale = media / spoken;
	return words.map((word) => ({ ...word, startSec: word.startSec * scale, endSec: word.endSec * scale }));
}

/*
 * The card attributes this builder owns, and the ones it must not touch.
 *
 * Timing belongs to the builder — class, data-start, data-duration, at, for —
 * because those are what the runtime keys visibility off and what a rebuild
 * has to recompute. Everything else is design, and design gets hand-edited in
 * the composition after it is generated. Regenerating used to overwrite that
 * silently, so the opening card is passed in and the caller keeps its own.
 */
const attrs = (map) =>
	Object.entries(map)
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([name, value]) => `${name}="${esc(value)}"`)
		.join(" ");

/*
 * Where the speaker's circle sits, and how big it is.
 *
 * In the recipe rather than in this stylesheet, because it is the setting most
 * likely to be wrong for a given cut — a circle sized for one talking head
 * crowds a wider shot — and every rebuild used to reset whatever it had been
 * tuned to. Percentages of the frame's width, so it holds at any render size.
 *
 * `aspect` is why this is not just a diameter. A circle cut from 16:9 shows
 * 56% of the frame's width and no more: object-fit fills the height, so the
 * sides are gone whatever object-position does. That is the floor, so "too
 * zoomed in" cannot be answered by moving the crop — only by widening the
 * window. aspect 1 with radius 50 is the circle; 16/9 with a small radius is
 * the whole shot, uncropped; anything between trades one for the other.
 */
const PIP = { size: 46, right: -8, bottom: -4, aspect: 1, radius: 50 };

/**
 * The words, as blocks and as timing data, for a given set of clip windows.
 *
 * Exported because a composition gets retimed after it is built — a clip is
 * trimmed or moved in HyperFrames — and when that happens the words have to be
 * recomputed against the windows the file now has. Two implementations of this
 * would mean a rebuild and a retime disagreeing about where a phrase belongs,
 * which is the bug it exists to fix.
 */
export async function sayTrack({ projectDir, clips }) {
	const lines = [];
	/*
	 * The timeline as data, not as code.
	 *
	 * Every tween here is one of three shapes repeated: a phrase fades in and
	 * out, a word brightens once, a speaker's block leaves at its out point. Six
	 * hundred lines of `tl.to(...)` states those shapes three hundred times over
	 * — unreadable, undiffable, and the numbers you actually want to check are
	 * buried in the boilerplate around them.
	 *
	 * So the builder emits the numbers and the composition carries a short loop
	 * that turns them into the timeline. A retime rewrites a table of times; the
	 * shapes stay where they are stated once.
	 */
	/*
	 * Times relative to the clip, not to the composition.
	 *
	 * A speaker's words and the take they belong to are one thing, and they were
	 * stored as two: the video carried its own window and the words carried
	 * absolute composition times computed from it. Move the clip in HyperFrames
	 * and the words stayed where they were — the caption ran seconds ahead of the
	 * mouth, and the only cure was a retime.
	 *
	 * So a cue states which clip it belongs to and how far into that clip it
	 * happens. The composition reads each clip's own data-start when it builds
	 * the timeline, which means moving a clip moves its words with it and there
	 * is nothing left to keep in step.
	 */
	const phrases = [];
	/* Not `words`: the per-clip word list inside the loop already owns that name,
	   and shadowing it here silently pushed every cue into the wrong array. */
	const wordCues = [];
	const outs = [];
	/* One row per speaker: which clip, and how long they take to arrive. */
	const pips = [];
	let wordIndex = 0;

	for (const [index, clip] of clips.entries()) {
		const words = await wordsFor(projectDir, clip.src);
		/*
		 * A word is in the cut if it STARTS inside the window.
		 *
		 * Tempting to accept any word that overlaps, so one straddling the out
		 * point is not lost. But the same leniency at the IN point shows a word
		 * twice — once as the previous speaker's tail and once as this one's
		 * opening — and a caption that repeats a word across a cut is worse than
		 * one that stops a word early.
		 *
		 * So a word cut off by a trim is genuinely not in the cut, and the fix is
		 * the trim: extend the clip past the word rather than teach the filter to
		 * reach past the clip.
		 */
		const inRange = words.filter((w) => w.startSec >= clip.ms && w.startSec < clip.ms + clip.dur);

		/*
		 * Words come in groups that replace each other, not one growing block.
		 *
		 * A speaker gets through sixty-odd words in twenty seconds, and sixty
		 * words at a readable size do not fit beside a face — the first cut
		 * simply overflowed the frame. This is what a caption does: a phrase at
		 * a time, broken where the sentence breaks, so the size stays fixed and
		 * the text always fits.
		 */
		const groups = [];
		let current = [];
		const width = (words) => words.reduce((n, w) => n + w.text.length + 1, -1);
		for (const word of inRange) {
			/* Break BEFORE the word that would overflow, not after — breaking
			   after is how a phrase ends up one word too long for its box. */
			if (current.length >= GROUP_MIN && width([...current, word]) > GROUP_CHARS) {
				/* Back up to the last clause opener, if doing so still leaves a
				   phrase worth reading on its own. */
				let cut = current.length;
				for (let i = current.length - 1; i >= GROUP_MIN; i -= 1) {
					if (CLAUSE_OPENERS.has(current[i].text.toLowerCase().replace(/[^a-z']/g, ""))) {
						cut = i;
						break;
					}
				}
				groups.push(current.slice(0, cut));
				current = current.slice(cut);
			}
			current.push(word);
			const ends = /[.!?]$/.test(word.text);
			const commaPause = /[,;:]$/.test(word.text) && current.length >= GROUP_MIN;
			if ((ends && current.length >= 4) || commaPause || current.length >= GROUP_MAX) {
				groups.push(current);
				current = [];
			}
		}
		if (current.length) groups.push(current);

		const blocks = groups.map((group, groupIndex) => {
			const groupId = `g${index + 1}-${groupIndex + 1}`;
			const at = clip.start + (group[0].startSec - clip.ms);
			// A group leaves when the next one arrives, or with its speaker.
			const nextAt = groups[groupIndex + 1]
				? clip.start + (groups[groupIndex + 1][0].startSec - clip.ms)
				: clip.start + clip.dur;
			/* Baselines at zero, so seeking to any frame gives the same picture as
			   playing to it — the renderer only ever seeks. */
			/* id, in, out — the kill is added below, once the next phrase is known. */
			/* id, clip, in, out, gone — the three times measured from the clip's
			   own start, so the row survives the clip being moved. */
			phrases.push([
				groupId,
				index + 1,
				+(at - clip.start).toFixed(3),
				+(Math.max(at, nextAt - PHRASE_FADE) - clip.start).toFixed(3),
				+(nextAt - clip.start).toFixed(3),
			]);
			/*
			 * The hard kill at the boundary, which a fade alone does not give.
			 *
			 * The renderer seeks; it does not play. A seek landing after the
			 * fade has started but before it has finished leaves the phrase
			 * part-visible over the next speaker, and a seek past the boundary
			 * leaves whatever state the last render happened to end on. The
			 * `set` is what makes an arbitrary frame land in the same state as
			 * playing through it — the same reason the say block has one, and
			 * it was dropped from the groups when this was rewritten to
			 * cross-fade.
			 */


			/*
			 * The whole phrase is readable; what has been said is lit.
			 *
			 * The phrase is on screen at half strength from the moment it
			 * arrives, so it can be read ahead of the voice, and each word comes
			 * up to full as it is spoken and stays there. Nothing returns to dim
			 * inside a phrase — the line fills, and the filled part is where the
			 * speaker has got to.
			 */
			const said = group.map((word) => {
				const wordAt = clip.start + (word.startSec - clip.ms);
				const id = `w${(wordIndex += 1)}`;
				wordCues.push([id, index + 1, +(wordAt - clip.start).toFixed(3)]);
				return `<span id="${id}" class="word">${esc(word.text)}</span>`;
			});
			return `<div id="${groupId}" class="say__group">${said.join(" ")}</div>`;
		});
		const spans = blocks;

		/*
		 * The exit rides an inner element, not the clip.
		 *
		 * The framework owns a .clip's visibility, so fading the clip itself
		 * fights it — and a seek that lands past the fade leaves the block
		 * half-gone. The hard kill at the boundary is what makes an arbitrary
		 * seek land in the same state as playing through it.
		 */
		const out = clip.start + clip.dur;
		/* Measured from the clip's start like everything else, so a clip that is
		   retrimmed takes its own exit with it. */
		outs.push([`say-${index + 1}-in`, index + 1, +(out - 0.4 - clip.start).toFixed(3), +(out - clip.start).toFixed(3)]);
		pips.push([index + 1, index === 0 ? PIP_FIRST_FADE : PIP_FADE]);
		lines.push(
			`    <div id="say-${index + 1}" class="clip say" data-start="${seconds(clip.start * 1000)}" data-duration="${seconds(clip.dur * 1000)}" data-track-index="${index + 20}">` +
				`<div id="say-${index + 1}-in" class="say__in">` +
				`<div class="say__who">${esc(clip.speaker ?? "")}</div><div class="say__words">${spans.join(" ")}</div>` +
				`</div></div>`,
		);
	}

	return { lines, phrases, words: wordIndex, wordCues, outs, pips };
}

export async function buildPip(projectId, folder = "canvas-pip-transcript", { clips: given, title, closing, opening, pip, wallpaper = "rm-brand.jpg", scrim = true, keep = [] } = {}) {
	const shot = { ...PIP, ...(pip ?? {}) };
	let clips = given;
	const root = defaultRoot();
	const projectDir = join(root, projectId);
	const outDir = join(projectDir, "media", "Renders", folder);
	await mkdir(outDir, { recursive: true });

	/*
	 * Each clip contributes its own words, shifted onto the composition clock.
	 *
	 * A word is timed against its own file, so it moves by the clip's position
	 * minus where the clip starts inside that file. Words outside the trimmed
	 * range are dropped rather than clamped: a word that was cut is not a word
	 * that appears at second zero.
	 */
	const notes = [];

	/*
	 * No clip may ask for footage its file does not contain.
	 *
	 * dallas.mp4 is 15.67s and its window ran 0.39 → 18.19, so the last 2.5
	 * seconds of that segment were one frozen frame while the words had already
	 * run out — and every clip after it sat 2.5 seconds off the speech. A
	 * window is clamped to what exists, and the clips are re-chained from the
	 * clamped lengths rather than the asked-for ones.
	 */
	const cut = [];
	let at = clips[0]?.start ?? 0;
	for (const clip of clips) {
		const media = await durationOf(join(projectDir, "media", clip.src)).catch(() => 0);
		const room = media > 0 ? media - clip.ms : clip.dur;
		const dur = Math.min(clip.dur, room);
		if (dur < clip.dur - 0.01) notes.push(`${clip.src}: asked for ${clip.dur.toFixed(2)}s from ${clip.ms.toFixed(2)}s, file holds ${room.toFixed(2)}s`);
		cut.push({ ...clip, start: at, dur });
		at += dur;
	}
	clips = cut;

	const { lines, phrases, words: wordIndex, wordCues, outs, pips } = await sayTrack({ projectDir, clips });

	/*
	 * Each speaker's transcript is its own file.
	 *
	 * The words are the bulk of this composition — six blocks of them against
	 * everything else put together — and they are the part somebody reads and
	 * corrects. Kept inline they made one file nobody could diff: HyperFrames
	 * reformats a block onto one line per word when it saves, so six blocks
	 * emitted as six lines came back as several hundred.
	 *
	 * The mount host carries no window of its own and lays out as nothing at
	 * all. The say block inside it keeps its own data-start, so the clip the
	 * runtime steps is still the clip the generator wrote — the file boundary
	 * is a boundary in the source, not in the timeline.
	 */
	const parts = clips.map((clip, index) => ({
		file: `compositions/say-${index + 1}.html`,
		speaker: clip.speaker ?? `speaker ${index + 1}`,
		body: lines[index].trim(),
	}));
	/*
	 * The shape HyperFrames requires, which is stricter than it looks.
	 *
	 * A mount host needs both a composition id and a stable id of its own, and
	 * the file it names has to be a whole composition — its own root carrying
	 * data-composition-id and dimensions — not the fragment it feels like. Get
	 * any of that wrong and `hyperframes check` rejects the file and Studio
	 * renders the mount as nothing, which reads as the transcript vanishing.
	 *
	 * The wrapper is not in the final DOM: given a composition id, the inliner
	 * takes the root's innerHTML, so the say block lands directly in the host.
	 */
	const mounts = parts.map((part, index) =>
		`    <div id="say-${index + 1}-mount" class="say-mount" data-composition-id="say-${index + 1}"`
		+ ` data-composition-src="${part.file}" data-track-index="${index + 20}"></div>`);

	/*
	 * Framing is per speaker, because the framing is.
	 *
	 * Three knobs, and they are not interchangeable:
	 *
	 *   focus   where the crop sits ACROSS the frame — 0 shows the left edge,
	 *           100 the right. This is object-position, and it works because
	 *           cropping 16:9 to a circle leaves horizontal slack.
	 *   zoom    how much of the recording the circle shows. 1 is the whole
	 *           frame; 1.6 shows a bit under two thirds of it, which is what
	 *           makes a wide shot match a close one.
	 *   focusY  where that zoomed view sits UP AND DOWN the frame. It does
	 *           nothing at zoom 1 and cannot: a square cut from 16:9 already
	 *           fills the height, so there is no vertical slack until zoom
	 *           creates some. This is why the first version's "center 30%" had
	 *           no effect, and why the fix is zoom rather than a Y position.
	 *
	 * One element, not a wrapper around it. A timed <video> inside a timed <div>
	 * makes the frame extractor read the video's own start while visibility uses
	 * the wrapper's window, and the two disagree — the linter names this exactly.
	 * That rules out a transform zoom, which needs something to clip it. So zoom
	 * is object-view-box, which crops into the recording's own box without
	 * touching the element: no wrapper, no transform, and at zoom 1 it resolves
	 * to inset(0%) — byte-identical to what this drew before it existed.
	 */
	const media = clips.map((clip, index) => {
		const focus = Number.isFinite(clip.focus) ? clip.focus : 50;
		/* Only what differs from the default is written. A style attribute
		   carrying --pip-zoom:1 on every clip is noise in a file people edit. */
		const zoom = Number(clip.zoom) > 0 ? Number(clip.zoom) : 1;
		const focusY = clip.focusY ?? 50;
		const framing = [`--pip-focus:${focus}%`, ...(zoom !== 1 ? [`--pip-zoom:${zoom}`] : []), ...(zoom !== 1 && focusY !== 50 ? [`--pip-y:${focusY}`] : [])].join(";");
		return `    <video id="pip-${index + 1}" class="clip pip" data-assembly-media src="source/${clip.src}" data-start="${seconds(clip.start * 1000)}" data-duration="${seconds(clip.dur * 1000)}" data-media-start="${seconds(clip.ms * 1000)}" data-track-index="${index}" data-has-audio="true" playsinline preload="auto" style="${framing}"></video>`;
	});

	const last = clips.at(-1);
	const endsAt = last.start + last.dur;
	const cardSeconds = 3;
	/* A cut that ends on something else — a haze, a still, anything inserted —
	   should not also carry the built-in card. `closing: ""` says so, and the
	   runtime stops where the clips do. */
	const total = endsAt + (closing === false || closing === "" ? 0 : cardSeconds);

	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${esc(title ?? "PIP cut")}</title>
    <link rel="stylesheet" href="theme.css" />
    <script type="module" src="assets/canvas-components/rm-video.js"></script>
    <script src="assets/vendor/gsap.min.js"></script>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: var(--color-dark); }
      /*
       * The brand wall behind everything.
       *
       * Three layers by default: a gradient that darkens the paper so light type
       * stays readable on it, the wallpaper, and the ground colour under both —
       * because a jpeg that fails to load must not leave white paper behind
       * white type.
       *
       * scrim:false writes the wallpaper alone. A wallpaper that is already
       * dark does not want darkening, and the gradient over it reads as a
       * mistake — which is why it kept being deleted by hand and kept coming
       * back on the next rebuild.
       */
      [data-composition-id] { position: relative; width: 1920px; height: 1080px; overflow: hidden;
        background: ${scrim === false
					? `url("assets/wallpapers/${esc(wallpaper ?? "rm-brand.jpg")}") center / cover`
					: `linear-gradient(color-mix(in srgb, var(--color-dark) 62%, transparent), color-mix(in srgb, var(--color-dark) 78%, transparent)),
                    url("assets/wallpapers/${esc(wallpaper ?? "rm-brand.jpg")}") center / cover,
                    var(--color-dark)`};
        font-family: var(--font-display); container-type: inline-size; }

      /*
       * The speaker is a circle, and the circle is the smaller thing on screen.
       *
       * object-fit: cover with a centred position, because a talking head framed
       * for a full 16:9 frame has its subject in the middle and a square crop of
       * the left third is a shoulder.
       */
      /*
       * The pip's crop, as properties rather than baked numbers.
       *
       * Every one of these is a custom property with a default on the
       * composition, so it can be changed in HyperFrames without editing a
       * stylesheet — set --pip-size on the composition to move every speaker,
       * or on one <video> to move only that one.
       *
       * --pip-focus moves the crop across the frame, 0% the left edge and 100%
       * the right. --pip-zoom is how much of the recording the circle shows, 1
       * being all of it. --pip-y moves that view up and down and does nothing
       * at zoom 1, because a square cut from 16:9 has no vertical slack until
       * zoom makes some.
       *
       * The inset is arithmetic rather than three more numbers to keep in step:
       * --pip-vis is the visible fraction, the left inset centres it (across is
       * object-position's job at every zoom), and the top is clamped so a pip
       * pushed to an edge stops there instead of showing nothing.
       */
      [data-composition-id] { --pip-size: ${shot.size}cqw; --pip-aspect: ${shot.aspect}; --pip-right: ${shot.right}cqw;
             --pip-bottom: ${shot.bottom}cqw; --pip-radius: ${shot.radius}%; --pip-focus: 50%;
             --pip-zoom: 1; --pip-y: 50; }
      .pip { position: absolute; right: var(--pip-right); bottom: var(--pip-bottom);
             width: var(--pip-size); height: calc(var(--pip-size) / var(--pip-aspect));
             border-radius: var(--pip-radius); object-fit: cover; object-position: var(--pip-focus) 50%;
             --pip-vis: calc(100 / var(--pip-zoom));
             --pip-t: clamp(0, var(--pip-y) - var(--pip-vis) / 2, 100 - var(--pip-vis));
             --pip-l: calc((100 - var(--pip-vis)) / 2);
             object-view-box: inset(calc(var(--pip-t) * 1%) calc(var(--pip-l) * 1%)
                                    calc((100 - var(--pip-t) - var(--pip-vis)) * 1%) calc(var(--pip-l) * 1%));
             border: .3cqw solid color-mix(in srgb, var(--color-light) 22%, transparent);
             box-shadow: 0 2cqw 6cqw rgba(0,0,0,.5); }

      /* The words start at the top left and grow down, which is where reading
         starts — the speaker sits opposite so the two never overlap. */
      /* A mount point is a seam in the source, not a box in the picture. It
         lays out as nothing, so the say block inside it positions against the
         composition and resolves cqw against it exactly as it did inline. */
      .say-mount { display: contents; }
      .say { position: absolute; left: 6cqw; top: 9cqw; width: 56cqw; }
      .say__who { color: var(--color-accent); font-family: var(--font-mono); font-size: 1.5cqw;
                  letter-spacing: .16em; text-transform: uppercase; margin-bottom: 1.2cqw; }
      /* Every group occupies the same box, so a short phrase and a long one
         start on the same line instead of the text jumping up the frame. */
      .say__words { position: relative; min-block-size: 22cqw; }
      .say__group { position: absolute; inset-block-start: 0; opacity: 0;
                    color: var(--color-light); font-size: 3.4cqw; font-weight: 700;
                    line-height: 1.28; letter-spacing: -.02em; }
      /* Half strength is the resting state: the phrase can be read before it is
         spoken, and the word being said is the one at full weight. */
      .word { opacity: ${WORD_DIM}; display: inline-block; margin-right: .28em; }
      /* Present so it plays, invisible because it is a clock and not a picture. */
      .pip-clock { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    </style>
  </head>
  <body>
    <!--
      No data-no-timeline: this composition DOES register one.

      The flag exists to stop the producer polling 45 seconds for a timeline
      that is never coming, and it was carried here from a composition that had
      none. But the transcript is a GSAP timeline on window.__timelines, so the
      flag was telling HyperFrames not to look for the very thing it needs to
      drive — the words never advanced under its own playback, and the clips it
      steps were the only thing moving.
    -->
    <main id="pip" data-composition-id="pip" data-start="0" data-duration="${seconds(total * 1000)}" data-width="1920" data-height="1080" data-fps="30">
${keep.length ? `    <!--\n      Kept from the composition, not generated here.\n\n      A rebuild writes this file from the recipe, and anything added by hand in\n      HyperFrames is not in the recipe — so every rebuild silently deleted it.\n      Somebody who inserted four backgrounds and then nudged a framing lost all\n      four and had no way to know. These come back untouched, at the top,\n      because a full-frame ground belongs behind the type.\n    -->\n${keep.join("\n")}\n` : ""}
    <!--
      A silent track the length of the composition.

      RM.seek is driven by media events, and the opening and closing cards play
      over no footage at all — so without this the clock never advances during
      them and the field never draws. The same trick the assembly exporter uses
      for title-only spans.
    -->
    <audio id="pip-clock" class="pip-clock" src="assets/clock.m4a" data-assembly-clock data-start="0" data-duration="${seconds(total * 1000)}" data-media-start="0" preload="auto"></audio>

    <rm-study-field id="open-field" class="clip" data-start="0.000" data-duration="${seconds(cardSeconds * 1000)}" data-track-index="90" at="0" for="${Math.round(cardSeconds * 1000)}"
      ${attrs({ mode: "bloom", phase: "1.4", eyebrow: title ? "CCC Days" : "", title: title ?? "", size: "6.6", align: "center", ...(opening ?? {}) })}></rm-study-field>

${media.join("\n")}

${mounts.join("\n")}

${closing === false || closing === ""
		? "    <!-- no closing card: this cut ends on something inserted instead -->"
		: `    <rm-study-field id="close-field" class="clip" data-start="${seconds(endsAt * 1000)}" data-duration="${seconds(cardSeconds * 1000)}" data-track-index="91" at="${Math.round(endsAt * 1000)}" for="${Math.round(cardSeconds * 1000)}"
      mode="wipe" phase="3.1" title="${esc(closing ?? "Thanks for watching")}" size="6.6" align="center"></rm-study-field>`}
    </main>

  <script>
    /* HyperFrames seeks and plays each timed media element; this puts the
       composition clock on the page so the Canvas components follow it. */
    const syncPip = (event) => {
      const media = event.target;
      if (!(media instanceof HTMLMediaElement) || !media.matches('[data-assembly-media], [data-assembly-clock]')) return;
      const ms = (Number(media.dataset.start) || 0) * 1000
        + Math.max(0, media.currentTime - (Number(media.dataset.mediaStart) || 0)) * 1000;
      document.documentElement.style.setProperty('--t', ms + 'ms');
      window.RM?.seek(ms);
    };
    for (const name of ['timeupdate', 'seeked', 'loadeddata']) document.addEventListener(name, syncPip, true);
  </script>
  <script>
    /*
     * The words, as GSAP tweens on the composition clock.
     *
     * GSAP because it is the animation the renderer actually seeks — a CSS
     * animation keyed off --t is not driven frame by frame and only flashes.
     * Every word is positioned in absolute composition time, so a word appears
     * when it is said and stays until its speaker leaves.
     */
    (function () {
      if (!window.gsap) return;
      var tl = gsap.timeline({ paused: true });

      /*
       * Three shapes, stated once, applied to a table of times.
       *
       * Every tween in this composition is one of these: a phrase fades in and
       * back out, a word brightens as it is said, a speaker's block leaves at
       * its out point. Writing them out per cue was six hundred lines of
       * boilerplate with the numbers that matter buried inside it.
       *
       * PHRASE [id, clip, in, out, gone]  WORD [id, clip, at]  OUT [id, clip, from, gone]
       */
      var FADE = ${PHRASE_FADE}, FILL = ${WORD_FILL}, DIM = ${WORD_DIM};
      var PHRASE = ${JSON.stringify(phrases)};
      var WORD = ${JSON.stringify(wordCues)};
      var OUT = ${JSON.stringify(outs)};
      /* [clip, how long that speaker takes to arrive] */
      var PIPS = ${JSON.stringify(pips)};
      var PIP_OUT = ${PIP_FADE};

${TIMELINE_LOOPS}

      window.__timelines = window.__timelines || {};
      window.__timelines['pip'] = tl;
    })();
  </script>
</body>
</html>
`;

	await writeFile(join(outDir, "index.html"), html, "utf8");
	/*
	 * The transcripts, one file each.
	 *
	 * Deliberately not carrying data-composition-id: HyperFrames treats an HTML
	 * file with that attribute as a composition in its own right, and six more
	 * of those would show up as six more things to open and render. These are
	 * fragments of one composition, and the folder keeps them out of the way.
	 */
	await mkdir(join(outDir, "compositions"), { recursive: true });
	for (const [index, part] of parts.entries()) {
		await writeFile(
			join(outDir, part.file),
			`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(part.speaker)}</title>
</head>
<body>
<div data-composition-id="say-${index + 1}" data-width="1920" data-height="1080">
${part.body}
</div>
</body>
</html>
`,
			"utf8",
		);
	}
	/* The recipe, beside the result. The clip list lived only in whatever command
	   was typed to build this, so rebuilding meant reverse-engineering the
	   windows back out of the composition. */
	await writeFile(join(outDir, "clips.json"), `${JSON.stringify({ title, closing, wallpaper, scrim, opening, pip: shot, clips }, null, 2)}\n`, "utf8");
	return { outDir, words: wordIndex, seconds: total, clips, notes };
}

/*
 * Rebuild from the recipe beside the composition.
 *
 * clips.json records what a cut was built from, and nothing read it — so a
 * rebuild still meant retyping the windows, the framing and the card copy, and
 * getting one of them wrong. Run with a project and a folder and it rebuilds
 * exactly what is there, which is also how a framing correction survives.
 *
 *   node lib/make-pip.mjs rolemodel-ccc-days canvas-pip-transcript
 */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
	const [projectId, folder = "canvas-pip-transcript"] = process.argv.slice(2);
	if (!projectId) {
		console.error("usage: node lib/make-pip.mjs <projectId> [folder]");
		process.exit(1);
	}
	const recipe = join(defaultRoot(), projectId, "media", "Renders", folder, "clips.json");
	const spec = await readFile(recipe, "utf8").then(JSON.parse).catch(() => null);
	if (!spec?.clips?.length) {
		console.error(`no recipe at ${recipe} — build it once with buildPip() and it writes one`);
		process.exit(1);
	}
	const built = await buildPip(projectId, folder, spec);
	console.log(`  ${built.words} words, ${built.seconds.toFixed(3)}s`);
	for (const note of built.notes) console.log(`  clamped — ${note}`);
	for (const clip of built.clips) {
		console.log(`  ${clip.src.padEnd(24)} ${clip.start.toFixed(3).padStart(8)} → ${(clip.start + clip.dur).toFixed(3).padStart(8)}  focus ${clip.focus ?? 50}/${clip.focusY ?? 50} zoom ${clip.zoom ?? 1}`);
	}
}
