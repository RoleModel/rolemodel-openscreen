# Cask for RoleModel's fork of OpenScreen.
#
# Installs github.com/RoleModel/openscreen, which differs from upstream's release
# in ways the toolkit depends on:
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
#   - It is called RoleModel Studio, in the Dock, the menu bar, the About panel and
#     every permission prompt, and carries the RoleModel palette, mark and typeface.
#     The bundle on disk is still Openscreen.app — see the `app` stanza below, which
#     depends on that, along with the shim and the DMG name.
#
# Upstream's build installs the same app name and cannot coexist with this one;
# see conflicts_with. This tap used to carry a cask for that build too, "for
# comparison" — nothing installed it, nothing depended on it, and a second cask
# for somebody else's binary is a thing to explain rather than a thing to have.
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

  version "0.0.1"
  sha256 arm: "76d41df494e7b04bce33271278be239426e67d60c93c80716d87672ab5fae4ff",
         intel: "797d7541d25c4510c4b6301de41f43415a279af1415d583f481cbcb733886075"

  url "https://github.com/RoleModel/openscreen/releases/download/v#{version}/Openscreen-macOS-#{arch}-#{version}.dmg",
      verified: "github.com/RoleModel/openscreen/"

  # Two `name` stanzas, because the app answers to two things: what it calls itself
  # (CFBundleDisplayName, which is what the Dock and the menu bar show) and what it
  # is a build of, which is how anyone who has heard of it will search.
  name "RoleModel Studio"
  name "OpenScreen (RoleModel build)"
  desc "Screen recorder and editor for product demos, with the RoleModel pipeline's CLI additions"
  homepage "https://github.com/RoleModel/openscreen"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates false

  # Same bundle name as upstream, so two casks would fight over
  # /Applications/Openscreen.app, and Homebrew's own error for that talks about a
  # pre-existing app rather than about two casks.
  #
  # This names a cask, not a file. Upstream publishes none of its own (checked
  # 2026-08-23) and this tap no longer carries one, so what it really guards
  # against is a third-party tap claiming the name — which is exactly how the
  # siddharthvaddem/openscreen mixup happened.
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

  # Clear the quarantine flag, but only from a build that needs it.
  #
  # An ad-hoc signed bundle cannot be opened while quarantined: macOS says "Apple
  # could not verify Openscreen is free of malware" and offers only Move to Trash
  # or Done — and Move to Trash deletes it. Homebrew 6 removed --no-quarantine, so
  # there is no flag to pass; it has to come off afterwards.
  #
  # Guarded on the signature rather than done unconditionally. Once the release is
  # signed with a Developer ID and notarized, macOS has no objection and stripping
  # quarantine would be throwing away a check for nothing. So this heals the
  # unsigned builds and becomes a no-op the moment there is a real identity.
  postflight do
    app_path = "#{appdir}/Openscreen.app"
    next unless File.directory?(app_path)

    signature = Utils.popen_read("/usr/bin/codesign", "-d", "--verbose=2", app_path, err: :out)
    next unless signature.include?("Signature=adhoc")

    opoo "This build is ad-hoc signed, not notarized: clearing its quarantine flag so macOS will open it."
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", app_path],
                   sudo: false,
                   print_stderr: false
  end

  caveats do
    <<~EOS
      `openscreen` is put on PATH by the rm-video formula, not by this cask:

        brew install rolemodel/tap/rm-video

      A symlink to the binary inside the bundle breaks Electron's helper-app
      resolution, so the formula installs a shim that execs the bundle path.

      OpenScreen needs Screen Recording permission before it can capture, and
      macOS grants that to whatever binary hosts Electron:

        - launching the app normally  -> grant it to RoleModel Studio
        - driving the CLI from a shell -> grant it to your TERMINAL

      System Settings > Privacy & Security > Screen & System Audio Recording.
      A permission failure is a settings toggle, not something to retry.

      0.0.1 changed the bundle id from upstream's to rolemodel.studio, so this is
      now a separate app rather than one installed over theirs. macOS keys the
      Screen Recording grant to that id, so if you had already granted it to an
      earlier build you will be asked once more.

      This build is ad-hoc signed, not notarized: the release job signs with a
      certificate only when one is configured, and this fork configures none. On
      first launch macOS will need you to approve it under Privacy & Security.
    EOS
  end

  # Both names, because the app was renamed and the paths follow the name rather than
  # the bundle. Electron derives `app.getPath("userData")` and the log directory from
  # `app.name`, which on macOS is CFBundleDisplayName — so a copy installed after the
  # rename writes to "RoleModel Studio" and one installed before it wrote to
  # "Openscreen". A zap that lists only the current name leaves the older directory
  # behind on exactly the machines that have been running this the longest.
  #
  # Both bundle ids, because it changed at 0.0.1.
  #
  # It used to be com.etiennelescot.openscreen — upstream's — which meant this
  # installed as upstream's app and the two could not coexist. rolemodel.studio makes
  # it a separate app.
  #
  # The cost is a real one and the caveats above say it out loud: macOS keys the
  # Screen Recording grant to the bundle id, so a machine that had already granted it
  # to the old id has to grant it again to the new one. There is no way to carry a
  # TCC grant across identities, and the alternative was shipping for ever under
  # someone else's identifier.
  #
  # The old paths stay listed so `brew zap` still cleans up after a build that
  # predates the change.
  zap trash: [
    "~/Library/Application Support/RoleModel Studio",
    "~/Library/Application Support/Openscreen",
    "~/Library/Application Support/openscreen",
    "~/Library/Preferences/rolemodel.studio.plist",
    "~/Library/Preferences/com.etiennelescot.openscreen.plist",
    "~/Library/Saved Application State/rolemodel.studio.savedState",
    "~/Library/Saved Application State/com.etiennelescot.openscreen.savedState",
    "~/Library/Logs/RoleModel Studio",
    "~/Library/Logs/Openscreen",
  ]
end
