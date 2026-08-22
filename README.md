# rolemodel-openscreen

RoleModel brand layer for [OpenScreen](https://github.com/getopenscreen/openscreen).

**No fork.** Everything here sits on top of the public `.openscreen` document
format and the headless CLI. Nothing patches OpenScreen's source, so an upgrade
is `npm update`, not a merge.

```
brand/tokens.json          palette, type, and scale — mirrors the Academy HyperFrames theme
brand/optics-tokens.json   the Optics export — upstream source of truth for colour
brand/optics.css           GENERATED — 1160 Optics tokens as CSS custom properties
brand/wallpapers.json      wallpaper recipes — the editable source of truth
brand/wallpapers/          16 rendered backdrops + a contact sheet
presets/*.json             rolemodel · academy · lightning
lib/theme.mjs              load a preset, patch a project document
lib/annotations.mjs        branded title / lower-third / callout / watermark / zoom builders
lib/wallpaper.mjs          recipe -> canvas. One implementation, shared by the
                           Studio preview, the Studio export, and the batch build
lib/wallpaper-recipes.mjs  the default recipe set, derived from tokens
lib/make-wallpapers.mjs    batch-render brand/wallpapers.json to JPEG
lib/optics-css.mjs         turn the Optics export into CSS
lib/jobs.mjs               run the pipeline and stream it back to the browser
lib/script-parse.mjs       markdown -> speakable lines (served to the browser too)
lib/narration.mjs          per-line TTS, measured, into audio + an exact SRT
components/rm-video.js     custom elements for scenes — seekable, Optics-coloured
components/gallery.html    live gallery with a scrubber
components/scene.html      the scene template to copy
components/render-scene.mjs  scene -> MP4, frame by frame
lib/verify.mjs             assert the presets still match OpenScreen's own types
bin/rm-video.mjs           CLI
skill/SKILL.md             agent skill — record → brand → export, end to end
```

## Why this shape

OpenScreen turned out to be a much better foundation than its reputation
suggests. Three things decided the approach:

1. **It has a real headless CLI**, explicitly built for agents —
   `record`, `sources`, `export`, `pack`, `captions`, `info`, all with NDJSON
   output. The pipeline is `record → edit the project JSON → export`.
2. **`.openscreen` is a Zod-typed JSON document** (`AxcutDocument`,
   schemaVersion 7) with a forward-only migration chain. Every appearance
   setting the editor exposes is a field in that document.
3. **It is MIT**, actively developed, ~1,670 tests, with an `AGENTS.md` and real
   architecture docs.

So the missing piece was never the editor. It was the brand. That is what this is.

## Use

```bash
node bin/rm-video.mjs presets

# appearance only
node bin/rm-video.mjs theme demo.openscreen --preset rolemodel --variant vertical

# appearance + title card + watermark
node bin/rm-video.mjs brand demo.openscreen \
  --preset academy --unit rails \
  --title "Active Record basics" --eyebrow "Week 4" \
  --watermark --duration-ms 240000

openscreen export demo.openscreen -o demo.mp4 --auto-zoom --json
```

## Build chain

```bash
npm run build     # sync-brand -> optics.css -> wallpapers
npm run check     # the same three, as assertions — this is what CI runs
npm run dev       # Studio with live reload
npm run studio    # Studio, plain
```

`npm run dev` is `node --watch` over `bin/` and `lib/` plus a live-reload stream
to the browser, so editing a panel and seeing it are the same motion. Changes to
`presets/` and `brand/` reload too. Nothing is watched in a normal run.

## Running things

The Studio runs the pipeline rather than describing it: Record, Make, and From a
test all hand you a **Run** button, and the output streams into **Console** while
it happens. Commands are built server-side from an allowlist of binaries
(`lib/jobs.mjs`) and passed as an argv array, so no string ever reaches a shell.

If you want a prompt to type into, that is opt-in:

```bash
rm-studio --shell
```

## Narration

A markdown script becomes a voice track and a subtitle file that cannot drift
from it.

```bash
rm-voice feeney-cable-rail-promo --script opener --voice af_nova
rm-voice --voices
```

Or `rm-studio` → Voice, which previews exactly which lines will be spoken before
you commit to a synth pass.

The obvious pipeline — synthesise the whole script, then run the audio back
through Whisper for timings — is wrong. You already know the words; sending them
through speech recognition to get them back mis-hears product names and costs a
pass. So this synthesises **one clip per line**, measures each one, and writes
the SRT from durations it already has. Timings are exact by construction, and
a copy edit re-synthesises only the lines that changed.

Voices are Kokoro via `hyperframes tts` — local, no API key, no per-character
billing, and nothing about an unreleased client product leaves the machine.
First run needs `pip install kokoro-onnx soundfile` and downloads ~27MB.

## Putting narration on a render

```bash
rm-mux --video demo.mp4 --audio narration.wav --srt narration.srt -o final.mp4
```

**A render and a narration track are on different clocks.** recast compresses
idle time — a five-second interaction becomes 3.8 seconds — while narration is
however long the words take, which was 22 seconds for the same demo. Burn a
22-second subtitle track into a 3.8-second render and you get cue 1 held for the
whole clip and the rest silently dropped. It looks like it worked.

`rm-mux` reconciles them: within 25% it pads the shorter one; when narration is
longer it slows the video up to `--max-stretch`, then holds the last frame and
*tells you*, because the real fix is a shorter script or a demo with more in it.
Subtitles are burned onto the final timeline, after the stretch.

The Studio wires this automatically: if a project has narration matching the
render name, the From-a-test panel returns two steps and recast skips its own
burn-in.

## Three ways into a video

| | input | tool | stays current? |
|---|---|---|---|
| **Record** | your screen | `openscreen` | no — re-record by hand |
| **Make** | a script or a URL | HyperFrames, via Claude | re-run the brief |
| **From a test** | a Playwright trace | `playwright-recast` | **yes** — re-run the test |

The third one is the interesting one. A trace already contains actions,
screenshots, network waits and cursor positions, so a demo cut from it can be
regenerated on every deploy and can never drift from the UI it documents.

## Components

Custom elements for HyperFrames scenes — title cards, browser chrome, lower
thirds, callouts, stats, build-on lists. `rm-studio` → Components, or open
`components/gallery.html`.

```html
<rm-scene wallpaper="brand/wallpapers/rm-dark-dotgrid">
  <rm-title at="0" for="2600" eyebrow="Product tour" title="Estimating, in one pass"></rm-title>
  <rm-browser at="2600" w="68" url="app.rolemodelsoftware.com" image="shot.png"></rm-browser>
  <rm-callout at="4200" for="2600" x="62" y="38" text="Live pricing"></rm-callout>
</rm-scene>
```

**Time is seeked, not played.** Every animation is a paused CSS animation whose
delay is driven from one `--t` property, so `RM.seek(2400)` puts the whole scene
at exactly that instant and frame N is identical on every render. A renderer
steps seek and grabs frames; nothing depends on when it happened to look.

That is also why the two animations on a component write to different registered
custom properties rather than both to `opacity` — with `fill-mode: both`, the
exit animation's backwards fill silently wins, and every component renders
visible from frame 0. `npm run check` asserts the contract: paused animations,
no transitions, every delay positioned by `--t`, and no colour that isn't an
Optics token.

```bash
node components/render-scene.mjs components/scene.html -o demo.mp4 --fps 30
```

## Wallpapers

The backdrop behind the recording is the largest branded surface in the video, so
it is editable rather than baked in. A wallpaper is a small JSON recipe in
`brand/wallpapers.json`: base colour, a linear gradient, an optional directional
tint, and a texture.

Edit them with a live 4K preview:

```bash
rm-studio            # -> Wallpapers
```

Save re-draws the frame at 3840x2160 in the browser and writes both the JPEG and
the recipe. No Playwright needed on a designer's machine.

Batch-render the whole set (CI, or after editing `brand/tokens.json`):

```bash
npm install playwright
node lib/make-wallpapers.mjs            # render brand/wallpapers.json
node lib/make-wallpapers.mjs --reset    # re-derive recipes from tokens first
```

Colour comes from Optics. `brand/optics-tokens.json` is the Figma export;
`lib/optics-css.mjs` turns it into `brand/optics.css` — every token as a custom
property, both modes, resolved with `light-dark()`. The Studio and the wallpapers
consume those tokens, and `npm run check` fails if the CSS is stale or if
`lib/studio-ui.mjs` grows a hand-written hex.

**The edge is a solid border.** `border: { width, color, inset, radius }` — width in px at 1920, scaled with the export. A gradient edge was wrong twice over: as a radial it produced the dark band along the bottom, and as a linear scrim it was still a fade where the brand calls for a line. `rm-framed` is the example.

**No radial gradients.** RoleModel's brand is linear — direction, not blobs. The
first version used a radial vignette to settle the edges; at 16:9 that ellipse
fell outside the frame along the bottom and read as a thick dark border under
every recording. `lib/verify.mjs` fails the build if one comes back.

Check the presets against a specific OpenScreen version:

```bash
node lib/verify.mjs --openscreen /path/to/openscreen-checkout
```

`verify` reads `ProjectEditorState`, the webcam/quality enums, and the
`AnnotationRegion` / `AnnotationTextStyle` / `ZoomRegion` interfaces straight out
of the checkout and asserts every preset field and builder output against them.
It matters because a wrong field name doesn't error — OpenScreen normalises it
back to a default and the video silently looks stock.

## What the presets decide

The stock defaults are fine for a hobby recording and wrong for client work.
Each preset documents its reasoning inline; the ones worth knowing:

| Setting | Stock | Ours | Why |
| --- | --- | --- | --- |
| `borderRadius` | 40 | 28 | Echoes the 28px scene border in the Academy HyperFrames spec, so a capture cut beside a HyperFrames scene reads as one system |
| `padding` | 50 | 62 | The backdrop is the only branded surface in a screen demo |
| `shadowIntensity` | 0.2 | 0.38 | Stock reads flat against `#293747` |
| `motionBlurAmount` | 0.2 | 0.18 | Motion blur smears UI text during pans |
| `cursorTheme` | `default` | `default` | Pinned deliberately — every bundled theme is a novelty cursor (Hello Kitty, Among Us, Pokémon). None belong in client work |

## Known limits

- **Wallpapers are referenced by absolute `file://` URL.** OpenScreen only
  rewrites its own bundled `/wallpapers/wallpaperN.jpg` paths and passes
  anything else through, so this works — but it means projects aren't portable
  across machines unless the toolkit sits at the same path. The clean fix is a
  user-wallpapers folder the app scans, which is a small upstream PR, not a
  reason to fork.
- **The document format is pre-1.0.** Both the v7 `AxcutDocument` and the legacy
  v2 shape are handled, but a future bump could move fields. `lib/verify.mjs`
  is how you find out fast.
- **No custom cursor.** A clean RoleModel cursor would need a theme contributed
  to the app itself. Worth doing upstream.
- **LightningCAD's signature came from Optics.** `lcad` is a real scale in the
  export (#2b84f7), so the preset uses it rather than a placeholder.

## Open design question

Does a sub-brand get its own motion language, or only its own colour, type, and
surface signature over one shared system? These presets assume the latter — one
system, distinct signatures. Deciding otherwise means maintaining a design
system per sub-brand, which is a real ongoing cost for a team this size.
