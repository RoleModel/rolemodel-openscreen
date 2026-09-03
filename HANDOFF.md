# Handoff — the cut editor

Written 2026-09-02. Branch **`editor-timeline`**, working tree clean at `8a7f242`.

> This replaced a handoff from 2026-08-22 about the Cowork-bridge delivery and
> the first Homebrew release. Its open items — push, set `TAP_TOKEN`, tag
> `v0.1.0` — are all long done; `origin/main` is on v0.1.76. Recover it with
> `git show 8a7f242~1:HANDOFF.md` if you want it.

## Where things are

You are in the main checkout: `/Users/dallas/Development/openscreen/rolemodel-openscreen`.
Dallas asked, in these words, that instances **work in the main repo on a branch
like every other instance** — not in a worktree off in the Claude folder. An
earlier session committed twelve of these commits straight onto `main` in his
primary checkout, which meant he could not tell what his own app was running.
`main` has since been reset to `origin/main` and every editor commit lives on
`editor-timeline`. Do not commit editor work to `main`.

```
editor-timeline   8a7f242   twelve commits, none pushed
main              2a1f27c   = origin/main, clean
```

Two other worktrees exist. **Leave both alone.**
`rolemodel-openscreen-editor-spike` is stale but holds uncommitted CSS that is
not ours; `rolemodel-openscreen-reconcile` is a detached HEAD belonging to
another session. A concurrent Claude session commits to `main` — do not clobber
its work, and never `git stash` in a shared checkout.

## What this is

An editor to replace the HyperFrames video-editing experience, which Dallas
said plainly he hates. The reference point he keeps naming is **elevate.io**:
twenty-plus clips, buttery drag and scrub, instant page load, transitions that
drop right on. Speed is the feature.

The spine is that **nothing derived is stored**, and **the editor never opens
the original media**.

- `lib/cut.mjs` — the model. A clip is `{id, source?, name?, in, out, at}`.
  Duration is `out - in`. Cut length is the furthest `clipEnd`. A transition IS
  an overlap; there is no transition field. `writeCut` refuses a cut with
  problems rather than writing one and repairing it later.
- `lib/edit-cache.mjs` — three artefacts per source, built once: a 720p/5 Mbps
  proxy (`-g 30`, `-sc_threshold 0` so it seeks), 160×90 filmstrip JPEGs every
  0.5s, and min/max peak arrays. Keyed by
  `sha256(size:mtimeMs:basename).slice(0,16)`.
- `lib/timeline-canvas.js` — one paint, never opens media. 1.2–2.8 ms per
  repaint, and the panel shows that number so a regression is visible.
- `lib/timeline-input.js` — gestures. Wheel pans, cmd/ctrl zooms. Snapping is
  measured in pixels, not seconds.
- `lib/cut-seed.mjs` — reads a composition into a cut. Shared by CLI and Studio.
- Panel: `vTimeline()` in `lib/studio.js`, markup in `lib/templates/timeline.{html,css}`.
- CLI: `bin/rm-cut.mjs` (`seed`, `show`).

## Working now

Seeding a composition into `cut.json`; video, graphic and audio lanes; drag to
move, drag an edge to trim, drag the ruler to scrub; filmstrips and per-clip
waveforms; wheel panning; a scene layer that mounts the real composition over
the picture and seeks it; standalone audio with `POST /api/edit/audio`;
`rolemodel-studio-promo` carries `seven-steps.wav` as a 37.9s bed.

`1879 passed, 0 failed, 1 skipped` on `node --run verify`. BEM holds.

## Do this first

**Watch it play in a visible window.** Everything below the line is unverified
in motion, and that is the whole point of the next session.

```
node bin/rm-studio.mjs            # then: Timeline in the nav rail
```

Dallas's own Studio needs restarting to pick up the branch. A test one may still
be on `:57533` — kill it rather than adding another.

Scrub the CCC Days cut to ~10s. Expect the caption `say-1` over footage
`hf-2q0u`, with the background haze gone. Then press play and watch whether the
words animate and the picture moves.

## What is left, in his words

> "the words are not playing and the videos are not playing either, the
> wallpaper covers them up"

The wallpaper half is fixed — the composition's full-frame elements were
painting over the footage because only the mounted sub-compositions were being
switched. Every graphic the cut lists is switched now. Whether the words and
the picture actually move is **unconfirmed**, because Chrome suspends video
decoding, WebGL and `requestAnimationFrame` in the hidden tabs automation
drives. In my screenshots the static RoleModel bug renders and the shader and
tweens do not. I could verify geometry and DOM state; I could not verify a
single moving frame. Treat every playback claim in the git log as untested.

If the words still do not arrive: the say-N mounts register no timeline of their
own, so they are driven by the absolute `--t` custom property in milliseconds
plus `RM.seek(ms)`. That is correct only while a clip sits where the markup says
it does — **move a graphic on the timeline and its animation will desync**,
because `--t` is absolute composition time and `clip.at` is now something else.
Nobody has solved that yet.

