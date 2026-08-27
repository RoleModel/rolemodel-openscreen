#!/usr/bin/env python3
"""motion-scan.py -- score camera motion for video files, and rank calm windows.

Why this exists: stills cannot show a pan. A contact sheet of a drifting handheld
shot looks perfectly fine, and the shakiness only appears after the render, which
is the most expensive place to discover it. This turns "shaky" into a number you
can filter on before you ever pick a shot.

Method: frame-to-frame mean absolute difference on a 32x18 grayscale reduction at
4 fps. At that resolution local subject motion (a head, a hand) averages out,
while a camera pan or handheld drift displaces the whole frame and spikes the
metric. Substitute for libvidstab, which is often missing from a homebrew ffmpeg.

Calibrated thresholds, from real reviewer feedback on rendered output:

    peak < 5     reads as locked off        (2.4 / 2.5 / 1.9 / 2.9 accepted; 3.9 called excellent)
    peak 5 - 10  perceptible drift          (6.1 shipped with a caveat; 9.1 and 10.2 replaced)
    peak > 20    visibly shaky or panning   (46.9 and 47.0 = "shaky"; 26.2 = "the camera pans down")

Rank by PEAK, never by mean. One whip pan ruins a shot whose average is calm.

Usage:
    ./motion-scan.py CLIP [CLIP ...]                     summary per clip
    ./motion-scan.py --window 4.0 --top 5 /broll/*.MP4   best 4s windows per clip
    ./motion-scan.py --window 4.0 --top 20 --pooled ...  best windows across all clips
    ./motion-scan.py --at 130.0 --window 4.12 CLIP       score one specific window
    ./motion-scan.py --json ...                          machine-readable, for the EDL

Verification use: after rendering, re-run with --at/--window over each opaque
hold in the OUTPUT file. That proves the shot you picked is the shot that
shipped, at the steadiness you measured.
"""

import argparse
import json
import subprocess
import sys

FPS = 4          # sampling rate of the reduction
COLS, ROWS = 32, 18
N = COLS * ROWS


def series_for(path):
    """Return the per-interval motion series for a file, at FPS samples/second."""
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path,
         "-vf", f"fps={FPS},scale={COLS}:{ROWS},format=gray",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True)
    if p.returncode != 0:
        sys.stderr.write(f"ffmpeg failed on {path}: {p.stderr.decode()[:400]}\n")
        return []
    buf = p.stdout
    frames = [buf[i * N:(i + 1) * N] for i in range(len(buf) // N)]
    return [sum(abs(x - y) for x, y in zip(a, b)) / N
            for a, b in zip(frames, frames[1:])]


def score(series, start_idx, count):
    """Peak and mean over a slice of the series."""
    chunk = series[start_idx:start_idx + count]
    if not chunk:
        return None
    return {"peak": max(chunk), "mean": sum(chunk) / len(chunk)}


def verdict(peak):
    if peak < 5:
        return "locked off"
    if peak < 10:
        return "perceptible drift"
    if peak < 20:
        return "noticeable movement"
    return "shaky / panning"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clips", nargs="+")
    ap.add_argument("--window", type=float,
                    help="window length in seconds; enables window ranking")
    ap.add_argument("--top", type=int, default=5,
                    help="how many calm windows to report (default 5)")
    ap.add_argument("--at", type=float,
                    help="score one window starting at this second, instead of ranking")
    ap.add_argument("--pooled", action="store_true",
                    help="rank windows across all clips together, not per clip")
    ap.add_argument("--max-peak", type=float, default=None,
                    help="only report windows at or below this peak")
    ap.add_argument("--stride", type=float, default=0.5,
                    help="window step in seconds (default 0.5)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    pooled = []
    out = []

    for path in args.clips:
        s = series_for(path)
        if not s:
            continue
        dur = len(s) / FPS

        if args.at is not None and args.window:
            r = score(s, int(args.at * FPS), int(args.window * FPS))
            if r:
                rec = {"clip": path, "start": args.at, "window": args.window, **r,
                       "verdict": verdict(r["peak"])}
                out.append(rec)
            continue

        if not args.window:
            rec = {"clip": path, "duration": round(dur, 2),
                   "peak": max(s), "mean": sum(s) / len(s)}
            rec["verdict"] = verdict(rec["peak"])
            out.append(rec)
            continue

        count = int(args.window * FPS)
        step = max(1, int(args.stride * FPS))
        wins = []
        for i in range(0, max(0, len(s) - count), step):
            r = score(s, i, count)
            if not r:
                continue
            if args.max_peak is not None and r["peak"] > args.max_peak:
                continue
            wins.append({"clip": path, "start": round(i / FPS, 2),
                         "window": args.window, **r, "verdict": verdict(r["peak"])})
        wins.sort(key=lambda w: w["peak"])
        if args.pooled:
            pooled.extend(wins)
        else:
            out.extend(wins[:args.top])

    if args.pooled:
        pooled.sort(key=lambda w: w["peak"])
        out = pooled[:args.top]

    if args.json:
        print(json.dumps(out, indent=2))
        return

    for r in out:
        if "duration" in r:
            print(f"{r['clip']}\n  duration {r['duration']}s  "
                  f"peak {r['peak']:.1f}  mean {r['mean']:.1f}  -> {r['verdict']}")
        else:
            print(f"{r['clip']}  in={r['start']:7.2f}  len={r['window']:.2f}  "
                  f"peak={r['peak']:6.1f}  mean={r['mean']:5.1f}  {r['verdict']}")


if __name__ == "__main__":
    main()
