#!/usr/bin/env python3
"""permute-vo.py -- reorder clauses in a voiceover without retiming or regenerating it.

Use this only when the narration lists things in a different order than the
recording performs them AND the conflicting clauses are a list, because a list is
order free in meaning. Never apply it unasked. Propose the exact new sentence,
get approval, then run this.

Because the output is a pure permutation of adjacent spans covering the whole
file, total duration is preserved exactly and no speech is resampled, retimed, or
regenerated. Only the order changes.

Usage:
    ./permute-vo.py in.mp3 out.mp3 \
        --span 0:19.465 --span 19.465:20.920 --span 20.920:22.455 \
        --span 22.455:25.200 --span 25.200: \
        --order 1,4,3,2,5

    ./permute-vo.py in.mp3 out.mp3 --spec spans.txt --order 1,4,3,2,5
    ./permute-vo.py in.mp3 out.mp3 ... --dry-run      print the filtergraph only

Rules that make it work:

  * Split only at boundaries measured by vo-phrase-boundaries.py, and only where
    the floor is deep. -49 dB or below is comfortable.
  * Leave a trailing conjunction attached to the clause it precedes, so the
    grammar survives the move. "lowering the stair profile, or" travels as one
    span.
  * Spans must be adjacent and cover the whole file, or the duration changes.
  * asetpts=N/SR/TB after each atrim is required or concat mis-stacks timestamps.
  * An 8 ms fade at each cut edge kills clicks without changing length.

Verify afterward by re-transcribing the output. It should come back as one clean
sentence in the intended order with the same word count. A recogniser that has no
trouble with the joins is good evidence they are inaudible. Also check by ear:
moving a list-final clause, which carries falling intonation, into first position
can sound odd even when the splice is clean.
"""

import argparse
import subprocess
import sys

FADE = 0.008


def duration(path):
    return float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())


def parse_spans(items, total):
    spans = []
    for raw in items:
        a, _, b = raw.partition(":")
        start = float(a) if a.strip() else 0.0
        end = float(b) if b.strip() else total
        spans.append((start, end))
    return spans


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("infile")
    ap.add_argument("outfile")
    ap.add_argument("--span", action="append", default=[],
                    help="START:END in seconds; repeat, in original order. "
                         "Omit END on the last span to run to the tail.")
    ap.add_argument("--spec", help="file with one START:END per line, '#' comments ok")
    ap.add_argument("--order", required=True,
                    help="1-based span order for the output, e.g. 1,4,3,2,5")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    total = duration(args.infile)

    raw = list(args.span)
    if args.spec:
        with open(args.spec) as fh:
            raw += [ln.strip() for ln in fh
                    if ln.strip() and not ln.strip().startswith("#")]
    if not raw:
        sys.exit("no spans given")

    spans = parse_spans(raw, total)

    # Adjacency and coverage. A gap or overlap changes the duration silently.
    if abs(spans[0][0]) > 1e-6:
        sys.exit(f"first span must start at 0, got {spans[0][0]}")
    if abs(spans[-1][1] - total) > 0.02:
        sys.exit(f"last span must end at {total:.3f}, got {spans[-1][1]:.3f}")
    for (_, e), (s, _) in zip(spans, spans[1:]):
        if abs(e - s) > 1e-6:
            sys.exit(f"spans must be adjacent: {e:.3f} then {s:.3f}")

    order = [int(x) for x in args.order.split(",")]
    if sorted(order) != list(range(1, len(spans) + 1)):
        sys.exit(f"--order must be a permutation of 1..{len(spans)}")

    parts, labels = [], []
    for pos, idx in enumerate(order):
        s, e = spans[idx - 1]
        seg = e - s
        lab = f"p{idx}"
        labels.append(f"[{lab}]")
        trim = f"atrim={s}:{e}" if idx != len(spans) else f"atrim={s}"
        fades = []
        if pos > 0:
            fades.append(f"afade=t=in:d={FADE}")
        if pos < len(order) - 1:
            fades.append(f"afade=t=out:st={seg - FADE:.3f}:d={FADE}")
        chain = ",".join([trim, "asetpts=N/SR/TB"] + fades)
        parts.append(f"[0:a]{chain}[{lab}]")

    graph = ";\n ".join(parts) + \
        f";\n {''.join(labels)}concat=n={len(order)}:v=0:a=1[out]"

    cmd = ["ffmpeg", "-y", "-v", "error", "-i", args.infile,
           "-filter_complex", graph, "-map", "[out]",
           "-c:a", "libmp3lame", "-q:a", "2", args.outfile]

    if args.dry_run:
        print(graph)
        return

    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(p.stderr[:800])

    got = duration(args.outfile)
    print(f"wrote {args.outfile}")
    print(f"in {total:.3f}s  out {got:.3f}s  delta {got - total:+.3f}s")
    if abs(got - total) > 0.05:
        print("WARNING duration changed. The spans probably do not cover the file.")
    print("\nNow re-transcribe the output and confirm the word count is unchanged "
          "and the sentence reads in the intended order.")


if __name__ == "__main__":
    main()
