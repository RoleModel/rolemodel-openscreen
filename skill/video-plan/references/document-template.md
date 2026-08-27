# Document Template

One file, in this order. Planning sections come first because they were built first and because they are what someone reads to understand why the script says what it says.

Write only the sections that apply. A one minute internal update does not need a lower thirds spec. Do not include an empty section as a placeholder.

---

```markdown
# Video Plan: [Title]

Date: [today's date]
Target runtime: [m:ss]
Word budget: [n]
Status: [planning approved / script drafted / final]

---

## 1. Purpose

**Primary action:** [The one thing the viewer does next]
**Fallback action:** [Minimum acceptable outcome]

**What this video is:** [One or two sentences. The definition someone
would give if asked what the video is for.]

---

## 2. The Four A's

**Audience**
In front of it: [Who, specifically. A role in a situation, not a segment.]
Retold to: [Who sees it secondhand, and what they will see of it]

**Attributes**
Surface: [Where it is watched]
Sound: [On, off, or assume off]
Runtime: [m:ss]
Familiarity: [How much the audience already knows]

**Attitudes**
Tailwinds: [What is working in your favor]
Headwinds: [Skepticism, objections, indifference to overcome]

**Action**
[Restated as one specific behavior, with the friction named]

---

## 3. Beliefs

What the viewer must believe for the action to feel obvious.

1. **[Belief]**
   Support: [Evidence, demo, story, or number that drives it]

2. **[Belief]**
   Support: [...]

3. **[Belief]**
   Support: [...]

[If four or five: state the reason here. If fewer than three: state that
the material honestly supports this many and was not padded.]

---

## 4. Speakers

**[Name]** - [role in the video]
Why this person: [what they carry that another speaker could not]
Carries: [which beats]
Appears: [on camera / voiceover / both]

**[Name]** - [role in the video]
...

**Handoffs:** [Where the video changes voice, and why there]

---

## 5. Outline

| # | Beat | Runtime | Words | Speaker | On screen | Demo | B-roll |
|---|------|---------|-------|---------|-----------|------|--------|
| 1 | Open: [problem or purpose, stated] | 0:00-0:20 | 48 | | | | rec |
| 2 | Belief 1: [belief] | 0:20-0:55 | 73 | | | REQ | rec |
| 3 | Belief 2: [belief] | 0:55-1:30 | 85 | | | | rec |
| 4 | Belief 3: [belief] | 1:30-2:05 | 85 | | | | |
| 5 | Close: summary + action | 2:05-2:25 | 48 | | | | |

Overhead: [m:ss] for title card, end card, handoffs, unnarrated demo moments
Allocated: [n] of [n] words, [n] held in reserve

---

## 6. Shot List

### Demo Captures (required, timed to script)

**CAPTURE 1** - serves Beat 2, 0:20-0:55, 0:35 total

- Application: [what]
- Resolution: [n x n]
- Setup: [exact starting state]
- Data: [what appears. Fictional, realistic in shape.]
- Sequence:
  1. [action] (0:00-0:06)
  2. [action] (0:06-0:19)
  3. [action] (0:19-0:35)
- Pace: [real time / slowed / sped with a note]
- Cursor: [visible or hidden]
- Zoom: [region, moment, reason]
- Must show: [the thing the belief depends on]
- Do not show: [real partner data, unrelated UI, notifications]
- Takes: [2 expected]

### B-Roll Recommendations (creative, optional)

**Beat 1, around 0:12**
- Concept: [what the shot shows]
- Why here: [what it does for this moment]
- Feel: [what it communicates]
- Source: [existing / needs capture / stock / motion graphic]
- Priority: [strong / nice to have]
- Instead: [alternative if unavailable]

---

## 7. Visual Direction

Direction for whoever edits. Also the handoff context for
`/hyperframes-helper` when motion graphics are being built.

**Overall feel**
[Two or three sentences on intended tone. This governs pacing and
motion, not only color.]

**Brand basics**
- Accent: RM Blue #3A70B3 (light) / Light Blue #87D4E9 (dark)
- Type: [from skills/rolemodel-brand/rolemodel-brand-reference.md]
- Logo: [placement, clear space]

**Title card**
[Text, treatment, duration. Or "none" and why.]

**Lower thirds**
[Per speaker: name, role, when it appears, how long it holds]

**On-screen text**
[Sentence case, seven words or fewer. Which beats carry text.
If the surface is sound-off autoplay, note that text carries the open.]

**Demo framing**
[Full frame, inset, rounded corner. Where to zoom and when.]

**Motion graphics**
[Where animation earns its place and what it should do. Written as
intent, not keyframes. This is what /hyperframes-helper reads.]

**End card**
[Logo, one line, the action or URL]

**Pacing notes**
[Cut rhythm, where to hold, where to move]

---

## 8. Script

### 0:00 - 0:20 | Open: [the problem or purpose, stated]

**Speaker:** [name] ([on camera / voiceover])

**On screen:** [text that appears, if any]

**Visual:** [what the viewer sees]

**Script:**
[The spoken words, written for the ear.]

**Words:** [n] (allocated: [n])

---

### 0:20 - 0:55 | Belief 1: [belief]

**Speaker:** [name] ([mode])

**On screen:** [text]

**Visual:** [including CAPTURE 1 and its timing]

**Script:**
[Spoken words. Written to the capture sequence, so the narration
never gets ahead of the screen.]

**Words:** [n] (allocated: [n])

---

[Continue for every beat. Close last.]

---

## 9. Budget Reconciliation

Budget: [n] words / [m:ss]
Draft: [n] words / [m:ss]
Variance: [+/- n] words / [+/- m:ss]

[If cuts were made, list what was cut and what it cost. If the runtime
target was raised, say so and say why.]

---

## 10. Checks

**Voice review** (`/rolemodel-voice`)
- Humble Confidence: [score, note]
- Trusted Partnership: [score, note]
- Instructive Clarity: [score, note]
- Practical Value: [score, note]
- AI patterns flagged: [any]
- Non-negotiables: [pass or the violation]

**Spoken check**
- [ ] Sentences under 18 words, or deliberately longer for effect
- [ ] Contractions throughout
- [ ] No parentheticals, semicolons, or page-only constructions
- [ ] Reads aloud without stumbling
- [ ] Numbers spoken the way a person says them
- [ ] Opens by defining the problem or purpose
- [ ] Closes with a summary and one action

**Compliance**
- [ ] Objective stated as a viewer action, with a fallback
- [ ] Four A's completed
- [ ] Three or fewer beliefs, or four to five with a stated reason
- [ ] No belief padded to fill the structure
- [ ] Every belief has support the viewer can see or hear
- [ ] Middle serves the purpose, ordered by what builds
- [ ] Speaker count justified, every speaker has a stated purpose
- [ ] Demo captures timed and tied to specific beats
- [ ] B-roll offered as recommendation with alternatives
- [ ] Visual direction usable by an editor and by /hyperframes-helper
- [ ] Script reconciled against the word budget

---

## 11. Production Notes

[Anything the person shooting or editing needs that does not fit above.
Locations, scheduling constraints, who owns which capture, existing
footage locations, deadline.]
```
