#!/bin/bash
# Build Orchestrator.app and install it to /Applications.
#
# The bundle is updated IN PLACE — never deleted and recreated — because removing it breaks
# the Dock pin and the LaunchServices registration that points at it. The executable is
# replaced with mv (an atomic rename), which also works while an older copy is still running.
#
#   ./scripts/build_app.sh            build + install to /Applications, keep the app running
#   ./scripts/build_app.sh --restart  also quit the running copy and relaunch it
#   ./scripts/build_app.sh --dev      install to ./dist instead of /Applications
set -euo pipefail
cd "$(dirname "$0")/.."

DEST=/Applications
RESTART=0
for arg in "$@"; do
    case "$arg" in
        --dev) DEST="$PWD/dist" ;;
        --restart|--open) RESTART=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

APP="$DEST/Orchestrator.app"
BUILD_STAMP="$(date '+%Y-%m-%d %H:%M')"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"

echo "Building…"
swift build -c release

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Orchestrator</string>
    <key>CFBundleDisplayName</key><string>Orchestrator</string>
    <key>CFBundleIdentifier</key><string>local.claude.orchestrator</string>
    <key>CFBundleVersion</key><string>${COMMIT}</string>
    <key>CFBundleShortVersionString</key><string>${BUILD_STAMP}</string>
    <key>CFBundleExecutable</key><string>Orchestrator</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSSupportsAutomaticTermination</key><false/>
    <key>NSSupportsSuddenTermination</key><false/>
</dict>
</plist>
PLIST

# Rename over the old executable rather than writing through it: a running copy keeps its
# own inode, and the bundle directory (which the Dock points at) is never removed.
cp .build/release/Orchestrator "$APP/Contents/MacOS/Orchestrator.new"
mv -f "$APP/Contents/MacOS/Orchestrator.new" "$APP/Contents/MacOS/Orchestrator"

codesign --force --sign - "$APP" >/dev/null 2>&1
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$APP" >/dev/null 2>&1 || true

echo "Installed $APP  (build $BUILD_STAMP, commit $COMMIT)"

if [[ "$RESTART" == "1" ]]; then
    osascript -e 'quit app "Orchestrator"' >/dev/null 2>&1 || true
    sleep 2
    open "$APP"
    echo "Relaunched."
else
    echo "Quit and reopen Orchestrator to pick up this build."
fi
