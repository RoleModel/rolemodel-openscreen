#!/bin/zsh
# Builds RoleModel Studio.app, signs it with RoleModel's Developer ID, notarizes it,
# and packages it as a DMG. Modelled on almanac-widget/Scripts/release.sh, and uses the
# same credentials: the "Developer ID Application: RoleModel Software, Inc." certificate
# in the keychain and the notarytool keychain profile named "AlmanacDesk".
#
#   macos/Scripts/release.sh            # dist/RoleModelStudio-<version>.dmg
#   macos/Scripts/release.sh --publish  # also uploads it to the GitHub release v<version>
#
# The version is package.json's, so the app and the toolkit inside it are one release.
#
# What goes inside the app, under Contents/Resources:
#   runtime/node  Node from nodejs.org, pinned and checksummed. Not Homebrew's: that one
#                 links against Homebrew's own libraries and breaks on a Mac without them.
#   toolkit/      this checkout's files and its production dependencies, the same tree the
#                 Homebrew formula installs. The app starts toolkit/bin/rm-studio.mjs.
#
# Everything executable inside is signed with the hardened runtime. Node also needs JIT
# and unsigned-memory entitlements (macos/node.entitlements) because V8 compiles at run time.
#
# Apple Silicon only for now: the bundled Node is arm64.
set -eu -o pipefail

if ! xcode-select -p 2>/dev/null | grep -q '\.app/'; then
  XCODE_APP="$(mdfind "kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'" 2>/dev/null | head -1)"
  [ -n "$XCODE_APP" ] || XCODE_APP=/Applications/Xcode.app
  export DEVELOPER_DIR="$XCODE_APP/Contents/Developer"
fi

PUBLISH=0; [[ "${1:-}" == "--publish" ]] && PUBLISH=1
NODE_VERSION="${NODE_VERSION:-24.13.0}"
NOTARY_PROFILE="${NOTARY_PROFILE:-AlmanacDesk}"

