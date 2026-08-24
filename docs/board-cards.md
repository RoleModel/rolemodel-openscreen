# Card-ready copy for the FigJam board

Rewritten 24 Aug 2026. One block per card — title, body, and the accent I'd use.

**Scope correction.** The first research pass was on generative video (Sora, Veo,
Runway). That was my mistake, not the brief. The brief was tools comparable to
HyperFrames and Remotion, plus review-and-feedback. Cards 5–11 are the
replacement; cards 12–18 are the feedback half, which was closer to right and is
now finished.

Everything below is from a primary source — the vendor's own docs, a LICENSE
file, a repo, or a test I ran. Card 18 says what is still unverified.

I can't author the RoleModel Card widget (Figma exposes no readable state, no
clone, no writable children), so this is paste-ready rather than placed.

---

# PART 1 — INSTALL

**Replace all four cards in the Install section.** Three are currently wrong:
"Run it" and "Voice (optional)" carry identical body text copied from each other,
and both show `brew install --cask …openscreen`, which installs the app rather
than running anything. The purple card is stale.

**Corrected on a second pass.** My first draft said `rm-studio` was the run
command, following `install.sh` and `docs/KICKOFF.md`. Both are out of date: fork
commit `8b77adb` made the app host the Studio and start it on launch.

> **New section subtitle:** macOS. Homebrew is the only thing you need first —
> the installer brings the rest, and `rm-setup` repairs anything it couldn't do.

---

### CARD 1 — "1 · One command"
*Accent: teal*

From nothing to a working pipeline. Safe to run again — every step checks before
it acts, so a second run only does what the first one couldn't.

```
curl -fsSL https://raw.githubusercontent.com/RoleModel/rolemodel-openscreen/main/install.sh | sh
```

It needs Homebrew already installed. The script deliberately won't install
Homebrew for you: that writes to /opt/homebrew and asks for your password, and a
script that does that silently is one nobody should pipe to `sh`.

---

### CARD 2 — "2 · Open the app"
*Accent: teal*

**You open OpenScreen. That's it.** The Studio isn't something you start — since
fork commit `8b77adb`, the app spawns `rm-studio` itself on boot, on a port it
asks the OS for, and shows it as a window. `electron/main.ts` calls
`openStudio()` right after `createWindow()`, because the window `createWindow()`
makes is the floating recorder, not a place to work.

**Don't launch it from a terminal.** macOS grants Screen Recording permission to
whatever process hosts Electron, so a shell launch grants it to Terminal.app
instead of OpenScreen — and recording then fails in a way that looks like a bug.
Our own cask caveats say this.

---

### CARD 3 — "3 · What's on PATH"
*Accent: teal*

Eight commands. The app calls one of them for you; the rest are there when you
want the pipeline without the UI.

| | |
|---|---|
| `rm-studio` | the Studio itself — the app starts this, you rarely do |
| `rm-setup` | checks and repairs everything Homebrew can't |
| `rm-video` | applies a brand preset to a document |
| `rm-demo` | drives a browser from a script, or records one |
| `rm-voice` | narration → audio + an exact SRT |
| `rm-mux` | reconciles narration timing against a recast render |
| `rm-library` | builds the library index |
| `rm-share` | sends a finished video for review |

```
rm-setup --check     # say what's missing, change nothing
rm-setup             # do whatever is missing
```

No sudo, and nothing installs into system Python.

---

### CARD 4 — "Not true yet"
*Accent: purple*

**The formula ships six of eight commands.** `rm-setup` and `rm-share` aren't in
`ENTRIES` in `packaging/rm-video.rb`, and `rm-setup` isn't in `package.json`'s
`bin` map either. So `install.sh`'s last step falls through to
`die "rm-video installed but rm-setup is not on PATH"`. **The one-command install
fails at the end on a clean machine.** Two lines fix it.

**The one-line installer 404s today.** `install.sh` is committed but `main`
hasn't been pushed, so the raw URL doesn't resolve.

**The cask needs a release to point at.** Pinned at `0.0.0-unreleased`. Someone
has to enable Actions once at github.com/RoleModel/openscreen/actions, then run
`update-cask.mjs`. `install.sh` degrades gracefully here — it warns and leaves a
working toolkit rather than failing.

**Watch for the name collision.** A different project claims `openscreen` on
Homebrew and its cask ships no CLI. `brew uninstall --cask openscreen`.

---

# PART 2 — THE FRAMEWORK LANDSCAPE

Programmatic video: you write code or markup, a renderer gives you an MP4. This
is the category HyperFrames and Remotion are in. Fetched 24 Aug 2026.

---

