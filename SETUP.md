# Repo + Homebrew setup

Two repos. One holds the code, one is the tap Homebrew installs from — Homebrew
requires the tap repo be named `homebrew-<something>`, so they can't be the same repo.

```
rolemodelsoftware/rolemodel-openscreen   the toolkit
rolemodelsoftware/homebrew-tap           Formula/rm-video.rb  (and every future RM formula)
```

---

## 1. The code repo

From the unzipped folder:

```bash
git init -b main
git add .
git commit -m "RoleModel brand layer for OpenScreen"

gh repo create rolemodelsoftware/rolemodel-openscreen --private --source=. --push
# or, without gh:
#   git remote add origin git@github.com:rolemodelsoftware/rolemodel-openscreen.git
#   git push -u origin main
```

**Private or public?** It matters more than usual here, because of the tap.

- **Private** is the safe default — `brand/` holds RoleModel brand assets, and
  the `LICENSE` carves them out of the MIT grant.
  The cost: **a private tap can't be installed by an unauthenticated `brew`.**
  Everyone installing needs a GitHub token in their environment
  (`HOMEBREW_GITHUB_API_TOKEN`) plus repo access. For ~10 people who all have
  GitHub access anyway, that's a one-line addition to a shell profile — annoying,
  not blocking.
- **Public** makes `brew install` frictionless and the code is genuinely
  publishable (it's a thin, well-behaved layer over an MIT project). But it puts
  the wallpapers and palette in public. If you want that, split `brand/` into a
  private submodule first.

My read: **private repo, private tap, document the token.** The audience is
internal and the brand assets shouldn't be the thing you have to think about.

---

## 2. The tap

```bash
mkdir homebrew-tap && cd homebrew-tap
git init -b main
mkdir Formula
cp ../rolemodel-openscreen/Formula/rm-video.rb Formula/
git add . && git commit -m "rm-video formula"
gh repo create rolemodelsoftware/homebrew-tap --private --source=. --push
```

The formula in this repo is the source of truth; CI copies it into the tap and
fills in `url` + `sha256` on every tag. Keep editing it here, not there.

---

## 3. First release

```bash
npm version 0.1.0 --no-git-tag-version   # if you want a different starting version
git commit -am "v0.1.0" && git tag v0.1.0
git push --follow-tags
```

The workflow verifies the presets against a fresh OpenScreen checkout, smoke-tests
the CLI, cuts the release, and pushes the updated formula to the tap.

**One secret to add first:** `TAP_TOKEN` on the code repo — a fine-grained PAT
with `contents: write` on `homebrew-tap`. Without it the workflow warns and skips
the tap update rather than failing, so the release still happens; you just bump
the formula by hand that once.

---

## 4. Install

```bash
brew tap rolemodelsoftware/tap        # private tap: needs HOMEBREW_GITHUB_API_TOKEN set
brew install rm-video

rm-video presets
```

Then, in `~/.zshrc`, so the Claude skill can find the toolkit wherever brew put it:

```bash
export RM_OPENSCREEN="$(rm-video root)"
```

### Upgrading

```bash
brew update && brew upgrade rm-video
```

---

## Is Homebrew actually the right channel?

Worth asking, because there are three audiences and brew only serves one well.

| Audience | What they need | Best channel |
| --- | --- | --- |
| You, iterating on presets | the git checkout | `git clone`, run from source |
| An engineer running `rm-video` by hand | a binary on PATH | **Homebrew** ✅ |
| A craftsman who just wants a demo video | the *skill*, in their Claude | **a plugin**, not brew |

The third row is most of the company, and brew doesn't reach it. A craftsman is
never going to type `rm-video brand --preset academy --unit rails`; they're going
to say "record me a demo of the estimating screen" and let the skill do it.

The skill needs the toolkit on disk, which is what brew provides — so these
aren't competing, they're layered:

```
brew install rm-video        → toolkit on disk, RM_OPENSCREEN set
plugin install               → skill in everyone's Claude, calls the toolkit
```

`academy-video-template` is already distributed to the team as a plugin, so
that path exists and people know it. Bundling `skill/SKILL.md` the same way is
the step that makes this useful to more than three people.

### The alternative, if brew feels heavy

`npm i -g` skips the tap entirely and the formula maintenance with it:

```bash
npm install -g github:rolemodelsoftware/rolemodel-openscreen
```

It works, it upgrades with `npm update -g`, and private repos just use your
existing SSH key — no token dance. What you lose is a clean `brew upgrade` story
and the ability to declare the `node` dependency. For an internal tool that
every engineer already has Node for, that's a fair trade — reach for brew when
you want it to feel like a real tool, and npm when you want it to exist today.
