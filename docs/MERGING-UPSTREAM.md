# Merging OpenScreen upstream

Read this before resolving conflicts in `../openscreen`. It records the decisions
this fork has already made, so the next merge does not re-derive them from the
diff. Every entry here cost real time to work out once.

```bash
pnpm run forks:check              # how far behind are we, and how big is our diff
pnpm run forks:upgrade --dry-run  # what an upgrade would do
pnpm run forks:upgrade            # branch, merge, resolve the mechanical half
```

## The one rule

**Merge every upstream minor release, not every fifth one.** The 1.12.2 catch-up
took a day: 526 commits, 39 conflicts, and two duplicate declarations that would
not compile. None of it was hard. All of it was volume. A merge per release is an
hour; a merge per quarter is a project, and the cost is superlinear because
upstream and this fork keep building the same features independently in between.

`pnpm run forks:check` prints the gap — the release distance and the size of our
diff on upstream's source. When it names more than one release, that is the signal.
It is deliberately not part of `pnpm run check`, which has to pass for people who
never clone the fork, so this one is on you to run.

## Standing decisions

These are settled. Do not relitigate them mid-merge.

**The stock wallpapers stay deleted.** `public/wallpapers/wallpaper{1..18}.jpg`
and their thumbs were removed by "The brand boards, and only the brand boards" —
a branded build offering eighteen stock gradients invites a video that is
off-brand by one click. Upstream keeps recompressing them, which is 36
delete/modify conflicts per merge. `forks:upgrade` resolves these; you should
never see them.

Consequence worth remembering: any upstream code that *names* a stock wallpaper
is broken here. In 1.12.2 that was `DEFAULT_PROJECT_APPEARANCE` in
`src/lib/projectDefaults.ts`, which now points at `DEFAULT_WALLPAPER`. Fix these
at the source, not at each caller — `stylePresets` and `sceneDescription` read
that block directly, and an override in `editorSettings` alone left both broken
in ways only the tests caught.

**The brand boards live at `/wallpapers/brand/`.** Anything upstream writes that
gates on `^/wallpapers/wallpaper\d+\.jpg$` needs widening. `BUNDLED_WALLPAPER_RE`
in `src/lib/ai-edition/stylePresets.ts` is one; keep the guarantee it is making
(relative, extension-pinned, no traversal, no URL) rather than loosening it.

**The language UI is commented out, not deleted.** `LaunchWindow.tsx`,
`EditorTopBar.tsx`'s `LangButton`, and their tests. Upstream keeps adding tests
that click it; comment those out beside the rest with a note, and **refresh the
commented block from upstream's version** so what comes back later is current
rather than a rewrite that was already stale.

**The product is "RoleModel Studio", from `PRODUCT_NAME`.** Upstream hardcodes
`"OpenScreen"` in markup and in test assertions. A branded fork cannot. Where
upstream asserts the literal, adapt the test to the fork's actual contract — do
not weaken the assertion, and do not change the branding to make a test pass.

**The version line is this fork's own `0.0.x`.** Not upstream's. Adopting 1.12.2
would collide with upstream's numbering in the Homebrew cask forever. Take
upstream's `package.json` changes and keep our `version` field.

**`open-media-file-picker` and `open-audio-file-picker` are different features.**
Ours browses a Studio project's `media` folder; upstream's imports one audio file
onto the timeline. Same shape, different jobs. Keep both. This is the pattern to
expect: when both projects build toward the same need, the answer is usually a
union, and upstream's half is usually the more thorough one because they had the
issue report.

**Generated files are committed on purpose.** `src/styles/optics-tokens.css`,
`src/lib/brandWallpapers.ts`, `public/wallpapers/brand/`, `icons/`, and
`website/docs/rolemodel/` are written by this toolkit, and committed because the
fork builds in CI with no toolkit checkout beside it. They are fork-only paths, so
they do not conflict — but if a brand input changed, regenerate rather than
hand-editing:

```bash
pnpm run optics-tokens   # src/styles/optics-tokens.css
pnpm run wallpapers      # public/wallpapers/brand/ + src/lib/brandWallpapers.ts
pnpm run icon            # icons/ + src/assets/rolemodel-mark.svg
pnpm run sync-docs       # website/docs/rolemodel/
```

`website/src/components/Recreation/generated.ts` is the exception that *is*
generated from the app's own source, so upstream invalidates it. After a merge:

```bash
cd ../openscreen/website && node scripts/gen-recreation.mjs --check
```

It needs Node ≥ 22.15 (`registerHooks`), which the repo's pinned 22.22.1 has.

## Resolving the rest

Nothing below is automatable. It is the same three questions each time.

1. **Is the conflicting code ours at all?** Check the merge base before assuming.
   In 1.12.2 the `MediaPane` block in `LeftPanel.tsx` looked fork-only and was
   not: it predated the fork, upstream deleted it as orphaned, and keeping "our"
   side would have resurrected 500 lines nothing imports. `git grep <symbol>
   <merge-base>` answers this in one command, and a grep for consumers answers
   whether it matters.

2. **Did both sides build the same thing?** Then upstream's version usually wins
   and ours becomes a fallback — but look for duplicate declarations the merge
   left behind. In 1.12.2 both `SUPPORTED_AUDIO_EXTENSIONS` and
   `approveReadableMediaPath` ended up defined twice and the merge looked clean.
   `npx tsc --noEmit` finds these; run it before the tests.

3. **Does a fix belong where the conflict is?** Usually not. The conflict is
   where git noticed, not where the disagreement lives.

## Verifying

```bash
cd ../openscreen
npm ci && npx tsc --noEmit && npm test && npx biome check .
```

Get a baseline first — some tests already fail on `main`, and knowing which ones
turns a scary test run into a short list. A worktree at `main` sharing the merge
branch's `node_modules` gives you one in a couple of minutes:

```bash
git worktree add --detach /tmp/baseline main
ln -s "$PWD/node_modules" /tmp/baseline/node_modules
(cd /tmp/baseline && npx vitest --run --reporter=dot)
```

At 1.12.2 the baseline was six failing `ProviderSettings` tests, and the merge
introduced four more — all four real, all four worth fixing.
