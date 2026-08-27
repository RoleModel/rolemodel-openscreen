"""Behavior specification for build.py."""

import re
import tempfile
import unittest
from pathlib import Path

from align import align_beats
from build import (
    build_manifest,
    link_media,
    internal_jump_cuts,
    place_timeline,
    render_composition,
    render_review,
    review_payload,
    unresolved_media,
)
from fixtures.transcript_builder import build_words, join_takes
from test_align import BEAT_1, BEAT_1_SCRIPT


BEAT_2_SCRIPT = "Time wasn't the only problem. It was that we didn't have a plan or process."

BEAT_2 = {
    "number": 2,
    "label": "Belief 1: the plan creates consistency up front",
    "speaker": "Jamey Meeker",
    "script": BEAT_2_SCRIPT,
    "plan": {"on_screen": "/video-plan", "screen_recording": "REC A", "b_roll": ""},
}

BEAT_1_WITH_PLAN = dict(
    BEAT_1,
    plan={"on_screen": "Title card", "screen_recording": "none", "b_roll": "team collaboration, around 0:16"},
)


def two_speaker_cut(beat_1_pauses=None):
    return align_beats(
        [BEAT_1_WITH_PLAN, BEAT_2],
        {
            "Blaine Irvin": {
                "source": "source/blaine.mp4",
                "words": build_words(BEAT_1_SCRIPT, pauses=beat_1_pauses),
            },
            "Jamey Meeker": {
                "source": "source/jamey.mp4",
                "words": build_words(BEAT_2_SCRIPT),
            },
        },
    )


def clip_attributes(markup, tag):
    return [
        dict(re.findall(r'([\w-]+)="([^"]*)"', element))
        for element in re.findall(rf"<{tag}\b[^>]*>", markup)
    ]


class TimelineTest(unittest.TestCase):
    def test_timeline_starts_at_zero_and_stays_contiguous(self):
        placements = place_timeline(two_speaker_cut())

        self.assertEqual(placements[0]["timeline_start_ms"], 0)
        for previous, current in zip(placements, placements[1:]):
            self.assertEqual(
                current["timeline_start_ms"],
                previous["timeline_start_ms"] + previous["duration_ms"],
            )

    def test_gap_beats_consume_no_timeline_time(self):
        cut = align_beats(
            [BEAT_1_WITH_PLAN, BEAT_2],
            {"Blaine Irvin": {"source": "source/blaine.mp4", "words": build_words(BEAT_1_SCRIPT)}},
        )
        placements = place_timeline(cut)

        self.assertTrue(all(placement["beat"] == 1 for placement in placements))
        self.assertEqual(
            sum(placement["duration_ms"] for placement in placements),
            cut["beats"][0]["duration_ms"],
        )

    def test_media_start_carries_the_source_offset(self):
        cut = two_speaker_cut()
        placements = place_timeline(cut)
        first_range = cut["beats"][0]["ranges"][0]

        self.assertEqual(placements[0]["media_start_ms"], first_range["start_ms"])

    def test_a_split_beat_produces_two_placements(self):
        placements = place_timeline(two_speaker_cut(beat_1_pauses={20: 2.0}))
        beat_1 = [placement for placement in placements if placement["beat"] == 1]

        self.assertEqual(len(beat_1), 2)


class CompositionTest(unittest.TestCase):
    def setUp(self):
        self.cut = two_speaker_cut(beat_1_pauses={20: 2.0})
        self.placements = place_timeline(self.cut)
        self.markup = render_composition(self.cut, self.placements)

    def test_each_range_becomes_a_paired_video_and_audio_element(self):
        self.assertEqual(len(clip_attributes(self.markup, "video")), len(self.placements))
        self.assertEqual(len(clip_attributes(self.markup, "audio")), len(self.placements))

    def test_media_elements_carry_ids_and_never_the_clip_class(self):
        for tag in ("video", "audio"):
            for element in clip_attributes(self.markup, tag):
                self.assertIn("id", element)
                self.assertNotIn("class", element)
                self.assertIn("data-start", element)
                self.assertIn("data-duration", element)
                self.assertIn("data-media-start", element)

    def test_video_elements_are_muted_so_audio_is_mixed_from_its_own_track(self):
        self.assertEqual(self.markup.count(" muted"), len(self.placements))

    def test_root_duration_matches_the_assembled_runtime(self):
        expected = f"{self.cut['runtime_ms'] / 1000:.3f}"

        self.assertIn(f'data-duration="{expected}"', self.markup)

    def test_adjacent_clips_share_an_exact_decimal_boundary(self):
        elements = clip_attributes(self.markup, "video")
        for previous, current in zip(elements, elements[1:]):
            boundary = float(previous["data-start"]) + float(previous["data-duration"])
            self.assertEqual(current["data-start"], f"{boundary:.3f}")

    def test_every_time_is_written_to_three_decimals(self):
        for element in clip_attributes(self.markup, "video"):
            for attribute in ("data-start", "data-duration", "data-media-start"):
                self.assertRegex(element[attribute], r"^\d+\.\d{3}$")

    def test_audio_only_project_emits_no_video_elements(self):
        markup = render_composition(self.cut, self.placements, {"audio_only": True})

        self.assertEqual(clip_attributes(markup, "video"), [])
        self.assertEqual(len(clip_attributes(markup, "audio")), len(self.placements))

    def test_root_declares_no_timeline(self):
        # A skeleton has no animation, so nothing registers window.__timelines.
        # Without this attribute lint fails and every render polls 45s for one.
        self.assertIn("data-no-timeline", self.markup)

    def test_rendered_composition_leaves_no_placeholders(self):
        self.assertNotIn("{{", self.markup)