### CARD 5 — "The licence is the finding, not the feature list"
*Accent: gold — this is the headline*

Three tools we'd realistically consider. Three completely different licence
models, and **two of them carry an obligation nobody has priced.**

| | licence | cost at our size |
|---|---|---|
| **HyperFrames** | Apache-2.0 | **$0** |
| **Remotion** | source-available, not OSS | **paid company licence required** |
| **OpenFrame** | FSL-1.1-ALv2, not OSS | **$0** — permitted, with conditions (card 12) |

Remotion is free only for a "for-profit organization with up to 3 employees."
We're well past that, and there's a clause that bites consultancies specifically.

OpenFrame isn't open source either, but its licence turns out to permit what we
actually do. Worth knowing rather than assuming in either direction.

The feature comparison is the easy part and barely matters — all three do the
job. The licence is what actually decides this.

---

### CARD 6 — "Remotion"
*Accent: neutral*

React + `useCurrentFrame()`. The most mature thing in the category: v4.0.515
shipped 21 Aug 2026, releases every one to three days, first published 2016.
Best-in-class captions (`@remotion/captions` + Whisper) and genuine
frame-indexed determinism, conditional on its pinned Chrome Headless Shell.

**The licence, verbatim from `LICENSE.md`:**

> "You are eligible to use Remotion for free if you are: an individual; a
> for-profit organization with up to 3 employees; a non-profit…; evaluating
> whether Remotion is a good fit"

Pricing from remotion.pro/license — **$25/mo per seat** (Creators), where a seat
is *"one person who writes Remotion code themselves or uses agentic coding
tools."* Automators is $0.01/render with a **$100/mo minimum**. Enterprise from
$500/mo. Lambda rendering runs in our own AWS at roughly $0.02 per minute of
video, so compute is rounding error next to the licence.

**The clause that matters for a consultancy** — from their licence FAQ. Deliver a
finished video only and just our headcount counts. But if the client owns or
operates the project, *"both companies' headcount is aggregated."* Same for
subcontractors. **Handing a client the project repo pulls them into our licence
surface.**

Also flagged in `LICENSE.md`: *"In Remotion 5.0, the license will slightly
change."*

---

### CARD 7 — "HyperFrames is HeyGen's, and it's Apache-2.0"
*Accent: gold*

Two things worth knowing that aren't obvious from using it.

**It's a HeyGen product.** `Copyright 2026 HeyGen, Inc.` in the LICENSE; the repo
is `github.com/heygen-com/hyperframes`; the npm maintainer is `vance@heygen.com`.
Not a side project — corporate copyright, a docs site, and a paid hosted service
behind it.

**It's Apache-2.0.** No size threshold, no seats, no headcount aggregation with
clients. At our size that's the difference between $0 and a licence conversation.
Local rendering is free because the software is free. HeyGen's hosted rendering
is the paid part — $0.10/min at 1080p30 up to $0.30/min at 4K60 — and it's
entirely optional: local, your own AWS Lambda, and your own GCP Cloud Run all
avoid it.

**The cost is churn.** v0.8.11, still pre-1.0, roughly 26 releases between 5 and
23 Aug 2026, and **no SLA, no LTS and no backward-compatibility guarantee**
anywhere in the docs. Pin the version per client project.

**Telemetry is on by default.** Turn it off with `HYPERFRAMES_NO_TELEMETRY=1`.
Project names and video content are never collected — but note this, verbatim:
*"When you run `hyperframes auth login`, your HeyGen account email … is linked to
your usage, and your prior anonymous usage is stitched to it."* Signing in once
retroactively de-anonymises earlier local activity. Put the opt-out in the
project scaffolding.

---

### CARD 8 — "HyperFrames renders are byte-identical"
*Accent: gold — I tested this rather than looking it up*

The open question was *"render the same composition twice and diff the hashes."*
Done.

```
d92bac0b9226e1265951c5861825019f…  a.mp4
d92bac0b9226e1265951c5861825019f…  b.mp4
```

18,904 bytes each. Per-frame hashes identical too, so it isn't a container
coincidence — the pixels match.

**Caveat, plainly:** same machine, same version, blank composition, draft
quality, no audio. Cross-machine determinism is still untested, and audio and
media are the parts most likely to break it. But the diff-not-re-roll discipline
is sound enough to build on.

Bonus: when the bundled Chrome download is blocked, point HyperFrames at any
Chromium with `HYPERFRAMES_BROWSER_PATH=/path/to/chromium`. That's how this test
ran at all.

---

### CARD 9 — "The MIT field, and why none of it wins"
*Accent: neutral*

If the licence were the only question, these would be the answer. It isn't.

