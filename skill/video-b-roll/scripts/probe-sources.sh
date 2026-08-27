#!/usr/bin/env bash
# probe-sources.sh -- integrity check every source file before any edit decision.
#
# Usage:  ./probe-sources.sh FILE [FILE ...]
#         ./probe-sources.sh /path/to/broll/*.MP4
#
# Prints one block per file and flags the two failure modes that silently ruin
# an edit: a truncated file whose container lies about its duration, and a
# variable frame rate source that will not seek accurately.

set -uo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $0 FILE [FILE ...]" >&2
  exit 64
fi

for f in "$@"; do
  [ -f "$f" ] || { echo "MISSING  $f"; continue; }

  echo "=== $f"
  ffprobe -v error \
    -select_streams v:0 \
    -show_entries stream=width,height,r_frame_rate,avg_frame_rate,codec_name,nb_frames \
    -show_entries format=duration,size,format_name \
    -of default=nw=1 "$f"

  ffprobe -v error -select_streams a:0 \
    -show_entries stream=codec_name,channels,sample_rate \
    -of default=nw=1 "$f" | sed 's/^/audio_/'

  bytes=$(ffprobe -v error -show_entries format=size -of csv=p=0 "$f")
  claimed=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")

  # Round power-of-two size is the classic upload/download cap tell.
  python3 - "$bytes" <<'PY'
import sys
b = int(float(sys.argv[1]))
if b and (b & (b - 1)) == 0:
    print(f"WARNING exact power-of-two size ({b} bytes). Strong truncation signal.")
PY

  # Decode the whole file. Anything printed here is a real container problem.
  errs=$(ffmpeg -v error -err_detect explode -i "$f" -f null - 2>&1 | head -5)
  if [ -n "$errs" ]; then
    echo "DECODE ERRORS:"
    echo "$errs" | sed 's/^/  /'
  fi

  # Real decodable duration, which can be far short of the claimed duration.
  real=$(ffmpeg -v error -i "$f" -map 0:v:0 -f null - 2>&1 >/dev/null; \
         ffprobe -v error -count_frames -select_streams v:0 \
           -show_entries stream=nb_read_frames -of csv=p=0 "$f" 2>/dev/null)
  fps=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$f")
  if [ -n "$real" ] && [ -n "$fps" ] && [ -n "$claimed" ]; then
    python3 - "$real" "$fps" "$claimed" <<'PY'
import sys
frames = float(sys.argv[1] or 0)
num, _, den = sys.argv[2].partition('/')
fps = float(num) / float(den or 1)
claimed = float(sys.argv[3])
decoded = frames / fps if fps else 0
print(f"decoded_frames={int(frames)}  decoded_duration={decoded:.2f}s  claimed_duration={claimed:.2f}s")
if claimed and decoded and (claimed - decoded) > 1.0:
    print(f"TRUNCATED by {claimed - decoded:.1f}s. Stop and ask the user before cutting anything.")
PY
  fi

  # VFR detection: r_frame_rate far from avg_frame_rate means variable frame rate.
  python3 - "$f" <<'PY'
import subprocess, sys
def q(entry):
    return subprocess.run(
        ["ffprobe","-v","error","-select_streams","v:0",
         "-show_entries",f"stream={entry}","-of","csv=p=0",sys.argv[1]],
        capture_output=True, text=True).stdout.strip()
def rat(s):
    try:
        n, _, d = s.partition('/')
        return float(n) / float(d or 1)
    except Exception:
        return 0.0
r, a = rat(q("r_frame_rate")), rat(q("avg_frame_rate"))
if r and a and abs(r - a) / r > 0.05:
    print(f"VFR likely (r={r:.2f} avg={a:.2f}). Build a constant frame rate proxy before seeking.")
PY
  echo
done
