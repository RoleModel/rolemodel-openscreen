#!/usr/bin/env bash
# build-segments.sh -- cut, retime, and normalize every segment the composition needs.
#
# One script for both modes. A cutaway is just a segment at rate 1.0.
#
# Usage:
#   SCALE=1280:720 FPS=24000/1001 ./build-segments.sh segments.tsv media/segments
#
# segments.tsv is tab separated, one row per segment, "#" comments allowed:
#
#   name    src                     srcIn    slotDur  rate  hPre  hPost
#   beat01  media/demo-proxy.mp4    12.400   2.850    1.62  0.16  0.16
#   b03     /vol/broll/0O8A7331.MP4 55.500   3.750    1.00  0.30  0.30
#
#   name     output basename, becomes <out>/<name>.mp4
#   src      source file, ideally a normalized proxy for mode A
#   srcIn    in point in SOURCE seconds, at the moment you want on screen at slot start
#   slotDur  how long the segment holds on the TIMELINE, in seconds
#   rate     speed multiplier baked into the media. 1.0 = no retime.
#   hPre     dissolve handle before the slot, in TIMELINE seconds
#   hPost    dissolve handle after the slot, in TIMELINE seconds
#
# Handles are extra material outside the nominal slot. They give the cross
# dissolve real footage instead of a held frame, and they preserve timing
# exactly: the frame on screen at any given timeline second is identical to a
# hard cut edit. 0.3s each side is the default for a 0.3s dissolve.
#
# Speed is baked in here with setpts on purpose. Never author speed with
# data-playback-rate: the timeline seek ignores it while the render frame
# extractor honours it, so check and snapshot pass clean and the render either
# aborts on a coverage error or ships the clip blank.
#
# Keep rate between about 0.8 and 2.2. Past 2.5 a UI screen recording turns to mush.
#
# Emits the data-* attributes for each segment on stdout when done.

set -euo pipefail

TSV="${1:?usage: $0 segments.tsv OUTDIR}"
OUT="${2:?usage: $0 segments.tsv OUTDIR}"
SCALE="${SCALE:-}"                 # e.g. 1280:720. Empty leaves size alone.
FPS="${FPS:-}"                     # e.g. 24000/1001 or 60. Empty leaves fps alone.
CRF="${CRF:-17}"
PRESET="${PRESET:-slow}"

mkdir -p "$OUT"
: > "$OUT/.attributes.txt"

while IFS=$'\t' read -r name src srcIn slotDur rate hPre hPost _rest; do
  case "$name" in ''|'#'*|name) continue ;; esac
  [ -f "$src" ] || { echo "missing source: $src" >&2; exit 1; }

  read -r sin odur sdur slotStart <<<"$(python3 - "$srcIn" "$slotDur" "$rate" "$hPre" "$hPost" <<'PY'
import sys
srcIn, slotDur, rate, hPre, hPost = map(float, sys.argv[1:6])
# Pull the pre-roll handle from earlier in the SOURCE, scaled by rate.
sin = max(0.0, srcIn - hPre * rate)
# +0.05 of encode headroom. A segment one frame short flashes black at the tail.
odur = slotDur + hPre + hPost + 0.05
# Pull a little extra SOURCE so the segment is always at least odur long.
# The composition only ever shows data-duration, so a slightly long tail is
# never displayed; a short one flashes black. Covers -ss landing mid-frame,
# where the decode yields one frame fewer than ceil(odur*fps).
sdur = (odur + 0.10) * rate
print(f"{sin:.4f} {odur:.4f} {sdur:.4f} 0")
PY
)"

  vf=("setpts=PTS/${rate}")
  [ -n "$SCALE" ] && vf=("scale=${SCALE}:flags=lanczos" "${vf[@]}")
  [ -n "$FPS" ] && vf+=("fps=${FPS}")
  vfjoined=$(IFS=,; echo "${vf[*]}")

  echo "building $name  src=$sin len=$sdur rate=$rate -> ${odur}s"
  ffmpeg -nostdin -y -v error -ss "$sin" -t "$sdur" -i "$src" \
    -vf "$vfjoined" -an \
    -c:v libx264 -preset "$PRESET" -crf "$CRF" \
    -g 15 -keyint_min 15 -sc_threshold 0 \
    -pix_fmt yuv420p -movflags +faststart "$OUT/$name.mp4"

  # A segment shorter than the clip duration it fills shows a black flash.
  python3 - "$OUT/$name.mp4" "$odur" "$name" <<'PY'
import subprocess, sys
got = float(subprocess.run(
    ["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",sys.argv[1]],
    capture_output=True, text=True).stdout.strip() or 0)
want = float(sys.argv[2])
if got + 1e-3 < want:
    sys.exit(f"FAIL {sys.argv[3]}: media is {got:.3f}s but the clip needs {want:.3f}s. "
             f"Move the in point earlier or shorten the handles.")
PY

  python3 - "$name" "$slotDur" "$hPre" "$hPost" >> "$OUT/.attributes.txt" <<'PY'
import sys
name, slotDur, hPre, hPost = sys.argv[1], *map(float, sys.argv[2:5])
print(f'<!-- {name}: data-start = slotStart - {hPre}   '
      f'data-duration = {slotDur + hPre + hPost:.3f} -->')
PY
done < "$TSV"

echo
echo "done. Attribute hints in $OUT/.attributes.txt"
echo "Reminder: set data-media-start=\"0\" on every segment. The cut is already baked in."