- **Motion Canvas** — MIT, genuinely deterministic, lovely authoring model, and
  **no first-party headless render.** The docs say you render by clicking a
  RENDER button in a browser editor. Non-starter for CI. No npm publish in about
  18 months.
- **Revideo** — MIT, and it fixes exactly that: real headless `renderVideo()`,
  parallel frame-range workers, frame-accurate audio. **But** it went dark on npm
  for 15 months, moved orgs (`redotvideo` → `midrender`), and came back as the
  engine behind one company's commercial product. No caption component. PostHog
  telemetry on by default. Best MIT option; single-vendor risk.
- **Editly** — no stable release since Dec 2022, solo-maintained. Its "subtitle"
  layer is a styled text overlay, not timed captions. Its audio mixing is the
  best in the group and worth stealing ideas from.
- **FFCreator** — abandoned. Last commit Dec 2024 was a CI tweak; 180 open
  issues; README still recommends Node 14.
- **Etro** — GPL-3.0, captures in realtime via `MediaRecorder` so two runs can
  drop different frames, and emits webm not MP4. Disqualified on determinism
  alone.
- **Manim CE** — the healthiest project audited (commit 23 Aug 2026) and it
  writes a real `.srt` alongside the video. But it's a mathematical diagram
  engine. Keep it in mind for technical explainers, not for brand work.

---

### CARD 10 — "Buy instead of build?"
*Accent: neutral*

At a realistic 30 videos/month × 2 minutes = 60 rendered minutes, 1080p30:

| | monthly |
|---|---|
| Shotstack (pay-as-you-go) | **~$18** |
| JSON2Video | $49.95 |
| Plainly (annual) | $94 |
| Remotion Lambda (own AWS) | ~$101 |
| Creatomate | $129 |

**The saving isn't real, and the exposure is.** Every hosted option means
uploading unreleased client UI to a third party to be rendered. That's strictly
more exposure than the TTS we already refused to send off-machine — the video
*shows* the product; the narration only describes it. Keeping local TTS while
adopting a hosted renderer is an incoherent posture.

Two more things no pricing page mentions:

- **No hosted vendor documents render determinism.** Re-cut an approved
  deliverable six months later and their FFmpeg or font stack may have moved.
- **Retention varies wildly.** Shotstack is the only one with a delete-after-
  render clause you could show a client's legal team. JSON2Video publishes no
  retention policy at all. Creatomate's privacy policy is silent on customer
  media.

