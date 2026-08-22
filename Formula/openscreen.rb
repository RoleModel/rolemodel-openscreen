# Cask for the OpenScreen app itself.
#
# This is why the tap earns its keep: `brew install rolemodel/tap/rm-video`
# now pulls Node, OpenScreen, and the brand toolkit in one command. Nobody
# installs four things by hand, and nothing gets committed to the repo.
#
# There is no OpenScreen cask in homebrew-cask (checked 2026-08-22), so this
# one lives in our tap. If upstream ever publishes one, delete this file and
# point `depends_on cask:` at theirs.
#
# Belongs in the TAP repo alongside rm-video.rb:
#   github.com/rolemodel/homebrew-tap -> Casks/openscreen.rb
cask "openscreen" do
  arch arm: "arm64", intel: "x64"

  version "1.9.6"

  # Placeholders. Fill them once with:
  #   brew fetch --cask rolemodel/tap/openscreen
  # Homebrew prints the real checksum on mismatch. Do it on both machines, or
  # compute directly:
  #   shasum -a 256 ~/Downloads/Openscreen-Mac-arm64-1.9.6-Installer.dmg
  sha256 arm:   "0000000000000000000000000000000000000000000000000000000000000000",
         intel: "0000000000000000000000000000000000000000000000000000000000000000"

  # Filename comes from electron-builder.json5:
  #   artifactName: "${productName}-Mac-${arch}-${version}-Installer.${ext}"
  url "https://github.com/getopenscreen/openscreen/releases/download/v#{version}/Openscreen-Mac-#{arch}-#{version}-Installer.dmg",
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
