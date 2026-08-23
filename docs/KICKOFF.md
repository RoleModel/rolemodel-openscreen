# Kickoff

Start here. This is the whole system in order, with the manual steps marked.

A shareable version of this page, for anyone who needs the map without the
repository: <https://claude.ai/code/artifact/ce8c8c27-cc27-48be-aeb2-a19d482a7c95>

If you read one thing: **the pipeline is record → brand → edit → share.** Four
steps, four tools, and every one of them can be driven from the Studio.

---

## One repo, not four

Clone this one. It is the only one you edit.

```sh
git clone https://github.com/RoleModel/rolemodel-openscreen.git
cd rolemodel-openscreen
npm run forks          # only if you need to build the app or run the review instance
```

The other three are not places to work:

- **`homebrew-tap`** is a publish target. Homebrew resolves `rolemodel/tap` to a
  repository named `homebrew-tap` and nothing else, which is the whole reason it
  exists. The formula and casks live in `packaging/` here; `npm run sync-tap`
  copies them across, and `npm run check` fails if the two drift.
- **the two forks** stay forks, deliberately. Our diff on OpenScreen is 661 lines
  on top of 2260 upstream commits, and it is small on purpose — that is what makes
  `git pull upstream main` a non-event. Folding them into a monorepo would turn
  every upstream release into a manual merge of somebody else's project, which is
  a bill you pay forever to save a clone you do once. `npm run forks` fetches them
  as siblings when you need them, with the upstream remote already set up.

## What exists, and why there are three repos

