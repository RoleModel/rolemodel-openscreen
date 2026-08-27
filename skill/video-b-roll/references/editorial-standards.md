# Editorial standards

Placement and treatment rules for cutting footage into RoleModel marketing video.
The two marked **[reviewed]** were explicit corrections on delivered work and are
strong defaults, not preferences. Everything else is a starting point you should
be able to justify per shot in the EDL.

## Coverage

- 20 to 26 percent of runtime for a testimonial, cohort, or partner piece. A
  shipped example landed at 23 percent.
- 3 to 4.5 seconds per cutaway. Shorter reads as a flash. Longer and the speaker
  feels abandoned.
- One cutaway per short answer (about 15 seconds), two per long answer (20
  seconds or more). Never more than two.

## Placement

- **[reviewed] No B-roll in the intro.** Let the title card, the host or narrator
  setup, and the first question card play clean. Coverage starts once the
  interviews are underway. On one piece that moved the first cutaway from 0:06 to
  0:19.
- Establish a new speaker's face for 3 to 5 seconds before their first cutaway.
- Never cover someone saying their own name.
- Return to the face for the payoff line, meaning the emotional or conclusive
  beat of the answer.
- Never cut away over title cards, question cards, or an animating lower third.
  Those are already designed beats.
- Cut on a clause boundary or a breath. Picture cuts do not have to respect word
  boundaries, since the audio is continuous, but they feel deliberate when they
  do.

## Shot selection

- **[reviewed] No shaky or busy B-roll. Prefer locked off.** Measure it with
  `scripts/motion-scan.py`. Do not judge stability from stills: a contact sheet
  of a drifting handheld shot looks fine, and a still cannot show a pan at all.
- Content must be motivated by the line underneath it. "Working in a team" gets a
  group shot. "How it's made" gets a whiteboard of architecture. "Really brutal"
  gets heads-down work. A shot that is merely pretty is not motivated.
- **[reviewed] Showing the current speaker in the B-roll is excellent where it is
  tasteful, not every time.** Build a person-identification key early by matching
  wardrobe and hair between interview frames and B-roll frames, then let this fall
  out of the selection rather than forcing it. On one piece 4 of 7 cutaways
  contained the speaker, and in each case that shot was independently the
  steadiest good match for the line.
- Check adjacent cutaways for visual similarity by looking at them, not by
  trusting that different source files are different shots. Ten unlabelled clips
  from one workshop day contained many near-duplicate setups from different
  cameras. One round paired two cutaways eight seconds apart that were the same
  two people at the same desk from two camera files, and it read as one shot
  interrupted.

## Treatment

- Interview or narration audio runs unbroken. All B-roll is silent. Nothing
  ducked, nothing retimed.
- A 0.3 second (about 7 frame) opacity cross dissolve in and out for warm brand
  work. Hard cuts for harder-edged pieces. Match whatever the existing graphic
  transitions already do.
- A synthetic push, scale 1.02 to 1.035 over the shot, keeps a locked-off frame
  from reading as a freeze. Keep it small. 1.065 was too much once "no busy
  movement" was the brief, and the 1.02 floor also hides any edge reveal from
  residual jitter.
- Re-audit your own additions against a note before declaring the note addressed.
  "We don't want lots of movement" applied to the push that had been authored into
  the composition, not only to the source footage.

## Camera motion thresholds

Calibrated against real reviewer language on rendered output. Rank candidate
windows by **peak**, never by mean, because one whip pan ruins a shot whose
average is calm.

| Peak | Reads as | Evidence |
|---|---|---|
| under 5 | locked off | 2.4, 2.5, 1.9, 2.9 accepted without comment; 3.9 called "excellent" |
| 5 to 10 | perceptible drift | 6.1 shipped with a caveat; 9.1 and 10.2 replaced pre-emptively and neither came back |
| over 20 | visibly shaky or panning | 46.9 and 47.0 got "shaky"; 26.2 got "the camera pans down" |

Select only from windows under 5. Going above it is a trade you should name in
the EDL, with the fallback shot listed. One shipped cutaway sat at 6.1 because
its thematic match beat a steadier but unrelated shot, and that was written down.

## Reading feedback as calibration data

Feedback on a perceptual quality is a scale, not just an instruction. "Shaky"
(46.9), "pans down" (26.2), and "excellent" (3.9) defined the table above. That
scale then flagged two shots nobody had mentioned as likely next complaints, both
were replaced before the next review, and neither came back.

When work is rejected on a perceptual quality you have not measured, look for a
cheap proxy metric and calibrate it on the accept and reject set before
re-picking. That is what turned a second review round from an argument into a
filter.

## Retiming limits

For mode A, where footage is compressed to fit a fixed voiceover:

- Keep per-beat speed between about 0.8x and 2.2x. Past 2.5x a UI screen
  recording turns to mush.
- Get the compression from cutting, not from uniform speed-up. A 6.35 to 1 ratio
  was absorbed with per-beat rates that never left 0.81x to 2.16x, because most
  of the source was simply dropped.
- Land the moment of change (the click, the snap, the flip) on the specific word
  that describes it. That is the whole point of the exercise.
