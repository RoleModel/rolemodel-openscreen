# Runtime Budget

Runtime is a budget set in the plan, not a number discovered in the edit. Set the target, convert it to words, allocate words per beat, then reconcile the draft against it.

## The Rates

Speaking rate is not one number. It depends on what the viewer is doing while they listen.

| Mode | Rate | Why |
|---|---|---|
| Energetic promo, sound-on social | 155-165 wpm | Pace carries the energy. Short video tolerates speed. |
| Standard on camera, talking to a viewer | 140-150 wpm | The conversational default. Use 145 for math. |
| Voiceover over screen capture | 120-130 wpm | The viewer is reading a UI. Words compete with the screen. |
| Teaching a concept for the first time | 115-125 wpm | Comprehension needs pauses the word count does not show. |
| Two-person dialogue | 135-145 wpm | Handoffs eat time that no word count captures. |

**Use 145 wpm as the default.** Drop to 125 for any beat where a demo is running.

## The Math

```
word budget = (runtime in seconds / 60) x wpm
```

Worked example, a 3:00 video with a 0:35 demo section:

```
Total runtime            3:00 = 180s
Demo section             0:35 = 35s at 125 wpm  =  73 words
Remaining                2:25 = 145s at 145 wpm = 350 words
Word budget                                       423 words
```

Round down. A budget that is 5 percent tight produces a better video than one that is 5 percent loose.

## Overhead That Words Do Not Cover

Subtract these before allocating. They consume runtime and carry no words.

| Element | Typical cost |
|---|---|
| Title card | 0:02 to 0:03 |
| End card holding after the last word | 0:02 to 0:04 |
| Each speaker handoff | 0:01 to 0:02 |
| Unnarrated demo moment, letting a result land | 0:02 to 0:05 each |
| Breath and beat between sections | 0:01 per section break |

A 3:00 video with a title card, an end card, two handoffs, and four section breaks loses roughly 0:15 to overhead. That is 36 words at 145 wpm. Budget it or the script runs long by exactly that much.

## Allocating Across Beats

Allocate proportionally, then adjust for mode.

```
Target 3:00, budget 423 words

Open           0:20   48 words   at 145 wpm
Belief 1       0:35   85 words   at 145 wpm
Belief 2       0:35   73 words   at 125, demo running
Belief 3       0:35   85 words   at 145 wpm
Close          0:20   48 words   at 145 wpm
Demo extension 0:20   42 words   at 125 wpm
Overhead       0:15    0 words
                      381 allocated, 42 held in reserve
```

Hold 5 to 10 percent in reserve. Something always needs a sentence you did not plan for.

## Sane Bands By Surface

Not rules, but flag it when a video lands well outside its band and say why.

| Surface | Band | Note |
|---|---|---|
| Feed autoplay, cold audience | 0:20 to 0:60 | First 3 seconds must read with no sound |
| Feed, warm audience | 0:60 to 1:30 | |
| Landing page embed | 1:00 to 2:30 | Viewer chose to click. More patience. |
| Feature demo for an evaluating buyer | 2:00 to 5:00 | Demo time is not filler here |
| Partner or exec update | 2:00 to 4:00 | |
| Teaching or walkthrough | 5:00 to 12:00 | Chapter it |
| Recorded talk | as delivered | Different discipline |

A cold-audience video at 6:00 is not a long video. It is a video with no audience, and the fix is a shorter cut plus a longer cut, not a compromise in the middle.

## Reconciling

Count the draft. Report the gap in both words and seconds, since seconds is what the user actually feels.

Bring specific cuts with their costs. Ranked cheapest first:

1. **Move a number to on-screen text.** A stat spoken is 12 words. On screen it is free and better remembered. Near zero cost.
2. **Cut the setup sentence.** Most beats open with a sentence that explains what the next sentence will say. Delete it.
3. **Delete the transition.** "So with that in mind" and its relatives. Free.
4. **Compress the example.** Keep the example, lose half its detail.
5. **Merge two beliefs.** Real cost, real savings. Offer it when the overage is large.
6. **Drop a belief entirely.** Highest cost. Only when the plan already had four or five.

Never fix an overage by quietly raising the runtime target. If the material honestly needs the time, say that and let the user decide.
