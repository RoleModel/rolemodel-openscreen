---
name: video-b-roll
description: Cut B-roll, cutaways, or a product demo into a marketing video, and fit long footage to a fixed-length voiceover. Handles two inputs - a finished edited video plus a B-roll library, or a locked voiceover plus a much longer demo or screen recording. Builds a HyperFrames project, measures camera motion and real phrase boundaries, renders a first cut, and writes an EDL so revisions are a cheap re-selection. Triggers on "add b-roll", "cut in b-roll", "cutaways", "sync b-roll to VO", "make the video match the narration", "recut this screen recording", "fit the demo to the voiceover", "/video-b-roll".
---

# Video B-roll

Insert motivated footage into a marketing video, or compress a long recording to
fit a locked narration. Both jobs are the same problem seen from two sides:
picture and words have to agree, and the expensive mistakes are the ones that
pass every validator.

## Two modes

Detect the mode from what the user hands over. Do not ask which mode this is.

| Mode | Inputs | Job | Reference |
|---|---|---|---|
| **A** | one locked voiceover plus one much longer demo or screen recording | fit footage to fixed narration | `references/mode-a-voiceover-fit.md` |
| **B** | one finished edited video plus a directory of B-roll | insert motivated cutaways | `references/mode-b-cutaways.md` |

The modes compose. A talking-head piece that also needs a product demo inserted
is mode B, with mode A's retiming technique applied to the demo segment.

Footage is supplied per run. There is no standing library, so always ask for the
paths if they were not given, and survey whatever arrives.

## How this runs

Run end to end without stopping for approval, and hand back a watchable MP4 plus
an EDL. The first cut is the conversation starter, not the deliverable.

The one exception is source integrity. If a file is truncated or otherwise
damaged, stop and ask before cutting anything, because losing a third of the
piece changes what the deliverable is. See `references/mode-b-cutaways.md`.

**Assume you will be corrected once.** Build and persist the analysis (transcript,
scene map, motion scores, measured phrase boundaries, EDL) so that round two is a
re-selection, not a re-derivation. That is what turns the second pass from an hour
into ten minutes.

Decide shot selection, timing, and transition style yourself, then justify each
one in the EDL. Ask only where the answer changes the work.

## Workspace

Everything lives in `marketing/drafts/<video-slug>/`, which is already gitignored.
Media never enters git.

```text
marketing/drafts/<video-slug>/
  EDL.md                  shot table: where, under which line, from where, why, measured peak
  segments.tsv            input to build-segments.sh; the single retiming surface
  analysis/               transcript.json, scene cuts, motion scores, phrase boundaries
  <project>/              the HyperFrames project
    index.html
    media/                normalized A-roll or proxy, plus cut segments
    renders/              keep every render for A/B
    snapshots/
```

Do not copy source footage into the workspace. Reference it by absolute path and
cut normalized segments out of it.

## Sequence

Stages 1 through 4 are analysis and must complete before any placement decision.

1. **Probe every source.** `scripts/probe-sources.sh FILE ...` Never trust a
   delivered file. Truncation and variable frame rate are both silent.
2. **Map the anchor.** Mode B: scene cuts plus transcript, cross-checked. Mode A:
   measured phrase boundaries via `scripts/vo-phrase-boundaries.py`, which
   overrule the transcript.
3. **Survey the footage.** `scripts/contact-sheet.sh`, coarse then fine. Log what
   is on screen at what source second.
4. **Measure.** Mode B: `scripts/motion-scan.py` over the whole library, and
   select only from calm windows. Mode A: derive per-beat rates from the measured
   phrase durations.
5. **Place.** Apply `references/editorial-standards.md`. Write `EDL.md` as you go.
6. **Build media.** `scripts/build-segments.sh`, which bakes speed and handles into
   normalized segments.
7. **Compose.** `references/hyperframes-build.md`.
8. **Verify, then render, then verify the render.** Same reference.

## Hard rules

These are the failures that pass validation and ship anyway.

- **Never author speed with `data-playback-rate`.** The timeline seek ignores it
  and the render frame extractor honours it, so check and snapshot pass clean
  while the render aborts or ships the clip blank. Bake speed with `setpts`.
- **Never trust ASR word timings for cut points.** Measured drift reached 1.0s
  and was not monotonic, so no global offset fixes it. Measure the audio.
- **Set `data-fps` on the root.** The renderer defaults to 30. A 23.976 source
  rendered at 30 gets uneven duplicated frames and visible judder on a talking
  head, with every check passing.
- **Never sign off on snapshots alone.** Pull frames and probe streams from the
  encoded MP4.
- **A lint error disables the layout and contrast audits.** They then report
  `0 samples`, which reads clean and means nothing ran.
- **Measure camera motion; never judge stability from stills.** A still cannot
  show a pan.
- **Never permute the voiceover unasked.** Propose it with the exact new sentence.

## References

- `references/mode-a-voiceover-fit.md` - fitting footage to a locked narration,
  including the narration-order conflict and its three resolutions
- `references/mode-b-cutaways.md` - cutaway insertion, A-roll mapping, truncation
  repair
- `references/editorial-standards.md` - coverage, placement, shot selection,
  treatment, and the calibrated camera-motion thresholds
- `references/hyperframes-build.md` - composition contract, silent failures,
  verification, render
- `references/edl-template.md` - the shot table to fill in
- `references/environment-notes.md` - ffmpeg build quirks, transcription, shell

## Scripts

| Script | Use |
|---|---|
| `scripts/probe-sources.sh` | integrity check every source; flags truncation and VFR |
| `scripts/contact-sheet.sh` | tiled survey sheets with correct tile-to-time mapping |
| `scripts/motion-scan.py` | camera-motion scoring and calm-window ranking; also verifies the render |
| `scripts/vo-phrase-boundaries.py` | measured RMS phrase boundaries in a voiceover |
| `scripts/build-segments.sh` | cut, retime, and normalize every segment from a TSV |
| `scripts/permute-vo.py` | reorder voiceover clauses at silent boundaries, on approval only |

## Handing back

Present the result as a table of where, under which line, and why, with the
measured peak for each shot. That framing is what makes review productive,
because it lets shots be rejected individually rather than the whole edit being
rejected. Name any shot that sits outside a standard, and list its fallback.

Offer captions once, at the end. The transcript is already built, so burning
captions is a short follow-up pass, but it changes the deliverable and the
framing rules (safe margins, no collisions with cutaway content). Default is off.

## Out of scope for now

Music beds, lower thirds, end cards, and title graphics. This skill cuts picture
against existing audio. If a piece needs designed graphics, that is
`/hyperframes-helper` or the HyperFrames `/talking-head-recut` workflow.
