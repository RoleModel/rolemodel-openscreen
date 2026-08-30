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

const esc = (value) =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

const seconds = (ms) => (Math.max(0, Math.round(Number(ms) || 0)) / 1000).toFixed(3);

/* A phrase, in words. Long enough to read as a sentence, short enough that the
   longest of them still fits beside a face at a readable size. */
const GROUP_MIN = 5;
const GROUP_MAX = 12;

/** The transcript for one media file, by the same base64url key Studio uses. */
async function wordsFor(projectDir, rel) {
	const key = Buffer.from(rel, "utf8").toString("base64url");
	const file = join(projectDir, "paper-edits", `${key}.json`);
	const doc = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
	return doc?.transcript?.words ?? [];
}

export async function buildPip(projectId, folder = "canvas-pip-transcript", { clips, title, closing, wallpaper = "rm-brand.jpg" } = {}) {
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
	let wordIndex = 0;

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
		for (const word of inRange) {
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
			tweens.push(`      tl.set('#${groupId}', { opacity: 1 }, ${at.toFixed(3)});`);
			tweens.push(`      tl.to('#${groupId}', { opacity: 0, duration: 0.28, ease: 'none' }, ${Math.max(at, nextAt - 0.28).toFixed(3)});`);
			tweens.push(`      tl.set('#${groupId}', { opacity: 0 }, ${nextAt.toFixed(3)});`);

			/*
			 * The whole phrase is readable; the word being said is lit.
			 *
			 * Words used to arrive one at a time, which made the line jump as it
			 * grew and put all the weight on times that are only approximate —
			 * these transcripts spread word times evenly across a caption cue
			 * rather than measuring them. Showing the phrase at half strength and
			 * lighting the current word keeps it readable even where the
			 * highlight runs a little ahead or behind.
			 */
			const said = group.map((word, wordPlace) => {
				const wordAt = clip.start + (word.startSec - clip.ms);
				const until = group[wordPlace + 1]
					? clip.start + (group[wordPlace + 1].startSec - clip.ms)
					: Math.min(nextAt, clip.start + (word.endSec - clip.ms));
				const id = `w${(wordIndex += 1)}`;
				tweens.push(`      tl.set('#${id}', { opacity: 1 }, ${wordAt.toFixed(3)});`);
				tweens.push(`      tl.set('#${id}', { opacity: 0.5 }, ${Math.max(wordAt, until).toFixed(3)});`);
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

	const media = clips.map(
		(clip, index) =>
			`    <video id="pip-${index + 1}" class="clip pip" data-assembly-media src="source/${clip.src}" data-start="${seconds(clip.start * 1000)}" data-duration="${seconds(clip.dur * 1000)}" data-media-start="${seconds(clip.ms * 1000)}" data-track-index="${index}" data-has-audio="true" playsinline preload="auto"></video>`,
	);

	const last = clips.at(-1);
	const endsAt = last.start + last.dur;
	const cardSeconds = 3;
	const total = endsAt + cardSeconds;

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
      .pip { position: absolute; right: 6cqw; bottom: 8cqw; width: 26cqw; height: 26cqw;
             border-radius: 50%; object-fit: cover; object-position: center 30%;
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
      .word { opacity: .5; display: inline-block; margin-right: .28em; }
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
      mode="bloom" phase="1.4" eyebrow="${esc(title ? "CCC Days" : "")}" title="${esc(title ?? "")}" size="6.6" align="center"></rm-study-field>

${media.join("\n")}

${lines.join("\n")}

    <rm-study-field id="close-field" class="clip" data-start="${seconds(endsAt * 1000)}" data-duration="${seconds(cardSeconds * 1000)}" data-track-index="91" at="${Math.round(endsAt * 1000)}" for="${Math.round(cardSeconds * 1000)}"
      mode="wipe" phase="3.1" title="${esc(closing ?? "Thanks for watching")}" size="6.6" align="center"></rm-study-field>
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
	return { outDir, words: wordIndex, seconds: total };
}
