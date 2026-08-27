# The HyperFrames contract for a skeleton

What `build.py` emits and why. Full authoring contract lives in `/hyperframes-core`; this covers the choices specific to a skeleton and the ones the checker enforces.

## Shape

One `<video>` plus one matching `<audio>` per kept source range, inside a composition root:

```html
<div id="root" data-composition-id="main" data-start="0"
     data-width="1920" data-height="1080" data-fps="30"
     data-duration="12.104" data-no-timeline>
  <video id="beat1-clip1" src="source/blaine.mp4" data-start="0.000"
         data-duration="4.554" data-media-start="5.356"
         data-track-index="0" muted playsinline preload="auto"></video>
  <audio id="beat1-clip1-audio" src="source/blaine.mp4" data-start="0.000"
         data-duration="4.554" data-media-start="5.356"
         data-track-index="1"></audio>
</div>
```

`data-start` is the position on the timeline. `data-media-start` is the offset into the source. `data-duration` is how long the clip runs. The source keeps its original in and out; nothing is pre-cut with ffmpeg, so re-cutting costs a rebuild rather than a re-encode.

## Five things that are not stylistic

**`data-no-timeline` on the root.** A skeleton has no animation, so nothing registers `window.__timelines`. Without this attribute `check` fails with `missing_timeline_registry`, and the renderer polls 45 seconds for a timeline that never arrives, on every render. The published attribute table does not mention this; it was found by running `check`.

**`data-duration` on the root.** With no GSAP timeline there is no other duration source, so lint raises `root_composition_missing_duration_source` without it.

**An `id` on every media element.** Lint errors with `media_missing_id`, and an `<audio>` without one is never picked up by the mixer, so the render comes out silent.

**No `class="clip"` on media.** The class is a layout convention for visible timed elements such as `div` and `img`. On `<video>` and `<audio>` it is wrong.

**Video is `muted` with audio on its own element.** Not because they are cut differently here; they use identical ranges. It is because `/video-b-roll` lays picture over the top while keeping the speaker's voice, and that only works if the audio is already an independent element. Building it this way now saves restructuring later.

## Timing without float drift

All arithmetic runs in integer milliseconds and is formatted to exactly three decimals at the end. Adjacent clips then share an exact decimal boundary, since `0.000 + 4.554` is `4.554` in both the code and the markup.

This matters because the visibility window is half-open, `[start, start + duration)`. Two clips authored back to back share no frame, so a contiguous cut needs no gap and no overlap. Accumulating floats would produce `7.113000000000001` against a neighbour's `7.113`, which is the collision the old helper skill worked around by alternating tracks. Integer milliseconds remove the cause instead.

`data-track-index` is a Studio display lane and the renderer never reads it. Video sits on 0 and audio on 1 purely so the Studio timeline is readable.

## Asset paths cannot traverse upwards

A composition is served with the project root as its base URL. Lint rejects any `src` containing `../` with `invalid_parent_traversal_in_asset_path`, and separately reports `missing_local_asset` and `audio_src_not_found` for the same paths, because renders rewrite them but Studio preview and other live consumers resolve against the project root and 404.

The pipeline keeps footage in the shared workspace one level above the composition, so `build.py --link-media ../source` symlinks it in under a root-relative name. Every `src` then reads `source/<file>` and there is still only one copy of the media on disk.

Do not solve this by copying footage into the project. Recordings are large, `/video-b-roll` reads the same files, and a second copy is a second thing to keep in sync.

## Clamping to the media

A range's out point is padded into the trailing silence so cuts do not clip breaths. When the last word of a take sits near the end of the file, that pad can run past the end of the media, which renders as a freeze or black. `align.py` clamps to `duration_s` from `transcripts.json`, which is why recording that value with `ffprobe` is a required step and not an optimisation.

## Audio-only projects

`--audio-only` emits the `<audio>` elements alone. Everything else is unchanged. The review page switches to an audio player and the read-through carries the review on its own.

## Validating

```bash
npx --yes hyperframes@latest check
```

Zero errors before the user sees anything. `check` runs lint, a runtime pass, a layout audit that samples element boxes in a real browser, a motion pass, and a contrast pass. A skeleton has no text and no motion, so layout, motion, and contrast report nothing to inspect; lint and runtime are the ones that matter.

The first run downloads Chromium, about 101 MB. Ask first.
