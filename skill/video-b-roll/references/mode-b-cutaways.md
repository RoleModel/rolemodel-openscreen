# Mode B: cut B-roll into a finished video

**Inputs:** one edited video, before any B-roll or demos are added, plus a
directory of unlabelled B-roll. **Job:** insert motivated cutaways.

The worked case behind this file: a 720p talking-head recruitment video against
about 28 minutes of unlabelled classroom B-roll, delivered at 1:49.5, 23.976 fps,
7 cutaways, 23 percent coverage.

## 1. Map the A-roll structure

Two independent signals, cross-checked. Neither alone is reliable.

**Scene cuts** give exact picture boundaries:

```bash
ffmpeg -v error -i "$A" -filter_complex "select='gt(scene,0.25)',metadata=print:file=-" \
  -f null - 2>/dev/null | grep -oE "pts_time:[0-9.]+" | cut -d: -f2
```

**Transcript** gives words and rough timings, from `hyperframes init --video` or
`hyperframes transcribe`.

Cross-check them. Whisper segment end times over-extend into trailing silence. On
the worked case a segment claimed to end at 48.72s when the speaker actually
finished around 44s and a graphic card occupied 45.38 to 48.38. Scene cuts are
ground truth for picture, the transcript is ground truth for words, and where
they disagree by 1 to 3 seconds, trust the scene cut.

**Identify graphics.** Extract a frame just after each scene cut and view them
tiled. Title cards, question cards, and lower thirds are already designed beats
and are no-go zones for cutaways.

Output a structural table of speaker, card, in, out. Every later decision
references it.

## 2. Survey the B-roll

```bash
scripts/contact-sheet.sh clip.MP4 coarse.jpg 0 600 6x4 1/20     # categorize a clip
scripts/contact-sheet.sh clip.MP4 dense.jpg 130 21 7x3 1        # find an exact in point
```

Build a person-identification key early, matching wardrobe and hair between
A-roll interview frames and B-roll frames. It pays off twice: it enables putting
the current speaker in their own cutaway, and it prevents mislabelling people in
the EDL.

## 3. Score every candidate window for camera motion

This is the highest-value step. Run it over the whole directory once, up front,
and select only from calm windows. 28 minutes of footage scores in about two
minutes.

```bash
scripts/motion-scan.py /path/to/broll/*.MP4                          # per clip summary
scripts/motion-scan.py --window 4.0 --top 20 --pooled --max-peak 5 \
  /path/to/broll/*.MP4                                               # best windows overall
```

Thresholds and the reasoning behind them are in `editorial-standards.md`. Rank by
peak, never by mean.

## 4. Place the cutaways

Apply `editorial-standards.md` in its stated priority order. Record every
decision as a row: where, under which line, from which source and in point, and
the measured peak. That framing is what makes a review round productive, because
it lets a reviewer reject shots individually instead of rejecting the whole edit.

## 5. Pre-cut and normalize

Do not point the composition at multi-GB originals. Cut each segment to its exact
needed length at the A-roll's resolution and frame rate. On the worked case, 6 GB
of 1080p29.97 originals became 48 MB of 720p23.976 project media, and the render
stopped seeking inside huge files.

```bash
SCALE=1280:720 FPS=24000/1001 scripts/build-segments.sh segments.tsv media/segments
```

Use `rate 1.0` for a straight cutaway. Cut 0.3s longer at each end than the
visible hold (`hPre` and `hPost`), so the cross dissolve has real footage to work
with rather than a held frame. B-roll is silent by design; the script strips
audio.

## 6. Compose, verify, render

Follow `hyperframes-build.md`. A-roll on track 0, cutaways above it, interview
audio on a separate `<audio>` element. Set `data-fps` on the root to the A-roll's
actual rate.

## Truncated sources

Never trust a delivered file. `scripts/probe-sources.sh` checks for this, and it
is not hypothetical: the worked case's A-roll was exactly 20.00 MiB, its
container claimed 153.5s, and it decoded to 109.7s.

Tells:

- File size is a suspiciously round power of two, meaning an upload or download cap
- `ffmpeg -i "$F" -f null -` emits `partial file`, `Invalid NAL unit size`, or
  `Error splitting the input into NAL units`
- `ffprobe -count_frames` returns far fewer frames than duration times fps
- Seeking late and extracting audio produces a much shorter file than requested

Repair by re-encoding only the decodable span, normalizing fps and size while you
are there:

```bash
ffmpeg -y -err_detect ignore_err -i "$SRC" -t 109.5 \
  -c:v libx264 -crf 16 -preset medium -pix_fmt yuv420p -r 24000/1001 \
  -c:a aac -b:a 192k -movflags +faststart media/aroll.mp4
```

**Surface truncation as a blocking question before cutting anything.** Losing a
third of the piece changes what the deliverable is. Offer three paths: get the
full file, proceed on what decodes, or proceed and trim to a clean boundary.
