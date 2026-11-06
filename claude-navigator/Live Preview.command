#!/bin/bash
# Claude Navigator: live preview.
# Double-click this file in Finder. It runs Claude Navigator straight from this folder and keeps it up to
# date: new changes from Claude are fetched every 20 seconds and appear in the window by themselves.
# Your folders and Claude sign-in are the same as in the installed app. Close this window to stop.

set -eo pipefail
cd "$(dirname "$0")"
APP_NAME="Claude Navigator"

fail() { printf '\n\033[31m%s\033[0m\n\n' "$1"; read -r -p "Press Return to close this window." _; exit 1; }

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  nvm use default >/dev/null 2>&1 || true
fi
command -v npm >/dev/null 2>&1 || fail "Node.js is not installed yet. Download the LTS version from https://nodejs.org, install it, then double-click this file again."

# Only one copy can run at a time (they share your folders), so close the installed app first.
osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  pgrep -f "/Applications/$APP_NAME.app/Contents/MacOS/" >/dev/null 2>&1 || break
  sleep 0.5
done

printf '\n\033[1mGetting the latest changes\033[0m\n'
if GIT_TERMINAL_PROMPT=0 git -C .. pull --ff-only --quiet 2>/dev/null; then
  echo "Up to date. New changes will arrive by themselves."
else
  echo "Could not fetch changes from here. In GitHub Desktop, click Fetch origin then Pull origin whenever"
  echo "Claude says a change is ready; the app refreshes by itself as soon as the files change."
fi

if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ package-lock.json -nt node_modules ]; then
  printf '\n\033[1mDownloading the building blocks (first time takes a minute)\033[0m\n'
  npm ci --no-audit --no-fund || fail "Download failed. Check your internet connection and try again."
  touch node_modules
fi
# The Electron engine is a separate download, which newer versions of npm no longer do by themselves.
# Fetch it straight from Electron's official releases if it is missing.
EDIR="node_modules/electron"
EBIN="Electron.app/Contents/MacOS/Electron"
if [ ! -x "$EDIR/dist/$EBIN" ]; then
  EVER="$(node -p "require('./$EDIR/package.json').version")"
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then EARCH=arm64; else EARCH=x64; fi
  printf '\n\033[1mDownloading the Electron engine %s (about 100 MB, once)\033[0m\n' "$EVER"
  ZIP="$(mktemp -t electron).zip"
  curl -fL --progress-bar -o "$ZIP" "https://github.com/electron/electron/releases/download/v$EVER/electron-v$EVER-darwin-$EARCH.zip" \
    || fail "Could not download Electron. Check your internet connection and try again."
  rm -rf "$EDIR/dist" && mkdir -p "$EDIR/dist"
  ditto -x -k "$ZIP" "$EDIR/dist" || fail "Could not unpack Electron."
  rm -f "$ZIP"
  printf '%s' "$EBIN" > "$EDIR/path.txt"
  printf 'v%s' "$EVER" > "$EDIR/dist/version"
  [ -x "$EDIR/dist/$EBIN" ] || fail "Electron did not unpack as expected. Send this window's text to Claude."
fi
# Keep npm's pointer to the engine in place too (harmless if it is already there).
[ "$(cat "$EDIR/path.txt" 2>/dev/null)" = "$EBIN" ] || printf '%s' "$EBIN" > "$EDIR/path.txt"

printf '\n\033[32mStarting the live preview. Keep this window open; close it (or quit the app) to stop.\033[0m\n'
CLAUDE_NAV_LIVE=1 "$EDIR/dist/$EBIN" .
