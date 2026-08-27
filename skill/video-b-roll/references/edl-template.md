# EDL template

Copy into `marketing/drafts/<video-slug>/EDL.md` and fill in. This is the review
surface and the round-two cache. Everything a re-selection needs should be here,
so that changing a shot never means re-deriving the analysis.

---

# EDL: <title>

Built <date> - mode <A|B> - <runtime> - <WxH> - <fps> - <n> cutaways - <n>% coverage

## Sources

| Role | Path | Duration | Size | Notes |
|---|---|---|---|---|
| A-roll / anchor | | | | native res, fps, integrity result |
| voiceover | | | | locked? |
| B-roll / demo | | | | number of clips, native res, fps |

Integrity findings: <truncation, VFR, decode errors, and what was done about them>

## Anchor structure

Mode B: speaker and card map from scene detection cross-checked against the
transcript. Mode A: measured phrase boundaries.

| Time in | Time out | Content | Source of truth |
|---|---|---|---|
| 0:00 | 0:03.0 | Title card | scene cut |
| 0:03.0 | 0:11.8 | <speaker>, <role> | scene cut |

No-go zones: <title cards, question cards, animating lower thirds, name lines>

## Shot list

| # | Start | Dur | Under the line | Source | In | Rate | Peak | Why this shot |
|---|---|---|---|---|---|---|---|---|
| b2 | 0:19.1 | 4.12 | "..." | <file> | 130.0 | 1.00 | 3.4 | motivated by <line>; speaker in frame |

## Treatment

- Dissolve: <0.3s opacity, incoming layer only>
- Push: <scale 1.02 to 1.035 over the shot, ease none>
- Handles: <0.3s each side>
- Audio: <unbroken; all inserted footage silent>

## Standards exceptions

Anything outside `editorial-standards.md`, with its fallback.

- <b7 sits at peak 6.1, above the under-5 target. That clip is handheld end to
  end and this is its steadiest window that also shows the thing described. The
  thematic match won. Fallback if rejected: <other shot> at peak 2.2, losing
  <what>.>

## Proposed but not applied

Changes that need approval before they go in, written out concretely enough to
approve or decline on the spot.

- <voiceover permutation: current sentence, proposed sentence, spans, order>

## Verification

- `hyperframes check`: <0 findings / n findings>
- Dissolve midpoints snapshotted at: <times>, all showing a 50/50 blend
- Rendered-output motion re-scan: <per-shot peaks from the MP4, matching selection>
- Encoded MP4: <codec, duration, fps, channels, mean volume>

## Open items

- <what is unresolved, and what would resolve it>
