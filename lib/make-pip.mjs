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
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
const PHRASE_FADE = 0.32;
const WORD_FILL = 0.2;
const WORD_DIM = 0.45;

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
	const words = doc?.transcript?.words?.length
		? doc.transcript.words
		: await readFile(`${stem}.vtt`, "utf8").then((raw) => transcriptFromCaptions(raw).words).catch(() => []);
	if (!words.length) return words;

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
 */
const PIP = { size: 46, right: -8, bottom: -4 };

export async function buildPip(projectId, folder = "canvas-pip-transcript", { clips: given, title, closing, opening, pip, wallpaper = "rm-brand.jpg" } = {}) {
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
	const lines = [];
	const tweens = [];
	const notes = [];
	let wordIndex = 0;

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

	for (const [index, clip] of clips.entries()) {
		const words = await wordsFor(projectDir, clip.src);
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
			tweens.push(`      tl.set('#${groupId}', { opacity: 0 }, 0);`);
			tweens.push(`      tl.to('#${groupId}', { opacity: 1, duration: ${PHRASE_FADE}, ease: 'power1.out' }, ${at.toFixed(3)});`);
			tweens.push(`      tl.to('#${groupId}', { opacity: 0, duration: ${PHRASE_FADE}, ease: 'power1.in' }, ${Math.max(at, nextAt - PHRASE_FADE).toFixed(3)});`);
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
			tweens.push(`      tl.set('#${groupId}', { opacity: 0 }, ${nextAt.toFixed(3)});`);

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
				tweens.push(`      tl.set('#${id}', { opacity: ${WORD_DIM} }, 0);`);
				tweens.push(`      tl.to('#${id}', { opacity: 1, duration: ${WORD_FILL}, ease: 'power1.out' }, ${wordAt.toFixed(3)});`);
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
		tweens.push(`      tl.to('#say-${index + 1}-in', { opacity: 0, duration: 0.4, ease: 'none' }, ${(out - 0.4).toFixed(3)});`);
		tweens.push(`      tl.set('#say-${index + 1}-in', { opacity: 0 }, ${out.toFixed(3)});`);
		lines.push(
			`    <div id="say-${index + 1}" class="clip say" data-start="${seconds(clip.start * 1000)}" data-duration="${seconds(clip.dur * 1000)}" data-track-index="${index + 20}">` +
				`<div id="say-${index + 1}-in" class="say__in">` +
				`<div class="say__who">${esc(clip.speaker ?? "")}</div><div class="say__words">${spans.join(" ")}</div>` +
				`</div></div>`,
		);
	}

	/*
	 * Framing is per speaker, because the framing is.
	 *
	 * Cropping 16:9 to a circle scales to fill the height, so there is no
	 * vertical overflow to slide — an object-position Y does nothing here, which
	 * is why the first version's "center 30%" had no effect. Horizontal is the
	 * axis that moves. The default is centred; where a speaker was not framed
	 * centrally, the clip carries its own `focus` — a percentage, exactly what
	 * object-position takes, so 0 shows the left edge and 100 the right.
	 *
	 * One element, not a wrapper around it. A timed <video> inside a timed <div>
	 * makes the frame extractor read the video's own start while visibility uses
	 * the wrapper's window, and the two disagree — the linter names this exactly.
	 * That rules out a transform zoom, which needs something to clip it; framing
	 * here is the crop, and focus is what moves the crop.
	 */
	const media = clips.map((clip, index) => {
		const focus = Number.isFinite(clip.focus) ? clip.focus : 50;
		return `    <video id="pip-${index + 1}" class="clip pip" data-assembly-media src="source/${clip.src}" data-start="${seconds(clip.start * 1000)}" data-duration="${seconds(clip.dur * 1000)}" data-media-start="${seconds(clip.ms * 1000)}" data-track-index="${index}" data-has-audio="true" playsinline preload="auto" style="object-position:${focus}% 50%"></video>`;
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
      /* The brand wall behind everything, with the ground under it: a jpeg that
         fails to load must not leave white paper behind white type. */
      [data-composition-id] { position: relative; width: 1920px; height: 1080px; overflow: hidden;
        background: linear-gradient(color-mix(in srgb, var(--color-dark) 62%, transparent), color-mix(in srgb, var(--color-dark) 78%, transparent)),
                    url("assets/wallpapers/${esc(wallpaper ?? "rm-brand.jpg")}") center / cover,
                    var(--color-dark);
        font-family: var(--font-display); container-type: inline-size; }

      /*
       * The speaker is a circle, and the circle is the smaller thing on screen.
       *
       * object-fit: cover with a centred position, because a talking head framed
       * for a full 16:9 frame has its subject in the middle and a square crop of
       * the left third is a shoulder.
       */
      .pip { position: absolute; right: ${shot.right}cqw; bottom: ${shot.bottom}cqw; width: ${shot.size}cqw; height: ${shot.size}cqw;
             border-radius: 50%; object-fit: cover;
             border: .3cqw solid color-mix(in srgb, var(--color-light) 22%, transparent);
             box-shadow: 0 2cqw 6cqw rgba(0,0,0,.5); }

      /* The words start at the top left and grow down, which is where reading
         starts — the speaker sits opposite so the two never overlap. */
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
    <main id="pip" data-composition-id="pip" data-start="0" data-duration="${seconds(total * 1000)}" data-width="1920" data-height="1080" data-fps="30" data-no-timeline>
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

${lines.join("\n")}

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
${tweens.join("\n")}
      window.__timelines = window.__timelines || {};
      window.__timelines['pip'] = tl;
    })();
  </script>
</body>
</html>
`;

	await writeFile(join(outDir, "index.html"), html, "utf8");
	/* The recipe, beside the result. The clip list lived only in whatever command
	   was typed to build this, so rebuilding meant reverse-engineering the
	   windows back out of the composition. */
	await writeFile(join(outDir, "clips.json"), `${JSON.stringify({ title, closing, wallpaper, opening, pip: shot, clips }, null, 2)}\n`, "utf8");
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
		console.log(`  ${clip.src.padEnd(24)} ${clip.start.toFixed(3).padStart(8)} → ${(clip.start + clip.dur).toFixed(3).padStart(8)}  focus ${clip.focus ?? 50}`);
	}
}
