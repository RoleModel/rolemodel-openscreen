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

## Sharing runs on the team's Postgres

`TEAM_SYNC` in [`board-store.mjs`](../lib/board-store.mjs) is the shared adapter.
It talks to one Postgres database — Neon today — through Drizzle over Neon's
HTTP driver ([`lib/db.mjs`](../lib/db.mjs), typed against
[`lib/schema.mjs`](../lib/schema.mjs)). The tables and the role it connects as
are in [`sql/studio.sql`](../sql/studio.sql).

`syncFor` refuses an adapter that is not ready, so **choosing "Everyone on the
team" does not turn it on** — it records an intent that takes effect when this
machine has a deployment and a sign-in. A machine that chose `"supabase"` before
the move is treated as having chosen the team.

### Where the credential lives

This repo is public and the database credential is not, so it is never
committed. The release workflow writes `lib/deployment.json` — the connection
string and the GitHub app's client id — from the repo's secrets
(`RM_DATABASE_URL`, `RM_GITHUB_CLIENT_ID`) into the tarball Homebrew installs.
Every install of a release carries it; a checkout does not, and sets
`RM_DATABASE_URL` and `RM_GITHUB_CLIENT_ID` in the environment to develop
against a database.

**Anyone who can install a release can reach the tables.** That is the
deliberate trade for a small team: one shared credential, no per-machine setup.
Two things keep it bounded:

- The credential is the `studio_app` role, which may read and write three tables
  and nothing else — no delete, no DDL. Never the owner's login; both the config
  and the release workflow refuse one.
- Rotating it is re-running `sql/studio.sql` with a new password, updating the
  secret, and cutting a release.

### Setting up the database, once

```sh
psql "$OWNER_URL" -v studio_password="<new password>" -f sql/studio.sql
gh secret set RM_DATABASE_URL --body "postgresql://studio_app:<new password>@<pooler host>/neondb?sslmode=require"
gh secret set RM_GITHUB_CLIENT_ID --body "<the OAuth app's client id>"
```

### Signing in is attribution, not access

Access is the credential above. Signing in says **whose** rating this is. It is
GitHub's device flow: press the button, a code appears, type it at
github.com/login/device, and the panel notices. No redirect, no callback port,
no client secret — the OAuth app only needs **Device Flow** enabled. The scopes
asked for are `read:user user:email`, and the token is kept in the same 0600
config file as the other tokens.

### What has to stay true

1. The role can reach three tables and cannot delete or alter anything.
2. `whoami` resolves to a **person**, not a device. Ratings are attributed, and
   "someone on a Mac said Hero" is not attribution.
3. The merge runs **client-side on every pull** — `mergeBoards`, not a
   server-side upsert of individual fields. Two people rating different takes in
   the same second must both survive, and a last-write-wins on the whole row
   would drop one.

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
