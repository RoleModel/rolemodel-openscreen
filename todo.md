# todo — install path

Findings from a review of all four repos (`rolemodel-openscreen`, `openscreen`
fork, `OpenFrame`, `homebrew-tap`) on 2026-08-25, looking for what breaks when
someone installs this from nothing.

Ordered so each item unblocks the next. #1 needs a decision rather than a commit,
so it sits at the top but does not block the rest.

## State this was written against

| repo | branch | tags | releases |
|---|---|---|---|
| `rolemodel-openscreen` | `main` | `v0.0.1` | none |
| `openscreen` (fork) | `main` | `v0.0.1`, plus upstream `v1.x` | `v0.0.1`, 13 assets |
| `OpenFrame` | `master` | `v0.1.0`, `v0.1.1` | none |
| `homebrew-tap` | `main` | — | — |

The tap went public 2026-08-24 14:39 UTC and the cask picked up real checksums the
same afternoon. Before that `brew tap rolemodel/tap` failed for everyone outside
the org — worth knowing if a bug report predates that.

What already holds, so nobody re-does it: the tap clones anonymously; the
formula's `sha256` matches the `v0.0.1` tarball byte for byte; both cask
checksums verify (`brew fetch --cask --arch intel` and a hand hash of the arm
DMG); both DMGs exist under exactly the names the cask builds; `packaging/` and
the tap are in sync with zero drift; all eight CLIs and the shim link and run;
`rm-setup --check` is clean.

---

## 1. Decide what to do about signing

Every DMG is unsigned, and Gatekeeper rejects it:

```
spctl -a -vv -t install <dmg>   →  rejected, source=no usable signature
xcrun stapler validate <dmg>    →  does not have a ticket stapled
codesign -dvv Openscreen.app    →  Signature=adhoc, TeamIdentifier=not set
```

Casks quarantine what they install. Ad-hoc plus quarantine on macOS 15/26 is the
"Apple could not verify this app is free of malware" dialog, and right-click-open
no longer defeats it — the only way through is System Settings → Privacy &
Security → Open Anyway. This is the first thing a new installer meets.

Two ways out, and they are not equivalent:

- Configure a Developer ID cert and the notarization secrets in the fork's
  `build.yml`. It already has `Sign DMG`, `Notarize DMG` and `Validate stapled
  DMG` steps that no-op when no certificate is configured, so this is
  configuration rather than code.
- Or keep it ad-hoc and rewrite the cask's caveats to name the exact clicks.
  "approve it under Privacy & Security" undersells what the dialog actually says.

## 2. Point `release.yml` at the fork, not upstream

`.github/workflows/release.yml:29` clones `getopenscreen/openscreen`, and then
`lib/verify.mjs` asserts against files that only exist in RoleModel's fork. So
`verify` can never pass, the `release` job never runs, and there are zero releases
of this repo. Everything in the tap got there by hand.

Proven both directions:

- Run `32729680712` (on `v0.0.1`) failed in 16s with
  `ENOENT ... /tmp/openscreen/electron/studio-preload.ts`. That path 404s on
  `getopenscreen/openscreen` and exists on `RoleModel/openscreen`.
- `node lib/verify.mjs --openscreen ../openscreen` → **901 passed, 0 failed**.

Change the clone to `https://github.com/RoleModel/openscreen.git`. Pin a ref
while you are there — a `--depth 1` of a moving `main` means a green tag can turn
red later with nothing changed here.

## 3. Fix the tap step in `release.yml`

Even with #2 done the job dies at `cp`. `release.yml:82` and `:87` copy
`Formula/rm-video.rb` and `Casks/openscreen.rb` from the repo root. Neither path
exists: the files live in `packaging/`, and the openscreen cask was deliberately
deleted (tap `75b8696`). It never copies `rolemodel-openscreen.rb` or
`update-cask.mjs` at all.

The comment justifying the openscreen copy cites `rm-video`'s `depends_on cask:`,
which the formula no longer has — delete the comment with the line.

Replace the three `cp`s with the thing that already knows the layout:

```sh
node lib/sync-tap.mjs --tap /tmp/tap
```

then keep the two `sed`s that write `url` and `sha256` into the formula.

Also: `TAP_TOKEN` is not set. `gh secret list` is empty on all three repos, so
the step warns and exits 0 no matter what else is fixed.

## 4. Cut a tag whose version matches the code

The formula pins `v0.0.1`, the only tag, and `git rev-list --count
v0.0.1..origin/main` is 14. Worse, `package.json` says `0.1.0` — inside the
`v0.0.1` tarball too. So `brew info` reports "stable 0.0.1" while the installed
code is 0.1.0, and the tap's own commits say "Sync packaging from
rolemodel-openscreen 0.1.0". There is no `v0.1.0` tag.

After #2 and #3, tag `v0.1.0` and let the workflow do the rest. Until then brew
ships August 24th's tree.

## 5. Document `brew trust` everywhere the manual path appears

Homebrew 6 refuses to load from an untrusted third-party tap, and the refusal is
an error rather than a prompt. `install.sh` handles it. Nothing else does — grep
finds `brew trust` in that one file and nowhere else.

So each of these fails at its first line for anyone on Homebrew 6:

