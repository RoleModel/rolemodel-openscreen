# packaging

The formula and casks live here, and this is the only copy anyone edits.

They *ship* from `RoleModel/homebrew-tap`, because Homebrew resolves
`brew tap rolemodel/tap` to a repository named `homebrew-tap` and nothing else —
that naming rule is the entire reason a second repository exists. So the tap is a
publishing target, not a place to work: `npm run sync-tap` copies these files
across and commits them.

Editing the tap directly is how the formula and the code it describes drift
apart, which already happened once — the toolkit carried its own stale copy of
`rm-video.rb` alongside the tap's, with a comment explaining that the copy
existed so the two would move together. They did not.

| file | is |
|---|---|
| `rm-video.rb` | the formula: seven CLIs and the `openscreen` shim |
| `rolemodel-openscreen.rb` | the cask for our fork of the app |
| `openscreen.rb` | the cask for upstream's build, kept for comparison |
| `update-cask.mjs` | reads a release's installers, hashes them, writes version + checksums |

## Cutting a release of the app

```sh
# 1. tag the fork — build.yml triggers on v*
cd ../openscreen && git tag -a v1.9.6-rm.2 -m "…" && git push origin v1.9.6-rm.2

# 2. whisper-stt artifacts expire, and the build refuses to package without them
gh workflow run build-whisper-stt.yml --repo RoleModel/openscreen

# 3. once both are green, point the cask at the release
node packaging/update-cask.mjs rolemodel-openscreen v1.9.6-rm.2

# 4. publish
npm run sync-tap
```

Step 2 is not optional and not obvious: the macOS job stages whisper binaries
from that other workflow's artifacts, and refuses to build rather than ship an
installer with speech-to-text silently dead. On a fresh fork it has never run, so
the first release always fails until it does.
