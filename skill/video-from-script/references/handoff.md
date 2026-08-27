# Handoff

What this skill leaves for `/video-b-roll` and `/video-branding`, and the reasoning behind its shape.

## Nothing is marked in the video

The exported skeleton has no slates, no coloured frames, no placeholder cards, and no reserved empty time. It is a contiguous talking-head cut and nothing else.

The reason is that reserving room in the picture locks the later steps into the plan's shape at the moment they are most likely to improve on it. A b-roll pass that finds a better cutaway than the plan imagined should not have to fight a placeholder to use it. So structure travels beside the video instead of inside it.

## What /video-b-roll actually takes

`/video-b-roll` Mode B is documented as taking "one finished edited video plus a directory of B-roll". So **the handoff artifact is `renders/skeleton.mp4`**, not the composition and not the manifest. Render on approval and name that file when handing over.

The manifest is context that travels alongside it. `/video-b-roll` runs its own analysis, builds its own HyperFrames project, and writes its own EDL, so nothing here is an input it must consume. It is there to save that skill from re-deriving what this one already knows: where each beat sits, what the plan wanted there, and which discontinuities want covering.

Both skills work in the same `marketing/drafts/<project>/` workspace. This skill keeps its output in `skeleton/` precisely so `/video-b-roll` can create its own project directory beside it without collision.

## The two files

`skeleton-manifest.json` is the machine-readable record. `skeleton-notes.md` is the same content for a person.

```json
{
  "binding": false,
  "runtime_ms": 141400,
  "target_runtime_ms": 150000,
  "runtime_delta_ms": -8600,
  "beats": [
    {
      "number": 1,
      "label": "Open: creating video takes too long",
      "speaker": "Blaine Irvin",
      "status": "matched",
      "source": "source/blaine.mp4",
      "timeline_start_ms": 0,
      "timeline_end_ms": 21300,
      "clips": 2,
      "plan": {
        "on_screen": "Title card. \"CCC Days, August 2026\"",
        "screen_recording": "none",
        "b_roll": "team collaboration, around 0:16"
      }
    }
  ],
  "jump_cuts": [
    { "timeline_ms": 14200, "beat": 1, "speaker": "Blaine Irvin",
      "reason": "filler", "text": "um", "wants_cover": true }
  ],
  "gaps": [],
  "parked": []
}
```

`binding` is `false` and stays `false`. It is there so a later skill reading this file sees, in the data itself, that none of it is an instruction.

## Beat windows

`timeline_start_ms` and `timeline_end_ms` give each beat's span in the assembled cut. This is what a later step needs to place anything against a beat, since the plan's original windows no longer apply once real delivery has been cut.

`plan` is whatever `/video-plan` asked for at that beat, carried through untouched. Treat it as intent, not specification. The plan's own runtime windows are in `beats.json` if they are ever needed.

## Jump cuts

Aggressive cleanup means the skeleton contains cuts nobody explicitly approved: a filler word removed, a repeated phrase dropped, dead air trimmed. Each one is a visible discontinuity in a single continuous shot.

Every one is listed with its timeline position, the beat it falls in, why it exists, and the text removed. `wants_cover: true` marks it as a natural place for a cutaway, because covering a jump cut is the one thing b-roll does that is purely functional rather than creative.

These positions are timeline positions in the rendered MP4, which is what `/video-b-roll` measures against. They are a shortlist of motivated cut points, not a required shot list.

Handoffs between beats are deliberately **not** listed. A hard cut between two speakers is a full stop the plan asked for, not damage to hide.

## Gaps

A beat with no usable footage appears in `gaps` with the script that was expected and the reason it could not be matched. It consumes no timeline time, so the assembled runtime is honest about what exists rather than padded with black.

A gap is a decision waiting for a person: reshoot, drop the beat, or cover it another way. Do not resolve it silently in a later step.

## Parked footage

Unused stretches with their text and position. Material worth keeping that no beat claimed, which is usually an unscripted line that came out better than the scripted one.

## Runtime delta

`runtime_delta_ms` compares the assembled cut against the plan's target. Negative is short. Expect the skeleton to run under target, because it has none of the overhead the plan budgeted: no title card, no end card hold, no held silent moments. On the reference plan that overhead was 21 seconds of a 2:30 target. `/video-branding` adds most of it back.

Do not trim the skeleton to hit the target. The gap is where the later steps live.
