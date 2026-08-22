# rolemodel-openscreen

RoleModel brand layer for [OpenScreen](https://github.com/getopenscreen/openscreen).

**No fork.** Everything here sits on top of the public `.openscreen` document
format and the headless CLI. Nothing patches OpenScreen's source, so an upgrade
is `npm update`, not a merge.

```
brand/tokens.json          palette, type, and scale — mirrors the Academy HyperFrames theme
brand/wallpapers/          8 generated backdrops + a contact sheet
presets/*.json             rolemodel · academy · lightning
lib/theme.mjs              load a preset, patch a project document
lib/annotations.mjs        branded title / lower-third / callout / watermark / zoom builders
lib/make-wallpapers.mjs    regenerate the wallpapers from tokens
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

Regenerate wallpapers after editing `brand/tokens.json`:

```bash
npm install playwright
node lib/make-wallpapers.mjs            # 3840×2160 by default
```

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
- **LightningCAD has no agreed signature.** Its preset is the RoleModel base on
  a blue wash, marked `open` in the JSON.

## Open design question

Does a sub-brand get its own motion language, or only its own colour, type, and
surface signature over one shared system? These presets assume the latter — one
system, distinct signatures. Deciding otherwise means maintaining a design
system per sub-brand, which is a real ongoing cost for a team this size.
