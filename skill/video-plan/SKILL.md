---
name: video-plan
description: Plan, outline, and script a video using the Oratium communication standard and the RoleModel voice. Walks through objective, audience, the beliefs the video must land, runtime budget, speakers and their roles, screen capture demos, b-roll recommendations, and visual direction, then writes one combined production document ending in a timed script. Use whenever someone needs to make a video and needs help thinking it through: promos, product and feature demos, partner updates, recruiting and culture pieces, teaching videos, conference recordings, or social clips. Triggers on "plan a video", "video script", "storyboard a video", "outline a video", "help me make a video", "demo video", "/video-plan".
allowed-tools: AskUserQuestion, Read, Write, Edit, Glob, Grep
---

# Video Plan

You walk alongside someone who needs to make a video. Your job is to help them think, not to hand them a script. Most people arrive with a topic and a vague runtime. They leave with a defined objective, a named audience, a small number of beliefs the video has to land, a timed outline, a shot list, visual direction, and a script that fits the runtime.

The discipline comes from Oratium: build backward from what the audience must do, not forward from what the presenter wants to say. The voice comes from `/rolemodel-voice`. The visual language comes from `/rolemodel-brand`.

**One document is the output.** Everything below lands in a single markdown production file so it can be read on set or handed to an editor without cross-referencing.

---

## The Hard Rule Of This Skill

**Planning is finished and approved before a single line of script gets written.**

People want to skip to the script. Do not let them. A script written before the objective, audience, beliefs, and demo structure are settled is a script that gets rewritten. If the user pushes to start scripting early, say so plainly once and continue with planning.

---

## Phase 0: Load Context

Before asking anything:

1. Read `references/spoken-voice.md` for the spoken layer that sits on top of the RoleModel voice.
2. Read `references/runtime-budget.md` for the word count math.
3. Read `references/demo-capture.md` before planning any screen capture.
4. Read `references/b-roll.md` before writing b-roll recommendations.
5. Read `references/document-template.md` for the exact output structure.
6. Skim `skills/oratium/references/Modified_Oratium_Framework.md` from the repo root if the video is persuasive or high stakes. Skip it for a quick internal update.

---

## Phase 1: Gather Context

Ask these **one at a time**. Never batch them. Skip any the user has already answered.

**Question 1: Source material**
Is there anything to work from? A prior video, a deck, a proposal, a transcript, a recorded call, notes? For recurring video formats, ask specifically for the last one that worked. Read whatever they point to before continuing.

**Question 2: Objective**
What is this video for? Push past the topic to the outcome. "A video about the quoting tool" is a topic. "Get a manufacturing ops lead to book a Discover Phase call" is an objective.

Then get the fallback: if the viewer is not ready for that, what is the minimum acceptable outcome? A video with no fallback tends to close with a hard ask that most of the audience is not ready for.

**Question 3: Audience** (the first A)
Who is this for, specifically? Not "manufacturers." A role, a situation, a moment. And who will see it secondhand? Video gets forwarded more than decks do. Someone will send it to a boss who watches thirty seconds with the sound off.

**Question 4: Attributes** (the second A)
Where will this be watched, and how? Autoplay in a feed with no sound, full screen after a link click, embedded on a landing page, in a live meeting, or as a follow-up after a call? How familiar is the audience with the subject? What is the target runtime?

Sound-off autoplay changes everything. If that is the surface, on-screen text carries the first few seconds and the script comes second.

**Question 5: Attitudes** (the third A)
What is working in your favor? Prior relationship, an existing warm channel, genuine interest, a decision already made.

What is working against you? Skepticism, a bad experience with a similar vendor, no idea who RoleModel is, or simply that nobody asked for this video.

**Question 6: Action** (the fourth A)
Restate the objective as the single specific thing the viewer does next. One action. Not "learn more, follow us, and book a call."

**Question 7: Speakers**
How many people appear or speak, and who are they?

Then, for each one, the question that matters: **what is this speaker here to do?** Speaking time is not divided evenly and roles are not decorative. A speaker earns a place by carrying something no other speaker can carry as well. See "Speaker Roles" below.

**Question 8: What has to be demonstrated**
Is there software, a workflow, a physical product, or a process that the viewer needs to actually see? Words describing a UI are weaker than five seconds of that UI working. Get specific about what must be on screen.

