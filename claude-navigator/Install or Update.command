#!/bin/bash
# Claude Navigator: install or update on this Mac.
# Double-click this file in Finder. It builds the app from this folder,
# puts it in Applications and opens it. Your folders and Claude sign-in are kept.

set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Claude Navigator"
APP="/Applications/$APP_NAME.app"

say_step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n\n' "$1"; read -r -p "Press Return to close this window." _; exit 1; }

if ! command -v npm >/dev/null 2>&1; then
  fail "Node.js is not installed yet. Download the LTS version from https://nodejs.org, install it, then double-click this file again."
fi

say_step "1 of 4  Closing $APP_NAME if it is open"
osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
sleep 1

say_step "2 of 4  Downloading the building blocks (the first time takes a few minutes)"
npm install --no-audit --no-fund || fail "Download failed. Check your internet connection and try again."

say_step "3 of 4  Building the app"
if [ "$(uname -m)" = "arm64" ]; then ARCH="--arm64"; else ARCH="--x64"; fi
rm -rf dist
npx electron-builder --mac dir "$ARCH" -c.mac.identity=null || fail "The build failed. Copy the text above and send it to Claude."
BUILT="$(find dist -maxdepth 2 -name "$APP_NAME.app" -type d | head -n 1)"
[ -n "$BUILT" ] || fail "The build finished but the app was not found in the dist folder."

say_step "4 of 4  Installing into Applications"
rm -rf "$APP"
cp -R "$BUILT" "$APP"
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

VERSION="$(node -p "require('./package.json').version")"
printf '\n\033[32mDone. %s %s is in your Applications folder.\033[0m\n' "$APP_NAME" "$VERSION"
echo "Opening it now. You can close this window."
open "$APP"
