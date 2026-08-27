# Alignment

How `align.py` decides which take of each beat to use and where to cut it. Source domain only: every time it emits is a position inside a source file. Timeline placement is `build.py`'s job.

Because the plan maps each beat to one speaker, alignment searches only that speaker's transcript for that beat's text. This collapses the search space and is the main reason matching is tractable.

## The passes

**1. Tokenize.** Both the beat's script and the transcript become token lists. Case and punctuation are stripped, apostrophes are removed so `wasn't` becomes `wasnt`, and spelled-out numbers are normalized so `four steps` matches `4 steps`. Contractions are kept as written because that is how people speak.

**2. Find anchor runs.** Every place where at least `min_anchor` consecutive tokens of the script appear in the transcript, extended to its maximal length and deduplicated. Note that `difflib.SequenceMatcher.get_matching_blocks` is the wrong tool here: it finds one best alignment, so with three attempts at a beat it matches one of them and hides the other two.

**3. Cluster runs into attempts.** Runs are sorted by transcript position. A new attempt starts when the script position jumps backwards relative to where the previous run ended, which is what a restart looks like, or when runs are separated by more than `attempt_gap_words`.

**4. Score each attempt.** Coverage is the fraction of script tokens matched. An attempt is complete when its furthest matched token reaches within `tail_slack` of the end of the script.

**5. Select.** The last attempt that clears `coverage_threshold` **and** is complete.

Completeness is doing real work in that sentence. People restart and then trail off, so the final attempt is often a fragment. A plain last-take rule takes the fragment. Requiring completeness takes the last good one and flags `trailing_abandoned_take` so the choice is visible.

**6. Refine boundaries.** The in point moves back into the preceding silence by up to `boundary_pad_s`, never taking more than half of what is available, so a tight recording start cannot produce a negative in point. The out point does the same forwards, then clamps to the media duration when one is known.

**7. Clean within the take.** Repeated runs drop their earlier occurrence. Filler words drop. Inter-word gaps over `max_gap_s` split the beat into separate ranges, which is what removes dead air. Every removal is recorded with a reason and appears struck through on the review page.

## Configuration

| Key | Default | What it controls |
| --- | --- | --- |
| `coverage_threshold` | 0.70 | How much of the script an attempt must match to be usable |
| `close_call_margin` | 0.05 | Coverage difference below which two attempts are called too close |
| `max_gap_s` | 0.6 | Silence longer than this is trimmed and splits the beat |
| `boundary_pad_s` | 0.12 | Silence kept on each side of a cut |
| `min_anchor` | 3 | Consecutive matching tokens needed to anchor |
| `restart_slack` | 2 | Backwards jitter tolerated before calling it a restart |
| `attempt_gap_words` | 25 | Transcript words allowed between runs of one attempt |
| `max_repeat_run` | 8 | Longest repeated phrase detected |
| `tail_slack` | 3 | Tokens from the end that still count as reaching it |
| `min_parked_words` | 5 | Shortest unused stretch worth parking |
| `fillers` | `um uh uhm erm er ah hmm` | Single tokens removed on sight |

These defaults are starting points chosen before real footage existed. Expect to tune `coverage_threshold` and `max_gap_s` against the first real recording.

`fillers` deliberately excludes "you know" and "I mean". Both appear as meaningful speech often enough that removing them would change what someone said. Add them per beat if a particular speaker leans on them.

Immediate single-word duplication is removed, so "is is" becomes "is". This does mean deliberate emphasis such as "very very" is removed too. That is the accepted cost of aggressive cleanup, and it is recoverable because the review page shows it struck through.

## Flags

| Flag | Meaning |
| --- | --- |
| `close_call` | Two qualifying attempts scored within the margin |
| `trailing_abandoned_take` | A later attempt existed but was incomplete |
| `no_complete_take` | Something matched but nothing reached the end of the beat |
| `below_threshold` | Nothing matched well enough; the beat is a gap |
| `no_footage` | No transcript for that speaker; every beat they carry is a gap |
| `forced_by_you` | Selection came from `overrides.json`, not from scoring |
| `override_ignored` | A forced attempt number does not exist |

`below_threshold` and `no_footage` look identical to a wrong speaker mapping. Check the mapping before touching thresholds.

## Overrides

`overrides.json` accumulates decisions so they are never re-litigated. Global config, per-beat config, and forced selection:

```json
{
  "config": { "max_gap_s": 0.45 },
  "beats": {
    "3": { "attempt": 2 },
    "1": { "config": { "fillers": [] } }
  }
}
```

Beat keys are strings. `attempt` is the 1-based attempt number as shown on the review page. Per-beat config merges over global config and applies to that beat alone.

## Parked footage

Any unused stretch of at least `min_parked_words` is recorded with its text and position. Nothing is deleted. Parked material is how a good unscripted line survives long enough for someone to decide to use it.

## Output

`cut.json` carries, per beat: every attempt with its score, the selection, the kept ranges, every cut with its reason, a `reading` that segments the take into kept and removed runs for the review page, and the plan intent passed through untouched.
