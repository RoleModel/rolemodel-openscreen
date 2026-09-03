# Next session

Goal for the session: **demo the app and cut a killer promo video for it.**
Everything below is either in the way of that, or discovered while getting the
CCC Days video out.

---

## Settled — do not redo

### Transitions (previous session)

- Clip transitions are **cross-dissolves driven by GSAP** on `window.__timelines`,
  positioned in absolute composition time. The old wash-through-black is gone.
- The `animation-delay: calc(<start> - var(--t))` idiom is **removed and now
  asserted against** in `lib/verify.mjs`. Do not reintroduce it — animate with GSAP.
- A dissolve rides a **muted tail clone** of the outgoing clip. **An audible audio
  cross-fade is not expressible today** — it needs an upstream HyperFrames feature.
- The exporter **ffprobes every take** and only offers a dissolve where real handle
  exists past the out point. A failed `hyperframes render` **still exits 0**, so
  check for the artifact, never the exit code (the render script now does).
- GSAP is vendored from `brand/vendor/` into every export.

Worth knowing for the promo cut: **a dissolve costs handle.** When recording,
roll a second or two past the last word.

### The manual edit is codified (this session — was §3 and §6)

The CCC Days cut needed ~an hour of hand edits that the data already supported.
All of it is now done by the app:

| was done by hand | now |
|---|---|
| Trimmed 49.6s of silence off Jamey, 13.6s off Joby | `lib/speech-trim.mjs` — every clip whose edge sits on the **file's own boundary** is tightened to first word −0.25s / last word +0.5s from the transcript. An edge somebody placed inside the file is never moved. Recorded per clip as `trimmedToSpeech` in `assembly.json` and said aloud in the panel ("2 clips were trimmed to speech (49.3s of silence removed)"). |
| Cut "Okay," off the front of Dallas | `leadingFiller()` finds it from the word timings; the Assembly page **offers** it per clip (`/api/multi-assembly/trim`) rather than cutting silently. |
| Re-laid clips, moved lower thirds, fixed the closing title, regenerated the clock, fixed the root duration | `lib/reconcile.mjs` — a pure pass over `index.html` that recomputes every derived value from the clips: root `data-duration`, clock duration + file, Canvas `at`/`for`, a closing title left standing after a gap, dissolve tails, lower thirds (now linked by `data-assembly-for`), and the exporter's own GSAP tween positions. Runs before **every** render in `bin/rm-render-hyperframes.mjs`; `rm-reconcile <dir> --check` audits without writing and exits 1 on disagreement. Verified on the real CCC composition: it found the stale 166s clock, the closing title's `at` 6.2s later than its `data-start` (the blank title), and `for=2600` on a 16.7s card. |
| "Honour the pick" | The build writes exactly the selected in/out; the same clip existed as three different pairs across the multi-assembly picks, board takes and `scenes/*.footage.json`, and the board build takes `cut ?? sceneFootage`. Trimming never touches a chosen edge, so a pick survives the build unchanged. |

One rule worth knowing: a closing title dragged **back over** the last clip (so
it fades in over the footage, as the CCC cut does) is treated as a decision;
only a **gap** between the last clip and the title is closed.

`npm run check` now drives both libraries against fixtures (`reconcile:` and
`speech:` checks) and asserts every Studio render path goes through the
reconciling script.

### Demo-biters fixed (this session — was §5)

- `rm-lower-third` is promoted onto the timeline at both sites (export and legacy
  upgrade), on the title track, with its `at`/`for` offset onto the composition.
- A Canvas scene only replaces the assembly lower third when it **contains an
  `rm-lower-third`**; a shader or callout no longer costs a speaker their name.
- Emitted lower thirds carry an `id` (`clip-NN-plate`) — HyperFrames' linter was
  warning on every one.
- **Compose** and **Wallpapers** have nav buttons. Scenes already had one (that
  item was stale). Compose may be superseded by the Canvas cut — decide whether
  it stays before the demo, it is visible now.

### Guards added (this session — was §7)

- `capture()` in `lib/narration.mjs` — which is what every ffprobe/ffmpeg/rclone
  call in Studio goes through — now inherits `jobs.childEnv()`, so the
  Finder-launched PATH bug is fixed at the source. `npm run check` fails if a
  `spawn(` in `rm-studio.mjs` lacks `env: jobs.childEnv()`.
- All 49 raw `(await fetch(...)).json()` sites in `lib/studio.js` go through
  `responseJson`; the check fails on a new one.
