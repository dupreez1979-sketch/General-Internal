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

# Find Node.js however it was installed: nvm, Homebrew, or the nodejs.org installer.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # nvm does not work with "set -u", so switch it off just while nvm loads.
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  nvm use default >/dev/null 2>&1 || true
  set -u
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "Node.js is not installed yet. Download the LTS version from https://nodejs.org, install it, then double-click this file again."
fi

echo "Using Node.js $(node -v) from $(command -v node)"

say_step "1 of 4  Closing $APP_NAME if it is open"
osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
# Wait (up to 15 seconds) until it has really closed.
for _ in $(seq 1 30); do
  pgrep -f "/Applications/$APP_NAME.app/Contents/MacOS/" >/dev/null 2>&1 || break
  sleep 0.5
done

say_step "2 of 4  Downloading the building blocks (the first time takes a few minutes)"
npm install --no-audit --no-fund || fail "Download failed. Check your internet connection and try again."

say_step "3 of 4  Building the app"
# Apple Silicon even when Terminal runs under Rosetta (where uname reports x86_64).
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then ARCH="--arm64"; else ARCH="--x64"; fi
rm -rf dist
npx electron-builder --mac dir "$ARCH" -c.mac.identity=null || fail "The build failed. Copy the text above and send it to Claude."
BUILT="$(find dist -maxdepth 2 -name "$APP_NAME.app" -type d | head -n 1)"
[ -n "$BUILT" ] || fail "The build finished but the app was not found in the dist folder."

say_step "4 of 4  Installing into Applications"
# Copy the new version next to the old one first, so a failed copy never leaves you with no app.
NEW="/Applications/.$APP_NAME.new.app"
rm -rf "$NEW"
cp -R "$BUILT" "$NEW" || fail "Could not copy the app into Applications. Your previous version is untouched."
xattr -cr "$NEW" 2>/dev/null || true
codesign --force --deep --sign - "$NEW" >/dev/null 2>&1 || { rm -rf "$NEW"; fail "Could not sign the app, so it would not open. Your previous version is untouched. Copy the text above and send it to Claude."; }
rm -rf "$APP"
mv "$NEW" "$APP" || fail "Could not put the new version in place. Look for the hidden new copy in Applications."

VERSION="$(node -p "require('./package.json').version")"
printf '\n\033[32mDone. %s %s is in your Applications folder.\033[0m\n' "$APP_NAME" "$VERSION"
echo "Opening it now. You can close this window."
open "$APP"
