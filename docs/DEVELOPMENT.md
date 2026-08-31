# Development

What you need installed, what language each part is in, and how to run it.

Read this after [KICKOFF.md](KICKOFF.md), which covers installing and using the
pipeline. This is about changing it.

---

## The short version

```sh
git clone https://github.com/RoleModel/rolemodel-openscreen.git
cd rolemodel-openscreen
pnpm install         # playwright and playwright-recast; nothing else
pnpm run dev         # the Studio on :4600, reloading on change
pnpm run check       # 390 assertions
```

That is the whole loop for most work. **No code is compiled** — the toolkit is
plain ESM JavaScript, the Studio is plain DOM, and `lib/studio.js` is served to
the browser as-is. Save a file, the page reloads.

`pnpm run build` exists but builds *assets*, not code: it syncs the brand tokens,
regenerates the Optics CSS and re-renders the wallpapers. You need it after
changing `brand/`, and never for a change to `lib/` or `bin/`.

The other two repositories are only needed to change the app or the review
instance: `pnpm run forks` fetches them.

---

## Four languages, and which parts are in which

| part | language | why it is that |
|---|---|---|
| **the toolkit** (`rolemodel-openscreen`) | plain ESM JavaScript, Node ≥20 | No compile step means no build to debug, and the Studio's client is the same language as its server. `lib/wallpaper.mjs` runs in the browser preview, the Studio export and the batch renderer — one implementation, three callers. |
| **the app's UI** (`openscreen`) | TypeScript + React 18, Vite 7, Tailwind 3 | Upstream's choice. 335 files. |
| **the app's main process** | TypeScript | Upstream's choice. Where our Studio window and `open` verb live. |
| **the compositor** | Rust | Upstream's choice. Frame compositing and the ffmpeg bindings. |
| **the capture helper** | Swift (ScreenCaptureKit) | The only API that captures a window on modern macOS. **The one thing that needs full Xcode**, which is why the app is built in CI. |
| **review** (`openframe`) | TypeScript, Next.js 16, Prisma 7, Postgres | Upstream's choice. Built with **bun**, not npm. |

The split matters when you are deciding where a change goes. Anything about
brand, narration, demo scripting or the Studio is JavaScript in the toolkit, with
no compile step. Anything about recording, the timeline or export is TypeScript
or Rust in the fork, with one.

---

## Tools

| | |
|---|---|
| **Node** | ≥20 in the toolkit; the fork pins **22.22.1** in `engines`. Node 26 works but warns. |
| **Biome** | Formatting and linting in both the toolkit and the fork. `npx biome check .` |
| **Playwright** | Not just for tests — it renders the wallpapers, drives demo scripts, and records them. It is a runtime dependency here, not a dev one. |
| **Docker** | Only for the review instance. |
| **Rust + full Xcode** | Only to build the app from source. CI has both. |

### Testing

The toolkit has no test framework. `lib/verify.mjs` is a single file of 390
assertions that runs in about two seconds:

```sh
pnpm run check     # brand sync, Optics pin, the assertions, tap drift
pnpm run verify    # just the assertions
```

It is deliberately not a unit-test suite. Most of what breaks here is a contract
between two things — a formula that promises twenty commands, a client that builds
a path the server resolves differently, a cask whose checksums no longer match
its release — and those are the assertions worth having. Several exist because
something shipped broken:

- three lists of CLI names that had drifted apart
- a client building `<library>/<id>/<rel>` for a file under `media/`
- a `file://` URL handed to a compositor that opens paths
- a poster frame seeking into an auto-zoom

**Write the assertion against the broken code first.** An assertion that has
never failed has not been tested, and several of mine passed vacuously until I
checked. `git stash` the fix, run it, watch it fail, restore.

The forks use **vitest** (`npm test`) and have their own suites — 172 pass across
the areas we touched in the `openscreen` fork. Upstream has ~40 pre-existing
failures unrelated to us; run the suite against `upstream/main` before assuming
you caused one, which is two minutes and has already saved me from reporting
someone else's bug as mine.

---

## Running each piece

### The Studio, on its own

```sh
pnpm run dev           # :4600, reloads on change
```

`--watch` never opens a browser: the tab you have reloads itself, and opening a
new window on every save is how you end up with forty of them.

### The Studio inside the app

```sh
cd ../openscreen && npm run app
```

This is the real configuration — the Studio is a window in the app, so opening a
document in the editor is an IPC call rather than a shell-out. `npm run app`
handles the environment for you; see `scripts/launch.mjs` for what each piece of
it is for, because every one is load-bearing.

### The app's renderer, hot-reloading

```sh
cd ../openscreen && npm run dev
```

Vite with HMR, for working on the editor itself.

### The review instance

```sh
cd ../openframe && docker compose up -d --build
```

App, Postgres and MinIO. Configuration is `.env.docker`, which is not committed.