- Orphaned preview servers: the existing reaper + "no preview server outlives
  the Studio that started it" check cover this. Not touched.

---

## 0. Before anything else

- [x] **Restart Studio.** Done twice this session; the :4600 CLI server is current.
      The desktop app runs its own server on a random port — restart the app too.
- [x] **Deploy OpenFrame.** `0de6699` went to Production on 2026-08-29 12:32Z
      and `OPENFRAME_API_TOKENS` is set in Vercel. Studio authenticates
      (`/api/review` lists the workspace and projects with the stored token).
      "Remove from review" confirmed working.
- [ ] **Another Claude session was committing in this repo concurrently** during
      this session (`5064989`, `6b031dc`). This session's work is uncommitted in
      the working tree — commit it before anything else sweeps it up. Files:
      `lib/reconcile.mjs`, `lib/speech-trim.mjs`, `lib/assembly-clock.mjs`,
      `bin/rm-reconcile.mjs`, `bin/rm-render-hyperframes.mjs`, `bin/rm-studio.mjs`,
      `lib/studio.{js,css,html}`, `lib/narration.mjs`, `lib/verify.mjs`,
      `package.json`, `packaging/rm-video.rb`, `docs/KICKOFF.md`, `docs/DEVELOPMENT.md`.
      `lib/sync-tap.mjs` also committed the formula change in `homebrew-tap`
      (not pushed).

---

## 1. The promo video (the actual goal)

The pipeline now trims, reconciles and verifies the artifact without opening
HyperFrames, so this is a content problem, not a plumbing one.

- [ ] **Decide the story first.** A shot list and script before any capture.
      Improvising it is how you get a generic UI tour.
