# Reading a video plan into beats.json

The plan is prose written for people. Read it and write `beats.json` yourself rather than building a parser: `/video-plan` is still developing, and a regex parser would break on its next revision while a careful read will not.

## Where the content lives

**Match on heading text, not section number.** `/video-plan`'s template instructs the author to renumber sections when one does not apply, so "Section 8" is not a stable address. Find the outline table and the script blocks by their headings.

A `/video-plan` output carries the beat spine in two places, and they agree with each other.

**The outline table** gives one row per beat with the beat number, label, runtime window, word count, speaker, on-screen text, screen recording, and b-roll intent. This is the fastest read for structure.

**The script section** gives one block per beat:

```markdown
### 0:23 - 0:53 | Belief 1: the plan creates consistency and organization up front

**Speaker:** Jamey Meeker (on camera, cutting to full-frame capture)

**On screen:** `/video-plan` in Geist Mono, upper third.

**Visual:** Jamey on camera through the first two lines, then cut to REC A.

**Script:**

> Time wasn't the only problem. The reason our videos looked different every time
> wasn't editing. It was that we didn't have a plan or process.

**Words:** 66 (0:27 of narration at 145 wpm)
```

**The blockquote under `**Script:**` is the only text that matters for alignment.** Everything else is either metadata for the manifest or direction for a later step.

If a future plan carries a structured block (frontmatter or fenced JSON) with the same fields, prefer it and skip the prose read.

## What to extract

```json
[
  {
    "number": 1,
    "label": "Open: creating video takes too long, so we built a process",
    "speaker": "Blaine Irvin",
    "script": "Our CCC Days team was myself, Dallas, Joby, Becky and Jamey, targeted at solving a real issue. Creating videos is time consuming.",
    "plan": {
      "on_screen": "Title card. \"CCC Days, August 2026\" in Mono Caps.",
      "screen_recording": "none",
      "demo_capture": "none",
      "b_roll": "team collaboration, around 0:16",
      "planned_start_s": 0,
      "planned_end_s": 23
    }
  }
]
```

`number`, `speaker`, and `script` drive the run. Everything under `plan` is carried through untouched and reappears in the handoff manifest, so the later steps see the plan's intent without re-reading the plan.

Rules for extraction:

- **Take the speaker's name only.** "Jamey Meeker (on camera, cutting to full-frame capture)" is the speaker `Jamey Meeker`. The parenthetical is direction.
- **Strip blockquote markers and rejoin wrapped lines** into one string. Keep punctuation and contractions as written; the aligner normalizes them and contractions match how people actually speak.
- **Keep the label short.** It appears as a heading on the review page.
- **Convert the runtime window to seconds.** `0:23 - 0:53` becomes 23 and 53. These are guides only; nothing in this skill is frame locked to them.
- **Record the runtime target** from the plan's budget section and pass it to `build.py` as `--target-runtime`. On the reference plan this is the revised 2:30, not the original 2:45.

## What to ignore

Purpose, audience analysis, beliefs, visual direction, voice checks, and production notes. They shaped the script and they matter to `/video-branding`, but they do not affect which take of which beat goes where.

Three exceptions worth carrying into the `plan` block when a beat names them, because they are instructions about the cut itself:

- A held moment, for example three seconds on the finished output. It affects runtime and belongs in the manifest.
- A do-not-cut-away instruction. `/video-b-roll` needs it, and it is easy to lose.
- A **demo capture** from the shot list's "Demo Captures (required, frame-locked to script)" subsection. Frame-locked means the narration was written to a specific on-screen action, so that beat's delivery cannot be retimed freely later. Carry it as `plan.demo_capture` and say so at handoff. A plan with no frame-locked captures omits the subsection entirely, in which case every beat is texture and the cut is free.

## Confirm before transcribing

Show the parsed table back and get agreement:

```text
5 beats, 2:21 of script, target 2:30

1. Blaine Irvin   Open: creating video takes too long          46 words
2. Jamey Meeker   Belief 1: the plan creates consistency       64 words
3. Dallas Peters  Belief 2: the tool builds from the plan      54 words
4. Becky Passner  Belief 3: four steps and one afternoon       61 words
5. Joby Martin    Close: a developer made one, and what shipped 66 words
```

A wrong speaker mapping is indistinguishable from missing footage once alignment runs, so catching it here saves a full transcription pass.

## When the plan and the footage disagree

Expected and fine. The plan is the guide, the recording is the material, and the aligner tolerates paraphrase. Two cases need a decision rather than a default:

- **The plan has a beat that was never recorded.** It becomes a gap. Say so plainly and let the user decide whether to reshoot or drop it.
- **The recording contains something good that the plan has no beat for.** It gets parked. Mention it once; do not invent a beat for it, because beat order is the plan's job.
