"""Aligns a video plan's beats against word-level transcripts.

Reads beats (from a /video-plan file) plus one transcript per speaker and
decides which take of each beat to use, where to cut it, and what to flag for
a human. Emits the cut.json that build.py turns into a composition, a review
page, and a handoff manifest.

Source-domain only: every time in the output refers to a position inside a
source file. Timeline placement belongs to build.py.
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path


DEFAULT_CONFIG = {
    "coverage_threshold": 0.70,
    "close_call_margin": 0.05,
    "max_gap_s": 0.6,
    "boundary_pad_s": 0.12,
    "min_anchor": 3,
    "restart_slack": 2,
    "attempt_gap_words": 25,
    "max_repeat_run": 8,
    "tail_slack": 3,
    "min_parked_words": 5,
    "fillers": ["um", "uh", "uhm", "erm", "er", "ah", "hmm"],
}

NUMBER_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13",
    "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17",
    "eighteen": "18", "nineteen": "19", "twenty": "20", "thirty": "30",
    "forty": "40", "fifty": "50", "sixty": "60", "seventy": "70",
    "eighty": "80", "ninety": "90", "hundred": "100", "thousand": "1000",
}

TOKEN_PATTERN = re.compile(r"[a-z0-9']+")


def tokenize(text):
    tokens = []
    for match in TOKEN_PATTERN.findall(text.lower()):
        token = match.replace("'", "")
        if token:
            tokens.append(NUMBER_WORDS.get(token, token))
    return tokens


def _ms(seconds):
    return int(round(seconds * 1000))


def _word_tokens(words):
    tokens = []
    for word in words:
        candidates = tokenize(word["text"])
        tokens.append(candidates[0] if candidates else "")
    return tokens


def _resolve_config(config):
    resolved = dict(DEFAULT_CONFIG)
    if config:
        resolved.update(config)
    return resolved


def _anchor_runs(reference, transcript, config):
    anchor = min(config["min_anchor"], len(reference))
    if anchor == 0 or len(transcript) < anchor:
        return []

    positions = defaultdict(list)
    for start in range(len(transcript) - anchor + 1):
        positions[tuple(transcript[start:start + anchor])].append(start)

    runs = []
    claimed = set()
    for reference_start in range(len(reference) - anchor + 1):
        key = tuple(reference[reference_start:reference_start + anchor])
        for word_start in positions.get(key, ()):
            if (reference_start, word_start) in claimed:
                continue
            length = anchor
            while (
                reference_start + length < len(reference)
                and word_start + length < len(transcript)
                and reference[reference_start + length] == transcript[word_start + length]
            ):
                length += 1
            for offset in range(length - anchor + 1):
                claimed.add((reference_start + offset, word_start + offset))
            runs.append({"ref": reference_start, "word": word_start, "length": length})

    runs.sort(key=lambda run: (run["word"], run["ref"]))
    return runs


def _cluster_runs(runs, config):
    clusters = []
    current = []

    for run in runs:
        if current:
            previous = current[-1]
            restarted = run["ref"] + config["restart_slack"] < previous["ref"] + previous["length"]
            distant = run["word"] - (previous["word"] + previous["length"]) > config["attempt_gap_words"]
            if restarted or distant:
                clusters.append(current)
                current = []
        current.append(run)

    if current:
        clusters.append(current)
    return clusters


def find_attempts(reference_tokens, words, config=None):
    config = _resolve_config(config)
    transcript_tokens = _word_tokens(words)
    clusters = _cluster_runs(_anchor_runs(reference_tokens, transcript_tokens, config), config)

    attempts = []
    for number, cluster in enumerate(clusters, start=1):
        covered = set()
        for run in cluster:
            covered.update(range(run["ref"], run["ref"] + run["length"]))

        first_word = min(run["word"] for run in cluster)
        last_word = max(run["word"] + run["length"] - 1 for run in cluster)
        coverage = len(covered) / len(reference_tokens) if reference_tokens else 0.0
        reaches_tail = max(covered) >= len(reference_tokens) - 1 - config["tail_slack"]

        attempts.append(
            {
                "number": number,
                "first_word": first_word,
                "last_word": last_word,
                "coverage": round(coverage, 4),
                "complete": bool(reaches_tail),
                "start": words[first_word]["start"],
                "end": words[last_word]["end"],
                "spoken": " ".join(word["text"] for word in words[first_word:last_word + 1]),
            }
        )

    return attempts


def select_attempt(attempts, config=None):
    config = _resolve_config(config)
    if not attempts:
        return None, ["below_threshold"]

    flags = []
    qualified = [
        attempt
        for attempt in attempts
        if attempt["coverage"] >= config["coverage_threshold"] and attempt["complete"]
    ]

    if qualified:
        chosen = qualified[-1]
        if len(qualified) > 1:
            runner_up = qualified[-2]
            if abs(chosen["coverage"] - runner_up["coverage"]) <= config["close_call_margin"]:
                flags.append("close_call")
    else:
        chosen = max(attempts, key=lambda attempt: attempt["coverage"])
        if chosen["coverage"] < config["coverage_threshold"]:
            return None, ["below_threshold"]
        flags.append("no_complete_take")

    trailing = attempts[-1]
    if trailing is not chosen and not trailing["complete"]:
        flags.append("trailing_abandoned_take")

    return attempts.index(chosen), flags


def refine_boundaries(words, first, last, config=None, limit_ms=None):
    config = _resolve_config(config)
    pad_ms = _ms(config["boundary_pad_s"])

    first_start = _ms(words[first]["start"])
    last_end = _ms(words[last]["end"])

    preceding_end = _ms(words[first - 1]["end"]) if first > 0 else 0
    lead_ms = max(0, first_start - preceding_end)

    following_start = _ms(words[last + 1]["start"]) if last + 1 < len(words) else last_end + 2 * pad_ms
    trail_ms = max(0, following_start - last_end)

    start_ms = first_start - min(pad_ms, lead_ms // 2)
    end_ms = last_end + min(pad_ms, trail_ms // 2)
    if limit_ms is not None:
        end_ms = min(end_ms, limit_ms)

    return max(0, start_ms), end_ms


def _repeated_run_length(tokens, index, last, config):
    longest = min(config["max_repeat_run"], (last - index + 1) // 2)
    for length in range(longest, 0, -1):
        if tokens[index:index + length] == tokens[index + length:index + 2 * length]:
            return length
    return 0


def _contiguous_groups(dropped):
    groups = []
    for index in sorted(dropped):
        if groups and index == groups[-1][1] + 1 and dropped[index] == groups[-1][2]:
            groups[-1][1] = index
        else:
            groups.append([index, index, dropped[index]])
    return groups


def _dropped_words(words, first, last, config):
    tokens = _word_tokens(words)
    dropped = {}

    index = first
    while index <= last:
        repeated = _repeated_run_length(tokens, index, last, config)
        if repeated:
            for offset in range(repeated):
                dropped[index + offset] = "repeated"
            index += repeated
            continue
        if tokens[index] in config["fillers"]:
            dropped[index] = "filler"
        index += 1

    return dropped


def reading_segments(words, first, last, config=None):
    """The selected take as a reader sees it: every word, kept or struck."""
    config = _resolve_config(config)
    dropped = _dropped_words(words, first, last, config)

    segments = []
    for index in range(first, last + 1):
        reason = dropped.get(index)
        if segments and segments[-1]["reason"] == reason:
            segments[-1]["text"] += " " + words[index]["text"]
        else:
            segments.append({"text": words[index]["text"], "kept": reason is None, "reason": reason})

    return segments


def clean_ranges(words, first, last, config=None, limit_ms=None):
    config = _resolve_config(config)
    dropped = _dropped_words(words, first, last, config)

    cuts = [
        {
            "reason": reason,
            "start_ms": _ms(words[start]["start"]),
            "end_ms": _ms(words[end]["end"]),
            "text": " ".join(word["text"] for word in words[start:end + 1]),
        }
        for start, end, reason in _contiguous_groups(dropped)
    ]

    kept = [index for index in range(first, last + 1) if index not in dropped]
    if not kept:
        return [], sorted(cuts, key=lambda cut: cut["start_ms"])

    max_gap_ms = _ms(config["max_gap_s"])
    ranges = []
    segment_start = kept[0]
    previous = kept[0]

    for current in kept[1:]:
        gap_ms = _ms(words[current]["start"]) - _ms(words[previous]["end"])
        if current == previous + 1 and gap_ms > max_gap_ms:
            ranges.append(_source_range(words, segment_start, previous, config, limit_ms))
            cuts.append(
                {
                    "reason": "long_pause",
                    "start_ms": _ms(words[previous]["end"]),
                    "end_ms": _ms(words[current]["start"]),
                    "text": "",
                }
            )
            segment_start = current
        elif current != previous + 1:
            ranges.append(_source_range(words, segment_start, previous, config, limit_ms))
            segment_start = current
        previous = current

    ranges.append(_source_range(words, segment_start, previous, config, limit_ms))
    return ranges, sorted(cuts, key=lambda cut: cut["start_ms"])


def _source_range(words, first, last, config, limit_ms=None):
    start_ms, end_ms = refine_boundaries(words, first, last, config, limit_ms)
    return {"start_ms": start_ms, "end_ms": end_ms}


def _parked_regions(words, used_spans, source, speaker, config):
    used = set()
    for first, last in used_spans:
        used.update(range(first, last + 1))

    regions = []
    run = []
    for index in range(len(words)):
        if index in used:
            if len(run) >= config["min_parked_words"]:
                regions.append(_parked_region(words, run, source, speaker))
            run = []
        else:
            run.append(index)

    if len(run) >= config["min_parked_words"]:
        regions.append(_parked_region(words, run, source, speaker))
    return regions


def _parked_region(words, indexes, source, speaker):
    return {
        "source": source,
        "speaker": speaker,
        "start_ms": _ms(words[indexes[0]]["start"]),
        "end_ms": _ms(words[indexes[-1]]["end"]),
        "word_count": len(indexes),
        "text": " ".join(words[index]["text"] for index in indexes),
    }


def _beat_overrides(overrides, number):
    if not overrides:
        return {}
    return overrides.get("beats", {}).get(str(number), {})


def align_beats(beats, transcripts, config=None, overrides=None):
    base_config = _resolve_config(config)
    used_spans = defaultdict(list)
    aligned = []

    for beat in beats:
        beat_override = _beat_overrides(overrides, beat["number"])
        config = _resolve_config({**base_config, **beat_override.get("config", {})})
        speaker = beat["speaker"]
        transcript = transcripts.get(speaker)
        result = {
            "number": beat["number"],
            "label": beat.get("label", ""),
            "speaker": speaker,
            "script": beat["script"],
            "plan": beat.get("plan", {}),
            "status": "gap",
            "source": transcript["source"] if transcript else None,
            "selected_attempt": None,
            "attempts": [],
            "ranges": [],
            "cuts": [],
            "reading": [],
            "flags": [],
            "duration_ms": 0,
        }

        if not transcript:
            result["flags"] = ["no_footage"]
            aligned.append(result)
            continue

        words = transcript["words"]
        limit_ms = _ms(transcript["duration_s"]) if transcript.get("duration_s") else None
        attempts = find_attempts(tokenize(beat["script"]), words, config)
        selected, flags = select_attempt(attempts, config)

        forced = beat_override.get("attempt")
        if forced is not None:
            match = next(
                (index for index, attempt in enumerate(attempts) if attempt["number"] == forced),
                None,
            )
            if match is None:
                flags = flags + ["override_ignored"]
            else:
                selected, flags = match, ["forced_by_you"]

        result["attempts"] = attempts
        result["flags"] = flags

        if selected is None:
            aligned.append(result)
            continue

        attempt = attempts[selected]
        ranges, cuts = clean_ranges(
            words, attempt["first_word"], attempt["last_word"], config, limit_ms
        )

        result["status"] = "matched"
        result["selected_attempt"] = selected
        result["ranges"] = ranges
        result["cuts"] = cuts
        result["reading"] = reading_segments(words, attempt["first_word"], attempt["last_word"], config)
        result["duration_ms"] = sum(entry["end_ms"] - entry["start_ms"] for entry in ranges)
        used_spans[speaker].append((attempt["first_word"], attempt["last_word"]))
        aligned.append(result)

    parked = []
    for speaker, transcript in transcripts.items():
        parked.extend(
            _parked_regions(
                transcript["words"], used_spans.get(speaker, []), transcript["source"], speaker, config
            )
        )

    return {
        "beats": aligned,
        "parked": parked,
        "config": base_config,
        "runtime_ms": sum(beat["duration_ms"] for beat in aligned),
    }


def _load_transcripts(mapping_path):
    mapping_path = Path(mapping_path)
    mapping = json.loads(mapping_path.read_text())
    transcripts = {}
    for speaker, entry in mapping.items():
        transcripts[speaker] = {
            "source": entry["source"],
            "duration_s": entry.get("duration_s"),
            "words": json.loads((mapping_path.parent / entry["transcript"]).read_text()),
        }
    return transcripts


def main(argv=None):
    parser = argparse.ArgumentParser(description="Align plan beats against speaker transcripts")
    parser.add_argument("--beats", required=True, help="beats.json produced from the video plan")
    parser.add_argument("--transcripts", required=True, help="JSON mapping speaker to source and transcript paths")
    parser.add_argument("--out", required=True, help="where to write cut.json")
    parser.add_argument("--overrides", help="overrides.json of accumulated user decisions")
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    arguments = parser.parse_args(argv)

    beats = json.loads(Path(arguments.beats).read_text())
    transcripts = _load_transcripts(arguments.transcripts)
    overrides = json.loads(Path(arguments.overrides).read_text()) if arguments.overrides else None

    result = align_beats(beats, transcripts, (overrides or {}).get("config"), overrides)

    matched = sum(1 for beat in result["beats"] if beat["status"] == "matched")
    print(f"{matched}/{len(result['beats'])} beats matched, {result['runtime_ms'] / 1000:.1f}s assembled")
    for beat in result["beats"]:
        if beat["flags"]:
            print(f"  beat {beat['number']} ({beat['speaker']}): {', '.join(beat['flags'])}", file=sys.stderr)

    if not arguments.dry_run:
        Path(arguments.out).write_text(json.dumps(result, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