---

## Things that will bite you

These are all environment, and all of them cost someone an hour already.

| symptom | cause |
|---|---|
| `pnpm install` installs no dev dependencies | `NODE_ENV=production` in your shell. Remove it, then run `pnpm install` again. |
| Electron dies on `Cannot find module …/record` | `ELECTRON_RUN_AS_NODE` leaked from an editor terminal. The toolkit strips it for children; a shell you ran it in yourself does not. |
| `cargo not found` with Rust installed | The build script looked only in rustup's `~/.cargo/bin`. Fixed in our fork; it checks `$CARGO`, rustup, then PATH. |
| A spawn works in your terminal and fails from the app | A GUI app launched from Finder does not inherit your shell's PATH, so `/opt/homebrew/bin` is not on it. Anything spawned directly needs `env: jobs.childEnv()` — `jobs.addPath()` only reaches children the job runner starts. |
| The first release build fails | whisper-stt artifacts expire, and the macOS job refuses to package without them. Run `build-whisper-stt.yml` first. |
| A button in Studio does nothing at all | An older `rm-studio` still serving on that port. The port changes each launch and old processes keep running, so a tab can be talking to a build from days ago. `ps aux \| grep rm-studio`. |
| A fetch reports "could not reach the Studio" and the server is fine | `.then(r => r.json())` on a reply that is not JSON. The throw is unhandled and the catch beside it blames the connection. Use `responseJson`, which reads the body first. |
| The machine is slow for hours with nothing running | Orphaned `hyperframes preview` servers. They are reparented to init and can spin at ~100% CPU indefinitely; a wedged one needs `kill -9`. |
| `hyperframes render --format webm` fills the project with PNGs | WebM renders with alpha, so frames extract as RGBA PNG into the render folder — gigabytes of them. Transcode the finished MP4 with ffmpeg instead. |
| A regex on `id="…"` matches attributes that are not `id` | `\bid="` also matches inside `data-hf-id="…"` and `data-composition-id="…"`: the hyphen before `id` is a word boundary. Cost an hour twice — once emitting twelve pips from six, once counting eighteen word blocks from six. Anchor on `(?:^\|\s)id="`. |
| A pip renders as a black shape instead of a circle | `pad=W:H:x:y` cannot place an input that does not fit inside the canvas and does not say so — it silently centres it. The pip hangs off the right edge on purpose, so its box runs past 1920. Use `overlay`, which clips at the edge. |
| A magenta flash for one frame at each speaker change | The split renderer punches its holes with a colour key, and a key cannot express a half-transparent hole. Mid-dissolve the captured hole is the key colour at partial strength — `R=148 G=1 B=156` — which is nowhere near `0xFF00FF` by RGB distance. Widening the tolerance cannot fix it; the dissolve belongs on the footage. |
| Every speaker's name printed over every other | A cue-less element — a speaker's name is simply on while its clip is on — left visible by anything that does not step clip visibility per frame. State the envelope in the timeline instead of trusting the runtime. |
| The composition looks right when scrubbed and wrong at its first frame | A paused GSAP timeline sitting at 0 has applied nothing, and `seek(0)` is not a change, so nothing renders. Anything that asks for exactly the first frame — a thumbnail — sees the document as authored, every clip at once. Seek a hair past zero once after building. |
| A finished render becomes a two-second clip | `rm-render-pip --from/--to` used to write the same path as the full cut, so checking one transition replaced the deliverable. It writes `<folder>-preview.mp4` now. |

### One clock, three copies of it

The class of bug that cost the most in one session, worth naming so it is
recognised early. When Studio builds a cut it writes three values derived from
where the clips were at that instant:

- `<main data-duration>` — the composition's length
- the canvas clock's `data-duration`, and the `.m4a` staged to match it
- each canvas component's `at=`, offset onto the composition clock

Move clips in the motion editor and every one of them is silently wrong: a title
that never appears, a video ending in dead air, transitions at boundaries that no
longer exist. Nothing errors, because none of the three has anything to
contradict it — the clock in particular is the one element whose duration is not
evidence of something you can see.

`data-assembly-clock-derived` is emitted alongside the clock as the "derived
versus deliberate" signal a reconcile pass needs. The pass itself is not written
yet; until it is, **rebuild the cut rather than repairing a composition by hand.**

### Sub-compositions, and the two places they are resolved

A composition may keep its scenes in separate files under `compositions/` and
mount them with `data-composition-src`, which is how a generated cut stays small
enough to read and diff. The shape is stricter than it looks, and every rule
below was learned from `hyperframes check` rejecting the file:

- the **host** needs `data-composition-id` *and* a stable `id` of its own
- the **file** must be a whole composition — its own root element carrying
  `data-composition-id` and `data-width`/`data-height` — not the fragment it
  feels like
