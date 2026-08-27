"""Builds a synthetic recording whose word timings are known exactly.

Speaks each word separately with macOS `say`, measures it, and concatenates with
known silences. The transcript that comes out is ground truth rather than a
Whisper estimate, so an end-to-end run is deterministic and needs no model
download. The speech sounds staccato; this is a test fixture, not a demo.

    python3 make_smoke_fixture.py --out <dir>
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


SAMPLE_RATE = 22050
WORD_GAP_S = 0.08

BEAT_1_SCRIPT = "Creating videos takes too long so we built a process."
BEAT_2_SCRIPT = "The plan is what makes the video consistent."

SPEAKERS = {
    "Blaine Irvin": {
        "slug": "blaine",
        "voice": "Fred",
        "colour": "0x04242b",
        "utterances": [
            ("Creating videos takes too", 0.9),
            ("Creating videos takes too long so um we built a process.", 1.4),
        ],
    },
    "Jamey Meeker": {
        "slug": "jamey",
        "voice": "Daniel",
        "colour": "0x3a70b3",
        "utterances": [
            ("The plan is the plan is what makes the video consistent.", 0.0),
        ],
        "internal_pause": {"after_word": 6, "seconds": 1.8},
    },
}

BEATS = [
    {
        "number": 1,
        "label": "Open: video takes too long, so we built a process",
        "speaker": "Blaine Irvin",
        "script": BEAT_1_SCRIPT,
        "plan": {"on_screen": "Title card", "screen_recording": "none", "b_roll": "team collaboration"},
    },
    {
        "number": 2,
        "label": "Belief 1: the plan creates consistency",
        "speaker": "Jamey Meeker",
        "script": BEAT_2_SCRIPT,
        "plan": {"on_screen": "/video-plan", "screen_recording": "REC A", "b_roll": ""},
    },
]


def _run(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{command[0]} failed: {result.stderr.strip()[:400]}")
    return result


def _duration_s(path):
    result = _run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ]
    )
    return float(result.stdout.strip())


def _installed_voices():
    listing = subprocess.run(["say", "-v", "?"], capture_output=True, text=True)
    return {line.split()[0] for line in listing.stdout.splitlines() if line.split()}


def _speak(text, voice, destination):
    raw = destination.with_suffix(".aiff")
    command = ["say"]
    if voice:
        command += ["-v", voice]
    _run(command + ["-o", str(raw), text])
    _run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(raw),
            "-ac", "1", "-ar", str(SAMPLE_RATE), str(destination),
        ]
    )
    raw.unlink()
    return _duration_s(destination)


def _silence(seconds, destination):
    _run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", f"anullsrc=r={SAMPLE_RATE}:cl=mono", "-t", f"{seconds:.3f}",
            str(destination),
        ]
    )
    return _duration_s(destination)


def build_speaker(name, spec, out_dir, skeleton_dir, work_dir):
    pieces = []
    words = []
    clock = 0.0
    word_index = 0

    for utterance, lead_silence in spec["utterances"]:
        if lead_silence:
            path = work_dir / f"sil-{len(pieces)}.wav"
            clock += _silence(lead_silence, path)
            pieces.append(path)

        for position, text in enumerate(utterance.split()):
            path = work_dir / f"w-{len(pieces)}.wav"
            duration = _speak(text, spec["voice"], path)
            words.append(
                {
                    "id": f"w{word_index}",
                    "text": text,
                    "start": round(clock, 3),
                    "end": round(clock + duration, 3),
                }
            )
            word_index += 1
            clock += duration
            pieces.append(path)

            pause = spec.get("internal_pause")
            trailing = pause["seconds"] if pause and pause["after_word"] == position else WORD_GAP_S
            gap_path = work_dir / f"gap-{len(pieces)}.wav"
            clock += _silence(trailing, gap_path)
            pieces.append(gap_path)

    listing = work_dir / f"{spec['slug']}-list.txt"
    listing.write_text("".join(f"file '{piece.resolve()}'\n" for piece in pieces))

    audio = work_dir / f"{spec['slug']}.wav"
    _run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
            "-i", str(listing), "-c", "copy", str(audio),
        ]
    )

    source = out_dir / "source" / f"{spec['slug']}.mp4"
    _run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c={spec['colour']}:s=640x360:r=30",
            "-i", str(audio), "-shortest",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-g", "30", "-keyint_min", "30",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            str(source),
        ]
    )

    transcript = skeleton_dir / "transcripts" / f"{spec['slug']}.json"
    transcript.write_text(json.dumps(words, indent=2))

    return {
        "source": f"source/{spec['slug']}.mp4",
        "transcript": str(transcript.relative_to(skeleton_dir)),
        "duration_s": round(_duration_s(source), 3),
        "words": len(words),
        "seconds": round(clock, 2),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Generate a deterministic end-to-end fixture")
    parser.add_argument("--out", required=True, help="project directory to create")
    arguments = parser.parse_args(argv)

    for tool in ("say", "ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            print(f"{tool} not found; this fixture needs macOS say plus ffmpeg", file=sys.stderr)
            return 1

    out_dir = Path(arguments.out)
    skeleton_dir = out_dir / "skeleton"
    work_dir = out_dir / ".work"
    for directory in (out_dir / "source", skeleton_dir / "transcripts", work_dir):
        directory.mkdir(parents=True, exist_ok=True)

    installed = _installed_voices()
    mapping = {}
    for name, spec in SPEAKERS.items():  # noqa: PLR1702
        if spec["voice"] not in installed:
            print(f"voice {spec['voice']} not installed, using the system default", file=sys.stderr)
            spec["voice"] = None
        built = build_speaker(name, spec, out_dir, skeleton_dir, work_dir)
        mapping[name] = {
            "source": built["source"],
            "transcript": built["transcript"],
            "duration_s": built["duration_s"],
        }
        print(f"{name}: {built['words']} words, {built['seconds']}s -> {built['source']}")

    (skeleton_dir / "beats.json").write_text(json.dumps(BEATS, indent=2))
    (skeleton_dir / "transcripts.json").write_text(json.dumps(mapping, indent=2))
    shutil.rmtree(work_dir)

    print(f"fixture ready in {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