class JumpCutTest(unittest.TestCase):
    def test_internal_jump_cuts_are_reported_with_a_reason(self):
        cut = two_speaker_cut(beat_1_pauses={20: 2.0})
        placements = place_timeline(cut)
        jumps = internal_jump_cuts(cut, placements)

        self.assertEqual(len(jumps), 1)
        self.assertEqual(jumps[0]["beat"], 1)
        self.assertEqual(jumps[0]["reason"], "long_pause")

    def test_beat_handoffs_are_not_reported_as_jump_cuts(self):
        cut = two_speaker_cut()
        placements = place_timeline(cut)

        self.assertEqual(internal_jump_cuts(cut, placements), [])

    def test_a_jump_cut_lands_where_the_next_clip_starts(self):
        cut = two_speaker_cut(beat_1_pauses={20: 2.0})
        placements = place_timeline(cut)
        jumps = internal_jump_cuts(cut, placements)
        second_clip = [placement for placement in placements if placement["beat"] == 1][1]

        self.assertEqual(jumps[0]["timeline_ms"], second_clip["timeline_start_ms"])


class ManifestTest(unittest.TestCase):
    def test_manifest_carries_plan_intent_per_beat(self):
        cut = two_speaker_cut()
        manifest = build_manifest(cut, place_timeline(cut))
        beat_1 = next(beat for beat in manifest["beats"] if beat["number"] == 1)

        self.assertEqual(beat_1["plan"]["b_roll"], "team collaboration, around 0:16")
        self.assertEqual(beat_1["plan"]["screen_recording"], "none")

    def test_manifest_records_gaps_with_the_script_that_is_missing(self):
        cut = align_beats(
            [BEAT_1_WITH_PLAN, BEAT_2],
            {"Blaine Irvin": {"source": "source/blaine.mp4", "words": build_words(BEAT_1_SCRIPT)}},
        )
        manifest = build_manifest(cut, place_timeline(cut))

        self.assertEqual([gap["number"] for gap in manifest["gaps"]], [2])
        self.assertIn("Time wasn't", manifest["gaps"][0]["script"])

    def test_manifest_reports_the_runtime_delta_against_the_plan(self):
        cut = two_speaker_cut()
        manifest = build_manifest(cut, place_timeline(cut), {"target_runtime_s": 150})

        self.assertEqual(manifest["target_runtime_ms"], 150000)
        self.assertEqual(manifest["runtime_delta_ms"], manifest["runtime_ms"] - 150000)

    def test_manifest_marks_itself_as_not_binding_on_later_steps(self):
        cut = two_speaker_cut()
        manifest = build_manifest(cut, place_timeline(cut))

        self.assertFalse(manifest["binding"])

    def test_manifest_keeps_parked_footage(self):
        aside = "Honestly I have no idea whether any of this is going to work at all."
        words, _bounds = join_takes([BEAT_1_SCRIPT, aside])
        cut = align_beats(
            [BEAT_1_WITH_PLAN],
            {"Blaine Irvin": {"source": "source/blaine.mp4", "words": words}},
        )
        manifest = build_manifest(cut, place_timeline(cut))

        self.assertTrue(manifest["parked"])


