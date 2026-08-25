---
name: hyperframes-brand
description: Put RoleModel brand on a HyperFrames video — where design.md comes from, which motion token to reach for, what the brand forbids, and how narration and client delivery work here. Use when someone says "make a RoleModel video", "brand this composition", "what easing should this use", "add motion graphics to this recording", or is writing any HyperFrames composition carrying the RoleModel or Academy brand. A thin layer over the existing HyperFrames skills — it adds what is ours and defers everything else.
---

# RoleModel brand for HyperFrames

We already have deep HyperFrames tooling. **Start from that inventory, not from
cold.** This skill is only the brand layer on top: where our values come from,
which one to reach for, and what we do not do.

## The inventory

Two sets are installed, and they overlap by name. Know which you are invoking.

**Official (HeyGen), in `~/.claude/skills`:**

| skill | reach for it when |
|---|---|
| `hyperframes` | composition authoring, timing, media, the production workflow |
| `hyperframes-core` | the composition contract and `data-*` timing attributes |
| `hyperframes-animation` | motion rules, scene blueprints, GSAP and the other runtimes |
| `hyperframes-keyframes` | punch-ins, camera moves, reframes, seek-safe keyframes |
| `hyperframes-creative` | palettes, beat planning, narration, composition patterns |
| `hyperframes-audio` | mixing a track already placed — fades, ducking, automation |
| `hyperframes-cli` | init, lint, check, preview, render, transcribe, tts |
| `hyperframes-registry` | installing blocks and components |
| `media-use` | sourcing or generating music, SFX, images, voice |

**Standard (ours), in `~/.claude/skills/synced`:**

| skill | reach for it when |
|---|---|
| `hyperframes` | our own composition skill — reads `design.md`, `house-style.md` |
| `hyperframes-cli` | our own CLI notes |
| `hyperframes-direction-harness` | **before** a final `index.html` when direction is not locked |
| `optics-context` | anything that also has to be a product surface |
| `gsap` | GSAP specifics |
| `impeccable` | our craft floor |

> **Name collision.** `hyperframes` and `hyperframes-cli` exist in both sets.
> When it matters which one you get, say so explicitly.

**Do not restate any of their rules here.** The composition contract, lint
errors, track collision, paused timelines — all of that belongs to those skills
and is maintained there. A second copy drifts the moment they ship a release and
nobody notices. If a rule is missing, fix it upstream, not in this file.

---

## Brand reaches HyperFrames through `design.md`

Standard's `hyperframes` skill already reads `design.md` from the project root
as *"the source of truth for brand colors, fonts, and constraints"*, and is told
to use its exact values rather than invent any. **That is the hook. Use it.**

The brand repo generates one:

```bash
cp rolemodel-brand/dist/design.md <video-project>/design.md
```

It is generated from `rolemodel-brand/tokens/brand.json` by
`scripts/build-tokens.mjs`, so it cannot disagree with the tokens every other
RoleModel surface uses. Never hand-edit it — change `brand.json` and re-run.

That file carries colour, type, the full motion scale, the four motion
principles, and the constraints below. Once it is in the project, the existing
skill does the rest.

For CSS custom properties in the composition itself:

```html
<link rel="stylesheet" href="rolemodel-brand/css/academy-theme.css">
<body data-theme="academy">
```

---

## Choosing a motion token

Full values are in `design.md`. The rule for picking is short:

**Pick by what the element is doing, not by how it looks.**

- A thing arriving → `--duration-base` + `--ease-enter`
- The same thing dismissed → `--duration-fast` + `--ease-exit`.
  Leaving is always quicker than arriving.
- Something already on screen changing place or size → `--ease-move`
- A deliberate look-at-me → `--ease-emphasis`, the only curve that may overshoot
- A group → one `--stagger` between siblings, never all at once

Never write a raw duration or a raw `cubic-bezier` into a composition. Same rule
the Studio applies to colour, for the same reason.

