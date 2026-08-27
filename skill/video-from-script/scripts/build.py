"""Turns cut.json into the three things a run hands over.

- index.html            the HyperFrames composition, a tight contiguous cut
- review.html           the approval page, played in the browser off the uncut sources
- skeleton-manifest.json + skeleton-notes.md   what the next two skills need to know

Timeline placement lives here. align.py works only in source coordinates.
"""

import argparse
import json
import sys
from pathlib import Path


TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"

DEFAULT_OPTIONS = {
    "title": "Video skeleton",
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "audio_only": False,
    "media_prefix": "",
    "target_runtime_s": None,
}

GAP_EXPLANATIONS = {
    "no_footage": "No recording was found for this speaker, so the beat has nothing under it yet.",
    "below_threshold": "Nothing in the recording matched this beat closely enough to use.",
}

MANIFEST_NOTE = (
    "Describes the skeleton and what the plan asked for at each beat. Nothing here binds "
    "video-b-roll or video-branding; depart from it wherever the material is better served."
)


def _resolve_options(options):
    resolved = dict(DEFAULT_OPTIONS)
    if options:
        resolved.update({key: value for key, value in options.items() if value is not None})
    return resolved


def _seconds(milliseconds):
    return f"{milliseconds / 1000:.3f}"


def place_timeline(cut):
    placements = []
    timeline_ms = 0

    for beat in cut["beats"]:
        if beat["status"] != "matched":
            continue
        for number, source_range in enumerate(beat["ranges"], start=1):
            duration_ms = source_range["end_ms"] - source_range["start_ms"]
            placements.append(
                {
                    "beat": beat["number"],
                    "clip": number,
                    "speaker": beat["speaker"],
                    "source": beat["source"],
                    "timeline_start_ms": timeline_ms,
                    "duration_ms": duration_ms,
                    "media_start_ms": source_range["start_ms"],
                }
            )
            timeline_ms += duration_ms

    return placements


def internal_jump_cuts(cut, placements):
    jumps = []

    for beat in cut["beats"]:
        if beat["status"] != "matched" or len(beat["ranges"]) < 2:
            continue

        beat_placements = [placement for placement in placements if placement["beat"] == beat["number"]]
        for index, source_range in enumerate(beat["ranges"][:-1]):
            gap_start = source_range["end_ms"]
            gap_end = beat["ranges"][index + 1]["start_ms"]
            overlapping = [
                entry
                for entry in beat["cuts"]
                if entry["start_ms"] < gap_end and entry["end_ms"] > gap_start
            ]
            reason = overlapping[0]["reason"] if overlapping else "unexplained"
            jumps.append(
                {
                    "timeline_ms": beat_placements[index + 1]["timeline_start_ms"],
                    "beat": beat["number"],
                    "speaker": beat["speaker"],
                    "reason": reason,
                    "text": overlapping[0]["text"] if overlapping else "",
                    "wants_cover": True,
                }
            )

    return jumps


def _media_element(placement, options):
    start = _seconds(placement["timeline_start_ms"])
    duration = _seconds(placement["duration_ms"])
    media_start = _seconds(placement["media_start_ms"])
    source = f"{options['media_prefix']}{placement['source']}"
    element_id = f"beat{placement['beat']}-clip{placement['clip']}"

    lines = []
    if not options["audio_only"]:
        lines.append(
            f'      <video id="{element_id}" src="{source}" data-start="{start}" '
            f'data-duration="{duration}" data-media-start="{media_start}" '
            f'data-track-index="0" muted playsinline preload="auto"></video>'
        )
    lines.append(
        f'      <audio id="{element_id}-audio" src="{source}" data-start="{start}" '
        f'data-duration="{duration}" data-media-start="{media_start}" '
        f'data-track-index="1"></audio>'
    )
    return "\n".join(lines)


def link_media(placements, project, media_dir):
    """Symlink the media directory into the project under its own root-relative name.

    HyperFrames serves a composition with the project root as its base URL and
    rejects "../" in asset paths (invalid_parent_traversal_in_asset_path), so the
    media has to be reachable without traversal. A symlink keeps one canonical
    copy in the shared workspace while making the project self-contained.
    """
    project = Path(project)
    target = Path(media_dir).resolve()
    created = []

    for name in {Path(placement["source"]).parts[0] for placement in placements}:
        link = project / name
        if link.exists() or link.is_symlink():
            continue
        link.symlink_to(target, target_is_directory=True)
        created.append(name)

    return created


def unresolved_media(placements, project, options=None):
    """Source paths the composition references but that do not exist on disk.

    The composition and the review page both resolve media relative to their own
    directory, so a forgotten --media-prefix produces a silent black render.
    """
    options = _resolve_options(options)
    project = Path(project)
    missing = set()

    for source in {placement["source"] for placement in placements}:
        if not (project / f"{options['media_prefix']}{source}").exists():
            missing.add(f"{options['media_prefix']}{source}")

    return sorted(missing)


