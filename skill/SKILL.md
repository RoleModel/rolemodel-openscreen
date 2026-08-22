---
name: rm-screen-demo
description: Record a branded RoleModel product demo or Academy lesson with OpenScreen — capture, apply the brand preset, add a title and callouts, and render an MP4 or GIF. Use when someone says "record a demo", "make a screen recording of this feature", "capture a walkthrough", "record an Academy lesson", or wants a branded screen recording for a case study, docs page, PR, or social post. Also use to re-brand or re-export an existing .openscreen project.
---

# Branded screen demos with OpenScreen

OpenScreen records the screen and renders polished demo video. This skill puts
RoleModel brand on it and drives the whole thing headlessly, so a craftsman gets
a consistent, on-brand demo without opening an editor or knowing the JSON.

**The craftsman never touches the terminal or the project file.** Ask what they
want, run the pipeline, hand back the MP4.

## Before you start

Confirm OpenScreen is installed and the CLI is reachable:

```bash
openscreen info --json
# macOS packaged: /Applications/Openscreen.app/Contents/MacOS/Openscreen info --json
```

If it is not installed, say so and stop — do not try to install it silently.

`RM_OPENSCREEN` should point at this toolkit (the folder containing `bin/rm-video.mjs`).

## Ask first, briefly

Get these before recording. One short round of questions, not an interrogation:

- **What is being demoed**, and which window or display
- **Sub-brand**: `rolemodel` (default), `academy` (then which unit — ruby / design / rails), or `lightning`
- **Where it will be posted** — decides the variant: `master` 16:9, `vertical` 9:16, `square` 1:1, `gif` for docs and PRs
- **Title card text**, and an eyebrow label if they want one
- **Narration** — a script to synthesise, a file they will record, or none

If the session is unattended, default to `rolemodel` + `master`, say so, and proceed.

## Pipeline

### 1. Find the source

```bash
openscreen sources -o /tmp/sources.json
```

Read the file and pick the display or window. Never guess a `--window` string —
match it against what `sources` actually returned.

### 2. Record

```bash
openscreen record --window "<title>" --duration <seconds> \
  --project <slug>.openscreen --json
```

Recording is headless, but it is capturing *their real screen* — tell them
before you start, and tell them when it stops. `--duration` is the safe way to
end; without it you have to signal the process.

On macOS the terminal hosting Electron needs Screen Recording permission. If
recording fails with a permission error, say exactly that — it is a system
setting the person must grant, not something to retry.

### 3. Brand it

```bash
node "$RM_OPENSCREEN/bin/rm-video.mjs" brand <slug>.openscreen \
  --preset academy --unit rails --variant master \
  --title "Active Record basics" --eyebrow "Week 4" \
  --watermark --duration-ms <total_ms>
```

`brand` applies the preset's appearance settings and adds the title and
watermark. Use `theme` instead when you only want the look, with no overlays.

`node .../rm-video.mjs presets` lists what is available, including which
sub-brands still have open design questions.

### 4. Add emphasis (optional)

For callouts and zoom beats, import the builders rather than hand-writing
regions — they carry the brand type scale and enforce a minimum zoom hold:

```js
import { callout, zoomRhythm } from "$RM_OPENSCREEN/lib/annotations.mjs";
import { annotationList, zoomList, readProject, writeProject } from "$RM_OPENSCREEN/lib/theme.mjs";

const doc = await readProject("demo.openscreen");
annotationList(doc).push(...callout({ text: "One-click setup", at: { x: 62, y: 38 }, startMs: 5200, endMs: 8400 }));
zoomList(doc).push(...zoomRhythm([{ atMs: 5000, at: { x: 0.62, y: 0.38 } }]));
await writeProject("demo.openscreen", doc);
```

Prefer `--auto-zoom` at export over hand-placed zooms unless the person asked
for emphasis at a specific moment. The auto-zoom engine reads real cursor
telemetry and is usually better than a guess.

### 5. Export

```bash
openscreen export <slug>.openscreen -o <slug>.mp4 \
  --auto-zoom --quality source --json
```

With narration:

```bash
openscreen export <slug>.openscreen -o <slug>.mp4 \
  --auto-zoom --audio narration.m4a --audio-mode replace --json
```

Use `--audio-mode replace` when the recording has no useful audio, `mix` when
there is something worth keeping under the voiceover.

### 6. Normalise loudness — do not skip this

Any export with audio gets a two-pass `loudnorm` before delivery. This is the
difference between amateur and professional and it takes seconds:

```bash
ffmpeg -i <slug>.mp4 -af loudnorm=I=-14:TP=-1.5:LRA=9:print_format=json \
  -f null - 2> /tmp/ln.json
# read measured_I / measured_TP / measured_LRA / measured_thresh / offset, then:
ffmpeg -i <slug>.mp4 -af "loudnorm=I=-14:TP=-1.5:LRA=9:measured_I=…:measured_TP=…:\
measured_LRA=…:measured_thresh=…:offset=…:linear=true" \
  -c:v copy -c:a aac -b:a 192k -ar 48000 <slug>-final.mp4
```

`-ar 48000` is required — loudnorm resamples internally and will otherwise hand
you a sample rate you did not ask for. If the second pass reports
`normalization_type: dynamic`, the source needs gain-staging; say so rather than
shipping a pumping mix.

### 7. Deliver

Send the MP4 with `SendUserFile`, and write it into a connected folder if there
is one. Say where it went in one line.

## Variants from one recording

To produce several cuts, copy the project per variant and re-brand each — do not
re-record:

```bash
for v in master vertical gif; do
  cp demo.openscreen "demo-$v.openscreen"
  node "$RM_OPENSCREEN/bin/rm-video.mjs" theme "demo-$v.openscreen" --preset rolemodel --variant "$v"
  openscreen export "demo-$v.openscreen" -o "demo-$v.${v/gif/gif}" --auto-zoom --json
done
```

## Things to get right

- **`.openscreen` files live next to their media.** Export only auto-approves
  media in the app's recordings directory or beside the project file. Use
  `openscreen pack` to move a project somewhere else.
- **Never set a novelty cursor theme.** Every bundled theme is a character
  cursor. The presets pin `default` deliberately.
- **GIFs stay under ~15 seconds.** Past that the file is too big to be useful
  in a PR or a docs page.
- **The project format is pre-1.0** and can change between OpenScreen versions.
  If `rm-video` reports an unrecognised document, run
  `node "$RM_OPENSCREEN/lib/verify.mjs" --openscreen <checkout>` against a
  checkout of the matching version and report what drifted.