## What we do not do

These are binding. Several are enforced by `npm run check` in the toolkit, and
all of them are in `design.md` where the composition skill will read them.

- **No radial gradients, anywhere.** The brand is linear — direction, not blobs.
- **No frame wipes.** Do not draw a white or light-lined frame, border, or box
  that sweeps across as a scene transition. Claude reaches for this
  unprompted; it is a stock template flourish, not us, and it directs attention
  at nothing. Transition by cutting, or by revealing the incoming content on
  `--ease-enter`. Nothing draws a box around the frame.
- **No decorative rules, underlines, or dividers.** Do not underline a heading,
  put a keyline between sections, or draw a border around a card, stat, quote, or
  lower third. Claude reaches for these to signal structure; they signal only that
  something was added. Separation comes from space, weight, and ground. The one
  sanctioned rule in the system is the short brand bar under a title, and
  `rm-title` draws it — never hand-add a second.
- **An edge is a solid border, not a fade.** That governs how a *necessary* edge
  is drawn; it is not licence to add one. If nothing is ambiguous without the
  edge, there is no edge.
- **Orange is an accent only** — never a background.
- **No ornament.** If an element does not carry information or direct attention,
  remove it.

---

## When direction is not locked

Do not start writing `index.html`. Use `hyperframes-direction-harness` — it is
built for exactly this and produces a reviewable board before any composition:

```
01_intake.md → 02_design_direction.md → 03_critical_frame_plan.md
             → direction_board.html  (Director Workbench, reviewed)
             → 04_render_plan.md     (ready only after review)
             → hand off to the hyperframes skill
```

Bypass it only for small edits to an existing composition — a typo, a timing
nudge, one colour, a lint fix.

## Which tool solves which problem

HyperFrames **composes**; it does not capture. If the video must show the real
product UI, it is the wrong tool.

| | input | tool | stays current? |
|---|---|---|---|
| **Record** | your screen | `openscreen` | no — re-record by hand |
| **Compose** | a script or a brief | HyperFrames | re-run the brief |
| **From a test** | a Playwright trace | `playwright-recast` | **yes** — re-run the test |

Reach for HyperFrames for the title cards, lower thirds and motion graphics that
sit on top of a capture.

## Narration, timing, delivery

Do not synthesise narration inside the composition.

```bash
rm-voice <project> --script opener --voice af_nova
```

One clip per line, each measured, SRT written from durations already known — so
timings are exact by construction and a copy edit only re-synthesises what
changed. Kokoro runs locally: no API key, and **nothing about an unreleased
client product leaves the machine.**

**A render and a narration track are on different clocks.** `playwright-recast`
compresses idle time; narration is however long the words take. Burn a
22-second subtitle track into a 3.8-second render and cue 1 holds for the whole
clip while the rest is silently dropped — it looks like it worked.

```bash
rm-mux --video demo.mp4 --audio narration.wav --srt narration.srt -o final.mp4
rm-share final.mp4 --project "Feeney Railing"
```

`rm-share` returns a link a client opens with no account and leaves timestamped
comments on. `rm-share --check` says whether it is configured.

## Before a client project

```bash
export HYPERFRAMES_NO_TELEMETRY=1
```

Telemetry is on by default. Project names and video content are never collected,
but `hyperframes auth login` links your HeyGen account email to your usage **and
stitches prior anonymous activity to it.** Put the opt-out in the scaffolding.

Pin the version. HyperFrames is Apache-2.0 — no seat count, no company-size
threshold, which is why it is our default — but it is pre-1.0 and ships
near-daily with no stated compatibility guarantee. A client project that renders
today should render the same way in six months.

---

## Credits

The three-level framing and the cut → storyboard → motion-graphics pipeline came
from **hyperframes-helper by Jay at RoboNuggets**, used under **CC BY 4.0**.
Keep the attribution if you re-share this — that is the licence.