def render_composition(cut, placements, options=None):
    options = _resolve_options(options)
    template = (TEMPLATE_DIR / "composition-template.html").read_text()
    media = "\n".join(_media_element(placement, options) for placement in placements)

    return (
        template.replace("{{TITLE}}", options["title"])
        .replace("{{WIDTH}}", str(options["width"]))
        .replace("{{HEIGHT}}", str(options["height"]))
        .replace("{{FPS}}", str(options["fps"]))
        .replace("{{DURATION}}", _seconds(cut["runtime_ms"]))
        .replace("{{MEDIA}}", media)
    )


def _gap_explanation(beat):
    for flag in beat["flags"]:
        if flag in GAP_EXPLANATIONS:
            return GAP_EXPLANATIONS[flag]
    return "This beat could not be matched against the footage."


def _alternates(beat):
    alternates = []
    for index, attempt in enumerate(beat["attempts"]):
        if index == beat["selected_attempt"]:
            continue
        words = attempt["spoken"].split()
        alternates.append(
            {
                "number": attempt["number"],
                "words": len(words),
                "preview": " ".join(words[:12]) + ("..." if len(words) > 12 else ""),
            }
        )
    return alternates


def review_payload(cut, placements, options=None):
    options = _resolve_options(options)
    beats = []

    for beat in cut["beats"]:
        entry = {
            "number": beat["number"],
            "label": beat["label"],
            "speaker": beat["speaker"],
            "status": beat["status"],
            "script": beat["script"],
            "duration_s": round(beat["duration_ms"] / 1000, 2),
            "reading": beat["reading"],
            "removed": [
                {
                    "reason": entry["reason"],
                    "text": entry["text"],
                    "seconds": round((entry["end_ms"] - entry["start_ms"]) / 1000, 1),
                }
                for entry in beat["cuts"]
            ],
            "alternates": _alternates(beat),
            "needs_a_look": bool(beat["flags"]) or len(beat["attempts"]) > 1,
            "gap_explanation": "" if beat["status"] == "matched" else _gap_explanation(beat),
        }
        beats.append(entry)

    clips = [
        {
            "beat": placement["beat"],
            "source": f"{options['media_prefix']}{placement['source']}",
            "start_s": round(placement["media_start_ms"] / 1000, 3),
            "end_s": round((placement["media_start_ms"] + placement["duration_ms"]) / 1000, 3),
        }
        for placement in placements
    ]

    return {
        "runtime_s": round(cut["runtime_ms"] / 1000, 2),
        "target_runtime_s": options["target_runtime_s"],
        "audio_only": options["audio_only"],
        "clips": clips,
        "beats": beats,
    }


def render_review(payload, options=None):
    options = _resolve_options(options)
    template = (TEMPLATE_DIR / "review-template.html").read_text()
    data = json.dumps(payload, indent=2).replace("</", "<\\/")

    return template.replace("{{TITLE}}", options["title"]).replace("{{DATA}}", data)


def build_manifest(cut, placements, options=None):
    options = _resolve_options(options)
    target_runtime_ms = (
        int(options["target_runtime_s"] * 1000) if options["target_runtime_s"] is not None else None
    )

    beats = []
    for beat in cut["beats"]:
        beat_placements = [placement for placement in placements if placement["beat"] == beat["number"]]
        beats.append(
            {
                "number": beat["number"],
                "label": beat["label"],
                "speaker": beat["speaker"],
                "status": beat["status"],
                "source": beat["source"],
                "timeline_start_ms": beat_placements[0]["timeline_start_ms"] if beat_placements else None,
                "timeline_end_ms": (
                    beat_placements[-1]["timeline_start_ms"] + beat_placements[-1]["duration_ms"]
                    if beat_placements
                    else None
                ),
                "clips": len(beat_placements),
                "plan": beat["plan"],
            }
        )

    return {
        "binding": False,
        "note": MANIFEST_NOTE,
        "runtime_ms": cut["runtime_ms"],
        "target_runtime_ms": target_runtime_ms,
        "runtime_delta_ms": (
            cut["runtime_ms"] - target_runtime_ms if target_runtime_ms is not None else None
        ),
        "beats": beats,
        "jump_cuts": internal_jump_cuts(cut, placements),
        "gaps": [
            {
                "number": beat["number"],
                "label": beat["label"],
                "speaker": beat["speaker"],
                "script": beat["script"],
                "reason": _gap_explanation(beat),
            }
            for beat in cut["beats"]
            if beat["status"] != "matched"
        ],
        "parked": cut["parked"],
    }