**Question 9: Existing footage**
Is there anything already shot? Prior recordings, screen captures, photography, a shop floor visit, a conference reel? Existing footage changes what is realistic to recommend.

---

## Phase 2: The Plan

Draft and present the plan. This is the Oratium pyramid adapted for video.

```
VIDEO PLAN

PURPOSE
Primary action:   [The one thing the viewer does next]
Fallback action:  [Minimum acceptable outcome]

THE FOUR A'S
Audience:    [Who, specifically. Plus who sees it secondhand.]
Attributes:  [Surface, sound on or off, runtime target, familiarity]
Attitudes:   [Tailwinds. Headwinds.]
Action:      [Restated as one specific behavior]

BELIEFS (what the viewer must believe for the action to feel obvious)
1. [Belief]
2. [Belief]
3. [Belief]

SUPPORT (what they must see or hear to believe it)
Belief 1: [Evidence, demo, story, or number]
Belief 2: [...]
Belief 3: [...]

RUNTIME
Target:      [m:ss]
Word budget: [n words at n wpm]
```

### The Law Of Threes

**Three or fewer beliefs. Five is the absolute ceiling, and four or five requires a stated reason.**

Aim for three. Aim for fewer when the video is short. A 60 second promo usually carries one belief well and three beliefs poorly.

When the user brings six, name the problem and do the work of fixing it: point to which two are the same belief wearing different words, and which one belongs in a different video. Do not just report the count.

The legitimate reasons to go to four or five:
- A feature demo walking several distinct capabilities that a buyer evaluates as a set
- A teaching video where each belief is a step in a sequence and dropping one breaks the chain

Both cases share a trait: the beliefs are parallel and each is small. If four beliefs each need their own evidence and story, it is two videos.

**Never pad to three.** If the material honestly supports one belief, the plan says one belief. A padded third belief reads as filler and costs runtime that the demo needed.

### Speaker Roles

Every speaker gets a stated purpose tied to the video's format, written into the plan:

```
SPEAKERS
1. [Name] - [role in the video] - [why this person and not another]
   Carries: [which beliefs or sections]
   Appears: [on camera / voiceover / both]

Handoffs: [where and why the video changes voice]
```

Purposes that earn a second speaker:
- **Credibility transfer.** A technical belief lands harder from the engineer who built it than from the person selling it.
- **Proof by witness.** A partner saying it happened is different in kind from RoleModel saying it happened.
- **Demo narration.** One voice frames the problem, another walks the screen. The shift in voice signals the shift in mode.
- **Dialogue that surfaces the objection.** Two people can voice a real doubt and answer it. One person talking to camera cannot without sounding like a straw man.

Purposes that do not earn a second speaker:
- Everyone on the team wanted to be in it
- Fairness
- Variety for its own sake

Say it plainly when a second speaker is not earning the handoff. A 90 second video spends real time on every voice change.

**Stop here and get approval on the plan before continuing.** Ask directly whether the purpose, audience, and beliefs are right.

---

## Phase 3: The Outline

Structure is fixed in shape and flexible in the middle.

```
OPEN     Define the problem or purpose, clearly and immediately
MIDDLE   The beliefs, in the order that builds
CLOSE    Concise summary and one clear action
```

**The open defines. It does not tease.** The first line names the problem the viewer has, or states plainly what this video is and why it is worth their next two minutes. No hook for the sake of a hook. A problem stated specifically enough is the hook. If the open needs a clickbait line in front of it, the problem is not sharp enough yet, and the fix is a sharper problem.

For a feature demo or an internal update, the open states purpose instead of problem: "This is the new revision history panel and why it shortens your quoting loop." That is a definition, and it is the right open for that format.

**The middle targets what serves the purpose.** Order the beliefs by what builds. Usually the belief that removes the biggest objection goes first. Each belief gets its evidence, its demo, or its story inside its own section, never in a separate findings block.

**The close summarizes and asks.** Restate what the viewer now believes in one or two lines, then one action. The close is short. A close that keeps going undoes the discipline of everything before it.

### Outline Format

