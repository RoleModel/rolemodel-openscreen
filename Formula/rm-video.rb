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

  # One command installs the whole stack. The toolkit is plain ESM and the
  # wallpapers ship pre-rendered, so nothing compiles and no Chromium is
  # downloaded — but OpenScreen itself comes along, because branding a project
  # you cannot record is useless.
  depends_on "node"
  # Narration and muxing are ffmpeg work, and the poster frames in the library
  # already were — it stops being optional the moment Voice exists.
  depends_on "ffmpeg"
  # Voice builds its own virtualenv, but it needs an interpreter Kokoro supports
  # to build it from: kokoro-onnx declares >=3.10,<3.14, and macOS ships 3.9.
  # Without this, `rm-voice --setup` on a clean Mac fails with a wall of
  # ResolutionImpossible that reads like a broken package rather than a wrong
  # Python. 3.13 is the newest version inside that range — do not bump to 3.14
  # until Kokoro publishes wheels for it.
  depends_on "python@3.13"
  depends_on cask: "rolemodel/tap/openscreen"

  def install
    # The tree is self-locating: lib/theme.mjs resolves ROOT from its own path,
    # so the whole thing goes to libexec and only the entry point is linked.
    libexec.install Dir["*"]
    %w[rm-video rm-library rm-studio rm-voice rm-mux].each do |exe|
      (bin/exe).write_env_script libexec/"bin/#{exe}.mjs", {}
      chmod 0755, bin/exe
    end
  end

  # rclone + a FUSE provider are only needed for `rm-library mount`; branding an
  # OpenScreen project does not require them, so they stay optional rather than
  # dragging a kernel extension into every install.
  def caveats
    <<~EOS
      OpenScreen was installed alongside this, and its CLI is on your PATH as
      `openscreen` — the binary normally hides inside the .app bundle.

        openscreen info --json
        openscreen sources -o /tmp/sources.json

      Point the Claude skill at this install by adding to your shell profile:

        export RM_OPENSCREEN="$(rm-video root)"

      Voice runs Kokoro locally through hyperframes — no API key, nothing leaves
      the machine. There is nothing to install by hand: the first run builds its
      own Python virtualenv under ~/.rolemodel-video and points the synthesiser
      at it, so your system Python is never touched.

        rm-voice --setup      # or just run it; setup happens on first use

      "Make a video" asks Claude to build the render `Using /hyperframes`, which
      needs that skill on your machine. It is not bundled here — the hyperframes
      CLI installs and versions its own skills, and they live in ~/.claude/skills
      where Claude can find them from any folder:

        rm-video skills           # install or update them
        rm-video skills --check   # see what you have

      This is not done during `brew install` on purpose: ~/.claude/skills is
      per-user, brew may run as a different user, and a formula that reaches the
      network at install time breaks on a locked-down machine. One command, once.

      "Make a video" and "Draft it with Claude" shell out to Claude Code, which
      Homebrew cannot install — Anthropic ships it through npm and its own
      installer, and the `claude-*` formulae in Homebrew are unrelated projects:

        npm install -g @anthropic-ai/claude-code

      Everything else Voice needs is handled: Python 3.13 comes with this
      formula, and the virtualenv is built on first use.

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
