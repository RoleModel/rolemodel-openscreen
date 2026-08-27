# Demo Capture

Screen capture is the one visual element that is required rather than recommended, and the one that must be timed to the script. The reason is simple: the words are written to what is on screen. If the capture does not match the timing, the narration describes a click the viewer already watched.

Plan the capture during the planning phase. Write the script to the capture, not the other way around.

## Why Demo Beats Description

Three sentences describing a UI are weaker than four seconds of that UI working. A buyer evaluating software wants to see the thing. Show it, then say what it means.

The corollary matters more: **a beat with a demo needs fewer words, not more.** The screen is carrying the meaning. Narration that describes what the viewer can plainly see is wasted runtime. Budget demo beats at 120 to 130 wpm and let the screen do its job.

## What Gets Demoed

Demo the thing the belief depends on. Not the tour.

| Demo this | Not this |
|---|---|
| The one action that proves the belief | Every feature in the menu |
| The result the user cares about | The path taken to get there |
| The moment the old way breaks | A complete happy path |
| The state before and the state after | Every intermediate screen |

A five minute product tour is the default instinct and it is almost always wrong. Pick the two or three moments that carry the beliefs.

## Capture Specification

Every capture gets a full spec in the shot list. Vague specs produce recordings that have to be redone.

```
CAPTURE [n] - serves Beat [n], [m:ss]-[m:ss], [m:ss] total

Application:  [what is being recorded]
Resolution:   [1920x1080 minimum. 2560x1440 if text will be zoomed.]
Setup:        [exact state the screen must be in before recording starts.
               Which account, which record, which data, what is already open.]
Data:         [what data appears. Never real partner data. Named demo data.]
Sequence:     1. [action] (0:00-0:06)
              2. [action] (0:06-0:19)
              3. [action] (0:19-0:35)
Pace:         [real time / slowed / sped 2x with an on-screen note]
Cursor:       [visible or hidden. Visible when the click matters.]
Zoom:         [which region, at what moment, and why]
Must show:    [the specific thing the belief depends on]
Do not show:  [real partner data, unrelated UI, anything unfinished,
               notifications, other browser tabs, personal bookmarks]
Audio:        [none. Narration is recorded separately.]
```

## Timing Rules

**Every action gets its own time window.** The script's words for that window are written to that action. A three step sequence in a 35 second beat is three timed windows, not one 35 second blob.

**Leave unnarrated moments.** When a result lands, let it land. Two to four seconds of silence while the viewer reads a result is the most effective moment in most demos, and it costs zero words. Budget it as overhead.

**Slow the cursor.** Natural mouse speed is too fast to follow on video. Move deliberately. Pause before each click. The recorded pace should feel slow to the person recording it.

**Never let narration get ahead of the screen.** If the script says "and the quote generates" the quote generates at that moment or just after, never three seconds before.

**Cut dead time in the edit, not in the recording.** Record the real thing at a deliberate pace, including load time. Speed it up or cut it in the edit. Trying to record a perfect take with no waiting produces rushed clicks.

## Setup Discipline

Do this before recording. Every item on this list has ruined a take.

```
[ ] Close every unrelated tab, window, and application
[ ] Notifications off, at the OS level and in the application
[ ] Demo data seeded, realistic, and not real partner data
[ ] Names, logos, emails, and numbers on screen are fictional or cleared for use
[ ] Browser zoom set so text is legible at final output size
[ ] Bookmarks bar hidden, personal bookmarks not visible
[ ] Signed in as the right role, since the UI may differ by permission
[ ] Screen recorded at native resolution, no scaling
[ ] The exact starting state reachable again for a second take
[ ] Run the whole sequence once before recording it
```

The last item is the one people skip. Rehearse the sequence once. The first attempt always finds a dialog nobody planned for.

## Data In Demos

Never real partner data. Not blurred, not partially redacted, not "just the test environment."

Use fictional data that is realistic in shape. Real-looking numbers, plausible company names, dates that make sense together. Obviously fake data ("Test Company 1," "asdf") undercuts the credibility the demo was supposed to build.

When the demo needs to reflect a real partner scenario, build fictional data with the same shape and say so in the plan.

## Retakes

Assume two takes for anything that matters, and note it in the shot list. The first take finds the problem, the second is the one that ships. A capture marked as one take is a capture that will be rerecorded on a deadline.
