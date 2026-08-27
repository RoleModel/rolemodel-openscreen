"""Behavior specification for align.py.

Fixtures use the real Beat 1 script from
marketing/drafts/ai-video-presentation-builder-video-plan.md so the tests
exercise realistic sentence length and phrasing.
"""

import unittest

from align import (
    DEFAULT_CONFIG,
    align_beats,
    clean_ranges,
    find_attempts,
    reading_segments,
    refine_boundaries,
    select_attempt,
    tokenize,
)
from fixtures.transcript_builder import build_words, join_takes


BEAT_1_SCRIPT = (
    "Our CCC Days team was myself, Dallas, Joby, Becky and Jamey, targeted at "
    "solving a real issue. Creating videos is time consuming. So we set out to "
    "build a consistent process for making video from start to finish. This "
    "video is the experiment reporting on itself."
)

BEAT_1 = {
    "number": 1,
    "label": "Open: creating video takes too long, so we built a process",
    "speaker": "Blaine Irvin",
    "script": BEAT_1_SCRIPT,
}


def transcripts_for(words, speaker="Blaine Irvin", source="source/blaine.mp4"):
    return {speaker: {"source": source, "words": words}}


def beat_result(result, number=1):
    return next(beat for beat in result["beats"] if beat["number"] == number)


class TokenizeTest(unittest.TestCase):
    def test_strips_case_and_punctuation(self):
        self.assertEqual(
            tokenize("Our CCC Days team was myself,"),
            ["our", "ccc", "days", "team", "was", "myself"],
        )

    def test_keeps_contractions_intact(self):
        self.assertEqual(tokenize("It wasn't editing."), ["it", "wasnt", "editing"])

    def test_normalizes_spelled_numbers(self):
        self.assertEqual(tokenize("Four steps."), tokenize("4 steps."))


class AttemptDiscoveryTest(unittest.TestCase):
    def test_clean_single_take_matches(self):
        words = build_words(BEAT_1_SCRIPT)
        result = align_beats([BEAT_1], transcripts_for(words))
        beat = beat_result(result)

        self.assertEqual(beat["status"], "matched")
        self.assertEqual(len(beat["attempts"]), 1)
        self.assertGreater(beat["attempts"][0]["coverage"], 0.95)
        self.assertTrue(beat["attempts"][0]["complete"])
        self.assertEqual(len(beat["ranges"]), 1)

    def test_three_complete_attempts_last_one_wins(self):
        words, boundaries = join_takes([BEAT_1_SCRIPT] * 3)
        attempts = find_attempts(tokenize(BEAT_1_SCRIPT), words, DEFAULT_CONFIG)
        selected, _flags = select_attempt(attempts, DEFAULT_CONFIG)

        self.assertEqual(len(attempts), 3)
        self.assertEqual(attempts[selected]["first_word"], boundaries[2][0])

    def test_abandoned_final_attempt_loses_to_last_complete_one(self):
        abandoned = "Our CCC Days team was myself, Dallas, Joby, Becky and Jamey, targeted at"
        partial = "Our CCC Days team was myself, Dallas, Joby"
        words, boundaries = join_takes([partial, BEAT_1_SCRIPT, abandoned])
        attempts = find_attempts(tokenize(BEAT_1_SCRIPT), words, DEFAULT_CONFIG)
        selected, flags = select_attempt(attempts, DEFAULT_CONFIG)

        self.assertEqual(attempts[selected]["first_word"], boundaries[1][0])
        self.assertIn("trailing_abandoned_take", flags)

    def test_paraphrased_delivery_still_matches(self):
        spoken = (
            "So our CCC Days team was me, Dallas, Joby, Becky and Jamey, and we were "
            "targeted at solving a real issue. Creating video is time consuming. So we "
            "set out to build a consistent process for making a video from start to "
            "finish. This video is the experiment reporting on itself."
        )
        result = align_beats([BEAT_1], transcripts_for(build_words(spoken)))
        beat = beat_result(result)

        self.assertEqual(beat["status"], "matched")
        self.assertGreater(
            beat["attempts"][beat["selected_attempt"]]["coverage"],
            DEFAULT_CONFIG["coverage_threshold"],
        )

    def test_wholesale_divergence_reports_a_gap(self):
        spoken = "Let's talk about something else entirely, like what we had for lunch on Tuesday."
        result = align_beats([BEAT_1], transcripts_for(build_words(spoken)))
        beat = beat_result(result)

        self.assertEqual(beat["status"], "gap")
        self.assertIn("below_threshold", beat["flags"])
        self.assertEqual(beat["ranges"], [])

    def test_two_close_attempts_are_flagged_for_adjudication(self):
        nearly = BEAT_1_SCRIPT.replace("a real issue", "a very real issue")
        words, _boundaries = join_takes([BEAT_1_SCRIPT, nearly])
        attempts = find_attempts(tokenize(BEAT_1_SCRIPT), words, DEFAULT_CONFIG)
        _selected, flags = select_attempt(attempts, DEFAULT_CONFIG)

        self.assertIn("close_call", flags)


