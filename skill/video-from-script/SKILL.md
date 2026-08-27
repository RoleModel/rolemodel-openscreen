---
name: video-from-script
description: "Assemble an edited video skeleton from raw talking-head or audio recordings plus a /video-plan output. Use when the user mentions 'video from script', 'assemble the video', 'cut my recordings to the script', 'build the video skeleton', 'match the takes to the script', 'edit my recordings', or hands over a video plan together with footage. Second step of the RoleModel video pipeline: /video-plan, then this, then /video-b-roll, then /video-branding. Selects the best take per beat, trims silence and stumbles, and produces a HyperFrames composition plus a review page for approval. Not for adding demo or b-roll footage, titles, or lower thirds."
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# Video From Script

Takes a video plan and raw recordings. Returns the assembled talking-head skeleton of the final piece: the right take of every beat, trimmed, in script order, as a HyperFrames composition.

The audience is someone who needs a video and does not edit video. Everything they are asked to judge is expressed in their own words or as something they can watch. They are never asked to read a timecode.

## Scope

**In:** talking-head footage, audio-only recordings, retake selection, silence and stumble trimming, beat ordering, the review loop.

**Out:** demo capture, b-roll, titles, lower thirds, captions, music. Those belong to `/video-b-roll` and `/video-branding`. Do not add them here, and do not put markers in the exported video to reserve room for them. Structure travels in the handoff manifest instead, which keeps the later steps free to depart from the plan.

## Where this sits

```
/video-plan  ->  /video-from-script  ->  /video-b-roll  ->  /video-branding
```

`/video-plan` hands over `marketing/drafts/<project>/<project>-video-plan.md`. This skill hands `/video-b-roll` a rendered MP4 plus `skeleton-manifest.json`.

This skill owns its deliverable. Load `/hyperframes-core` for the composition contract and `/hyperframes-cli` for check and render. Do not route through `/hyperframes`; its routing table has no workflow for assembling footage against a script, and it is vendor managed, so local changes there are overwritten by `npx hyperframes skills update`.

## Rules that hold throughout

1. **Script order wins.** Beats assemble in the plan's order regardless of the order they were recorded in.
2. **A beat with no usable footage becomes a visible gap**, never a silent omission. The reviewer must be able to see what is missing.
3. **Unmatched footage is parked, not deleted.** It goes in the manifest so a later step or a later conversation can still reach it.
4. **An explicit instruction from the user outranks the plan.** If they say to change direction, the new direction is the spec and the plan becomes reference.
5. **Every cut is visible on the review page.** Cleanup is aggressive, so recoverability comes from showing the reviewer exactly what was removed and why.

## Preflight

Run these without asking. They are read only.

```bash
node --version
ffmpeg -version | head -1
npx --yes hyperframes@latest --version
```

HyperFrames needs no global install; it runs through `npx`. If Node is missing, stop and tell the user to install Node, since nothing downstream works without it. If `ffmpeg` is missing, transcription and probing still work through HyperFrames, but say so.

**Ask before anything that downloads.** Name the thing and its size. Two cases come up:

- The Whisper model on the first `transcribe`, about 466 MB for `small.en`.
- Chromium on the first `check` or `render`, about 101 MB.

The review loop needs neither, because the review page plays the uncut sources directly in the browser. Only `check` and `render` do.

## Project layout

Video projects hold large binaries and never belong in git. The pipeline shares one workspace per video at `marketing/drafts/<project>/`, which the repo already ignores through `**/drafts/*`. `/video-plan` writes its document there as `<project>-video-plan.md`, and `/video-b-roll` works in the same directory.

Everything this skill produces goes in a `skeleton/` subdirectory, which keeps it clear of the HyperFrames project `/video-b-roll` builds later in the same workspace.