def render_notes(manifest, options=None):
    options = _resolve_options(options)
    lines = [
        f"# Skeleton notes: {options['title']}",
        "",
        MANIFEST_NOTE,
        "",
        f"Assembled runtime: {manifest['runtime_ms'] / 1000:.1f}s",
    ]

    if manifest["target_runtime_ms"] is not None:
        delta = manifest["runtime_delta_ms"] / 1000
        direction = "over" if delta > 0 else "under"
        lines.append(
            f"Plan target: {manifest['target_runtime_ms'] / 1000:.1f}s "
            f"({abs(delta):.1f}s {direction})"
        )

    lines += ["", "## Beats", ""]
    for beat in manifest["beats"]:
        if beat["status"] != "matched":
            lines.append(f"- Beat {beat['number']} ({beat['speaker']}): no footage placed")
            continue
        lines.append(
            f"- Beat {beat['number']} ({beat['speaker']}): "
            f"{beat['timeline_start_ms'] / 1000:.1f}s to {beat['timeline_end_ms'] / 1000:.1f}s, "
            f"{beat['clips']} clip(s)"
        )
        for key, value in beat["plan"].items():
            if value and value != "none":
                lines.append(f"  - plan wanted {key.replace('_', ' ')}: {value}")

    if manifest["jump_cuts"]:
        lines += ["", "## Jump cuts wanting cover", ""]
        for jump in manifest["jump_cuts"]:
            detail = f' ("{jump["text"]}")' if jump["text"] else ""
            lines.append(
                f"- {jump['timeline_ms'] / 1000:.1f}s, beat {jump['beat']}, "
                f"{jump['reason'].replace('_', ' ')}{detail}"
            )

    if manifest["gaps"]:
        lines += ["", "## Missing beats", ""]
        for gap in manifest["gaps"]:
            lines.append(f"- Beat {gap['number']} ({gap['speaker']}): {gap['reason']}")

    if manifest["parked"]:
        lines += ["", "## Parked footage", ""]
        for region in manifest["parked"]:
            lines.append(
                f"- {region['speaker']}, {region['start_ms'] / 1000:.1f}s to "
                f"{region['end_ms'] / 1000:.1f}s, {region['word_count']} words"
            )

    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the skeleton composition, review page, and manifest")
    parser.add_argument("--cut", required=True, help="cut.json from align.py")
    parser.add_argument("--project", required=True, help="project directory to write into")
    parser.add_argument("--title", help="video title for the composition and review page")
    parser.add_argument("--target-runtime", type=float, help="runtime the plan targeted, in seconds")
    parser.add_argument("--fps", type=int, help="frame rate hint for the composition")
    parser.add_argument("--width", type=int, help="canvas width")
    parser.add_argument("--height", type=int, help="canvas height")
    parser.add_argument("--audio-only", action="store_true", help="emit audio clips with no video")
    parser.add_argument("--media-prefix", help="path prefix for source files, relative to the composition")
    parser.add_argument(
        "--link-media",
        help="media directory to symlink into the project so paths stay root-relative",
    )
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    arguments = parser.parse_args(argv)

    cut = json.loads(Path(arguments.cut).read_text())
    options = {
        "title": arguments.title,
        "fps": arguments.fps,
        "width": arguments.width,
        "height": arguments.height,
        "audio_only": arguments.audio_only or None,
        "media_prefix": arguments.media_prefix,
        "target_runtime_s": arguments.target_runtime,
    }

    placements = place_timeline(cut)
    manifest = build_manifest(cut, placements, options)

    project = Path(arguments.project)
    if arguments.link_media and not arguments.dry_run:
        for name in link_media(placements, project, arguments.link_media):
            print(f"linked {name} -> {Path(arguments.link_media).resolve()}")

    missing = unresolved_media(placements, project, options)
    if missing:
        print(
            f"warning: {len(missing)} media path(s) do not resolve from {project}; "
            f"check --media-prefix",
            file=sys.stderr,
        )
        for path in missing:
            print(f"  missing: {path}", file=sys.stderr)
    outputs = {
        project / "index.html": render_composition(cut, placements, options),
        project / "review.html": render_review(review_payload(cut, placements, options), options),
        project / "skeleton-manifest.json": json.dumps(manifest, indent=2),
        project / "skeleton-notes.md": render_notes(manifest, options),
    }

    print(f"{len(placements)} clips, {manifest['runtime_ms'] / 1000:.1f}s assembled")
    if manifest["jump_cuts"]:
        print(f"{len(manifest['jump_cuts'])} jump cut(s) recorded as wanting cover")
    for gap in manifest["gaps"]:
        print(f"  beat {gap['number']} ({gap['speaker']}) has no footage", file=sys.stderr)

    if arguments.dry_run:
        return 0

    for path, contents in outputs.items():
        path.write_text(contents)
    print(f"wrote {', '.join(path.name for path in outputs)} to {project}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