class BoundaryTest(unittest.TestCase):
    def test_in_point_snaps_into_leading_silence_without_swallowing_it(self):
        words = build_words(BEAT_1_SCRIPT, start=1.00)
        start_ms, _end_ms = refine_boundaries(words, 0, len(words) - 1, DEFAULT_CONFIG)
        pad_ms = int(DEFAULT_CONFIG["boundary_pad_s"] * 1000)

        self.assertEqual(start_ms, 1000 - pad_ms)

    def test_boundary_pad_never_takes_more_than_half_the_available_silence(self):
        words = build_words(BEAT_1_SCRIPT, start=0.10)
        start_ms, _end_ms = refine_boundaries(words, 0, len(words) - 1, DEFAULT_CONFIG)

        self.assertEqual(start_ms, 50)


class CleanupTest(unittest.TestCase):
    def test_filler_words_are_cut(self):
        spoken = "Creating videos is um time consuming."
        words = build_words(spoken)
        _ranges, cuts = clean_ranges(words, 0, len(words) - 1, DEFAULT_CONFIG)

        self.assertEqual([cut["reason"] for cut in cuts], ["filler"])
        self.assertEqual(cuts[0]["text"], "um")

    def test_repeated_run_drops_the_earlier_take_of_the_phrase(self):
        spoken = "So we set out to so we set out to build a consistent process."
        words = build_words(spoken)
        _ranges, cuts = clean_ranges(words, 0, len(words) - 1, DEFAULT_CONFIG)

        self.assertEqual([cut["reason"] for cut in cuts], ["repeated"])
        self.assertEqual(tokenize(cuts[0]["text"]), ["so", "we", "set", "out", "to"])

    def test_immediate_word_duplication_is_cut(self):
        spoken = "Creating videos is is time consuming."
        words = build_words(spoken)
        _ranges, cuts = clean_ranges(words, 0, len(words) - 1, DEFAULT_CONFIG)

        self.assertEqual([cut["reason"] for cut in cuts], ["repeated"])
        self.assertEqual(cuts[0]["text"], "is")

    def test_long_mid_take_pause_splits_the_beat_into_two_ranges(self):
        words = build_words(BEAT_1_SCRIPT, pauses={20: 2.0})
        ranges, cuts = clean_ranges(words, 0, len(words) - 1, DEFAULT_CONFIG)

        self.assertEqual(len(ranges), 2)
        self.assertEqual([cut["reason"] for cut in cuts], ["long_pause"])
        self.assertLess(ranges[0]["end_ms"], ranges[1]["start_ms"])

    def test_pause_under_the_threshold_is_left_alone(self):
        words = build_words(BEAT_1_SCRIPT, pauses={20: DEFAULT_CONFIG["max_gap_s"] / 2})
        ranges, cuts = clean_ranges(words, 0, len(words) - 1, DEFAULT_CONFIG)

        self.assertEqual(len(ranges), 1)
        self.assertEqual(cuts, [])


