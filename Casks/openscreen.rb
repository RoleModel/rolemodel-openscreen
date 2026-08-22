# Cask for the OpenScreen app itself.
#
# This is why the tap earns its keep: `brew install rolemodel/tap/rm-video`
# now pulls Node, OpenScreen, and the brand toolkit in one command. Nobody
# installs four things by hand, and nothing gets committed to the repo.
#
# There is no OpenScreen cask in homebrew-cask (checked 2026-08-22), so this
# one lives in our tap. Upstream *has* an update-homebrew-cask.yml, but it has
# never been configured — no HOMEBREW_TAP_OWNER, no tap repo, and the job it
# guards has been skipping green on every release (their issue #335). So do not
# read the existence of that workflow as a cask to depend on. If they ever wire
# it up, delete this file and point `depends_on cask:` at theirs.
#
# Lives in Casks/ here to mirror the tap exactly, because Homebrew resolves by
# directory: this same file under Formula/ is a formula that fails to load, and
# `depends_on cask: "rolemodel/tap/openscreen"` in rm-video.rb will not resolve
# until it sits at github.com/rolemodel/homebrew-tap -> Casks/openscreen.rb.
cask "openscreen" do
  # Not "arm64"/"x64". electron-builder's artifactName produces those, but
  # build.yml renames each DMG before attaching it to the release — deliberately,
  # so the download is named after the machine About This Mac describes rather
  # than the instruction set. Trusting artifactName here is a 404, and the first
  # symptom is `brew install` failing on a download nobody can find.
  arch arm: "Apple-Silicon", intel: "Intel"

  version "1.9.6"

  # Verified against the v1.9.6 release assets on 2026-08-22. Both are computed
  # from the published DMGs, so `brew fetch --cask` should be silent; if it
  # reports a mismatch, upstream re-cut the release under the same tag.
  sha256 arm:   "0152bf29ad315e7a56ea3a128c809cd326d03756adf5f6756393e596f1743369",
         intel: "bca548c3661670cdf3ede27299c2354280e7bc8702efad348cf866080131474a"

  # Releases before this naming change used `-Mac-arm64-` / `-Mac-x64-`, so this
  # URL does not resolve for older versions. Bump both this and the checksums
  # together, or not at all.
  url "https://github.com/getopenscreen/openscreen/releases/download/v#{version}/Openscreen-macOS-#{arch}-#{version}.dmg",
      verified: "github.com/getopenscreen/openscreen/"

  name "OpenScreen"
  desc "Screen recorder and editor for product demos"
  homepage "https://github.com/getopenscreen/openscreen"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Pre-1.0 and shipping fast — warn rather than silently install something old.
  auto_updates false

  app "Openscreen.app"

  # The whole reason to bother: the CLI lives inside the app bundle, so without
  # this you are typing /Applications/Openscreen.app/Contents/MacOS/Openscreen
  # every time. This puts `openscreen` on PATH like any other tool.
  binary "#{appdir}/Openscreen.app/Contents/MacOS/Openscreen", target: "openscreen"

  caveats do
    <<~EOS
      OpenScreen needs Screen Recording permission before it can capture.
      macOS grants that to whatever binary hosts Electron, which means:

        - launching the app normally  -> grant it to Openscreen
        - driving the CLI from a shell -> grant it to your TERMINAL

      System Settings > Privacy & Security > Screen & System Audio Recording.
      A permission failure is a settings toggle, not something to retry.

      This build is not notarized by RoleModel. On first launch macOS may need
      you to approve it under Privacy & Security.
    EOS
  end

  zap trash: [
    "~/Library/Application Support/Openscreen",
    "~/Library/Preferences/com.etiennelescot.openscreen.plist",
    "~/Library/Saved Application State/com.etiennelescot.openscreen.savedState",
    "~/Library/Logs/Openscreen",
  ]
end
