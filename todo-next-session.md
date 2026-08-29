# Next session

Goal for the session: **demo the app and cut a killer promo video for it.**
Everything below is either in the way of that, or discovered while getting the
CCC Days video out.

---

## Settled since this file was written — do not redo

Transitions are **done and codified**; the exporter no longer needs a person to
think about them.

- Clip transitions are **cross-dissolves driven by GSAP** on `window.__timelines`,
  positioned in absolute composition time. The old wash-through-black is gone.
- The `animation-delay: calc(<start> - var(--t))` idiom is **removed and now
  asserted against** in `lib/verify.mjs`. The renderer never seeks CSS
  animations, so that one idiom caused *both* the flashing transitions and the
  mid-clip dips. Do not reintroduce it — animate with GSAP.
- A dissolve rides a **muted tail clone** of the outgoing clip, so each clip's
  own audio still ends on its out point. This is deliberate: a clip's native
  audio is bound to its video element, and HyperFrames' audio graph has no fade
  primitive (`atrim`/`adelay`/`amix`/`apad` + a static `volume=`), so overlapping
  clips would mix both speakers at full gain. **An audible audio cross-fade is
  not expressible today** — it needs an upstream HyperFrames feature.
- The exporter **ffprobes every take** and only offers a dissolve where real
  handle exists past the out point, falling back to a straight cut. Without this
  the render aborts on a frame-coverage gate — and note that a failed
  `hyperframes render` **still exits 0**, so check for the artifact, never the
  exit code.
- GSAP is vendored from `brand/vendor/` into every export; renders never touch
  the network.

Worth knowing for the promo cut: **a dissolve costs handle.** These takes had
almost none — trailing room tone was 0.4–1.0s and Jamey speaks to within 0.10s of
the end of his file, so that boundary stayed a straight cut. When recording for
the promo, roll a second or two past the last word.

---

## 0. Before anything else

- [ ] **Restart Studio.** Every server-side fix from the last session is in
      `bin/rm-studio.mjs`, and the running process predates all of it. Symptoms
      if you skip this: "Build and render MP4" reports an older server, `?download`
      plays instead of saving, rclone/ffmpeg spawns still fail.
- [ ] **Deploy OpenFrame.** `0de6699` is pushed to `RoleModel/OpenFrame` master
      but "Remove from review" stays broken until Vercel ships it, and until
      `OPENFRAME_API_TOKENS` maps the Studio token to your account email.

---

## 1. The promo video (the actual goal)

The pipeline now works end to end without opening HyperFrames, so this is a
content problem, not a plumbing one.

- [ ] **Decide the story first.** A shot list and script before any capture.
      The Plan stage exists for exactly this. Improvising it is how you get a
      generic UI tour.
- [ ] **Drive the capture.** `bin/rm-demo.mjs` + `lib/demo-capture.mjs`, or
      Playwright-trace regeneration (`PRODUCT.md` calls this mechanism #1, and
      it is the thing worth showing off).
