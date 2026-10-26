#!/usr/bin/env bash
# Signs Shiny.app with a code-signing identity. Without a stable identity macOS
# treats every build as a new app, dropping keychain access and camera or microphone grants.
#
#   scripts/sign.sh Shiny.app IDENTITY [entitlements.plist] [embedded.provisionprofile]
#
# IDENTITY is a SHA-1 or name from `security find-identity -v -p codesigning`.
set -euo pipefail

APP=${1:?usage: scripts/sign.sh Shiny.app IDENTITY [entitlements] [profile]}
ID=${2:?usage: scripts/sign.sh Shiny.app IDENTITY [entitlements] [profile]}
ENT=${3:-}
PROFILE=${4:-}
FW=$(find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.framework" | head -1)
V="$FW/Versions/$(readlink "$FW/Versions/Current")"
FW_BIN="$V/$(basename "$FW" .framework)"
sign() { codesign --force --timestamp=none --sign "$ID" "$@"; }

# Nested code has to be signed before the bundle that seals it.
while IFS= read -r -d '' f; do
  case "$f" in */Contents/MacOS/* | "$FW_BIN") continue ;; esac
  file -b "$f" | grep -q Mach-O && sign "$f"
done < <(find "$V" -type f \( -perm +111 -o -name "*.dylib" \) -print0)
for helper in "$V"/Helpers/*.app; do sign "$helper"; done
sign "$FW"

if [ -n "$PROFILE" ]; then cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"; fi
if [ -n "$ENT" ]; then sign --entitlements "$ENT" "$APP"; else sign "$APP"; fi

codesign --verify --deep --strict "$APP"
codesign -dv "$APP" 2>&1 | grep -E "^(Identifier|TeamIdentifier|Authority=)"