class ReadingTest(unittest.TestCase):
    def test_reading_marks_dropped_material_with_its_reason(self):
        words = build_words("Creating videos is um time consuming.")
        segments = reading_segments(words, 0, len(words) - 1, DEFAULT_CONFIG)
        dropped = [segment for segment in segments if not segment["kept"]]

        self.assertEqual(len(dropped), 1)
        self.assertEqual(dropped[0]["text"], "um")
        self.assertEqual(dropped[0]["reason"], "filler")

    def test_reading_covers_every_word_of_the_selected_attempt(self):
        spoken = "So we set out to so we set out to build a consistent process."
        words = build_words(spoken)
        segments = reading_segments(words, 0, len(words) - 1, DEFAULT_CONFIG)

        self.assertEqual(" ".join(segment["text"] for segment in segments), spoken)

    def test_matched_beat_carries_a_reading(self):
        result = align_beats([BEAT_1], transcripts_for(build_words(BEAT_1_SCRIPT)))
        beat = beat_result(result)

        self.assertTrue(beat["reading"])
        self.assertTrue(all(segment["kept"] for segment in beat["reading"]))


class PlanPassThroughTest(unittest.TestCase):
    def test_plan_intent_reaches_the_output_untouched(self):
        beat = dict(BEAT_1, plan={"on_screen": "Title card", "b_roll": "team collaboration, around 0:16"})
        result = align_beats([beat], transcripts_for(build_words(BEAT_1_SCRIPT)))

        self.assertEqual(beat_result(result)["plan"]["b_roll"], "team collaboration, around 0:16")

    def test_absent_plan_intent_is_an_empty_mapping(self):
        result = align_beats([BEAT_1], transcripts_for(build_words(BEAT_1_SCRIPT)))

        self.assertEqual(beat_result(result)["plan"], {})


class OverrideTest(unittest.TestCase):
    def _three_takes(self):
        words, boundaries = join_takes([BEAT_1_SCRIPT] * 3)
        return words, boundaries

    def test_forcing_an_attempt_overrides_the_default_selection(self):
        words, boundaries = self._three_takes()
        result = align_beats(
            [BEAT_1],
            transcripts_for(words),
            overrides={"beats": {"1": {"attempt": 1}}},
        )
        beat = beat_result(result)

        self.assertEqual(beat["attempts"][beat["selected_attempt"]]["first_word"], boundaries[0][0])
        self.assertIn("forced_by_you", beat["flags"])

    def test_forcing_an_attempt_that_does_not_exist_keeps_the_default_and_says_so(self):
        words, boundaries = self._three_takes()
        result = align_beats(
            [BEAT_1],
            transcripts_for(words),
            overrides={"beats": {"1": {"attempt": 9}}},
        )
        beat = beat_result(result)

        self.assertEqual(beat["attempts"][beat["selected_attempt"]]["first_word"], boundaries[2][0])
        self.assertIn("override_ignored", beat["flags"])

    def test_a_per_beat_config_can_put_a_filler_word_back(self):
        spoken = "Creating videos is um time consuming."
        beat = {"number": 1, "label": "x", "speaker": "Solo", "script": spoken}
        transcripts = {"Solo": {"source": "solo.mp4", "words": build_words(spoken)}}

        cut_out = align_beats([beat], transcripts)
        put_back = align_beats(
            [beat], transcripts, overrides={"beats": {"1": {"config": {"fillers": []}}}}
        )

        self.assertEqual([entry["reason"] for entry in cut_out["beats"][0]["cuts"]], ["filler"])
        self.assertEqual(put_back["beats"][0]["cuts"], [])

    def test_an_override_for_one_beat_does_not_leak_into_another(self):
        spoken = "Creating videos is um time consuming."
        beats = [
            {"number": 1, "label": "x", "speaker": "Solo", "script": spoken},
            {"number": 2, "label": "y", "speaker": "Duo", "script": spoken},
        ]
        transcripts = {
            "Solo": {"source": "solo.mp4", "words": build_words(spoken)},
            "Duo": {"source": "duo.mp4", "words": build_words(spoken)},
        }
        result = align_beats(
            beats, transcripts, overrides={"beats": {"1": {"config": {"fillers": []}}}}
        )

        self.assertEqual(result["beats"][0]["cuts"], [])
        self.assertEqual([entry["reason"] for entry in result["beats"][1]["cuts"]], ["filler"])


