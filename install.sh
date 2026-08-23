#!/bin/sh
# One command, from nothing to a working pipeline.
#
#   curl -fsSL https://raw.githubusercontent.com/RoleModel/rolemodel-openscreen/main/install.sh | sh
#
# Setting this up used to be twenty commands across three repositories, a tap, a
# cask, a Python virtualenv and a Docker stack, in an order you had to know. That
# is not a setup, it is a quiz. This does the whole thing, and it is safe to run
# again: every step checks before it acts, so a second run only does what the
# first one could not.
#
# It deliberately does NOT do the optional halves. The voice virtualenv, the
# HyperFrames skills, rclone and OpenFrame are handled by `rm-setup`, which this
# hands off to at the end — that way there is one place that knows how to check
# and repair an install, rather than two that can disagree.
set -eu

TAP="rolemodel/tap"
FORMULA="$TAP/rm-video"
CASK="$TAP/rolemodel-openscreen"

# Colour only when someone is watching. A log file full of escape codes is worse
# than a plain one, and this is exactly the script whose output gets pasted.
if [ -t 1 ]; then
	B=$(printf '\033[1m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m'); D=$(printf '\033[2m'); R=$(printf '\033[0m')
else
	B=''; G=''; Y=''; D=''; R=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s\n' "$G" "$R" "$B" "$1$R"; }
skip() { printf '  %salready done%s  %s\n' "$D" "$R" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$R" "$1"; }
die()  { printf '\n%sinstall failed:%s %s\n\n' "$Y" "$R" "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s)" in
	Darwin) ;;
	*) die "this is macOS only for now — the capture path is ScreenCaptureKit" ;;
esac

say ""
say "${B}RoleModel video pipeline${R}"
say "${D}record -> brand -> edit -> share${R}"

# ── Homebrew ────────────────────────────────────────────────────────────────
# Everything else is a brew package, so this is the one hard prerequisite. It is
# not installed silently: it writes to /opt/homebrew and asks for a password, and
# a script that does that without saying so is a script nobody should pipe to sh.
step "Homebrew"
if have brew; then
	skip "$(brew --version | head -1)"
else
	warn "Homebrew is not installed, and it needs your password to set up /opt/homebrew."
	say  "  Install it first, then run this again:"
	say  ""
	say  '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
	say  ""
	die  "Homebrew required"
fi

# ── the tap ─────────────────────────────────────────────────────────────────
step "Tap $TAP"
if brew tap | grep -qx "$TAP"; then
	skip "$TAP"
else
	brew tap "$TAP"
fi

# ── the toolkit ─────────────────────────────────────────────────────────────
# Seven commands and the openscreen shim. The shim matters: a cask's `binary`
# stanza is a symlink, and Electron resolves its helper apps relative to the
# running executable — through a symlink it computes the wrong base and dies.
step "The toolkit"
if brew list --formula 2>/dev/null | grep -qx "rm-video"; then
	skip "rm-video $(brew list --versions rm-video 2>/dev/null | awk '{print $2}')"
	brew upgrade "$FORMULA" 2>/dev/null || true
else
	brew install "$FORMULA"
fi

# ── the app ─────────────────────────────────────────────────────────────────
# Not a formula dependency on purpose. Until the fork has cut a release the cask
# points at a version that does not exist, and making the toolkit depend on it
# would mean neither installs. So it is attempted, and a failure here leaves you
# with a working toolkit and a clear reason rather than nothing at all.
step "The app"
if brew list --cask 2>/dev/null | grep -qx "rolemodel-openscreen"; then
	skip "rolemodel-openscreen"
elif brew install --cask "$CASK" 2>/dev/null; then
	say "  installed"
else
	warn "the cask is not installable yet."
	say  "  ${D}It needs a release of the fork to point at. Someone has to enable Actions once:${R}"
	say  "    https://github.com/RoleModel/openscreen/actions"
	say  "  ${D}Then, in the tap: node scripts/update-cask.mjs rolemodel-openscreen <tag>${R}"
	say  "  ${D}Everything except recording works without it.${R}"
fi

# Upstream's cask installs `openscreen` as a symlink into the bundle, which
# collides with our shim and breaks helper resolution. Say so rather than letting
# brew report a mysterious link conflict.
if brew list --cask 2>/dev/null | grep -qx "openscreen"; then
	warn "the upstream 'openscreen' cask is installed and will fight this one:"
	say  "    brew uninstall --cask openscreen"
fi

# ── everything else ─────────────────────────────────────────────────────────
# One place knows how to check and repair an install, and it is not this file.
step "The rest"
if have rm-setup; then
	say "  ${D}handing off to rm-setup — it checks each piece before touching it${R}"
	say ""
	rm-setup || warn "rm-setup reported something it could not do; see above."
else
	die "rm-video installed but rm-setup is not on PATH — brew doctor may explain why"
fi

say ""
say "${G}Done.${R} Start it with:"
say ""
say "    ${B}rm-studio${R}      ${D}# the Studio, on :4600${R}"
say ""
say "${D}The map, the sequence and what is not finished yet:${R}"
say "${D}  https://github.com/RoleModel/rolemodel-openscreen/blob/main/docs/KICKOFF.md${R}"
say ""