- `README.md:27-29` — the "you can do that by hand if you prefer" block
- `docs/KICKOFF.md:63,89`
- `packaging/README.md` and the tap's `README.md`
- **`bin/rm-setup.mjs:151-153`** — the repair command for the app is
  `brew tap rolemodel/tap && brew install --cask …` with no trust step. The tool
  whose job is fixing a broken install cannot fix this one. Fix this first; it is
  the only one that is code rather than prose.

## 6. Decide what `rm-demo` does on a brew install

The formula does `libexec.install Dir["*"]` and nothing else, so `npm install`
never runs and there is no `node_modules` —
`/opt/homebrew/Cellar/rm-video/0.0.1/libexec/node_modules` does not exist.

But `package.json` carries a real runtime dependency (`playwright-recast`), and
`bin/rm-demo.mjs` imports playwright at three call sites, each dying with
`playwright is not installed here — npm install`. A brew user cannot act on that:
the Cellar is wiped on upgrade.

`rm-video presets` and `rm-demo check` work. `rm-studio` survives via its
`npx --yes playwright-recast` fallback. `rm-demo`'s recording verbs do not, and
it is one of the eight CLIs `caveats` advertises.

Either add an `npm ci --omit=dev` (or Homebrew `resource`s) to the formula's
`install`, or say plainly in `caveats` that `rm-demo` needs a checkout.

## 7. Declare the minimum macOS in the cask

`brew audit --cask --online rolemodel/tap/rolemodel-openscreen` fails on exactly
one thing:

> Artifact defined :monterey as the minimum macOS version but the cask declared
> no minimum macOS version

On an older Mac brew currently installs an app that cannot launch. Add
`depends_on macos: ">= :monterey"` to `packaging/rolemodel-openscreen.rb`, then
`npm run sync-tap`.

## 8. Disarm `update-homebrew-cask.yml` in the fork

Inert today — `HOMEBREW_TAP_OWNER`, `HOMEBREW_TAP_REPO` and
`HOMEBREW_TAP_TOKEN` are all unset, and it warns loudly rather than skipping
green, which is the right shape. But it is pointed at a live weapon:

- It `cat >`s `tap/Casks/${CASK_NAME}.rb` from scratch. `CASK_NAME` defaults to
  `openscreen`, so configuring it recreates the cask that was deliberately
  dropped and that `conflicts_with cask: "openscreen"` exists to guard against.
- Set `HOMEBREW_CASK_NAME=rolemodel-openscreen` and it overwrites the
  hand-written cask with a generated stub: no `conflicts_with`, no shim caveats,
  and upstream's `com.etiennelescot.openscreen` zap paths.
- Its tag regex is `^v[0-9]+\.[0-9]+\.[0-9]+$`, which rejects the `-rm.N` scheme
  `build.yml` went out of its way to support — so it could never publish a fork
  release anyway.

Delete it in the fork, or hard-pin `CASK_NAME` and have it call
`scripts/update-cask.mjs` instead of writing Ruby.

## 9. Fix the messages a stuck user actually reads

- `bin/shims/openscreen`, last line: `brew install --cask rolemodel/tap/openscreen`
  names a cask that no longer exists. Should be `rolemodel-openscreen`. This is
  the exact text printed when the app is missing.
- `install.sh` runs `brew upgrade` on the formula but only *skips* the cask when
  it is already present, so a returning user never gets a newer app from the
  one-liner. Either upgrade both or say which one it will not touch.

## 10. Clean up what `brew style` and `brew audit` already flag

`brew style rolemodel/tap` → 9 offenses, 8 autocorrectable:

- cask: `caveats` and `zap` stanzas out of order, missing `depends_on :macos`
  (same fix as #7), `zap trash:` array not alphabetical
- formula `rm-video.rb:105`: `assert_predicate bin/entry, :exist?` should be
  `assert_path_exists` — this alone fails `brew audit --formula --strict`

Fix in `packaging/`, never in the tap, then `npm run sync-tap`.

## 11. Give the tap a CI workflow

`homebrew-tap` has no `.github/` at all. Nothing runs `brew audit`, `brew style`,
or `update-cask.mjs --check` on push. Every guarantee in that repo's README rests
on somebody remembering to run `npm run check` in this one — which is the same
failure mode as upstream's issue #335 that `update-cask.mjs` was written to
avoid.

A push workflow running those three is a handful of lines and closes the loop.

## 12. Get `npm run check` green before tagging

It currently fails at `optics:check`:

> `brand/optics/optics.css` does not match `brand/optics/manifest.json`
> (vendoredSha256) — it was hand-edited, or the export changed

This is an uncommitted edit in the working tree, not a committed defect. It
matters because it is the gate `release.yml` runs, so #4 cannot land while it is
red.

---

## Not problems

- **OpenFrame is clean.** `rolemodel/api-token` is fully merged to `master`,
  `lib/api-token.ts` is on `master`, `v0.1.0` and `v0.1.1` are tagged. It has no
  releases and CI has never run, but it installs by `docker compose` and
  `rm-setup` treats it as optional and manual, so it is not on the install path.
- **`packaging/` and the tap do not drift.** `sync-tap.mjs --check` reports all
  three files identical, and so does a diff of `origin/main` against
  `origin/main`.

## One caveat about testing locally

`openscreen` on Dallas's machine is a shell alias to
`/Applications/Openscreen.app/Contents/MacOS/Openscreen`, which masks the brew
shim in interactive shells. Anything checked by typing `openscreen` at a prompt
has not exercised the shim. `rm-setup` uses `sh -c`, so its check did hit the real
shim, and passed.