class MediaLimitTest(unittest.TestCase):
    SHORT_SCRIPT = "Creating videos is time consuming."

    def _beat(self):
        return {"number": 1, "label": "x", "speaker": "Solo", "script": self.SHORT_SCRIPT}

    def test_boundary_pad_is_clamped_to_the_media_duration(self):
        words = build_words(self.SHORT_SCRIPT)
        limit_ms = int(words[-1]["end"] * 1000) + 20
        _start_ms, end_ms = refine_boundaries(words, 0, len(words) - 1, DEFAULT_CONFIG, limit_ms)

        self.assertEqual(end_ms, limit_ms)

    def test_range_end_never_exceeds_a_declared_media_duration(self):
        words = build_words(self.SHORT_SCRIPT)
        duration_s = words[-1]["end"] + 0.02
        result = align_beats(
            [self._beat()],
            {"Solo": {"source": "solo.mp4", "words": words, "duration_s": duration_s}},
        )

        self.assertLessEqual(result["beats"][0]["ranges"][-1]["end_ms"], int(duration_s * 1000))

    def test_without_a_declared_duration_the_pad_is_applied_as_before(self):
        words = build_words(self.SHORT_SCRIPT)
        result = align_beats([self._beat()], {"Solo": {"source": "solo.mp4", "words": words}})
        pad_ms = int(DEFAULT_CONFIG["boundary_pad_s"] * 1000)

        self.assertEqual(
            result["beats"][0]["ranges"][-1]["end_ms"],
            int(words[-1]["end"] * 1000) + pad_ms,
        )


class MultiSpeakerTest(unittest.TestCase):
    def test_missing_speaker_file_reports_a_gap_for_every_beat_they_carry(self):
        beats = [
            BEAT_1,
            {
                "number": 2,
                "label": "Belief 1",
                "speaker": "Jamey Meeker",
                "script": "Time wasn't the only problem.",
            },
        ]
        result = align_beats(beats, transcripts_for(build_words(BEAT_1_SCRIPT)))

        self.assertEqual(beat_result(result, 1)["status"], "matched")
        self.assertEqual(beat_result(result, 2)["status"], "gap")
        self.assertIn("no_footage", beat_result(result, 2)["flags"])

    def test_beats_come_back_in_script_order_regardless_of_recorded_order(self):
        first = "Time wasn't the only problem."
        words, _boundaries = join_takes([first, BEAT_1_SCRIPT])
        beats = [
            BEAT_1,
            {"number": 2, "label": "Belief 1", "speaker": "Blaine Irvin", "script": first},
        ]
        result = align_beats(beats, transcripts_for(words))

        self.assertEqual([beat["number"] for beat in result["beats"]], [1, 2])
        self.assertEqual(beat_result(result, 1)["status"], "matched")
        self.assertEqual(beat_result(result, 2)["status"], "matched")

    def test_unused_footage_is_parked_rather_than_discarded(self):
        aside = "Honestly I have no idea if this is going to work at all."
        words, _boundaries = join_takes([BEAT_1_SCRIPT, aside])
        result = align_beats([BEAT_1], transcripts_for(words))

        self.assertTrue(result["parked"])
        parked_text = " ".join(region["text"] for region in result["parked"])
        self.assertIn("no idea", parked_text)


if __name__ == "__main__":
    unittest.main()
