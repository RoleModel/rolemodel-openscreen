# Next session

Goal for the session: **demo the app and cut a killer promo video for it.**
Everything below is either in the way of that, or discovered while getting the
CCC Days video out.

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

## 2. Fixes that will bite during the demo

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

## 3. The one architectural fix worth doing properly

**Three derived values go stale whenever clips move in HyperFrames, and nothing
contradicts them.** Every visual bug in the last session was this:

| value | what went wrong |
|---|---|
| `<main data-duration>` | 6.9s of dead air after the closing title |
| canvas clock `data-duration` + the `.m4a` | stale at 173s against 165.69s of content |
| closing title `at=` | 13.6s late, so the title rendered blank |
| stray `fade-through` transitions | parked at boundaries that no longer exist |

- [ ] **Write a reconcile pass**, run before every render:
      ```
      content_end = max(start + duration) over every timed element except the root
      → set root data-duration
      → set clock data-duration, regenerate the .m4a at ceil(content_end)
      → set closing title `at` to the last media clip's out point
      → drop transitions that sit at no clip boundary
      ```
      `data-assembly-clock-derived` is already emitted as the "derived vs
      deliberate" signal this needs.
- [ ] **Add a `npm run check` assertion** that fails when the root duration,
      the clock, or a title's `at` disagrees with the content. This repo already
      enforces decisions that way (`npm run check` fails on a hand-written hex).
      It turns a silently blank title into a build failure.

---

## 4. Guards for the bugs that recurred

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

## 5. Performance

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

## 1a. Finish the JS → HTML template migration

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

## 5a. Sign in to Studio with Slack

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

## 6. Unfinished work from the last session

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
