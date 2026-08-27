# Environment notes

macOS with homebrew ffmpeg, verified August 2026. Each item below cost at least
one failed command.

## ffmpeg build

- `-vsync` is **removed**. Use `-fps_mode passthrough`.
- `select` expressions take `*` and `+`, **not** `and` or `or`:
  `select='between(n,798,821)*not(mod(n-798,3))'`
- **No `drawtext`** (no freetype). You cannot burn a timecode into a contact
  sheet. `scripts/contact-sheet.sh` prints the tile-to-time mapping instead.
  For a timecoded test source use
  `-f lavfi -i "testsrc=size=960x540:rate=60:duration=60"`, which burns in a
  seconds counter. That is what made the `data-playback-rate` probe possible.
- **No `vidstabdetect` / libvidstab.** `scripts/motion-scan.py` is the substitute.
- `-v error` suppresses `volumedetect` output, which logs at info level. Use
  `-hide_banner -nostats` instead when you need the volume report.

## Frame extraction off-by-one

`ffmpeg -ss 0 -t 30 -vf fps=1 -start_number 1 s%02d.jpg` writes `s01` at t=0, so
`sNN` is `NN-1` seconds. This silently shifted a source map by a full second
mid-edit. Either pass `-start_number` equal to the `-ss` offset, so the filename
is the source second, or compute the mapping explicitly and sanity-check one
known frame. `scripts/contact-sheet.sh` avoids the problem entirely.

## Transcription

- `whisper-cli` is installed via homebrew but **no models are downloaded**. Use
  `hyperframes transcribe` or `hyperframes init --video/--audio`, which manages
  models and caches them to `~/.cache/hyperframes/whisper/models/`.
- `brew install whisper-cpp` (1.9.2) supplies the ASR backend.
- HyperFrames `transcript.json` is **whisper.cpp shape**: a `transcription` array
  of segments with `offsets.from` and `offsets.to` in milliseconds and nested
  `tokens`. It is not a flat `words` array.
- Parakeet (`uv pip install parakeet-mlx`) is the documented more accurate
  alternative and has not been tried here. Worth trying first, given the timing
  drift documented in `mode-a-voiceover-fit.md`.

## Shell and tooling

- Python 3.13 has no `audioop`. The RMS envelope in
  `scripts/vo-phrase-boundaries.py` uses only `array` and `math`.
- **No `timeout` command** in this zsh.
- The Bash tool's working directory resets between calls. Use absolute paths, or
  `cd` inside every invocation. A relative path that silently resolves to the
  wrong directory, combined with `2>/dev/null`, wastes a cycle.
- Long `find /` scans time out at two minutes. Scope them.
- `hyperframes` is not on PATH. Use `npx hyperframes@<version>` or the project's
  `npm run` scripts.
- The first render downloads Chrome, about 101 MB, once. Cached after that.