- that root is scaffolding for the file, not a box in the picture. The editor
  mounts the root's `innerHTML`, discarding it. Keep it and you leave a real
  1920x1080 block per scene in the flow, which stacks: the content is present,
  laid out, and below the bottom of the frame.

Get any of it wrong and Studio mounts nothing, which reads as the content
vanishing rather than as a structural error.

The resolution happens in **two** places and only one of them is HyperFrames.
Nothing inside a composition folder can inline a sub-composition — that lives in
the editor's compiler — so a composition opened straight off disk sees empty
mount points and renders without whatever was split out, silently, because an
empty div measures fine. `rm-render-pip` therefore splices the files together
**server-side, before the page is served**. That timing is the whole point: the
timeline is built by an inline script at the end of the body, and GSAP resolves a
selector when the tween is made. Mount after load and every word and phrase
tween points at an element that did not exist yet — the transcript is
permanently invisible while the speaker's name, which has no tween, shows fine.

Anything else that reads a composition has to follow the mounts too.
`rm-retime-pip` writes each file it finds rather than `index.html` alone.

And a fragment has to say it has no clock. Both the host and the file's root
carry `data-no-timeline`, which is not cosmetic: anything carrying a composition
id is a composition to the producer, and it polls `window.__timelines[id]` for
**forty-five seconds** before giving up. Six transcripts is four and a half
minutes added to every render, waiting for six timelines that were never going
to appear. They carry the parent's `data-duration` for the same reason — these
fragments are measured on the parent's clock, and it is the one number here that
does not change when a clip is retimed.

This surfaces in an odd place. The compiler copies each sub-composition into
`renders/work-<uuid>/compiled/compositions/` and lints it **standalone**, so the
errors name a build artifact rather than your source. Those work directories are
created per compile and swept, so the report is a snapshot of one — fix the
source, and every later compile is a copy of the fix.

### The editor writes the file too

HyperFrames rewrites a composition when it saves: it pretty-prints, stamps every
element with a `data-hf-id`, reorders attributes, and puts a word block onto one
line per word — six transcript blocks emitted as six lines came back as several
hundred. So a line-count lint can fire on a file the generator never produced,
and any pattern anchored to how the builder writes a tag will miss.

It also changes clip windows. A pip that was `19.100` came back `18.900` mid
session. `rm-retime-pip` prints the clip table with any gap or overlap it finds
for exactly this reason — read it, and treat a reported gap as a question rather
than noise, because a deliberate trim looks identical to an accidental one.

### A composition names its own thumbnail

Poster frames for plain recordings are chosen by scoring candidates at fractions
of the duration, which is right for a screen capture — the question there is
whether a frame sits inside an auto-zoom — and wrong for a composition, whose
opening card is already the answer. Scoring picked the halfway mark of a
six-speaker cut: a picture of whoever happened to be talking at sixty seconds.

`rm-render-pip` writes the time into a `<file>.mp4.poster` sidecar, because
whatever makes the thumbnail never sees the composition, and the promotion into
project media carries it along. `data-poster` on the composition root overrides
it. No sidecar means no opinion, which is every other video in the library.

---

## Working on a fork without making rebasing expensive

Our diff on `openscreen` is 7 commits, 29 files, 895 lines — on top of 2260
upstream commits. On `openframe` it is 9 files and 185 lines. Both are small on
purpose, and keeping them small is the whole reason `git pull upstream main`
stays a non-event. Check yours before you push:

```sh
pnpm run forks          # also reports how far each is from upstream
```

The pattern, everywhere we have touched their code:

- **One new file** carrying the logic (`electron/studio/server.ts`,
  `lib/api-token.ts`), so upstream never conflicts with it.
- **One line changed per call site.** `await auth()` became
  `await authFromRequest(request)` in eleven places and nothing else moved.
- **Never reformat.** A formatter run across a file you changed three lines of
  turns a clean rebase into a manual one.

When you need something from their code, check whether they already solved it.
The Studio window's drag region is injected the same way they inject
`--titlebar-inset-left`; the release tag validator was widened rather than
worked around. Both are cheaper to rebase than an invention would have been.

---

## Where the seams are

Each of these runs on its own, with no Studio and no app. If you want to lift one
piece and leave the rest, start here.

| module | does | needs |
|---|---|---|
| `lib/wallpaper.mjs` | recipe → canvas | a canvas (browser or node) |
| `lib/demo-script.mjs` | parse a demo script | nothing |
| `lib/demo-record.mjs` | capture a demo by doing it | playwright |
| `lib/openframe.mjs` | send a video for review | fetch, a token |
| `lib/narration.mjs` | lines → audio + an exact SRT | a TTS provider |
| `lib/theme.mjs` | apply a brand preset to a document | nothing |
| `lib/script-parse.mjs` | markdown → speakable lines | nothing |

`lib/verify.mjs` asserts a lot of the behaviour above, so it doubles as the
specification for anything you reimplement.