```text
marketing/drafts/<project>/
  <project>-video-plan.md    written by /video-plan
  source/                    the recordings, untouched
  skeleton/
    beats.json               the plan, parsed
    transcripts.json         speaker to source, transcript, and duration
    transcripts/             one word-timestamp JSON per source
    cut.json                 alignment decisions
    overrides.json           accumulated decisions from the user
    index.html               the HyperFrames composition
    review.html              the approval page
    skeleton-manifest.json   handoff context for the next two skills
    skeleton-notes.md        the same handoff, readable
    source/                  symlink to ../source, created by build.py
    renders/skeleton.mp4     the handoff artifact itself
```

`source/` is a symlink inside `skeleton/`, pointing at the real `source/` in the workspace above. **Pass `--link-media ../source` to `build.py` and it creates the symlink for you.**

This is not tidiness. HyperFrames serves a composition with the project root as its base URL and rejects `../` in asset paths with `invalid_parent_traversal_in_asset_path`, so media must be reachable without traversal. A symlink satisfies that while keeping one canonical copy of the footage in the shared workspace, so nothing is duplicated and `/video-b-roll` reads the same files.

If the recordings live somewhere else entirely and are too large to move, point `--link-media` at them there. `build.py` warns on stderr when a referenced source does not resolve, so read its output before moving on.

## Workflow

### 1. Collect the inputs

The plan file and the footage. If either is missing, ask for it. Copy the plan to `plan.md` in the project so the run is reproducible from one directory.

### 2. Parse the plan into beats.json

Read the plan and write `beats.json` yourself. Do not write a parser; the plan format is prose and still moving. Follow `references/plan-parsing.md` for what to extract.

Then **show the parsed beat table back and confirm it** before going further. This is the cheapest gate in the run: a misread speaker mapping costs one message here and a whole transcription pass later.

### 3. Map speakers to source files

Match on filename first, since `blaine.mp4` for Blaine Irvin is unambiguous. Ask when it is not. Write `transcripts.json` as you go.

One speaker per file is the expected shape. A single file holding several speakers needs diarization, which this skill does not do; split it first or treat it as one speaker.

### 4. Transcribe

Ask before the first run, then:

```bash
npx --yes hyperframes@latest transcribe source/<file> --model small.en
```

Always pass `--model` explicitly. The CLI default silently translates non-English audio into English.

Record each source's duration in `transcripts.json` as `duration_s`:

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 source/<file>
```

This is not optional. Without it a trailing pad can run a clip past the end of its file, which reads as a freeze or black at the end of the video.

### 5. Align

```bash
python3 <skill>/scripts/align.py \
  --beats beats.json --transcripts transcripts.json --out cut.json
```

Add `--overrides overrides.json` once it exists. `references/alignment.md` covers the algorithm, the thresholds, and every flag.

### 6. Adjudicate the flags

Read the flags in `cut.json` and resolve what you can before showing the user anything.

| Flag | Meaning | What to do |
| --- | --- | --- |
| `close_call` | Two attempts scored within the margin | Compare the spoken text and pick the cleaner one. Mention it. |
| `trailing_abandoned_take` | The last attempt was abandoned, an earlier one was used | Usually correct. Say so and move on. |
| `no_complete_take` | Nothing reached the end of the beat | Flag prominently. The beat may need a reshoot. |
| `below_threshold` | Nothing matched | Check the speaker mapping first, since a wrong file looks exactly like this. |
| `no_footage` | No recording for that speaker | Ask whether a file is missing. |
| `override_ignored` | A forced attempt number does not exist | Tell the user what attempts actually exist. |

### 7. Build

```bash
python3 <skill>/scripts/build.py \
  --cut cut.json --project . --link-media ../source \
  --title "<video title>" --target-runtime <seconds>
```

Add `--audio-only` for audio recordings. Takes the runtime target from the plan so the review page can show assembled against intended. Check stderr for unresolved media before moving on.

### 8. Validate

```bash
npx --yes hyperframes@latest check
```

Must pass with zero errors before the user sees anything. `references/composition.md` explains what the checker enforces and why the template is shaped the way it is.

### 9. Hand over the review page

**You own the preview server. Never ask the user to start or stop it.**

The review page seeks into the uncut sources, which needs two things a `file://` URL cannot give: HTTP delivery and **Range request support**.