Then, roughly in the order he raised them:

- **UI.** He is doing this himself and said so. The docked transport container,
  its Optics form classes, and `form-group--no-padding` in `lib/studio.css` are
  his. Ask before restyling the panel. He has already had to tell me the layout
  was wrong once.
- **Render from `cut.json`.** There is no path from a cut to a finished file.
  The editor can describe an edit it cannot produce.
- **Scenes and clips together.** He asked for "clips and scenes working, with
  audio". Audio and scenes are in; whether they hold up under real editing is
  untested.
- `todo-next-session.md` §7b — Slack Socket Mode, so Slack can see the library.
- `canvas-rough-cut` still has the old Joby ending at 17.000.
- Dallas/Becky/Blaine-closing captions in the pip cut still run 1–2s early.

## Rules he has stated

- **"I'm not going to nor would I expect any other user to run node commands…
  this has to be integrated."** A feature that is not reachable in the Studio UI
  is not done. He has had to tell me this three times — "then where is the
  editor?", "where is teh link to edit?", "motioon editor just links to
  hyperframes." Finishing the machinery is not finishing the work.
- **No markup in `studio.js`.** It goes in `lib/templates/*.html`. `control()` is
  a template lookup (`control-<kind>`), not an element factory.
- **No invented colours.** Zero hex literals in `lib/studio.{css,html,js}` and
  `lib/templates/*` — not even as a `var(--op-…, #hex)` fallback. The verify
  suite enforces it. `lib/timeline-canvas.js` is exempt, because a canvas cannot
  read a custom property.
- Spacing tokens are `--op-space-x-small`, `-small`, `-medium`… There is no
  `--op-space-xs`; I tried and the suite caught it.

## Traps already paid for

- **An ffmpeg `.part` draft needs an explicit `-f mp4`.** Without it ffmpeg
  guesses the muxer from the filename and exits with `Invalid argument`, which
  says nothing about containers. This has now bitten twice.
- **A source with no video stream** cannot be scaled or stripped. `cacheSource`
  probes with `hasVideo()` first; asking libx264 to scale a music bed failed the
  whole cache rather than the one artefact that could not exist.
- **`aspect-ratio` plus a max on each axis does not letterbox** — it clamps one
  axis and leaves the other, which produced a 1.25:1 picture from a 16:9 rule.
  `.tl__frame` asks its container both ways with `min(100cqw, calc(100cqh * 16 / 9))`.
- **An iframe does not scale its document to its box.** The scene layer renders
  at the composition's native 1920×1080 and the frame is transformed onto the
  picture via `--tl-scale`, kept current by a `ResizeObserver`.
- **The composition root carries `data-composition-id` too.** Switching every
  element with that attribute hid the entire piece, and `visibility` inherits,
  so every caption went with it. Switch by the clips the cut lists.
- **Setting `src` resets a media element to paused.** One `play()` in a click
  handler is not enough; the picture has to be told on every clip it enters.
- **`.gitignore` needs a bare `node_modules`, not `node_modules/`.** The
  trailing slash matches directories only, so a worktree symlink was staged,
  merged as mode 120000, and replaced the real directory — `ELOOP` on
  `pnpm run app`. That broke his build.
- **`git branch -f main origin/main`** while checked out elsewhere rewinds a
  branch without touching anyone's working tree. Prefer it to `reset --hard` in
  a shared checkout.
- Chrome suspends media decode, WebGL and `requestAnimationFrame` in hidden
  tabs. `await` on a rAF there hangs the CDP call for 45s. Poll with
  `setTimeout`, and do not trust a black preview as evidence of a bug.

## How to check things without a browser

```bash
node --run verify                 # 1879 tests
node --run bem:check
node bin/rm-cut.mjs show <project>

curl -s "http://127.0.0.1:PORT/api/edit/cut?project=rolemodel-ccc-days&folder=canvas-pip-transcript" | python3 -m json.tool
curl -s -o /dev/null -w "%{http_code}\n" -I "http://127.0.0.1:PORT/api/edit/cache/<project>/proxy/<key>.mp4"
```

Studio routes the editor added: `/api/edit/cut` (GET/POST), `/api/edit/seed`
(POST), `/api/edit/audio` (POST), `/api/edit/cache/:project/*` (GET/HEAD, Range),
`/api/edit/scene/:project/:folder/*` (GET/HEAD).

Set the opening view without clicking:
`curl -X POST .../api/view -H 'content-type: application/json' -d '{"view":"timeline"}'`

## Two test subjects

- **`rolemodel-ccc-days` / `canvas-pip-transcript`** — 9 graphics, 7 video
  takes, real footage with its own audio, no audio files in the project at all
  (so the Audio picker is correctly hidden).
- **`rolemodel-studio-promo` / `studio-promo-30s`** — 8 mounted beats, no video
  track, one 37.9s bed. This is the graphics-only case, and the one where the
  wall clock has to drive playback because there is no footage to clock off.
