# Homebrew formula for the RoleModel OpenScreen brand layer.
#
# This file belongs in the TAP repo, not this one:
#   github.com/RoleModel/homebrew-tap  ->  Formula/rm-video.rb
# A copy lives here so the formula and the code it describes move together.
# `.github/workflows/release.yml` copies it across and fills in url + sha256
# on every tag, so the two never drift by hand.
class RmVideo < Formula
  desc "RoleModel brand layer for OpenScreen — presets, wallpapers, and demo tooling"
  homepage "https://github.com/RoleModel/rolemodel-openscreen"
  url "https://github.com/RoleModel/rolemodel-openscreen/archive/refs/tags/v0.0.1.tar.gz"
  sha256 "7242e8bace3ce0254b2b7b9aa5ec092cdcaa30d9a7e2383a1b28d91dde48ca76"
  license "MIT"

  # Node is the only system runtime dependency. The scripted-demo commands need
  # Playwright at runtime, so install the production dependency tree into
  # libexec before linking the CLIs.
  depends_on "node"
  depends_on "pnpm" => :build

  # Every CLI in the toolkit, not just one.
  #
  # `rm-video` was the only entry point linked, which meant `rm-studio` — the
  # thing you actually open — was reachable only by typing a path into libexec.
  # `rm-demo` is newer than that and had never been linked at all.
  # Every entry point in bin/, and `pnpm run check` asserts this list matches both
  # the directory and package.json's bin map. It drifted twice: `rm-setup` was in
  # neither, so `install.sh` — whose last step hands off to it — died at the
  # finish line on a clean machine, and `rm-share` was in the bin map but not
  # here, so brew shipped six of eight commands while the docs promised seven.
  ENTRIES = %w[rm-video rm-studio rm-transcribe rm-voice rm-mux rm-library rm-demo rm-share rm-setup rm-compose rm-cut rm-insert rm-align-audio rm-render-alignment rm-render-hyperframes rm-render-pip rm-adopt rm-resync rm-retime-pip rm-reconcile rm-visual-beats rm-fal].freeze

  def install
    system "pnpm", "install", "--prod", "--frozen-lockfile"

    # The tree is self-locating: lib/theme.mjs resolves ROOT from its own path,
    # so the whole thing goes to libexec and only the entry points are linked.
    libexec.install Dir["*"]

    ENTRIES.each do |entry|
      script = libexec/"bin/#{entry}.mjs"
      next unless script.exist?

      (bin/entry).write_env_script script, {}
      chmod 0755, bin/entry
    end

    # `openscreen` on PATH comes from here, not from the cask.
    #
    # A cask's `binary` stanza installs a symlink, and Electron resolves
    # Contents/Frameworks/*Helper*.app relative to the running executable —
    # through a symlink it computes the wrong base and dies with
    #
    #   FATAL:electron_main_delegate_mac.mm:65] Unable to find helper app
    #
    # `--help` survives because it never forks; `record` and `sources` do not.
    # The shim resolves the bundle and execs it directly, which is the same
    # binary reached by a path Electron can reason about.
    shim = libexec/"bin/shims/openscreen"
    if shim.exist?
      bin.install_symlink shim => "openscreen"
    end
  end

  def caveats
    <<~EOS
      This installs the toolkit CLIs: #{ENTRIES.join(", ")}.

      None of them is the thing you open day to day: that is the RoleModel Studio
      app, which hosts the same Studio as a window. `rm-studio` serves it to a
      browser on :4600 instead, which is the developer path — and launching the
      recorder from a shell gives macOS's Screen Recording grant to your terminal
      rather than to the app.

      It brands, narrates and scripts OpenScreen projects; it does not record or
      export them. Install the app for that:

        brew trust --tap rolemodel/tap
        brew install --cask rolemodel/tap/rolemodel-openscreen

      Use RoleModel's fork rather than upstream: the Studio hands documents to
      the editor with `openscreen open <file>`, and upstream has no such verb —
      its bundle declares no document type, so there is no way in from outside.

      This formula also puts `openscreen` on PATH as a shim. If you have the
      upstream `openscreen` cask installed, its own binary symlink will collide
      with that; uninstall it first:

        brew uninstall --cask openscreen

      Point the Claude skill at this install by adding to your shell profile:

        export RM_OPENSCREEN="$(rm-video root)"
    EOS
  end

  test do
    # `presets` exercises the real path: it loads every preset JSON, resolves
    # the `extends` chain, and reads the wallpaper directory out of libexec.
    # If the install layout were wrong, this is what would catch it.
    assert_match "rolemodel", shell_output("#{bin}/rm-video presets")
    assert_match libexec.to_s, shell_output("#{bin}/rm-video root").strip

    # Every entry point that exists in the tree must have been linked. A missing
    # link is silent otherwise: the command simply is not there.
    ENTRIES.each do |entry|
      next unless (libexec/"bin/#{entry}.mjs").exist?

      assert_path_exists bin/entry, "#{entry} was not linked"
    end

    # The demo scripting DSL, exercised without a browser: `check` parses a
    # script and reports on it, which is the whole pure half of rm-demo.
    (testpath/"d.md").write <<~SCRIPT
      A line of narration.

      ```do
      goto https://example.com/
      click "Learn more"
      ```
    SCRIPT
    out = shell_output("#{bin}/rm-demo check #{testpath}/d.md")
    assert_match "2 actions", out
    assert_match "1 narration line", out
  end
end
