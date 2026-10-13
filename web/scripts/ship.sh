#!/bin/bash
# Rebuilds the packaged Mac app from the working tree and replaces the installed one, ready for
# the user to open when they want it. It quits a running copy and never relaunches: they run the
# browser app, and two copies would both write the same state.json.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
npx electron-builder --mac --dir
BUILT=$(ls -td release/mac*/Sloperator.app | head -1)

# A packaged app that cannot start is worse than no update, and it fails silently: the server is
# required from the main process, so a bad bundle only shows up as a window that never loads.
# Prove this build serves before anything is replaced, against a throwaway state directory.
SMOKE=$(mktemp -d)
trap 'pkill -f "$BUILT/Contents/MacOS/Sloperator" 2>/dev/null || true; rm -rf "$SMOKE"' EXIT
ORCHESTRATOR_STATE_DIR="$SMOKE/state" ORCHESTRATOR_WORKTREE_ROOT="$SMOKE/worktrees" \
  "$BUILT/Contents/MacOS/Sloperator" >"$SMOKE/log" 2>&1 &
SMOKE_PID=$!
# The app prints the port it chose; asking lsof instead once matched another process's socket.
PORT=""
for _ in $(seq 40); do
  PORT=$(sed -n 's#.*orchestrator server on http://127\.0\.0\.1:\([0-9][0-9]*\).*#\1#p' "$SMOKE/log" | head -1)
  [ -n "$PORT" ] && break
  kill -0 "$SMOKE_PID" 2>/dev/null || break   # it died: stop waiting and report the log
  sleep 0.5
done
if [ -z "$PORT" ] || [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Origin: http://127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/state")" != "200" ]; then
  echo "ABORTED: the freshly built app never served /api/state — the installed copy was left alone." >&2
  sed -n '1,40p' "$SMOKE/log" >&2
  exit 1
fi
echo "smoke test passed on port $PORT"
pkill -f "$BUILT/Contents/MacOS/Sloperator" 2>/dev/null || true

osascript -e 'tell application "Sloperator" to quit' 2>/dev/null || true
osascript -e 'tell application "Orchestrator" to quit' 2>/dev/null || true   # the app's old name
# AppleScript can be refused silently (no automation permission); a plain TERM always reaches it.
pkill -TERM -x Sloperator 2>/dev/null || true
pkill -TERM -x Orchestrator 2>/dev/null || true
# Deleting the bundle while it is still running corrupts the copy that replaces it, and leaves the old
# version on screen: wait for it to exit, and stop here if it does not.
for _ in $(seq 40); do pgrep -x "Sloperator|Orchestrator" >/dev/null || break; sleep 0.5; done
if pgrep -x "Sloperator|Orchestrator" >/dev/null; then
  echo "ABORTED: the running app did not quit, so the installed copy was left alone. Quit it and ship again." >&2
  exit 1
fi
rm -rf /Applications/Sloperator.app /Applications/Orchestrator.app
cp -R "$BUILT" /Applications/
codesign --force --deep --sign - /Applications/Sloperator.app
# Installed but NOT launched: the browser app on 5273 is what the user runs, and a second copy
# would be a second writer on the same state.json. They open it themselves when they want it.
echo "Sloperator.app updated from $(git rev-parse --short HEAD 2>/dev/null || echo 'working tree') — installed, not launched"