Rule out Bannerbear (it overlays existing video, it can't compose one) and
Plainly/nexrender (both import an After Effects dependency we don't have).

---

### CARD 11 — "What I'd actually do"
*Accent: gold*

**Stay on HyperFrames.** Apache-2.0 is the only licence here with no obligation
at our size, the pipeline already runs local, and the determinism we depend on is
tested. Price the churn honestly: pin the version per client project and expect a
migration each time we take a minor bump.

**Keep Remotion as the named fallback, and price it out loud.** Roughly
$50–150/mo in seats depending on how many people write composition code. If we
ever hand a client the project repo, read the aggregation clause first — that's a
contract question, not a tooling one.

**Don't outsource rendering while confidentiality is a constraint.** It's about
$60/month of savings against a client-confidentiality problem and a renderer we
don't control.

---

# PART 3 — REVIEW AND FEEDBACK

---

### CARD 12 — "OpenFrame is source-available, not open source — and our use is fine"
*Accent: teal*

The LICENCE in our own clone at `openframe/`:

> **Functional Source License, Version 1.1, ALv2 Future License** — `FSL-1.1-ALv2`
> — Copyright 2026 **IPEK TECH LLC**

Not MIT. But the test is narrower than "not open source" suggests, and it reads
in our favour. Verbatim:

> "A Permitted Purpose is **any purpose other than a Competing Use.** A Competing
> Use means making the Software available to others in a commercial product or
> service that: 1. substitutes for the Software; 2. substitutes for any other
> product or service we offer using the Software…; or 3. offers the same or
> substantially similar functionality as the Software."

**It's one broad grant with a single carve-out.** The four listed purposes —
internal use, education, research, and *"professional services that you provide
to a licensee"* — are introduced with "specifically **include**." They're
examples, not the boundary.

So the only question is whether our commercial offering competes with OpenFrame.
It doesn't. We sell video production. Handing a client a review link is delivery
plumbing inside that service, not a review product we're selling. None of the
three sub-tests hits.

**Two things to keep true:**

- **Don't productise the review portal.** The moment "client review" becomes a
  line item we sell, or we host instances for other people, sub-test 2 or 3
  starts to bite. That's a business-model tripwire, not a today problem.
- **Our public fork carries FSL, not MIT.** The Redistribution clause requires
  the Terms and the copyright notice to travel with any copy — our clone keeps
  both, good. But `github.com/RoleModel/OpenFrame` should not be described as
  open source anywhere, and the trademark clause means we can name it only to
  identify origin.

Converts to Apache-2.0 two years after each version ships — v0.1.x around 2028.

*I'm reading licence text, not giving legal advice. If a client contract makes
this material, run it past someone who is.*

---

### CARD 13 — "OpenFrame: six months old, one author"
*Accent: purple*

Separate from the licence, the health:

- First commit **5 Feb 2026**. 336 commits, roughly **314 by one person** across
  four name/email identities. 4 open issues. Latest commit 22 Aug 2026.
- Two git tags, **no published GitHub releases**.

Actively developed, genuinely responsive, and a bus factor of one.

The good news — **verified in the schema, not taken from the README:**
`Comment.timestamp Float // e.g., 65.5 = 1:05.5` with `timestampEnd` for range
comments, threading, and voice notes. `VideoVersion` carries `versionNumber` and
its own comments, so comments are scoped per version. Both features are real.

---

### CARD 14 — "Frame.io V4: the blocker is Admin Console, not the plan"
*Accent: teal*

Server-to-server auth is **not** Enterprise-only — it requires an account
*"administered via the Adobe Admin Console,"* which is a different gate. A
self-serve Team account isn't in an Adobe org, so the entitlement never appears,
which is exactly the failure people report.

**A path the first pass missed:** Legacy Developer Tokens still exist for
accounts not on Adobe Admin Console. The docs steer new integrations to OAuth,
but the token path is documented, not removed.

Still unresolved: the one public forum thread asking this exactly was answered
with *"Just sent you a direct message"* and never resolved in the open. **Ask
Adobe in writing** — but the question is now "can our Team account get an Admin
Console entitlement," not "is the API Enterprise-only."

---

### CARD 15 — "Filestage: answered"
*Accent: teal*

API and webhooks are on **Business, $329/month, 10+ seats** — and on Enterprise.
Free and Starter have neither, though they do have Slack and Drive integrations.

Verbatim: *"Connect Filestage to your existing tech stack using Webhooks and our
REST API."*

A real fallback at a known price, which it wasn't before.

---

### CARD 16 — "Ziflow: still won't say"
*Accent: purple*

Their pricing page lists Free ($0, 2 users), Standard ($199/mo, 15), Pro
($329/mo, 20) and Enterprise (custom, 25+) — and **mentions API access at no tier
at all.** It links to API docs without ever saying who can use them.

Don't buy Ziflow on the strength of an API claim nobody will put in writing.

---

### CARD 17 — "The rest of the field, priced"
*Accent: neutral*

- **Wipster** — still independent; their own blog (25 Mar 2026) positions
  explicitly against Adobe-owned Frame.io. Light $9.95/user/mo annual; **Team
  $19.95 with API included**. But there is **no public developer portal anywhere
  on their domain** — the API exists per the vendor and is undocumented publicly.
  Real integration risk.
- **ReviewStudio** — Starter free (3 active reviews), Pro $15/user/mo, **Advanced
  $25/user/mo with API access, 5-seat minimum.** Developer docs at
  `app.reviewstudio.com/api/documentation/` do resolve.
- **Dropbox Replay** — a limited version is included on every Dropbox plan (4
  files, 10 on business tiers); a paid add-on removes the cap. **No API access to
  Replay comments** — Dropbox's own api-spec has no Replay namespace, only
  admin audit-log events saying that something happened.
- **Vimeo** — review features are on all four tiers ($12/$25/$75/custom per
  seat), but the API can't reach the notes. Vimeo's own OpenAPI spec shows the
  Comment object has **no timecode field** and there is no review endpoint.

---

### CARD 18 — "Still open"
*Accent: purple*

Not answered, and I'd stop guessing at them:

- Frame.io **Enterprise** per-seat price and seat minimum — quote-only everywhere
- Frame.io storage add-on price per increment — page not retrieved
- Dropbox Replay's standalone add-on price — Dropbox appears to show it only at
  checkout
- ReviewStudio's actual API surface — the portal resolves but is JS-rendered;
  whether it exposes timecoded comments is unknown
- Whether **Remotion 5.0's** licence change helps or hurts us — `LICENSE.md`
  flags it, the PR is unread
- The Vimeo finding is against Vimeo's own spec repo, last updated Dec 2023 — not
  against a live reference
- **Cross-machine render determinism** (see card 8)
- Whether `github.com/RoleModel/OpenFrame`'s public description calls it open
  source — the Redistribution and Trademark clauses make that worth a look