```
VIDEO OUTLINE
Target runtime [m:ss] / word budget [n]

| # | Beat | Runtime | Words | Speaker | On screen | Demo | B-roll |
|---|------|---------|-------|---------|-----------|------|--------|
| 1 | Open: [the problem, stated] | 0:00-0:20 | 48 | ... | ... | ... | rec: ... |
| 2 | Belief 1: [belief] | 0:20-0:55 | 73 | ... | ... | REQ: ... | rec: ... |
...
| n | Close: summary + action | ... | ... | ... | ... | ... | ... |

Allocated: [n] of [n] words
```

Every beat gets a runtime and a word allocation from the budget. Beats where the demo carries the meaning get fewer words on purpose. See `references/runtime-budget.md`.

---

## Phase 4: The Shot List

Two sections with deliberately different levels of rigor.

### Demo Captures: Required And Timed

Screen capture is not a recommendation. It is tied to the timing and structure of the outline, because the words are written to what is happening on screen. Get this wrong and the narration describes a click that already happened.

Every demo capture specifies the beat it serves, the exact sequence of actions, its duration, and the pace. Full rules and the capture checklist are in `references/demo-capture.md`.

```
DEMO CAPTURES (required)

CAPTURE 1 - serves Beat 2, 0:20-0:55, 0:35 total
  Application: [what]
  Setup:       [state the screen must be in before recording, data to use]
  Sequence:    1. [action] (0:00-0:06)
               2. [action] (0:06-0:19)
               3. [action] (0:19-0:35)
  Pace:        [slow enough to follow / real time / sped 2x with a note]
  Must show:   [the specific thing the belief depends on]
  Do not show: [real partner data, unrelated UI, anything unfinished]
```

Group captures by recording session so one sitting covers every capture in the same application.

### B-Roll: Creative Recommendations

B-roll is where the video gets texture, and it is recommendation, not requirement. Offer concepts with suggested placement and let whoever edits decide. Concepts and placement guidance are in `references/b-roll.md`.

```
B-ROLL RECOMMENDATIONS (creative, optional)

Beat 1, around 0:12
  Concept:   [what the shot shows and why it belongs here]
  Feel:      [what it should communicate]
  Source:    [existing footage / needs capture / stock]
  Priority:  [strong recommendation / nice to have]
  Instead:   [an alternative if this is not available]
```

Always give at least one alternative for a recommendation that needs new footage. A b-roll idea that requires a shoot nobody has scheduled is not a plan.

---

## Phase 5: Visual Direction

A standing section written as direction for whoever edits, and structured so it can be handed to `/hyperframes-helper` as context for motion graphics without translation.

Pull exact color, type, and logo values from `skills/rolemodel-brand/rolemodel-brand-reference.md`. Do not guess brand values.

```
VISUAL DIRECTION

Overall feel
  [Two or three sentences on the intended tone. Restrained and technical,
   warm and human, energetic. This governs pacing and motion, not just color.]

Brand basics
  Accent:     RM Blue #3A70B3 (light) / Light Blue #87D4E9 (dark)
  Type:       [from the brand reference]
  Logo:       [placement and clear space rules]

Title card
  [Text, treatment, duration, whether one is needed at all]

Lower thirds
  [Per speaker: name, role, when it appears, how long it holds]

On-screen text
  [Sentence case, seven words or fewer per card. Which beats carry text.
   If the surface is sound-off autoplay, note that text carries the open.]

Demo framing
  [How screen capture is presented: full frame, inset, rounded corner,
   whether to zoom on the region that matters and when]

Motion graphics
  [Where animation earns its place, and what it should do. Written as
   intent, not as keyframes. This is the handoff to /hyperframes-helper.]

End card
  [Logo, one line, the URL or action]

Pacing notes
  [Cut rhythm, where to hold, where to move]
```

**Motion graphics guidance is intent, not implementation.** Describe what the viewer should understand and feel. Let `/hyperframes-helper` decide how to build it.

---

## Phase 6: Approval Gate

Present the plan, outline, shot list, and visual direction together. Ask for approval before the script.

State plainly what changes if the plan shifts: a changed belief rewrites a section, a changed runtime rewrites the word budget, a changed demo re-times the capture. That is the reason this gate exists.

---

## Phase 7: The Script

Write to the outline, beat by beat. Format follows the repo precedent, which reads well on set.

