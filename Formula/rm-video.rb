# Homebrew formula for the RoleModel OpenScreen brand layer.
#
# This file belongs in the TAP repo, not this one:
#   github.com/rolemodelsoftware/homebrew-tap  ->  Formula/rm-video.rb
# A copy lives here so the formula and the code it describes move together.
# `.github/workflows/release.yml` copies it across and fills in url + sha256
# on every tag, so the two never drift by hand.
class RmVideo < Formula
  desc "RoleModel brand layer for OpenScreen — presets, wallpapers, and demo tooling"
  homepage "https://github.com/rolemodelsoftware/rolemodel-openscreen"
  url "https://github.com/rolemodelsoftware/rolemodel-openscreen/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  # Node is the only runtime dependency. There is nothing to compile — the
  # toolkit is plain ESM and the wallpapers ship pre-rendered, so no Playwright
  # or Chromium download happens at install time.
  depends_on "node"

  def install
    # The tree is self-locating: lib/theme.mjs resolves ROOT from its own path,
    # so the whole thing goes to libexec and only the entry point is linked.
    libexec.install Dir["*"]
    (bin/"rm-video").write_env_script libexec/"bin/rm-video.mjs", {}
    chmod 0755, bin/"rm-video"
  end

  def caveats
    <<~EOS
      rm-video brands OpenScreen projects; it does not record or export them.
      Install OpenScreen itself for that:

        brew install --cask openscreen      # if a cask exists for your version
        # or download from https://github.com/getopenscreen/openscreen/releases

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
  end
end
