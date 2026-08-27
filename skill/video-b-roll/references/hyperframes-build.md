# Building and verifying the HyperFrames composition

Everything here has been paid for at least once. The items under "Silent
failures" all pass validation and still ruin the output.

## Scaffold

```bash
npx hyperframes@latest skills update general-video

# mode B, finished video plus B-roll
npx hyperframes init <name> --example blank --video "<A-roll>" \
  --model small.en --language en --non-interactive --skill general-video

# mode A, fixed voiceover plus demo recording
npx hyperframes init <name> --audio "<voiceover>" --resolution 1080p \
  --non-interactive
```

- `init --non-interactive` requires one of `--example`, `--video`, or `--audio`.
  For an empty project pass `--example blank` explicitly.
- `init --video` and `init --audio` transcribe automatically on scaffold.
  `npx hyperframes transcribe media/vo.mp3 -m medium.en --json` does it standalone.
- `hyperframes` is not on PATH here. Use `npx hyperframes@<version>` or the
  project's own `npm run` scripts.
- The scaffolded `package.json` pins an exact CLI version. Before any
  render-affecting work, probe with
  `npx hyperframes@latest upgrade --project . --check` (keep the literal `.`).
- `hyperframes.json` ships `media.autoProxy: true`. An explicit hand-built proxy
  is still worth it for seek accuracy and decode cost.
- This is a footage remix, so the routing is `/general-video`. Not
  `/talking-head-recut`, which is for designed graphic overlays, and not
  `/embedded-captions`.

## Structure

- A-roll or demo base as `<video class="clip layer">` on track 0.
- Cutaway or beat segments as `<video>` elements above it.
- A separate `<audio>` element carrying the interview sound or the voiceover.
- Exactly one paused GSAP timeline registered at `window.__timelines["<id>"]`.
- Keep every cutaway timing in **one JS array**, mirrored by the `data-start` and
  `data-duration` on each element, so there is a single obvious place to retime.

```html
<video id="beat07" class="shot" src="media/segments/beat07.mp4"
       data-start="19.165"        <!-- slotStart minus hPre -->
       data-duration="3.345"      <!-- slotDur plus hPre plus hPost -->
       data-media-start="0"
       data-track-index="6" muted playsinline></video>
```

```js
const tl = gsap.timeline({ paused: true });
tl.set("#beat07", { opacity: 0 }, 0);                                          // load bearing
tl.to("#beat07", { opacity: 1, duration: 0.28, ease: "sine.inOut" }, 19.325);  // cut minus d/2
window.__timelines["main"] = tl;
```

For a mode B cutaway with a dissolve out and a synthetic push:

```js
tl.fromTo(el, {opacity: 0}, {opacity: 1, duration: 0.3, ease: "power1.inOut"}, start);
tl.to(el, {opacity: 0, duration: 0.3, ease: "power1.inOut"}, start + duration - 0.3);
tl.fromTo(el, {scale: 1.02}, {scale: 1.035, duration: duration, ease: "none"}, start);
```

## Composition rules

- `tl.set(opacity: 0)` at t=0 on every incoming clip is required. Without it the
  clip paints at full opacity during its pre-roll handle and shows its content
  early. A bare `fromTo` does not cover seeks before the tween starts.
- Only the incoming layer ramps, an A-over-B dissolve. Fading both gives a
  visible luminance dip at the midpoint.
- Stacking comes from **DOM order**. `data-track-index` is a Studio display lane
  and does not set z-index.
- Every `<video src>` needs `data-start`, even `data-start="0"`. Lint error
  `media_missing_data_start`, and the scaffold's own example omits it.
- Every `<audio>` needs an `id` or the mixer skips it and the render is silent.
- `<video>` gets `muted`. Audio comes from the separate `<audio>` element.
- No CSS `transform` on an element GSAP tweens transform on. Lint error
  `gsap_css_transform_conflict`. Set the initial state in `fromTo`.
- Root needs explicit pixel `data-width` and `data-height` and a sized box.
- No `crossorigin` on media.
- A `<video data-start>` must not sit inside another plain element that also has
  `data-start`.
- Never tween `display` or `visibility` on a clip element.
- Put cuts in speech pauses. Dissolve length `d` needs `d/2 <= handle`, and
  should shrink near short beats. A 0.56s beat with a 0.32s dissolve is all blend.

## Silent failures

**`data-fps` on the root.** The renderer defaults to 30 fps. Rendering 23.976
sources at 30 duplicates frames unevenly and puts visible judder on a talking
head, while every check and snapshot passes clean. Set
`data-fps="24000/1001"` or whatever the source actually is. This is the single
easiest way to ruin the output without noticing.

**`data-playback-rate` is unusable and fails silently.** Proven with a controlled
probe on hyperframes 0.8.16, using a `testsrc` clip that burns a seconds counter
into the picture, placed three times at rates 0.5, 1, and 2:

- The timeline seek ignores the attribute. All three advanced the source 1:1, so
  two seconds of timeline moved two seconds of source at every rate.
- The render frame extractor honours it. It pulled only `rate x duration` worth
  of frames, so render aborted with *"Video r05 captured 60 of expected 120
  frames (coverage 50.0%) ... check/snapshot may pass while the encoded MP4
  renders this clip blank."*
- `check` and `snapshot` both passed clean on that same file.

Bake speed into the media with `setpts` instead, which is what
`scripts/build-segments.sh` does, and place the clip 1:1. The framework's own
docs point at preprocessing for retiming, and state the rate math as "consumed
source = timeline duration x rate", which is what the extractor implements and
the seek does not.

**A lint error disables the layout and contrast audits.** They then report
`0 sample(s)` and `0/0 text checks`, which reads clean but means nothing ran.
Clear every lint error before trusting those numbers.

**Resolution.** Match the composition to the source's native resolution. Do not
upscale a 720p A-roll to 1080p. It adds nothing and forces the B-roll through a
needless resample.

## Verify

```bash
npx hyperframes check                     # must be 0 findings, not 0 samples
npx hyperframes snapshot --at 4.0,6.15,7.5,... --no-end -o snapshots
npx hyperframes render
```

Snapshots are necessary and not sufficient. Verify the encoded MP4:

```bash
ffprobe -v error -show_entries stream=codec_type,duration,r_frame_rate,channels \
  -of default=nw=1 OUT.mp4

# volumedetect logs at info level; -v error suppresses its output entirely
ffmpeg -hide_banner -nostats -i OUT.mp4 -af volumedetect -f null /dev/null 2>&1 | grep volume

# consecutive frames across a dissolve, to confirm a monotonic ramp
ffmpeg -y -v error -i OUT.mp4 -vf "select='between(n,420,434)',scale=440:-1,tile=5x3" \
  -fps_mode passthrough -q:v 4 dissolve.jpg
```

- Snapshot the **dissolve midpoints**, not only shot centres. `start + 0.15` and
  `start + duration - 0.15` should each show a 50/50 blend. That is how you prove
  the transitions render rather than pop.
- Re-run `scripts/motion-scan.py --at ... --window ...` over each opaque hold in
  the rendered file. It proves the shot you picked is the shot that shipped, at
  the steadiness you measured.
- When you add handles or change dissolves, re-snapshot the same nominal times
  before and after. Identical frames prove the timing did not move.

## Render

```bash
npx hyperframes@latest render -o renders/final.mp4 --quality high --crf 16 --gpu
```

Keep every render. A/B against the previous one is how the editorial decisions
actually get settled.
