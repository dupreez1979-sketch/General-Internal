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

if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  printf '\n\033[1mDownloading the building blocks (first time takes a minute)\033[0m\n'
  npm install --no-audit --no-fund || fail "Download failed. Check your internet connection and try again."
  touch node_modules
fi

printf '\n\033[32mStarting the live preview. Keep this window open; close it (or quit the app) to stop.\033[0m\n'
CLAUDE_NAV_LIVE=1 npx electron . 
