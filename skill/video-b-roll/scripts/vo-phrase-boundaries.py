#!/usr/bin/env python3
"""vo-phrase-boundaries.py -- find the real phrase boundaries in a voiceover.

Why this exists: ASR word timings drift. Measured against real audio, whisper.cpp
placed a phrase up to 1.0s away from where it is actually spoken, and the drift
was not monotonic, so no global offset corrects it. A bigger model did not help;
medium.en was worse than small.en at the spot that mattered. Cutting on ASR
timings puts every cut early, and the picture changes while the word is still
being said.

The audio itself does not drift. This dumps a 10ms RMS envelope and reports every
gap below a threshold, which are the pauses a reader actually took.

Usage:
    ./vo-phrase-boundaries.py media/voiceover.mp3
    ./vo-phrase-boundaries.py media/vo.mp3 --threshold -45 --min-gap 0.09
    ./vo-phrase-boundaries.py media/vo.mp3 --json
    ./vo-phrase-boundaries.py media/vo.mp3 --dips        also report shallow local minima

How to use the output:

 1. Map each reported gap to a comma or period in the script. If every punctuation
    mark has a gap and every gap has a punctuation mark, the envelope is
    trustworthy and it overrules the transcript.
 2. For a boundary with no measurable pause (a comma the reader ran through),
    interpolate by syllable count across the enclosing measured span, then confirm
    with --dips that a shallow local minimum exists there.
 3. Splice or cut only where the floor is deep. Below -49 dB is comfortable.

Python 3.13 removed audioop, so this uses only array and math.
"""

import argparse
import array
import json
import math
import subprocess
import sys
import tempfile
import os

SR = 8000
HOP = 80          # 80 samples at 8 kHz = 10 ms


def envelope(path):
    """Decode to mono 8 kHz s16le and return a 10ms dBFS envelope."""
    with tempfile.NamedTemporaryFile(suffix=".pcm", delete=False) as tf:
        pcm = tf.name
    try:
        p = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", path,
             "-ac", "1", "-ar", str(SR), "-f", "s16le", pcm],
            capture_output=True)
        if p.returncode != 0:
            sys.stderr.write(p.stderr.decode()[:400] + "\n")
            sys.exit(1)
        a = array.array("h")
        with open(pcm, "rb") as fh:
            a.frombytes(fh.read())
    finally:
        os.unlink(pcm)

    env = []
    for k in range(len(a) // HOP):
        s = a[k * HOP:(k + 1) * HOP]
        v = math.sqrt(sum(x * x for x in s) / len(s)) if s else 0
        env.append(20 * math.log10(v / 32768) if v > 0 else -99.0)
    return env


def gaps(env, thr, min_gap):
    out, i = [], 0
    while i < len(env):
        if env[i] < thr:
            j = i
            while j < len(env) and env[j] < thr:
                j += 1
            length = (j - i) * 0.01
            if length >= min_gap:
                out.append({"start": round(i * 0.01, 2),
                            "end": round(j * 0.01, 2),
                            "length": round(length, 2),
                            "floor": round(min(env[i:j]), 1)})
            i = j
        else:
            i += 1
    return out


def dips(env, thr, span=0.25):
    """Local minima that never cross the threshold. Candidate soft boundaries."""
    w = int(span / 0.01)
    out = []
    for i in range(w, len(env) - w):
        lo = min(env[i - w:i + w + 1])
        if env[i] == lo and env[i] < thr + 12 and env[i] >= thr:
            if not out or i * 0.01 - out[-1]["at"] > 0.30:
                out.append({"at": round(i * 0.01, 2), "floor": round(env[i], 1)})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio")
    ap.add_argument("--threshold", type=float, default=-45.0,
                    help="dBFS silence threshold (default -45; silencedetect at -34 "
                         "misses real boundaries)")
    ap.add_argument("--min-gap", type=float, default=0.09,
                    help="minimum gap length in seconds (default 0.09)")
    ap.add_argument("--dips", action="store_true",
                    help="also report shallow local minima, for run-through commas")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    env = envelope(args.audio)
    g = gaps(env, args.threshold, args.min_gap)
    d = dips(env, args.threshold) if args.dips else []
    total = round(len(env) * 0.01, 3)

    if args.json:
        print(json.dumps({"duration": total, "gaps": g, "dips": d}, indent=2))
        return

    print(f"{args.audio}  duration {total}s  threshold {args.threshold} dBFS\n")
    print(f"{'start':>8} {'end':>8} {'len':>6} {'floor':>7}   phrase boundary")
    prev_end = 0.0
    for x in g:
        print(f"{x['start']:8.2f} {x['end']:8.2f} {x['length']:6.2f} {x['floor']:7.1f}"
              f"   speech {prev_end:.2f} -> {x['start']:.2f} "
              f"({x['start'] - prev_end:.2f}s)")
        prev_end = x["end"]
    if prev_end < total:
        print(f"{'':8} {'':8} {'':6} {'':7}   speech {prev_end:.2f} -> "
              f"{total:.2f} ({total - prev_end:.2f}s)")
    print(f"\n{len(g)} gaps. Match each one to a comma or period in the script "
          f"before trusting them.")
    if d:
        print("\nshallow dips (no full gap; candidate soft boundaries):")
        for x in d:
            print(f"{x['at']:8.2f} {'':8} {'':6} {x['floor']:7.1f}")


if __name__ == "__main__":
    main()