- [ ] **Cut and render** through the Canvas stage → **Build and render MP4**.
- [ ] Decide whether the promo shows the *app* or the *output*. The strongest
      version is probably the app producing the video you are watching — the
      CCC Days script already does this ("This video is the experiment
      reporting on itself").

---

## 2. Finish the JS → HTML template migration

The half-done conversion this session interrupted. The codebase already decided
this — `studio.html` carries the pattern and the comment explaining it:

> *"A panel used to be assembled in JavaScript — forty lines of `el('div')` and
> `.append()` per view, where the structure was something you reconstructed by
> reading code rather than something you could see."*

It stopped at six panels.

| | |
|---|---|
| panels already templated | **6 of 30** (`firstrun`, `new`, `create`, `scripts`, `scenes`, `components`) |
| `el()` construction calls left in views | **~1,200** |
| lines of view code | ~12,000 |

Worst offenders: `vStoryboard` (103 calls / 1,334 lines), `vMultiAssembly` (102),
`vProject` (82), `vBrand` (77), `vRecord` and `vMake` (63 each).

- [ ] **Extend the existing pattern**, do not invent a second one:
      `<template data-panel="x">`, `data-region="main|side|footer"`,
      `data-el="handle"`, mounted with `mountPanel()`. Nothing needs designing.
- [ ] **Repeating lists need a row template.** Project cards, media rows, board
      takes and transcript lines cannot be static HTML. Add
      `<template data-row="…">` cloned per item, so JS clones and fills text
      rather than building structure. This is what the three biggest views are
      almost entirely made of.
- [ ] **Add a `npm run check` rule per converted panel**, so it cannot slip back
      — the same idiom as the hand-written-hex check.
- [ ] Do it panel by panel, checking after each. A single sweep across 30 views
      is unreviewable.

**Note:** a literal zero is not achievable client-side — lists must still be
cloned and filled at runtime. The achievable target is *zero structure built in
JS*. Server-rendering the lists would be a genuine zero and a much larger change
to how Studio fetches and updates.

---

## 3. Codify the manual edit — the app should do all of this

Nearly every hour of the CCC Days video went into steps the data already
supported. None of it needed judgement; it needed the app to act on what it
already knew. **This is the single highest-value item in this file.**

### What was done by hand, and what it should have been

| done by hand | the data that was already there |
|---|---|
| Trimmed 49.6s of silence off Jamey, 13.6s off Joby | the transcript says speech ends at 18.0s and 24.0s |
| Cut "Okay," off the front of Dallas | word timings: `w1 "Okay," 0 → 0.385` |
| Re-laid every clip so nothing gapped | arithmetic |
| Moved 6 lower thirds, 7 transitions, the closing title | all derived from clip positions |
| Regenerated the clock, fixed the root duration | derived from content end |
| Trimmed a blooper ("Nailed it") | the pick already said `out=26.04`; the export ignored it |

- [ ] **Trim every clip to its speech on import.** First word to last word plus a
      breath, from the transcript that already exists. A clip should never
      default to the whole file — that is where every silence came from.
- [ ] **Offer leading-filler removal.** "Okay", "alright", "so", "um" as the
      first word is detectable from word timings. Offer it per clip rather than
      doing it silently; it is an editorial call, but finding it is not.
- [ ] **Honour the pick.** The assembly chose `19.04 → 26.04` for Blaine and the
      composition played `19.284 → 26.834`, which cut a word off the front and
      let a blooper in at the end. The export must not drift from the selection.
- [ ] **Reconcile before every render** (section 4 covers this). Every derived
      value recomputed from clip positions.
- [ ] **Then: "Build and render MP4" produces a watchable cut with no hand
      editing.** That is the test. If a person has to open the composition to
      make it good, this item is not done.

### Why it kept happening

Each of these failed *silently*. Nothing errored, nothing looked broken — the
render simply contained 63 seconds of someone sitting still, and the only way to
find out was to watch it. Anything derived from another value needs either a
check that it agrees, or a pass that recomputes it.

---

## 4. Titles and motion: the videos are boring

Honest assessment after watching one: the footage is fine and the titles are
inert. A static title card and a static lower third, on a static wallpaper.

**There is more in the component library than the pipeline uses.** These exist,
are seek-driven, and nothing in the assembly path emits them:

| component | what it does |
|---|---|
| `rm-pixel-reveal` | halftone / duotone image reveal, GPU shader |
| `rm-shader` | animated background treatment behind a lockup |
| `rm-bullets` | a list that **staggers** its items in |
| `rm-stat`, `rm-year` | counting numbers |
| `rm-callout` | a pointer that pops onto a spot in the frame |

`lib/annotations.mjs` also has a motion vocabulary already — `fade`, `pop`,
`slide-up` — used for annotations and never for titles.

- [ ] **Give `rm-title` real entrances.** Today it is `--rise:26px` and nothing
      else. Word-level or line-level stagger, an eyebrow that arrives before the
      title, an accent rule that draws in. The component already knows its own
      `at`/`for`, so this is animation inside it, not new timeline plumbing.
- [ ] **Use the reveal components on the bookends.** The opening title over a
      `rm-pixel-reveal` of a frame from the video, rather than a flat wallpaper,
      would carry more than any amount of typography tuning.
- [ ] **Lower thirds should enter and leave**, not cut. `slide-up` exists.
- [ ] **Decide a house motion spec** and put it in `DESIGN.md` beside the
      existing "Motion" rules, so this is a decision rather than per-video taste.

### The technique worth stealing: the background leads the cut

From HeyGen's own `inspector-launch` study
(`heygen-com/hyperframes-launches/inspector-launch`), which Dallas pointed at.
The interesting idea is not title animation at all — their `DESIGN.md` says:

> *"The halftone should make a major shift about `0.1s` before each scene
> transition begins, so the background cues the edit before the foreground
> follows."*

A continuous halftone field behind everything, which **shifts just ahead of every
cut**. The eye is told a change is coming a beat before it arrives, so the edit
feels intentional rather than abrupt. That single idea would do more for these
videos than any amount of type animation.

Two things they deliberately do **not** do, worth copying as restraint:

- **No stacked word pills for the opener** — the cascading word reveal is named
  and rejected.
- **No character stagger or line-by-line fades specified anywhere.** Titles are
  large and still; the motion lives in the background.

That fits this design system better than a stagger would: precision, one accent,
nothing decorative.

**We already have the halftone.** `rm-pixel-reveal` is a WebGL shader with
exactly these controls, and the assembly path emits it zero times:

```
image, pixel-density, pixel-gap, pixel-roundness, halftone-frequency,
show-duotone, color-a, color-b, paper, cyan-ink, magenta-ink, yellow-ink,
black-ink, color-fringing, flow-intensity, flow, at, for
```

Note theirs is Canvas 2D and **static** — a seeded `mulberry32` dot field, chosen
for determinism. Ours is a GPU shader with CMYK inks and a `flow` parameter, so
it can do the continuous drift theirs cannot, and `flow`/`at`/`for` are already
seek-driven.

- [ ] **Spike it:** one `rm-pixel-reveal` behind the whole composition, with
      `flow` stepping ~100ms before each clip boundary. The boundaries are known
      — the reconcile pass in section 6 computes them.
- [ ] Check the render cost first. A full-frame fragment shader over every frame
      of a two-minute video is a real per-frame cost, and the render already
      takes ~70s.
- [ ] Keep the CMYK inks on brand: `paper` and the four inks should come from
      the Optics tokens, not be hand-picked per video.

**Caution worth stating:** motion is where a branded video becomes a cheap one.
The existing design system is deliberately restrained — no shadows, one accent,
tight radii. Titles that fly and bounce would fight that. The reference above is
useful precisely because its answer is *less* foreground motion, not more.

---

## 5. Fixes that will bite during the demo

- [ ] **`rm-lower-third` is not promoted onto the timeline.**
      `splitCanvasTimelineComponents` (`bin/rm-studio.mjs`) promotes only
      `rm-title | rm-shader | rm-pixel-reveal`. Attach `blaine.html` to a clip
      and its lower third stays in the untimed scene body — no track of its own,
      and its `at`/`for` are never offset onto the composition clock. Add it to
      that list.
- [ ] **Canvas clips suppress assembly lower thirds wholesale.**
      The rule is `clip.speaker && !hasCanvasScene`. It should be "unless the
      scene already contains an `rm-lower-third`", so a scene that does its own
      titling wins but one that doesn't still gets a plate.
- [ ] **Slash-command vocabulary is too thin.** `/title /brand /wallpaper
      /speaker` exist; **eyebrow, subtitle, and shader config do not**, so the
      only way to set them is hand-editing scene HTML. That is why
      `blaine.html` has `sub="Developer 2"` written by hand. Decide which knobs
      are worth exposing and what the defaults are for the rest.
- [ ] **Scene editor has no front door.** `vScenes` is reachable only via
      Canvas → "Edit scene" / "Open scene editor". Give it a nav entry.
      Same class of bug: **Wallpapers** has no nav button, and **Compose** has
      *zero* routes and is completely unreachable.

---

## 6. The one architectural fix worth doing properly

**Three derived values go stale whenever clips move in HyperFrames, and nothing
contradicts them.** Every visual bug in the last session was this:

| value | what went wrong |
|---|---|
| `<main data-duration>` | 6.9s of dead air after the closing title |
| canvas clock `data-duration` + the `.m4a` | stale at 173s against 165.69s of content |
| closing title `at=` | 13.6s late, so the title rendered blank |
| ~~stray `fade-through` transitions~~ | gone — transitions are GSAP tweens now |

- [ ] **Write a reconcile pass**, run before every render:
      ```
      content_end = max(start + duration) over every timed element except the root
      → set root data-duration
      → set clock data-duration, regenerate the .m4a at ceil(content_end)
      → set closing title `at` to the last media clip's out point
      → re-derive each dissolve from the clip boundary it belongs to
      ```
      `data-assembly-clock-derived` is already emitted as the "derived vs
      deliberate" signal this needs.
- [ ] **Add a `npm run check` assertion** that fails when the root duration,
      the clock, or a title's `at` disagrees with the content. This repo already
      enforces decisions that way (`npm run check` fails on a hand-written hex).
      It turns a silently blank title into a build failure.

---

## 7. Guards for the bugs that recurred

- [ ] **`spawn` without `childEnv`.** Fixed in six places (ffmpeg ×1, rclone ×3,
      zip ×2) — all the same bug: a Finder-launched Studio has
      `PATH=/usr/bin:/bin`, so Homebrew binaries are invisible. Add a check that
      no direct `spawn`/`execFile` omits `env: jobs.childEnv()`.
- [ ] **Raw `.json()` on fetch.** Fixed in seven places; each one turned a real
      server answer into "could not reach the Studio" or a silently dead button.
      Add a check that client fetches go through `responseJson`.
- [ ] **Orphaned processes.** 15 HyperFrames previews and 4 Studio servers were
      found running, two wedged at ~98% CPU for 12+ hours — a large part of why
      the machine felt slow all day. Studio should reap its own preview servers
      on exit, or refuse to start a second one for the same project.

---

## 8. Explore: the Chrome extension as a capture source

**The scenario worth building toward:** record the screen you are already on,
talk while you click, and get back a transcript that Claude has aligned to the
clicks — so the cut, the captions, and the beats all come out of one take with
no script written in advance.

That is the inverse of the current Make path, which writes a script first and
then performs it. Both are worth having: one for a demo you plan, one for a demo
you narrate as you go.

**Most of the parts already exist. This is an integration, not a new pipeline.**

| piece | where it already is |
|---|---|
| driving a browser, capturing screenshots | the Chrome extension |
| a recording with cursor positions | `lib/demo-capture.mjs` — `RECORD_FLAGS.cursor` |
| Playwright traces carrying actions, screenshots, waits | `PRODUCT.md` calls this mechanism #1 |
| transcription with word timings | `/api/paper-edit/transcribe` → `.vtt` per source |
| aligning spoken words to structure | `skill/video-from-script/scripts/align.py` — `align_beats()` |
| aligning audio to a visual cut | `/api/multi-assembly/audio-align` |

**What is missing is the click track.** `align_beats` aligns a transcript to
*script beats*. This wants the same function aligned to *events* — "clicked
Save at 12.4s" — so a beat boundary is a real interaction rather than a
sentence somebody wrote earlier.

- [ ] **Establish what the extension can emit.** A timestamped event stream is
      the whole question: selector or accessible name, coordinates, and a clock
      that can be reconciled with the recording's. Without a shared clock this
      does not work at all, so answer it first.
- [ ] **Write the event stream beside the media**, the way transcripts already
      sit in `paper-edits/`. One file per recording, same naming.
- [ ] **Teach the aligner to take events as anchors.** `align_beats` is the
      right function and it is already tested (`test_align.py`); the change is
      the shape of what it aligns *to*, not the matching itself.
- [ ] **Then the payoff:** a first cut where every click is a candidate cut
      point and the narration is already timed to it. Speak, click, get an
      assembly — no script, no paper edit.

**Worth a spike before committing to it.** The risk is not the alignment, it is
clock drift between three recorders (screen, microphone, extension) and whether
the extension can see enough of the page to name what was clicked. Prove those
two on one throwaway recording before building anything around it.

---

## 9. Performance

- [ ] **455 MB of video is eagerly loaded.** Six `<video preload="auto">`
      elements pointing at *full source recordings* (via the `source` symlink),
      not trimmed clips. Change to `preload="metadata"` — **but check the render
      path first**, since the same HTML drives headless rendering and I did not
      want to alter frame buffering blind.
- [ ] **Never render WebM natively again.** `--format webm` re-captures every
      frame as RGBA PNG into the project folder — it wrote **3.7 GB / 2,212
      files** before I killed it. Transcode the finished MP4 with ffmpeg instead
      (minutes, no alpha, no staging).

---

## 10. Sign in to Studio with Slack

Supabase already has a Slack provider (`slack_oidc`), so **only the sign-in step
changes** — RLS, `to authenticated`, the session file, `storyboards` and
`studio_settings` all keep working, because it stays a Supabase session.

It also makes the model in `sql/storyboards.sql` literally true — *"signed in and
on the team are the same statement"* — and removes the password flow, which is
the thing that wasn't working on the Canvas.

**The obstacle is the redirect URI.** OAuth needs a pre-registered callback and
Studio's port moves:

| launched how | port |
|---|---|
| `rm-studio` CLI | 4600 (`flag("port", 4600)`) |
| the desktop app | random — `electron/studio/server.ts` calls `freePort()` |

- [ ] **Use a one-shot loopback listener on a fixed port** for the callback only
      — e.g. `http://127.0.0.1:4666/auth/callback` — opened when sign-in starts
      and closed the moment the code arrives. Standard CLI-OAuth pattern (`gh
      auth login`, `aws sso`), and immune to Studio's own port changing. A
      wildcard redirect (`http://localhost:*`) may also work, but that depends on
      Supabase allowlist behaviour I have not verified against this project.
- [ ] Enable **Slack (OIDC)** in Supabase → Authentication → Providers.
- [ ] Slack app needs `openid`, `email`, `profile`. Can be the same app as the
      bot token, but it is a separate concern — keep the bot scopes minimal
      (`files:write`, `chat:write`, `channels:read`).
- [ ] Then delete the email/password form on the Canvas.

**Do this as its own piece.** It changes how people get into Studio, and auth
failures are the kind that lock you out of your own tool.

---

## 11. Unfinished work from the last session

- [ ] **Slack has no settings UI.** `lib/slack.mjs`, credential storage with
      validation, and three endpoints exist; "Post to Slack" is on every video's
      action menu. But the token/channel can only be set via `SLACK_TOKEN` /
      `SLACK_CHANNEL` env vars. Needs a settings panel, and **none of it has
      been run against a real workspace.**
- [ ] **3 failing `npm run check` assertions** belong to ChatGPT's in-flight
      work, deliberately untouched: the review `remove` button
      (`acts.append(checkIt, openIt, copyIt, remove)`), the `studio.html`
      rewrite (Docs block), and a view missing an icon.
- [x] **`templates-migration` worktree** removed — it was branched from main
      with zero commits. The migration itself is now section 1a.
- [ ] **Orphan transcript** for `Footage/blaine-2.mp4`, a file that no longer
      exists, in `paper-edits/`. Harmless, worth deleting.
- [ ] **Becky Passner has no role** in the script or her scene. Everyone else
      has one. Needs her actual title.

---

## Reference: what the CCC Days video needed

Kept because the promo will hit the same things.

- The composition lives at
  `~/RoleModel Library/rolemodel-ccc-days/media/Renders/canvas-rough-cut/`
- Lower thirds were missing for **two independent reasons**: the 14:14
  selection carried no speakers (it predates bare-name support), and the
  hand-made speaker scenes were never attached to the clips.
- The script names speakers as bare lines (`Blaine Irvin`), which the parser now
  accepts, along with a role on the next line or after a comma/dash.
- Regenerating the assembly is what makes speakers flow through properly;
  editing the script does not retroactively fix an existing selection.
