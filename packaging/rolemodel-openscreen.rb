# Cask for RoleModel's fork of OpenScreen.
#
# Separate from `openscreen.rb`, which installs upstream's release. This one
# installs github.com/RoleModel/openscreen, which differs in ways the toolkit
# depends on:
#
#   - `openscreen open <project.openscreen>` opens a document in the editor.
#     Upstream has no way in at all: its bundle declares no document type, so
#     `open <file>` has nothing to route to; `open -a Openscreen <file>` launches
#     the app and discards the argument; and a bare path is a silent no-op. The
#     Studio's "open this in OpenScreen" is that verb.
#   - `.openscreen` is declared as a document type, so Finder double-click and
#     `open` both work.
#   - The compositor build finds cargo without assuming rustup's layout, which is
#     what stopped a Homebrew Rust from building it.
#
# The two casks install the same app name and cannot coexist; see conflicts_with.
#
# GENERATED FIELDS: `version` and both `sha256` values come from a release, and
# are written by `scripts/update-cask.mjs`. Do not hand-edit them — run
#
#   node scripts/update-cask.mjs rolemodel-openscreen <tag>
#
# which reads the release's assets and rewrites this file. Upstream ships an
# update-homebrew-cask.yml that has never been configured (their issue #335),
# which is exactly the failure mode that script exists to avoid: a cask nobody
# updates is a cask that installs last month's build.
cask "rolemodel-openscreen" do
  # Not "arm64"/"x64". electron-builder's artifactName produces those, but
  # build.yml renames each DMG before attaching it to the release, so the
  # download is named after the machine About This Mac describes. Trusting
  # artifactName here is a 404 whose first symptom is a failed install.
  arch arm: "Apple-Silicon", intel: "Intel"

  version "0.0.0-unreleased"
  sha256 arm: "0000000000000000000000000000000000000000000000000000000000000000",
         intel: "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/RoleModel/openscreen/releases/download/v#{version}/Openscreen-macOS-#{arch}-#{version}.dmg",
      verified: "github.com/RoleModel/openscreen/"

  name "OpenScreen (RoleModel)"
  desc "Screen recorder and editor for product demos, with the RoleModel pipeline's CLI additions"
  homepage "https://github.com/RoleModel/openscreen"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates false

  # Same bundle name as upstream, so both casks would fight over
  # /Applications/Openscreen.app. Homebrew's own error for that is about a
  # pre-existing app rather than about two casks, so say it here instead.
  conflicts_with cask: "openscreen"

  app "Openscreen.app"

  # No `binary` stanza, on purpose.
  #
  # The obvious thing — `binary "#{appdir}/Openscreen.app/Contents/MacOS/Openscreen"`
  # — installs a symlink, and Electron resolves Contents/Frameworks/*Helper*.app
  # relative to the running executable. Through a symlink it computes the wrong
  # base and dies with
  #
  #   FATAL:electron_main_delegate_mac.mm:65] Unable to find helper app
  #
  # `--help` survives because it never forks; `record` and `sources` do not. Same
  # binary, same arguments, different path. So `openscreen` on PATH comes from the
  # rm-video formula instead, which installs a shim that execs the real bundle
  # path — see bin/shims/openscreen in the toolkit.

  caveats do
    <<~EOS
      `openscreen` is put on PATH by the rm-video formula, not by this cask:

        brew install rolemodel/tap/rm-video

      A symlink to the binary inside the bundle breaks Electron's helper-app
      resolution, so the formula installs a shim that execs the bundle path.

      OpenScreen needs Screen Recording permission before it can capture, and
      macOS grants that to whatever binary hosts Electron:

        - launching the app normally  -> grant it to Openscreen
        - driving the CLI from a shell -> grant it to your TERMINAL

      System Settings > Privacy & Security > Screen & System Audio Recording.
      A permission failure is a settings toggle, not something to retry.

      This build is ad-hoc signed, not notarized: the release job signs with a
      certificate only when one is configured, and this fork configures none. On
      first launch macOS will need you to approve it under Privacy & Security.
    EOS
  end

  zap trash: [
    "~/Library/Application Support/Openscreen",
    "~/Library/Application Support/openscreen",
    "~/Library/Preferences/com.etiennelescot.openscreen.plist",
    "~/Library/Saved Application State/com.etiennelescot.openscreen.savedState",
    "~/Library/Logs/Openscreen",
  ]
end
