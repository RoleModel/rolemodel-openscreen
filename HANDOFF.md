# Handoff

Written for a Claude Code session picking this up cold on Dallas's Mac, after a
Cowork session on 2026-08-22 built most of what is here. Updated later the same
day by the session that landed it in git.

**Read this first, then `npm run check`.** If the check passes, the tree is sound
and you can start on "What's left" below — which is now short, and blocked on one
thing only Dallas can do.

---

## Why this handoff exists

The Cowork session that wrote this code runs in a cloud container with **no git
remote, no `gh`, and GitHub blocked at the egress allowlist**. It could not push.
Its only channel to the Mac was: tar the changed files → write the tarball into
the repo → extract with `--overwrite`. Six deliveries went that way.

So the working tree had all the code and **the git history had none of it.** That
is now fixed: it is two commits, `d4f970c` and `83622d5`. Kept here because it
explains the shape of that first commit — 54 files in one go is not how anyone
would choose to land this, and the reason is the bridge, not haste.

---

## State as of handoff

| | |
|---|---|
| Local HEAD | `83622d5` — *"Make the tap installable"* |
| `origin/main` | `6d91986` — **three behind local**, all of it unpushed |
| Working tree | clean |
| Tests | `npm run check` → **78 passing, 51 skipped** (no local OpenScreen checkout) |
| Full suite | **129 passing, 0 failed** against a fresh upstream clone, 2026-08-22 |
| Tap repo | `../homebrew-tap` — `Formula/rm-video.rb` + `Casks/openscreen.rb`, **one commit unpushed** |

The 129/0 matters more than it looks: `lib/verify.mjs` reads OpenScreen's own
TypeScript, so a clean run against a *fresh clone of upstream today* means the
presets have not drifted against a repo shipping ~2.4 releases a day.

The stale `.git/index.lock` and the 2.5MB `_to_delete/` are both gone — the
Cowork bridge's `device_bash` could not delete files.

---

## What this repo is

A **brand and workflow layer on top of OpenScreen** — not a fork of it.

OpenScreen exposes a headless CLI (`record`, `sources`, `export`, `pack`,
`captions`, `info`, all with NDJSON output) and a JSON document format. This repo
is a *client* of both. Forking would mean owning an Electron shell plus a Rust
compositor plus a Swift capture helper against a repo shipping ~2.4 releases a
day — to add panels that are all just HTML. Don't. `brew upgrade` is the upgrade
path, and nothing here needs merging.

```
bin/rm-studio.mjs      the one window — a local web app, zero deps
bin/rm-video.mjs       presets and theming for .openscreen documents
bin/rm-library.mjs     project manifests, rclone mounts, media catalog
bin/rm-voice.mjs       script -> narration + SRT
bin/rm-mux.mjs         put narration on a render, reconciling their clocks

lib/jobs.mjs           spawn allowlisted binaries, stream output over SSE
lib/optics-css.mjs     vendor @rolemodel/optics; generate only what it lacks
lib/wallpaper.mjs      recipe -> canvas. Shared by preview, export, batch build
lib/narration.mjs      per-line TTS, measured, into audio + an exact SRT
lib/script-parse.mjs   markdown -> speakable lines (served to the browser too)
lib/verify.mjs         129 assertions, incl. against a real OpenScreen checkout
components/            custom elements for HyperFrames scenes
brand/optics/          Optics verbatim + the RoleModel-only scales, pinned by hash
```

`lib/verify.mjs` reads OpenScreen's own TypeScript to check the presets still
match its types. That needs a checkout, and there isn't one on this Mac:

```bash
node lib/verify.mjs --openscreen /path/to/openscreen   # all 129
node lib/verify.mjs                                    # 78, skips 51 loudly
```

Without `--openscreen` it looks in `../openscreen`, finds nothing, and **skips**
the 51 schema-drift assertions rather than crashing — so `npm run check` is
useful on a fresh clone. Naming a path that isn't a checkout is still fatal,
which is the case that matters: CI passes `--openscreen`, and a silent skip
there would drop the drift checks out of the tag gate while still printing green.

---

## Six traps, each of which cost real time

These are the things that will bite again if nobody knows them.

**1 · Backticks inside a template literal.** `lib/studio-ui.mjs`,
`bin/rm-studio.mjs` and `components/rm-video.js` all build CSS and JS inside
tagged template literals. A backtick in a CSS comment silently terminates the
literal, the module stops parsing, and the page renders as unstyled tags — which
looks like a component bug and is not one. This happened twice. `npm run check`
now runs `node --check` over all three files. Same family: `\n` and `\1` inside a
nested literal need doubling, or you get a real newline / an octal escape error.

**2 · Two CSS animations cannot both drive `opacity`.** In `components/rm-video.js`,
enter and exit are separate animations. With `fill-mode: both`, the exit
animation's *backwards* fill (opacity 1) beats the entrance's (opacity 0) purely
by list order — so every component rendered visible from frame 0 and nothing ever
appeared on cue. They now write to separate registered custom properties and
`opacity` composes from both. Do not "simplify" that back.

