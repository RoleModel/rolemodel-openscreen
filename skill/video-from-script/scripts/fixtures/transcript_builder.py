"""Builds word-timestamp transcripts for tests without needing media files.

Mirrors the shape `npx hyperframes transcribe` emits: a flat array of
{id, text, start, end} with times in seconds.
"""


WORD_DURATION = 0.30
WORD_GAP = 0.06


def build_words(spoken, start=1.00, word_duration=WORD_DURATION, gap=WORD_GAP, pauses=None):
    """Turn a plain string into timed words.

    `pauses` maps a word index to extra silence inserted *before* that word,
    which is how a mid-take breath or a stall between attempts is expressed.
    """
    pauses = pauses or {}
    words = []
    clock = start

    for index, text in enumerate(spoken.split()):
        clock += pauses.get(index, 0.0)
        words.append(
            {
                "id": f"w{index}",
                "text": text,
                "start": round(clock, 3),
                "end": round(clock + word_duration, 3),
            }
        )
        clock += word_duration + gap

    return words


def join_takes(takes, start=1.00, between=1.50, **kwargs):
    """Concatenate several spoken attempts into one continuous transcript.

    Returns (words, take_boundaries) where each boundary is the (first, last)
    word index of that take, so a test can assert which attempt was selected
    without hardcoding timestamps.
    """
    words = []
    boundaries = []
    clock = start

    for take in takes:
        take_words = build_words(take, start=clock, **kwargs)
        first_index = len(words)
        for word in take_words:
            words.append(word)
        boundaries.append((first_index, len(words) - 1))
        clock = take_words[-1]["end"] + between

    for index, word in enumerate(words):
        word["id"] = f"w{index}"

    return words, boundaries