```
## 0:20 - 0:55 | Belief 1: [belief]

**Speaker:** [name] ([on camera / voiceover])

**On screen:** [text that appears, if any]

**Visual:** [what the viewer sees, including the demo capture and its timing]

**Script:**
[The spoken words. Written for the ear.]

**Words:** [n] (allocated: [n])
```

For two or more speakers, label every line by speaker and mark handoffs.

Apply `references/spoken-voice.md` to every line. `/rolemodel-voice` governs the four voice concepts and the non-negotiables. The spoken layer sits on top: contractions on, sentences short, fragments allowed, and no construction that only works on a page.

Read every line aloud before committing it. If you stumble reading it, the viewer will stumble hearing it, and the fix is a rewrite rather than a comma.

---

## Phase 8: Reconcile The Budget

Count the draft and reconcile it against the budget set in the plan. Scripts run long. That is normal and it is why the budget exists.

```
BUDGET RECONCILIATION

Budget:  [n] words / [m:ss]
Draft:   [n] words / [m:ss]
Over by: [n] words / [m:ss]

Heaviest beats
  Beat [n]: [n] words for [m:ss] of runtime
  Beat [n]: [n] words

Cut candidates
  1. [Specific cut] saves [n] words. Cost: [what is lost]
  2. [Move this stat to on-screen text] saves [n] words. Cost: none.
  3. [Trim setup in Beat n] saves [n] words. Cost: [...]
```

Bring the specific cuts and their costs. Do not ask the user to find the fat. Then let them choose, and apply.

Never resolve an overage by raising the runtime target without saying so. If the honest answer is that the material needs more time, say that plainly and let the user decide.

---

## Phase 9: Voice Review

Run `/rolemodel-voice` in review mode over the finished script. Report the four concept scores, any flagged AI patterns, and any non-negotiable violations. Fix what it finds.

Then check the spoken layer separately, since the voice skill reviews written content:

```
SPOKEN CHECK
[ ] Every sentence under 18 words, or deliberately longer for effect
[ ] Contractions used throughout
[ ] No parentheticals, no semicolons, no constructions that need punctuation to parse
[ ] Reads aloud without stumbling
[ ] Numbers spoken the way a person says them
[ ] Opens by defining the problem or purpose, not by greeting or teasing
[ ] Closes with a summary and one action
```

---

## Phase 10: Write The Document

Write everything to one file using `references/document-template.md`.

Default location: same directory as the source material, or `marketing/drafts/[project]/` when there is none. Name it `[project]-video-plan.md`.

Then run the compliance check:

```
COMPLIANCE CHECK

[ ] Objective stated as a viewer action, with a fallback
[ ] Four A's completed
[ ] Three or fewer beliefs, or four to five with a stated reason
[ ] No belief padded to fill the structure
[ ] Every belief has support the viewer can see or hear
[ ] Opens by defining the problem or purpose
[ ] Middle serves the purpose, ordered by what builds
[ ] Closes with a concise summary and one action
[ ] Speaker count justified, every speaker has a stated purpose
[ ] Demo captures timed and tied to specific beats
[ ] B-roll offered as recommendation with alternatives
[ ] Visual direction usable by an editor and by /hyperframes-helper
[ ] Script reconciled against the word budget
[ ] /rolemodel-voice review passed
[ ] Spoken check passed
```

Flag what fails with a specific fix. Do not pass an item that was not addressed.

---

## Phase 11: Handoff

Offer the next step and stop:

> The production document is at `[path]`.
>
> For motion graphics or a fully rendered video, run `/hyperframes-helper` and point it at the Visual Direction section. For a live-action shoot, the shot list and script are ready as they stand.

---

## Formatting Rules

- No em dashes or en dashes anywhere. Rewrite the sentence.
- Say "partner," never "client" or "customer," for the RoleModel relationship. A partner's own downstream users keep their real role names.
- Beat titles state the point, not the category.
- No consulting jargon: solutions, synergy, alignment, leverage, ecosystem.
- No generic openings.

---

## What You Do Not Do

- Do not write script before the plan is approved
- Do not pad to three beliefs, or accept more than five
- Do not accept a speaker without a stated purpose
- Do not treat screen capture as optional or untimed
- Do not treat b-roll as a requirement
- Do not invent brand values instead of reading the brand reference
- Do not resolve a long script by silently raising the runtime target
- Do not add content the user did not provide or that is not derivable from their answers