**3 · A render and a narration track are on different clocks.** `playwright-recast`
compresses idle time — a 5s interaction became 3.8s of video — while narration is
however long the words take, which was 22s for the same demo. Burning a 22s SRT
into a 3.8s render shows cue 1 for the whole clip and drops the rest, **and it
looks like it worked**. `bin/rm-mux.mjs` reconciles them. The Studio returns
recast + mux as two steps and skips recast's own `--burn-subs` when a mux
follows.

**4 · recast needs a video beside the trace.** With only a `trace.zip` it
assembles from screencast frames — 15 of them for a 3s interaction, which reads
as a slideshow. Record with `recordVideo` and save the `.webm` next to the `.zip`
under the same basename. The Studio warns when it is missing.

**5 · The cask filename is not the one electron-builder prints.** OpenScreen's
`electron-builder.json5` says
`artifactName: "${productName}-Mac-${arch}-${version}-Installer.${ext}"`, and the
cask was written from it. But `build.yml` renames every DMG before attaching it
to the release — deliberately, since "x64" reads as the normal one and "arm64" as
the exotic variant, which is backwards on any Mac sold since 2020. The real
assets are `Openscreen-macOS-Apple-Silicon-<ver>.dmg` and `-Intel-`. Releases
before that change used `-Mac-arm64-` / `-Mac-x64-`, so the URL does not resolve
for older versions either. Check the release assets, not the build config.

**6 · No radial gradients, anywhere.** RoleModel's brand is linear. The first
wallpaper set used a radial vignette to settle the edges; at 16:9 that ellipse
fell outside the frame along the bottom and read as a thick dark border under
every recording. `npm run check` fails if one comes back. The edge, when a board
wants one, is a solid border.

---

## What's left

Done since this was written: the working tree is committed; `release.yml` no
longer runs `sync-brand --check` twice and now runs `optics-css --check` too; the
cask has real checksums and, more to the point, a URL that resolves; and the tap
has `Casks/openscreen.rb`. Both repos have unpushed commits.

What remains:

1. **Push.** `rolemodel-openscreen` is three commits ahead of `origin/main`, and
   `../homebrew-tap` is one ahead. Neither has been pushed.
2. **Set `TAP_TOKEN`** in this repo's Actions secrets — a PAT with
   `contents: write` on `rolemodel/homebrew-tap`. **Only Dallas can do this**, and
   nothing downstream works without it: `release.yml` warns and skips rather than
   failing, so a tag without it looks like a successful release that published
   nothing. That failure mode is worth naming, because it is exactly what
   upstream's own cask workflow has been doing for every release (their #335).
3. **Tag `v0.1.0`** and let the workflow run end to end once. It creates the
   release, hashes the tag tarball, and pushes `Formula/rm-video.rb` +
   `Casks/openscreen.rb` into the tap. Then confirm the round trip actually
   works, which is the only real test of any of this:
   ```bash
   brew tap rolemodel/tap
   brew install rm-video       # pulls node, ffmpeg, and the OpenScreen cask
   rm-video presets
   ```

### Then, if there is appetite

- **A screenshot Run button.** `rm-browser` takes an `image=` path you type by
  hand. Capturing a URL with Playwright into the project's `media/Stills/` and
  wiring the path in would close the loop between "I have a URL" and "I have a
  scene". This was offered and not built.
- **Save an edited lower-third back to a preset** from the Brand panel.
- **Package `skill/SKILL.md` as a Cowork plugin.**

---

## Things verified against primary sources, so nobody re-litigates them

- **HyperFrames telemetry is on by default.** Running `hyperframes tts` prints:
  *"Hyperframes collects anonymous usage data… If you sign in to HeyGen, your
  account is linked to your usage. Disable anytime: `hyperframes telemetry
  disable`."* The research doc listed this as an open question because the docs
  page 404s. It is answered; the FigJam sticky has not been updated yet.
- **OpenScreen is not GUI-only.** An early research pass said it was. It ships a
  full headless CLI designed for agents. That correction is on the FigJam board.
- **Upstream does not publish a Homebrew cask**, so ours is not redundant. This
  is easy to get wrong, because `getopenscreen/openscreen` *has* an
  `update-homebrew-cask.yml` that looks like one. It has never been configured —
  no `HOMEBREW_TAP_OWNER`, no tap repo — and the job it guards has been skipping
  green on every release, which their own issue #335 is about. There is also no
  `openscreen` in homebrew-cask (`Casks/o/openscreen.rb` → 404, checked
  2026-08-22).
- **Kokoro TTS is genuinely local.** `pip install kokoro-onnx soundfile`, then
  ~27MB of voice data on first run. No API key, no per-character billing, and
  nothing leaves the machine — which is the part that matters for client work.

Research lives in the FigJam board *Video Tools Research — CCC Days*
(`figma.com/board/BKPsEkjIqsk0osNiDyZjqI`) and in three markdown docs that were
delivered into the conversation rather than the repo.
