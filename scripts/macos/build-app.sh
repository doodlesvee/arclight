#!/bin/sh
# Builds "Private Server.app": a small launcher to keep in the Dock. Opening it
# starts Docker and the app if they are not running, then opens the app in its
# own window (see scripts/launch.sh).
#
#   make mac-app
#
# The app is only a shortcut to this folder, so the project stays where it is.
# If you move the project, run this again.
#
# Settings, all optional:
#   DEST=/some/folder       where to put the app (default ~/Applications)
set -eu

if [ "$(uname -s)" != Darwin ] && [ "${ALLOW_NON_MAC:-}" != 1 ]; then
  echo "This builds a macOS app, so it has to be run on a Mac." >&2
  exit 1
fi

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEST=${DEST:-$HOME/Applications}
APP="$DEST/Private Server.app"
ICONSET="$ROOT/scripts/macos/AppIcon.iconset"
LAUNCH="$ROOT/scripts/launch.sh"

[ -f "$LAUNCH" ] || { echo "Cannot find $LAUNCH" >&2; exit 1; }

# Wraps a path in single quotes for the generated script, so a project folder
# with spaces or quotes in its name still works.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Info.plist. LSUIElement keeps the launcher itself out of the Dock: it only
# starts things and exits, and the window that opens is Chrome's.
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Private Server</string>
  <key>CFBundleDisplayName</key>
  <string>Private Server</string>
  <key>CFBundleIdentifier</key>
  <string>local.private-server.launcher</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

printf '#!/bin/sh\nexec /bin/sh %s\n' "$(quote "$LAUNCH")" > "$APP/Contents/MacOS/launcher"
chmod +x "$APP/Contents/MacOS/launcher"

if command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
else
  echo "iconutil not found, so the app will have the default icon." >&2
fi

# Makes Finder and the Dock notice the new icon.
touch "$APP"

echo "Built: $APP"
echo "Open it once, then keep it in the Dock: right-click its icon > Options > Keep in Dock."
