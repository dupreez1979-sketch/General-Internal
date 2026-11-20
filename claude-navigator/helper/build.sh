#!/bin/bash
# Builds build/navdraft with the newest Xcode on this Mac. Fails if the Mac's writing model is not in that Xcode.
set -euo pipefail
cd "$(dirname "$0")/.."
newest="$(ls -d /Applications/Xcode*.app 2>/dev/null | grep -vi beta | sort -V | tail -1 || true)"
if [ -n "$newest" ]; then export DEVELOPER_DIR="$newest/Contents/Developer"; fi
echo "Using: ${DEVELOPER_DIR:-the default Xcode}"; xcrun swiftc --version
xcrun swiftc -O -parse-as-library -target arm64-apple-macos13.0 helper/NavDraft.swift -o build/navdraft
got="$(./build/navdraft --sdk)"; echo "$got"
[ "$got" = "model:yes" ] || { echo "This Xcode does not include the Mac's writing model (needs the macOS 26 kit or later)."; exit 1; }
# A quick run: it must answer a status request and a writing request (with words or an error) without hanging.
sw_vers || true
out="$( { printf '{"op":"status"}\n{"op":"run","id":"t1","instructions":"Answer briefly.","prompt":"Say hello."}\n'; sleep 12; } | ./build/navdraft || true )"
echo "$out" | cut -c1-400
echo "$out" | grep -q '"status"' || { echo "The helper did not answer a status request."; exit 1; }
echo "$out" | grep -q '"t1"' || { echo "The helper did not answer a writing request (it hung)."; exit 1; }
