# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: any RoleModel Software engineer or PM on a client project — **not a
designer**. They need a branded demo video out of work they already did, without
knowing Optics, ffmpeg, or the OpenScreen document format. The interface has to
teach the pipeline and make off-brand output hard to produce, because the person
driving it cannot be assumed to recognise off-brand when they see it.

Secondary, confirmed: a design-fluent operator who knows the whole system and
should not be slowed down by guidance built for the primary user.

Outside RoleModel: the repo is MIT on `github.com/rolemodel/rolemodel-openscreen`
with a Homebrew tap (`brew install rm-video`), but external users are **not a
design constraint**. Internal first; public incidentally.

## Product Purpose

A brand and workflow layer on top of [OpenScreen](https://github.com/getopenscreen/openscreen)
— presets, wallpapers, annotation builders, seekable scene components, local
narration, and a local web Studio that runs the pipeline rather than describing
it. It exists so that a client demo or marketing video is a normal part of
delivery instead of a specialist project.

Explicitly **not a fork**: it is a client of OpenScreen's headless CLI and JSON
document format, so an upgrade is `brew upgrade`, never a merge.

Success: someone who is not a designer produces a video that reads as RoleModel
work, and a demo of a shipped feature is still accurate after that feature
changes.

## Positioning

Three confirmed mechanisms a neighbouring tool could not truthfully copy, all
three named as load-bearing:

1. **Demos regenerate from Playwright traces.** A trace already holds actions,
   screenshots, network waits and cursor positions, so a demo cut from it is
   re-cut on every deploy and cannot drift from the UI it documents. This is the
   difference between a recording that ages and a demo that stays true.
2. **Narration is local by default.** Kokoro TTS runs on the machine — no API
   key, no per-character billing, and nothing about an unreleased client product
   leaves the building. Lines are synthesised individually and measured, so the
   SRT is exact by construction rather than transcribed back with speech
   recognition.

   ElevenLabs is available as an opt-in provider, for when a client has asked
   for a particular commercial voice. Choosing it sends the script text to a
   third party, so it is never the default and the UI says so at the point of
   choosing. Only the speak step differs: measuring and caching stay shared, so
   the exact-by-construction SRT holds either way. The local path remains the
   one the product is positioned on — "no API key" stops being true the moment
   you opt in, and that is the user's decision to make per project, not a
   default to drift into.
3. **Frames are seeked, not played.** Every scene animation is a paused CSS
   animation positioned by one `--t` property, so `RM.seek(2400)` puts the whole
   scene at exactly that instant and frame N is identical on every render.

## Operating Context

- The Studio is one local web app (`rm-studio`, default port 4600): plain DOM,
  zero runtime dependencies, no build step — it has to survive being ignored for
  six months and still start. `npm run dev` adds live reload over `bin/` and
  `lib/`.
- Panels: Library, New project, Record, Make a video, From a test, Scripts,
  Voice, Brand, Wallpapers, Components, Storage, Console.
- Work is organised as project folders on disk under a library root, grouped by
  client (Feeney and Hershey are two clients, not one project). Each project is
  a folder with a manifest, plus `media/`, `scripts/`, and `media/Renders/`.
- Long jobs stream into **Console** over SSE rather than hiding behind a spinner.
  Commands are built server-side from an allowlist of binaries and passed as an
  argv array, so no string ever reaches a shell. A typed prompt is opt-in
  (`rm-studio --shell`).
- Five CLIs alongside the Studio: `rm-video`, `rm-library`, `rm-studio`,
  `rm-voice`, `rm-mux`. Node >= 20.
- The Studio is pinned dark because it sits next to video all day.
- External tools expected on PATH: `openscreen`, `ffmpeg`/`ffprobe`, `rclone`,
  `hyperframes`, `playwright-recast` (via npx), and Claude.
- Storage is optional: local folders work on their own, with Cloudflare R2 over
  rclone once two people need the same footage.

## Capabilities and Constraints

- Narration providers: `kokoro` (local, default) and `elevenlabs` (opt-in,
  cloud). The ElevenLabs key lives in `~/.rolemodel-video/config.json` at mode
  0600 or in `ELEVENLABS_API_KEY`; it is never returned to the browser and never
  passed as an argument, so it cannot appear in the Console transcript.
- Three ways into a video: **Record** (your screen via `openscreen` — does not
  stay current), **Make** (a script or URL through HyperFrames via Claude —
  re-run the brief), **From a test** (a Playwright trace — stays current).
- A render and a narration track are on different clocks: recast compresses idle
  time while narration takes however long the words take. `rm-mux` reconciles
  them, and says so when it has to hold a frame, because the real fix is a
  shorter script.
- recast needs a video beside the trace; with only a `trace.zip` it assembles
  from sparse screencast frames and reads as a slideshow.
- Colour is Optics **imported, not copied**: `brand/optics/optics.css` is
  `@rolemodel/optics` verbatim, pinned by version and hash, and
  `rolemodel-scales.css` carries only the eight RoleModel sub-brand scales the
  open-source release does not publish. Setting one hue re-tints all 486 tokens.
  `npm run check` fails on a hand-edited copy, a stale supplement, a shadowed
  token, an unresolvable `--op-` token, or a hand-written hex in the Studio.
  *(Enforced in CI today, but not named load-bearing — treat it as a live
  engineering constraint rather than a fixed principle.)*
- Eight sub-brands, each a real Optics scale: Craftsmanship Academy,
  LightningCAD, Dock Designer, Deck Designer, Railing Designer, Building,
  Airfield, Flow.
- CSS and JS are built inside tagged template literals, which is load-bearing
  and fragile: a backtick in a CSS comment silently terminates the literal and
  the page renders as unstyled tags. `npm run check` runs `node --check` over
  `lib/studio-ui.mjs`, `bin/rm-studio.mjs`, and `components/rm-video.js`.
- Two CSS animations must not both drive `opacity`. Enter and exit write to
  separate registered custom properties and `opacity` composes from both;
  simplifying that back makes every component render visible from frame 0.
- The OpenScreen document format is pre-1.0. `lib/verify.mjs` reads OpenScreen's
  own TypeScript and asserts every preset field against it, because a wrong
  field name does not error — it normalises back to a default and the video
  silently looks stock.
- Wallpapers are referenced by absolute `file://` URL, so projects are not
  portable across machines unless the toolkit sits at the same path.
- **Undecided, recorded rather than invented:** whether a sub-brand gets its own
  motion language, or only its own colour, type, and surface signature over one
  shared system. The presets assume the latter — one system, distinct
  signatures — because a design system per sub-brand is a real ongoing cost for
  a team this size.

## Brand Commitments

Binding, from `brand/tokens.json` and the Academy HyperFrames spec:

- **No radial gradients, anywhere.** RoleModel's brand is linear — direction,
  not blobs. A radial vignette at 16:9 put the ellipse outside the frame and
  read as a thick dark border under every recording. `npm run check` fails if
  one comes back.
- **An edge is a solid border, not a fade.** `border: { width, color, inset,
  radius }`, width in px at 1920 and scaled with the export.
- **Orange is an accent only** — never a slide or video background.
- **Cursor themes stay `default`.** Every bundled alternative is a novelty
  cursor; none belong in client work.
- Type is DM Sans (display and body) and Geist Mono, mirroring the Academy
  HyperFrames theme. Primary green is `#00b871`; `#293747` is the dark surface.
- Annotation type is sized in pixels against a 1920x1080 composed frame: title
  96, section heading 64, lower-third title 44 / sub 24, callout 36, eyebrow 26.

## Evidence on Hand

- 16 rendered wallpapers plus a contact sheet in `brand/wallpapers/`, generated
  from JSON recipes in `brand/wallpapers.json`.
- A live component gallery with a scrubber (`components/gallery.html`) and a
  scene template to copy (`components/scene.html`).
- Three presets: `rolemodel`, `academy`, `lightning`.
- `lib/verify.mjs` — 129 assertions, 78 of which run without an OpenScreen
  checkout.
- Real client work in the library on this machine (a Feeney railing project).
- Research lives in the FigJam board *Video Tools Research — CCC Days*
  (`figma.com/board/BKPsEkjIqsk0osNiDyZjqI`) and in three markdown docs that
  were delivered into a conversation rather than into the repo.
- **Absences future work must not fabricate:** there is no `DESIGN.md` in this
  repo (only a reference to one in `brand/tokens.json`), no testimonials, no
  benchmarks, no pricing, and no published `v0.1.0` release yet — the tag, the
  `TAP_TOKEN` secret, and the first `brew install` round trip are all still
  outstanding.

## Product Principles

1. **Run it, don't describe it.** A panel that hands you a command to paste has
   failed. Buttons execute, and output streams into Console while it happens.
2. **Assume the operator is not a designer.** Make the branded path the easy
   path and off-brand output hard to reach, because the person driving cannot be
   expected to recognise off-brand when they see it.
3. **Prefer the input that regenerates.** Between two ways to get the same
   video, the one that can be re-run after a deploy is worth more than the one
   that looked better once.
4. **Exact by construction, not by correction.** Measure and derive rather than
   transcribe and reconcile — the SRT from durations already known, the frame
   from a seek rather than from a moment.
5. **Sit on top, never fork.** Upstream ships fast; every capability here is a
   client of a public CLI and a public document format, so an upgrade stays an
   upgrade.