class MediaResolutionTest(unittest.TestCase):
    def test_missing_media_is_reported(self):
        cut = two_speaker_cut()
        missing = unresolved_media(place_timeline(cut), "/nowhere-that-exists")

        self.assertEqual(missing, ["source/blaine.mp4", "source/jamey.mp4"])

    def test_media_that_resolves_reports_nothing(self):
        cut = two_speaker_cut()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "skeleton").mkdir()
            (root / "source").mkdir()
            for name in ("blaine.mp4", "jamey.mp4"):
                (root / "source" / name).write_bytes(b"")

            missing = unresolved_media(
                place_timeline(cut), root / "skeleton", {"media_prefix": "../"}
            )

        self.assertEqual(missing, [])


class MediaLinkTest(unittest.TestCase):
    def test_linking_makes_media_resolve_without_traversal(self):
        cut = two_speaker_cut()
        placements = place_timeline(cut)

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            media = workspace / "source"
            media.mkdir()
            for name in ("blaine.mp4", "jamey.mp4"):
                (media / name).write_bytes(b"")
            project = workspace / "skeleton"
            project.mkdir()

            created = link_media(placements, project, media)

            self.assertEqual(created, ["source"])
            self.assertTrue((project / "source").is_symlink())
            self.assertEqual(unresolved_media(placements, project), [])

    def test_linking_twice_is_a_no_op(self):
        cut = two_speaker_cut()
        placements = place_timeline(cut)

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "source").mkdir()
            project = workspace / "skeleton"
            project.mkdir()

            link_media(placements, project, workspace / "source")
            self.assertEqual(link_media(placements, project, workspace / "source"), [])

    def test_composition_references_media_without_parent_traversal(self):
        cut = two_speaker_cut()
        markup = render_composition(cut, place_timeline(cut))

        self.assertNotIn("../", markup)


class ReviewTest(unittest.TestCase):
    def test_payload_carries_the_reading_and_what_was_removed(self):
        cut = two_speaker_cut(beat_1_pauses={20: 2.0})
        payload = review_payload(cut, place_timeline(cut))
        beat_1 = next(beat for beat in payload["beats"] if beat["number"] == 1)

        self.assertTrue(beat_1["reading"])
        self.assertEqual([entry["reason"] for entry in beat_1["removed"]], ["long_pause"])
        self.assertEqual(beat_1["removed"][0]["seconds"], 2.1)

    def test_payload_lists_other_attempts_as_alternates(self):
        words, _bounds = join_takes([BEAT_1_SCRIPT, BEAT_1_SCRIPT])
        cut = align_beats(
            [BEAT_1_WITH_PLAN],
            {"Blaine Irvin": {"source": "source/blaine.mp4", "words": words}},
        )
        payload = review_payload(cut, place_timeline(cut))
        beat_1 = payload["beats"][0]

        self.assertEqual(len(beat_1["alternates"]), 1)
        self.assertEqual(beat_1["alternates"][0]["number"], 1)
        self.assertTrue(beat_1["needs_a_look"])

    def test_payload_explains_a_gap_in_plain_language(self):
        cut = align_beats(
            [BEAT_1_WITH_PLAN, BEAT_2],
            {"Blaine Irvin": {"source": "source/blaine.mp4", "words": build_words(BEAT_1_SCRIPT)}},
        )
        payload = review_payload(cut, place_timeline(cut))
        beat_2 = next(beat for beat in payload["beats"] if beat["number"] == 2)

        self.assertEqual(beat_2["status"], "gap")
        self.assertIn("recording", beat_2["gap_explanation"].lower())

    def test_clips_are_expressed_in_seconds_for_the_browser_player(self):
        cut = two_speaker_cut()
        payload = review_payload(cut, place_timeline(cut))

        self.assertTrue(payload["clips"])
        for clip in payload["clips"]:
            self.assertLess(clip["start_s"], clip["end_s"])
            self.assertIn("source", clip)

    def test_rendered_review_leaves_no_placeholders_and_embeds_its_data(self):
        cut = two_speaker_cut()
        payload = review_payload(cut, place_timeline(cut))
        markup = render_review(payload, {"title": "The RoleModel Studio"})

        self.assertNotIn("{{", markup)
        self.assertIn("The RoleModel Studio", markup)
        self.assertIn('"beats"', markup)

    def test_embedded_data_cannot_break_out_of_the_script_tag(self):
        beat = dict(BEAT_1_WITH_PLAN, label="</script><script>alert(1)</script>")
        cut = align_beats(
            [beat],
            {"Blaine Irvin": {"source": "source/blaine.mp4", "words": build_words(BEAT_1_SCRIPT)}},
        )
        markup = render_review(review_payload(cut, place_timeline(cut)), {"title": "x"})

        self.assertNotIn("</script><script>alert(1)</script>", markup)


if __name__ == "__main__":
    unittest.main()
