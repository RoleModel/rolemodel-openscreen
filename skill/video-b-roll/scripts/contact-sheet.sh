#!/usr/bin/env bash
# contact-sheet.sh -- survey footage cheaply by reading one tiled image, not twenty frames.
#
# Reading frames one at a time burns context fast. A tile sheet lets you read a
# whole minute of footage in a single image.
#
# Usage:
#   ./contact-sheet.sh SRC OUT.jpg [START] [LEN] [GRID] [FPS]
#
#   ./contact-sheet.sh clip.MP4 coarse.jpg 0 600 6x4 1/20    coarse: is anything here?
#   ./contact-sheet.sh clip.MP4 dense.jpg 130 21 7x3 1       fine: pick an exact in point
#
# Defaults: START=0 LEN=whole file GRID=5x4 FPS=1
#
# Prints the time of every tile, because this ffmpeg build has no drawtext and
# cannot burn a timecode into the picture. Read tiles left to right, top to bottom.
#
# Note the off-by-one that this script exists to avoid: with
# `-ss 0 -t 30 -vf fps=1 -start_number 1 s%02d.jpg`, ffmpeg writes s01 at t=0, so
# sNN is NN-1 seconds, not NN. That silently shifts a whole source map by one
# second. Use this script, or pass -start_number equal to the -ss offset so the
# filename IS the source second.

set -euo pipefail

SRC="${1:?usage: $0 SRC OUT.jpg [START] [LEN] [GRID] [FPS]}"
OUT="${2:?usage: $0 SRC OUT.jpg [START] [LEN] [GRID] [FPS]}"
START="${3:-0}"
LEN="${4:-}"
GRID="${5:-5x4}"
FPS="${6:-1}"
WIDTH="${WIDTH:-320}"

args=(-y -v error -ss "$START")
[ -n "$LEN" ] && args+=(-t "$LEN")
args+=(-i "$SRC" -vf "fps=${FPS},scale=${WIDTH}:-1,tile=${GRID}" -frames:v 1 -q:v 4 "$OUT")

ffmpeg "${args[@]}"
echo "wrote $OUT"

python3 - "$START" "$GRID" "$FPS" <<'PY'
import sys
start = float(sys.argv[1])
cols, rows = (int(x) for x in sys.argv[2].split("x"))
num, _, den = sys.argv[3].partition("/")
step = float(den or 1) / float(num)          # seconds between tiles
print(f"\ntile times ({cols}x{rows}, {step:g}s apart), left to right, top to bottom:")
for r in range(rows):
    line = []
    for c in range(cols):
        t = start + (r * cols + c) * step
        line.append(f"{int(t)//60}:{t%60:05.2f}")
    print("  " + "  ".join(line))
PY