| repo | what it is | you touch it when |
|---|---|---|
| **rolemodel-openscreen** | The brand layer and the Studio — presets, wallpapers, narration, demo scripting, and the web UI that drives all of it. | Almost always. This is the surface. |
| **RoleModel/openscreen** | A fork of [OpenScreen](https://github.com/getopenscreen/openscreen). Records the screen, edits the document, exports the MP4. | Rarely — only for the app itself. |
| **RoleModel/OpenFrame** | A fork of [OpenFrame](https://github.com/yusufipk/OpenFrame). Client review: timestamped comments, versions, approval. | Rarely — only for review/sharing. |

Both forks are small on purpose. Each is one new file plus a one-line change per
call site, which is what keeps rebasing on upstream cheap. What they add:

- **openscreen** — `openscreen open <doc>` so a document can be handed to the
  editor; `.openscreen` registered as a document type; and this Studio hosted as
  a window in the app. Upstream has no way in from outside: its bundle declares
  no document type, `open -a Openscreen <file>` launches and discards the
  argument, and a bare path is a silent no-op.
- **OpenFrame** — token auth, so a pipeline can deliver a video without holding a
  browser session.

---

## 1. Install

```bash
brew install rolemodel/tap/rm-video
```

That installs Node and seven commands:

| command | does |
|---|---|
| `rm-studio` | **serves the Studio on :4600 — this is the one to run** |
| `rm-video` | applies a brand preset to a document |
| `rm-demo` | drives a browser from a script, or records one |
| `rm-voice` | narration → audio + an exact SRT |
| `rm-mux` | reconciles narration timing against a recast render |
| `rm-library` | builds the library index |
| `rm-share` | sends a finished video for review |

And the app:

```bash
brew install --cask rolemodel/tap/rolemodel-openscreen
```

> **Manual step, once.** The cask needs a release to point at, and GitHub
> disables all workflows on a forked repo until someone acknowledges it:
>
> 1. Open <https://github.com/RoleModel/openscreen/actions>
> 2. Click **"I understand my workflows, go ahead and enable them"**
> 3. The `v1.9.6-rm.1` tag is already pushed, so the build starts on its own
> 4. Then, in the tap: `node scripts/update-cask.mjs rolemodel-openscreen v1.9.6-rm.1`
>
> That last command reads the release's DMGs, hashes them, and writes the version
> and checksums into the cask. Until it runs, the cask's version is
> `0.0.0-unreleased` and installing it will 404.

Use the fork, not upstream. The Studio hands documents to the editor with
`openscreen open`, and upstream has no such verb.

---

## 2. Make a video

Open the app, or run `rm-studio` and go to <http://localhost:4600>.

**Library** is the index — one card per project, indexed automatically from
whatever is on disk. Clicking a video opens it in the editor.

**New video** has three tabs:

- **Record a screen** — pick a window by its title, name the output, run it. The
  chain is record → brand → **stop**, then a button to open it for editing.
  Export is a separate click, because exporting before you have edited produces a
  file nobody chose anything about.
- **Make from a script** — hand a brief to Claude and let it build the pipeline.
- **From a test** — a demo, either from a Playwright trace you already have or
  written here.

**Record something happening.** A capture of an idle window is eight seconds of
nothing, and it looks like the pipeline is broken when it isn't.

---

## 3. Script a demo instead of recording one

A demo script is one markdown file. Prose is narration; fenced ` ```do ` blocks
are what the browser does. Order is the timeline.

````markdown
# Estimating walkthrough

We start on the estimating screen.

```do
goto https://your-app.example.com/quotes/new
expect "REQUEST QUOTE"
click "3D VIEW"
wait 800
```

Adding a railing is two clicks.
````

The same file feeds `rm-voice` unchanged — its parser ignores fenced blocks — so
the narration and the actions can never drift into two files that disagree.

```bash
rm-demo check demo.md                  # what will it do?
rm-demo run demo.md --out ./out        # drive it, leaving a trace + screencast
```

Ten verbs: `goto click dblclick hover type fill press wait scroll expect`. A typo
fails before a browser opens, with the line number and the correct form.

**Or don't write it at all.** `lib/demo-record.mjs` captures a demo by doing it:
open the app, click through, and the clicks become the script. It names things by
visible text, collapses per-character typing into one step, and keeps your real
pauses as explicit waits — the pauses are what make a demo watchable and the
first thing lost re-authoring by hand.

---

## 4. Share it for review

```bash
export OPENFRAME_URL=http://localhost:3100
export OPENFRAME_TOKEN=…                    # from OPENFRAME_API_TOKENS on the instance

rm-share --check                            # configured and reachable?
rm-share demo.mp4 --project "Feeney Railing"
```

Out comes a link a client opens with no account. They leave notes on the frame
they are about, rather than emailing "around the middle, the bit with the
railing".

### Running OpenFrame

```bash
cd openframe
docker compose up -d --build      # app + Postgres + MinIO
```

Configuration lives in `.env.docker` (not committed). The essentials:

| variable | why |
|---|---|
| `DATABASE_URL` | Postgres, from the compose service |
| `NEXTAUTH_URL` / `NEXTAUTH_SECRET` | session auth for the browser |
| `OPENFRAME_ENABLE_S3_VIDEO_UPLOADS=true` | MinIO stands in for R2 |
| `OPENFRAME_REQUIRE_INVITE_CODE=false` | so you can register the first user |
| `OPENFRAME_API_TOKENS` | `token:email` — what `rm-share` authenticates with |

A token **acts as the user it maps to** and gets no more access than they have.
That is what makes it safe to add; every authorisation check downstream is
untouched.

> **This laptop uses `:3100`, not the documented `:3000`** — a Rails app already
> owns 3000 here, and it wins for `localhost`. That override is in
> `docker-compose.override.yml`, which is deliberately not committed.

Teardown: `docker compose down` keeps the data, `down -v` deletes it.

---

## The parts that are not finished

Worth knowing before you promise any of it to anyone.

- **The cask needs the one click above.** Until then there is no installable app,
  only a checkout.
- **A share link only resolves for whoever can reach the instance.**
  `localhost:3100` proves the integration and is useless to a client. A real
  review needs OpenFrame on a host with a domain, and it wants SMTP for
  invitations.
- **A locally built openscreen cannot record.** The ScreenCaptureKit helper needs
  full Xcode, which is why the release is built in CI. A local build brands,
  edits and exports fine.
- **`rm-share` refuses multipart uploads** rather than half-doing them. Large
  videos will need that implemented; the failure is explicit, not silent.
- **The recorder is a library, not a Studio button yet.** `lib/demo-record.mjs`
  works and is tested; nothing in the UI calls it.

---

## When something breaks

| symptom | it is almost always |
|---|---|
| `openscreen: not found on PATH` | the formula installs a shim; the upstream cask's symlink breaks Electron's helper resolution. Uninstall the upstream cask. |
| The Studio opens OpenScreen but not the editor | you are on upstream's build, which has no `open` verb. Use the fork's cask, or `RM_OPENSCREEN_BIN=bin/dev/openscreen-fork`. |
| `npm install` installs no dev dependencies | `NODE_ENV=production` is set in your shell. npm omits them silently. |
| Electron dies on `Cannot find module …/record` | `ELECTRON_RUN_AS_NODE` leaked from an editor terminal. The toolkit strips it for children; a shell you ran it in yourself will not. |
| A capture has a black band under it | the recorder padded a window into a display-sized buffer. `rm-video brand` detects it and writes a crop; no re-encode. |
| A thumbnail looks like a zoomed crop | it was, and it is fixed — poster frames are chosen by measuring candidates, because `--auto-zoom` holds a zoom for seconds. |

`npm run check` runs 354 assertions across the toolkit. It is the fastest way to
find out whether something you changed broke something you were not looking at.