**Do not use `python3 -m http.server`.** It ignores Range headers, so the browser reports `seekable` as empty and silently drops every assignment to `currentTime`. The page then plays each source from its start instead of from the chosen take, and because it works once a file happens to be fully buffered, it fails intermittently rather than obviously. Use the server that ships with this skill instead; it serves the same repo root on the same port 8000, so the convention in the root `AGENTS.md` still holds.

First check whether one is already up:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/ --max-time 2
```

`200` means a server is already running. Verify it answers Range requests before trusting it:

```bash
curl -s -D - -o /dev/null -r 0-99 http://localhost:8000/ --max-time 2 | head -1
```

`206 Partial Content` means it is usable, and you should **not kill it later** because it is not yours. A `200` to that request means it is the seek-broken kind: stop it and start this one in its place. Nothing running means just start this one, in the background:

```bash
python3 <skill>/scripts/preview_server.py \
  --directory "$(git rev-parse --show-toplevel)" --port 8000
```

Then give the user the URL and a short summary: how long it came out, how it compares to the target, which beats are worth a look, and what is missing. Keep it in their language, not in timecodes.

```text
http://localhost:8000/marketing/drafts/<project>/skeleton/review.html
```

Media is reached through the symlink at `skeleton/source`, which the server follows.

**Shut down a server you started** once the review is settled, which means the user has approved, moved on to another task, or ended the session:

```bash
kill $(lsof -ti:8000)
```

Leaving a stray server bound to 8000 is exactly the maintenance this skill exists to spare people. If you started it, you close it.

### 10. Iterate, then hand off

Translate what they say into `overrides.json`, re-run align and build, and tell them what changed. See the feedback loop below.

When they approve, **render**. This is not optional and not only for the user's benefit: `/video-b-roll` Mode B takes "one finished edited video plus a directory of B-roll", so the rendered MP4 is the handoff artifact. The manifest is context that travels alongside it.

```bash
mkdir -p renders
npx --yes hyperframes@latest render -o renders/skeleton.mp4 --fps 30
```

Ask before the first render if `check` has not already run, since it downloads Chromium. Once `check` has run, it is cached and the render needs nothing new.

Then hand off explicitly: name `renders/skeleton.mp4` as the finished edited video, `skeleton-manifest.json` as the context, and point out that `jump_cuts` marks the places wanting cover. Close the preview server if you started it.

## The feedback loop

Feedback arrives in plain language. Turn it into `overrides.json`, which accumulates so decisions are never re-litigated.

```json
{
  "config": { "max_gap_s": 0.45 },
  "beats": {
    "3": { "attempt": 2 },
    "1": { "config": { "fillers": [] } }
  }
}
```

| They say | You write |
| --- | --- |
| "use the second attempt at beat 3" | `"3": {"attempt": 2}` |
| "put the um back in beat 1, it sounded natural" | `"1": {"config": {"fillers": []}}` |
| "the pauses are too tight everywhere" | `"config": {"max_gap_s": 0.9}` |
| "beat 4 is missing, I did record it" | Recheck the mapping before touching thresholds |
| "cut the bit where I stumble on pricing" | Find it in the transcript, then narrow that beat's window |

Re-run both scripts after every change. Never hand-edit `cut.json` or `index.html`; they are generated, and an edit there is lost on the next run.

## Testing

```bash
python3 -m unittest discover -p "test_*.py"          # from scripts/
python3 scripts/make_smoke_fixture.py --out <dir>     # deterministic end to end
```

The fixture speaks each word separately with `say` and measures it, so the transcript is ground truth rather than a Whisper estimate. It builds in about ten seconds, downloads nothing, and deliberately contains a false start, a filler word, a repeated phrase, and a long pause.

## References

- `references/plan-parsing.md` reading a `/video-plan` file into `beats.json`
- `references/alignment.md` the matching algorithm, thresholds, flags, and overrides
- `references/composition.md` the HyperFrames contract for a skeleton
- `references/handoff.md` the manifest, and what the next two skills read from it