MACOS="${0:A:h:h}"
REPO="${MACOS:h}"
OUT="$REPO/dist"
DERIVED="${TMPDIR:-/tmp}/rolemodel-studio-archive"
CACHE="$HOME/Library/Caches/RoleModelStudioBuild"
VERSION="$(node -p "require('$REPO/package.json').version")"
BUILD_NUMBER="$(git -C "$REPO" rev-list --count HEAD)"
DMG="$OUT/RoleModelStudio-$VERSION.dmg"
ARCHIVE="$OUT/RoleModelStudio.xcarchive"
APP="$OUT/export/RoleModel Studio.app"
DEV_ID="$(security find-identity -v -p codesigning 2>/dev/null | grep -oE '"Developer ID Application: [^"]+"' | head -1 | tr -d '"')"

[ -n "$DEV_ID" ] || { echo "No Developer ID Application certificate in the keychain."; exit 1; }
if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  echo "==> Note: the working tree has uncommitted changes, and they go into this build."
fi

rm -rf "$OUT" "$DERIVED"
mkdir -p "$OUT" "$CACHE"

echo "==> Archiving RoleModel Studio $VERSION (build $BUILD_NUMBER)"
xcodebuild archive \
  -project "$MACOS/RoleModelStudio.xcodeproj" -scheme RoleModelStudio -configuration Release \
  -destination 'generic/platform=macOS' -archivePath "$ARCHIVE" -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=NO 2>&1 | grep -E "error:|ARCHIVE" || true
[ -d "$ARCHIVE" ] || { echo "archive failed"; exit 1; }
mkdir -p "$OUT/export"
ditto "$ARCHIVE/Products/Applications/RoleModel Studio.app" "$APP"
RESOURCES="$APP/Contents/Resources"

echo "==> Node $NODE_VERSION"
NODE_TAR="node-v$NODE_VERSION-darwin-arm64.tar.gz"
if [ ! -f "$CACHE/$NODE_TAR" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TAR" -o "$CACHE/$NODE_TAR.part"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
  WANT="$(grep " $NODE_TAR\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | awk '{print $1}')"
  HAVE="$(shasum -a 256 "$CACHE/$NODE_TAR.part" | awk '{print $1}')"
  [ -n "$WANT" ] && [ "$WANT" = "$HAVE" ] || { echo "Node checksum mismatch"; rm -f "$CACHE/$NODE_TAR.part"; exit 1; }
  mv "$CACHE/$NODE_TAR.part" "$CACHE/$NODE_TAR"
fi
mkdir -p "$RESOURCES/runtime"
tar -xzf "$CACHE/$NODE_TAR" -C "$OUT" "node-v$NODE_VERSION-darwin-arm64/bin/node"
mv "$OUT/node-v$NODE_VERSION-darwin-arm64/bin/node" "$RESOURCES/runtime/node"
rm -rf "$OUT/node-v$NODE_VERSION-darwin-arm64"

echo "==> Toolkit"
TOOLKIT="$RESOURCES/toolkit"
mkdir -p "$TOOLKIT"
# What git would ship, from the working tree: tracked files plus new ones that are not
# ignored. The Mac app's own sources are not part of the toolkit.
git -C "$REPO" ls-files -z --cached --others --exclude-standard -- . ':!macos' \
  | (cd "$REPO" && xargs -0 -I{} sh -c '[ -f "{}" ] && echo "{}"') \
  | rsync -a --files-from=- "$REPO/" "$TOOLKIT/"
# Hoisted, so node_modules is plain folders: a bundle's signature does not survive
# pnpm's symlink farm. --trust-lockfile for the same reason as the formula: a dev
# dependency lives in a private registry this install never needs.
(cd "$TOOLKIT" && pnpm install --prod --frozen-lockfile --trust-lockfile --config.node-linker=hoisted --silent)
rm -rf "$TOOLKIT/node_modules/.bin" "$TOOLKIT/node_modules/.pnpm" "$TOOLKIT/node_modules/.modules.yaml"
echo "    $(du -sh "$TOOLKIT" | awk '{print $1}') toolkit"

echo "==> Signing with $DEV_ID"
sign() { codesign --force --options runtime --timestamp --sign "$DEV_ID" "$@"; }
# Innermost first: every Mach-O in the toolkit (native addons, prebuilt helpers), then
# Node with its entitlements, then the app around them.
find "$TOOLKIT" -type f \( -name '*.node' -o -name '*.dylib' -o -perm -u+x \) -print0 \
  | while IFS= read -r -d '' file; do
      file -b "$file" | grep -q 'Mach-O' && sign "$file" >/dev/null 2>&1 && echo "    signed ${file#$TOOLKIT/}"
    done
sign --entitlements "$MACOS/node.entitlements" "$RESOURCES/runtime/node"
# Sparkle's helpers, innermost first, as Sparkle's docs require. Xcode signed them
# with the development certificate, which notarization rejects.
SPARKLE="$APP/Contents/Frameworks/Sparkle.framework"
if [ -d "$SPARKLE" ]; then
  V="$SPARKLE/Versions/B"
  sign "$V/XPCServices/Installer.xpc"
  sign --preserve-metadata=entitlements "$V/XPCServices/Downloader.xpc"
  sign "$V/Autoupdate"
  sign "$V/Updater.app"
  sign "$SPARKLE"
fi
sign --entitlements "$MACOS/RoleModelStudio.entitlements" "$APP"
codesign --verify --deep --strict "$APP" && echo "    signature verified"

notarize() {
  xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1 | grep -E "status:|id:" | head -3
}
echo "==> Notarizing the app"
ditto -c -k --keepParent "$APP" "$OUT/RoleModelStudio.zip"
notarize "$OUT/RoleModelStudio.zip"
xcrun stapler staple -q "$APP"; echo "    app stapled"
rm -f "$OUT/RoleModelStudio.zip"

echo "==> Building DMG"
STAGE="$OUT/dmg-root"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/RoleModel Studio.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "RoleModel Studio $VERSION" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DMG"
rm -rf "$STAGE"
codesign --force --timestamp --sign "$DEV_ID" "$DMG"

echo "==> Notarizing the DMG"
notarize "$DMG"
xcrun stapler staple -q "$DMG"; echo "    DMG stapled"
echo "==> Gatekeeper assessment"
spctl --assess --type open --context context:primary-signature -v "$DMG" 2>&1 | tail -1
spctl --assess --type exec -v "$APP" 2>&1 | tail -1

# Keep LaunchServices from remembering the build copies; /Applications is the one to open.
for stray in "$APP" "$ARCHIVE/Products/Applications/RoleModel Studio.app"; do
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$stray" >/dev/null 2>&1 || true
done

echo "==> $DMG ($(du -h "$DMG" | awk '{print $1}'))"
shasum -a 256 "$DMG"

if [ "$PUBLISH" = 1 ]; then
  REPO_SLUG=RoleModel/rolemodel-openscreen
  echo "==> Uploading to the GitHub release v$VERSION"
  gh release view "v$VERSION" --repo "$REPO_SLUG" >/dev/null \
    || { echo "No release v$VERSION yet. Run pnpm run release first."; exit 1; }
  gh release upload "v$VERSION" "$DMG" --clobber --repo "$REPO_SLUG"

  # The update feed. Installed apps read it from the Pages site (SUFeedURL in
  # macos/Info.plist) and download the DMG from the release it names. The
  # signature is made with the private key in this Mac's keychain; an app only
  # installs an update whose signature matches its SUPublicEDKey.
  echo "==> Writing the update feed"
  SIGN_UPDATE="$DERIVED/SourcePackages/artifacts/sparkle/Sparkle/bin/sign_update"
  SIGNATURE="$("$SIGN_UPDATE" --account rolemodel-studio "$DMG")"
  URL="https://github.com/$REPO_SLUG/releases/download/v$VERSION/${DMG:t}"
  PREV="$(git -C "$REPO" tag --list 'v*' --sort=-v:refname | grep -v "^v$VERSION$" | head -1)"
  CHANGES="$(git -C "$REPO" log --no-merges -n 30 --format='%s' "${PREV:+$PREV..}v$VERSION" -- . ':!site' 2>/dev/null | grep -v '\[skip release\]' || true)"
  python3 - "$REPO/site/appcast.xml" "$URL" "$SIGNATURE" "$VERSION" "$BUILD_NUMBER" "$CHANGES" <<'PY'
import email.utils, html, re, sys
path, url, signature, version, build, changes = sys.argv[1:]
items = "".join(f"<li>{html.escape(line)}</li>" for line in changes.splitlines() if line.strip()) or "<li>Fixes and improvements.</li>"
attrs = dict(re.findall(r'([\w:]+)="([^"]*)"', signature))
open(path, "w").write(f'''<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>RoleModel Studio</title>
    <item>
      <title>RoleModel Studio {version}</title>
      <pubDate>{email.utils.formatdate()}</pubDate>
      <sparkle:version>{build}</sparkle:version>
      <sparkle:shortVersionString>{version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
      <description><![CDATA[<h3>What's new</h3><ul>{items}</ul>]]></description>
      <enclosure url="{url}" length="{attrs["length"]}" type="application/octet-stream" sparkle:edSignature="{attrs["sparkle:edSignature"]}"/>
    </item>
  </channel>
</rss>
''')
PY
  # Pages publishes site/ on a push to main. [skip release] keeps push.yml from
  # cutting a version for a feed.
  git -C "$REPO" add site/appcast.xml
  git -C "$REPO" commit -q -m "Point the Mac app's update feed at v$VERSION [skip release]"
  git -C "$REPO" push -q origin HEAD:main
  echo "    site/appcast.xml → https://rolemodel.github.io/rolemodel-openscreen/appcast.xml"
fi
