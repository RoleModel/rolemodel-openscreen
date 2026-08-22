# Homebrew formula for the RoleModel OpenScreen brand layer.
#
# This file belongs in the TAP repo, not this one:
#   github.com/rolemodel/homebrew-tap  ->  Formula/rm-video.rb
# A copy lives here so the formula and the code it describes move together.
# `.github/workflows/release.yml` copies it across and fills in url + sha256
# on every tag, so the two never drift by hand.
class RmVideo < Formula
  desc "RoleModel video tooling — OpenScreen brand presets and mounted project libraries"
  homepage "https://github.com/rolemodel/rolemodel-openscreen"
  url "https://github.com/rolemodel/rolemodel-openscreen/archive/refs/tags/v0.1.0.tar.gz"
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
    %w[rm-video rm-library].each do |exe|
      (bin/exe).write_env_script libexec/"bin/#{exe}.mjs", {}
      chmod 0755, bin/exe
    end
  end

  # rclone + a FUSE provider are only needed for `rm-library mount`; branding an
  # OpenScreen project does not require them, so they stay optional rather than
  # dragging a kernel extension into every install.
  def caveats
    <<~EOS
      rm-video brands OpenScreen projects; it does not record or export them.
      Install OpenScreen itself for that:

        brew install --cask openscreen      # if a cask exists for your version
        # or download from https://github.com/getopenscreen/openscreen/releases

      Point the Claude skill at this install by adding to your shell profile:

        export RM_OPENSCREEN="$(rm-video root)"

      For `rm-library mount` you also need rclone and a FUSE provider:

        brew install rclone
        brew install --cask macfuse   # approve in System Settings > Privacy & Security

      On a managed Mac where kernel extensions are blocked, use Mountain Duck
      instead and point --mount-point at the volume it creates.
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
