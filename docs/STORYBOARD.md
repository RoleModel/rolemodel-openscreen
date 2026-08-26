# The storyboard

Deciding which take to use is a different job from assembling a cut, and the
Studio now has a panel for each.

**Cut** asks one question — which clips, in what order — and answers it with a
list. That is the right shape for assembling and the wrong shape for deciding,
because deciding happens before there is an order: you shoot a thing four times,
you look at the four, you keep one. A list cannot hold three rejected takes
without pretending they are part of the video.

## The three things on a board

| | is |
|---|---|
| **Shot** | a hole in the video the brief says must be filled. Ordered, named, with a target length. Exists before any footage does. |
| **Take** | a candidate for one shot — a span of one file. Many per shot. |
| **Pick** | which take won its shot. One per shot, or none yet. |

Shots run across the canvas and takes stack down, so reading across tells you
what the video is and reading down one column tells you what you have for that
shot. Both get answered by looking rather than by remembering, which is the
entire reason this is a canvas.

## The picks are the cut

There is no "add to cut" step, deliberately. Choosing a take per shot **is** the
edit decision, so the footer's action compiles the board rather than exporting
it — [`toCutlist`](../lib/storyboard.mjs) is a projection of the picks, not a
copy of them.

Two consequences worth stating:

- A board with every shot settled is already a finished assembly. The button only
  writes it down.
- Nothing can drift, because there is no second copy to drift from.

A shot with nothing picked is a **hole** in the assembly and is left as one. A
black slug pretending to be footage would hide the one thing you need to know.

## Rating

Four answers, not five stars. Five invites a 3, and a 3 is not a decision — the
point of rating takes is to narrow.

| | means |
|---|---|
| **Hero** | the one to build around |
| **Good** | usable, not the best |
| **Maybe** | only if nothing better |
| **Reject** | argued against, kept as evidence |

Rejected takes stay on the board. A take somebody argued against is evidence, and
hiding it means re-litigating it next week.

A take's score is the **mean** of the latest rating from each person, never the
sum: four people calling something Good must not beat one person calling it Hero
purely by turnout. One rating per person per take, last one wins — rating
something twice is changing your mind, not voting twice. The history log keeps
both, so "we all agreed" can be checked rather than asserted.

The ratings **suggest**; they never decide. An explicit pick always wins, and the
board says `leading on ratings` rather than `chosen` when nobody has picked —
claiming a decision nobody made would be worse than offering no suggestion.

## Editing the shot list renames things

Shot ids derive from position and name, so **an edited shot name is a new shot**
and its takes stay attached to the old one. The panel warns before it does this.

That is the safe direction to be wrong in: the alternative is a take silently
moving under a shot nobody offered it for. Renaming costs a re-link, which is the
honest price of that guarantee.

## Where it lives

```
<project>/
  storyboard.json    the board, whole — plain JSON, hand-editable
  history.jsonl      every rating, pick and comment, appended, never rewritten
```

Two files because they answer different questions and fail differently.
`storyboard.json` is **state**: rewritten whole, last write wins.
`history.jsonl` is **what happened**: append-only, so a bad merge, a crash
mid-write or somebody's clock being wrong costs you the current state and not the
record of how it got there. When they disagree, the log is right.

The board is written atomically (write-then-rename) because it is saved on every
rating — a truncated `storyboard.json` is a matter of when rather than whether,
and its failure mode is losing every rating at once.

A board that will not parse is **reported, never replaced**. Falling back to an
empty board would write that empty board over a file that still holds everyone's
ratings, and the only symptom would be a board that looks new.

## Collaboration

### What works today

`local`: ratings and picks stay in the project folder. Everything above is real
and tested.

Footage is named by its place in the project (`rel`), never by an absolute path —
`/Users/dallas/RoleModel Library/…` identifies nothing on a teammate's machine.
Take ids are derived from `rel` plus the span, so the same span offered by two
people collapses to one take rather than becoming two that no merge could
reconcile. The board is portable by construction; only the transport is missing.

### The merge

Written in [`storyboard.mjs`](../lib/storyboard.mjs) rather than in a sync
adapter, because it is arithmetic and not transport: a file-based merge and a
hosted one have to produce the same answer.

| | rule | why |
|---|---|---|
| ratings | union, last-write-wins per (person, take) | nobody's opinion is dropped, and changing your mind is respected |
| takes | union by id | ids are spans, so the same span from two people is one take |
| comments | union by id, never overwritten | losing what somebody said is worse than showing two similar things |
| picks | last-write-wins per shot, by timestamp | a pick is a decision, and the most recent one stands |
| shots | the newer brief's, not the union | two people cannot both be right about what the video needs |

Picks are the one place a merge can genuinely lose information. That is why they
carry a timestamp and why the ratings are kept whole underneath them — the
argument survives even when the conclusion is overwritten.

Sync is always **pull, merge, push**, in that order. Pushing first would
overwrite whatever arrived since the last pull with a board that never saw it,
which is exactly how somebody's ratings disappear between two people looking at
the same screen.

## Supabase is wired up and has not been run

This is the part to read before switching.

`SUPABASE_SYNC` in [`board-store.mjs`](../lib/board-store.mjs) is a stub. Nothing
here has talked to a Supabase project: there is no schema applied, no anon key,
and no row-level security policy. It is wired so that finishing it is an
implementation rather than a redesign, and left `ready: false` so nobody
discovers it is untested by having a review fail in front of a client.

`syncFor` refuses an adapter that is not ready, so **storing `"supabase"` does
not turn it on** — it records an intent that takes effect when the adapter works.

### What has to be true before `ready` flips

1. A `storyboards` table exists, keyed by project id, with `ratings`, `takes` and
   `comments` as jsonb.
2. **RLS is on**, with a policy scoped to the team, tested by trying to read
   another team's row with a real anon key. This is the part that matters: a
   board carries client names and unreleased footage paths, and a permissive
   policy on a public anon key publishes both.
3. `whoami` resolves to a **person**, not a device. Ratings are attributed, and
   "someone on a Mac said Hero" is not attribution.
4. A pull-merge-push round trip has been run from two machines at once and the
   ratings from both survived.

The merge must run **client-side on every pull** — `mergeBoards`, not a
server-side upsert of individual fields. Two people rating different takes in the
same second must both survive, and a last-write-wins on the whole row would drop
one.

### Who a rating belongs to

Ratings are signed on the **server**, from the stored reviewer name, never from
the request body. A client that names its own rater can rate as anybody, and the
entire value of a rating is whose it is.

The name falls back to the OS account when unset. That is fine for a
single-machine board and is not good enough for a shared one — see point 3 above.

## What is not built

- **Live presence and cursors.** The interface has four functions and no more;
  anything richer is a property of one backend and would have to be faked by the
  local adapter.
- **Comments in the UI.** The route, the model and the merge rule all exist and
  are tested; nothing draws them yet.
- **Re-linking takes after a rename.** Today they stay on the old shot and you
  re-add them.
- **Trimming a take on the board.** In and out are typed. The editor is where
  frames get chosen, and duplicating that here would be a worse copy of it.