- [ ] **Drive the capture.** `bin/rm-demo.mjs` + `lib/demo-capture.mjs`, or
      Playwright-trace regeneration (`PRODUCT.md` mechanism #1).
- [ ] **Cut and render** through the Canvas stage → **Build and render MP4**.
      The panel now reports what was trimmed; the Console shows what was reconciled.
- [ ] Decide whether the promo shows the *app* or the *output*. The strongest
      version is probably the app producing the video you are watching.
- [ ] **The test for §3 being done:** Build and render MP4 on a fresh recording
      produces a watchable cut with no hand editing. Do this once before the
      promo shoot and fix whatever it exposes.

---

## 2. Titles and motion — done, with two caveats

- [x] **`rm-title` entrances.** Eyebrow / title / sub / rule arrive 0 / 120 /
      240 / 320ms after `at` on the brand curve (`--lead` in the shared timing);
      the rule draws in from the left. Verified in a rendered frame.
- [x] **Lower thirds enter and leave.** The exporter's plate gets a GSAP slide-in
      (400ms, `power3.out`) and a 200ms fade-out on the composition clock; the
      reconcile pass moves both with the clip.
- [x] **House motion spec** — `DESIGN.md` "Motion", asserted by `npm run check`.
- [x] **The background leads the cut.** `rm-pixel-reveal` takes `flow-beats`
      (seconds) and `flow-step` (ms, default 3100 = half the field's period) and
      shifts 100ms before each beat. The exporter fills `flow-beats="auto"` from
      the clip boundaries; a script asks for it with `/reveal <brand image>`.
- [x] **Render cost measured:** 5.7s vs 4.5s for a 10s composition — about +27%,
      roughly +20s on a 165s cut. Fine.

Caveats, both design calls for you:

- The footage is full-bleed (the 2.5% inset was deliberately removed), so a
  background behind the *whole* composition is only visible under title cards
  and letterboxing. To get HeyGen's effect on footage you would inset clips
  again, which the exporter's own comment argues against.
- The shader's drift amplitude is small (`flow-intensity` 1.5 of 3.5); at the
  default the step is perceptible, not dramatic. Raise `flow-intensity` on the
  scene if you want more.

---

## 3. Slash-command vocabulary — done

- [x] `/eyebrow` already existed; `/sub` and `/reveal <image>` added. The
      multi-assembly build reads the selected script and the opening card takes
      `/title`, `/eyebrow`, `/sub` from it (generic wording otherwise), with a
      pixel reveal behind it when `/reveal` is set. The Canvas cut path uses the
      scene files as authored, so `blaine.html`'s hand-written `sub` stays.

---

## 4. Finish the JS → HTML template migration — pattern set, 7 of 30

- [x] **Row templates exist.** `<template data-row="…">` + `mountRow(name)`
      (beside `mountPanel`) returns the row's root and its `data-el` handles,
      so a list clones and fills text instead of building cards.
- [x] **`vSkills` converted** — 28 `el()` calls → 0, panel + `skill-card` row.
- [x] **A check per converted panel.** The table in `lib/verify.mjs` ("Converted
      panels build no structure in JS") names each converted view; the rule is
      zero `el(` in its body. Add a row when you convert one — the count is
      the progress bar.
- [ ] Next, in order of pain: `vConsole` (26), `vUsage` (26), `vWallpapers` (34),
      then the big four — `vStoryboard` (103), `vMultiAssembly` (100),
      `vRestyle` (88), `vProject` (83). One panel per commit; check after each.
      Note the other agent is actively editing `vRestyle` and `vVoice` on main —
      leave those until its work lands.

---

## 5. Explore: the Chrome extension as a capture source

Unchanged. Speak, click, get an assembly. Most parts exist; **the click track is
missing** and the risk is clock drift across three recorders. Spike on one
throwaway recording before building anything.

---

## 6. Performance

- [x] ~~`preload="metadata"`~~ — already tried, measured and rejected in the
      exporter's own comment: without range support every clip sits on frame 0.
      The real fix is proxy media. Dropped.
- [x] ~~Never render WebM natively~~ — already a row in `docs/DEVELOPMENT.md`
      "Things that will bite you". Stale item.

---

## 7. Sign in to Studio with Slack

Unchanged; do as its own piece — auth failures lock you out of your own tool.
One-shot loopback listener on a fixed port for the callback; enable Slack OIDC in
Supabase; `openid email profile`; then delete the password form.

---

## 7b. Slack Socket Mode — browse Studio from Slack

The other direction. Everything today is outbound (`lib/slack.mjs`: `postVideo`,
`findChannel`, `whoami`) and Slack cannot reach back, because Studio is a process
on a laptop behind NAT with no public URL.

Socket Mode inverts it: the app dials out over a WebSocket and Slack pushes slash
commands and button clicks down it. No tunnel, no Request URL, no server. Node
has a native `WebSocket`, so there is no dependency to add.

What it needs on top of what exists:

- an app-level token `xapp-…` beside the bot token — `lib/settings.mjs`
  `slackSettings()` already has the token/channel pattern, so it is one field
- `connections:write` on the app, and Socket Mode switched on
- `apps.connections.open` to get the socket URL, then reconnect on Slack's
  `disconnect` frames
- ack each envelope inside 3 seconds and post the real answer after, the same
  shape the job system already uses

What it buys: `/studio projects` lists the library with counts and last-updated;
`/studio <project>` lists its renders with a **Post here** button — and posting
is `postVideo`, which already works. That closes the loop.

Three things to decide when it is built:

- it only answers while Studio is running. Laptop asleep, no reply. That is
  inherent to a local app and worth saying out loud rather than debugging later
- it is a read hole into the library: anyone who can run the command sees project
  names and sizes. An allowlist of channels or users belongs in the first commit,
  not a later one
- if "asleep" turns out to bite, the fallback is publishing a small read-only
  index to something already hosted (OpenFrame is on Vercel) — a snapshot rather
  than live, but it answers when the machine is shut

---

## 8. Unfinished

- [x] ~~Slack has no settings UI~~ — it does now (`lib/studio.js` ≈16490,
      `/api/slack/settings`); stale item. Still **never run against a real
      workspace** — that part stands.
- [x] ~~3 failing `npm run check` assertions~~ — gone; check is 1423/0.
- [x] ~~Orphan transcript for `blaine-2.mp4`~~ — already gone.
- [ ] **Becky Passner has no role** in the script or her scene. Needs her title.
- [ ] Transcripts are `timing: "caption"` — word times are interpolated inside
      each cue. Speech trimming is exact at cue edges; filler detection is
      approximate. Word-level timing from the transcriber would sharpen both.

---

## Reference: what the CCC Days video needed

- The composition lives at
  `~/RoleModel Library/rolemodel-ccc-days/media/Renders/canvas-rough-cut/`.
  `rm-reconcile <that dir> --check` lists its three remaining disagreements
  (the closing title's `at`/`for`, the clock's derived mark); the next render
  fixes them.
- The footage on disk is already hand-trimmed (`jamey.mp4` is 18.4s) while the
  board takes still say `0→67.63`; the build clamps to the probed file length.
- Lower thirds were missing for **two independent reasons**: the 14:14 selection
  carried no speakers, and the hand-made speaker scenes were never attached.
- Regenerating the assembly is what makes speakers flow through; editing the
  script does not retroactively fix an existing selection.
