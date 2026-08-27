# Mode A: fit a long recording to a fixed voiceover

**Inputs:** one full length voiceover (locked, immovable) plus one much longer
demo or screen recording. **Job:** make the relevant part of the recording play
under the sentence that explains it.

The worked case behind this file: a 184.5s LightningCAD deck-designer screen
recording against a 29.06s narration, a 6.35 to 1 ratio, delivered as 10 beats at
1920x1080 30fps.

## 1. Recon the recording

Use `scripts/contact-sheet.sh`. Coarse pass first at `fps=1/4` or `1/20` to find
the regions that matter, then 1s or 0.5s sheets on those regions.

Log what is on screen at what **source second**. This map is the whole basis of
the edit.

Also look for junk to cut around. That recording had a macOS Spotlight panel open
from about 180s and a browser right-click menu at about 76s. Both would have
shipped.

## 2. Transcribe, but do not trust the timings

Use the transcript for word order and phrasing only. whisper.cpp word timings
drifted up to 1.0s on the worked case, and the drift was not monotonic:
`medium.en` ran about 1.0s early at 17s and about 0.6s late at 29s, so no global
offset corrects it. A bigger model is not the fix; `medium.en` was worse than
`small.en` at the spot that mattered.

The practical effect of skipping step 3: the first cut had beats 2 through 6
running 0.3 to 0.7s early, and "add a roof" cut away while the word "roof" was
still being said.

Parakeet (`uv pip install parakeet-mlx`) is the documented more accurate
alternative and is worth trying first.

## 3. Measure the real phrase boundaries

This is the step that makes the edit accurate.

```bash
scripts/vo-phrase-boundaries.py media/voiceover.mp3 --dips
```

Then map each gap to a comma or period in the script. If every punctuation mark
has a gap and every gap has a punctuation mark, the envelope is trustworthy and
it overrules the transcript. On the worked case all 14 substantive gaps matched,
which is what justified overruling.

For a boundary with no measurable pause, meaning a comma the reader ran through,
interpolate by syllable count across the enclosing measured span, then confirm a
shallow local minimum exists there. Two boundaries were found that way and both
had dips, at -55 dB and -49 dB.

`silencedetect` is a quicker first look but missed several real boundaries at
-34 dB, which is why the script defaults to -45 dB.

## 4. Build a constant frame rate proxy

The original was 869 MB, 3070 px wide, and variable frame rate. Non-linear
seeking on that is slow and frame-inaccurate.

```bash
ffmpeg -y -i SRC.mov -t 180 -vf "scale=1920:1080:flags=lanczos" \
  -c:v libx264 -preset medium -crf 19 \
  -g 15 -keyint_min 15 -sc_threshold 0 \
  -pix_fmt yuv420p -r 60 -an -movflags +faststart media/demo-proxy.mp4
```

The short GOP of 15 is the point. It makes every seek land on the intended frame.
`-r 60` normalises the variable frame rate timeline, and content at source time T
stays at T, which is worth spot-checking once.

## 5. Assign beats

One beat per narration phrase. For each beat, pick the source window that shows
the thing being described, and set `rate = srcDur / slotDur`.

Aim to land the moment of change (the click, the snap, the flip) on the specific
word. Keep rate roughly 0.8x to 2.2x. Past about 2.5x a UI recording turns to
mush. Get the compression from cutting, not from uniform speed-up: the worked
case absorbed 6.35 to 1 with rates that never left 0.81x to 2.16x.

Write the beats into `segments.tsv` and build them:

```bash
SCALE=1920:1080 FPS=60 scripts/build-segments.sh segments.tsv media/segments
```

Never author speed with `data-playback-rate`. See `hyperframes-build.md`.

## 6. Compose, verify, render

Follow `hyperframes-build.md`. Place each segment 1:1 with `data-media-start="0"`
and dissolve on the incoming layer only.

## Narration order versus recording order

This is the substantive editorial conflict in mode A and it recurs. The narration
lists features in one order, the recording performs them in another:

| | order |
|---|---|
| narration | roof, screen, height ... ramp, stair, wrap |
| recording | height, roof, screens ... wrap, stair, ramp |

First check whether alternative footage even exists. On the worked case it did
not: the recording inserts a ramp exactly once, at 165s, long after the wrap at
82s. That left only the video-only options.

Three ways out, in increasing quality:

1. **Match words, accept state regression.** Each line gets its own action, but
   the model visibly reverts, so a roof and screens vanish and a joined deck
   un-joins. Cheap, and a dissolve softens it.
2. **Match state, lose action-on-words.** No regression, but the line now
   describes a static result instead of something happening. This is what a
   reviewer noticed and objected to.
3. **Reorder the narration.** Both properties at once. This is the right answer
   when the conflicting clauses are a **list**, because a list is order free in
   meaning.

Option 3 is a real change to delivered narration, so **propose it, never apply it
unasked.** Ship the first cut with the best video-only compromise, then present
the option with the exact new sentence written out, so it can be approved or
declined on its merits.

When approved, use `scripts/permute-vo.py`. The output is a pure permutation of
adjacent spans covering the whole file, so total duration is preserved exactly
(29.064s in, 29.064s out on the worked case) and no speech is resampled, retimed,
or regenerated.

```
P1 = [0.000, 19.465]  "... More advanced changes, like"
P2 = [19.465, 20.920] "adding a wheelchair ramp," + pause
P3 = [20.920, 22.455] "lowering the stair profile, or"
P4 = [22.455, 25.200] "joining two decks ... of the house," + pause
P5 = [25.200, 29.064] "happen in a 2D editor ... immediately." + tail
```

Emit `P1 P4 P3 P2 P5`. Note that `or` is deliberately left attached to the clause
it precedes, so the grammar survives the move.

Verify by re-transcribing the output. On the worked case it came back as one
clean sentence in the intended order with the same 85 word count, which is good
evidence the joins are inaudible since the recogniser had no trouble with them.
Also check by ear where possible: moving a list-final clause, which carries
falling intonation, into first position can sound odd even when the splice is
clean.
