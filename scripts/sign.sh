#!/usr/bin/env bash
# Signs Shy.app with a code-signing identity. Without a stable identity macOS
# treats every build as a new app, dropping keychain access and camera or microphone grants.
#
#   scripts/sign.sh Shy.app IDENTITY [entitlements.plist] [embedded.provisionprofile]
#
# IDENTITY is a SHA-1 or name from `security find-identity -v -p codesigning`.
set -euo pipefail

APP=${1:?usage: scripts/sign.sh Shy.app IDENTITY [entitlements] [profile]}
ID=${2:?usage: scripts/sign.sh Shy.app IDENTITY [entitlements] [profile]}
ENT=${3:-}
PROFILE=${4:-}
FW="$APP/Contents/Frameworks/$(plutil -extract CFBundleExecutable raw "$APP/Contents/Info.plist") Framework.framework"
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

# Other frameworks, such as Sparkle in a published update, bring helpers of their own.
for other in "$APP"/Contents/Frameworks/*.framework; do
  [ "$other" = "$FW" ] && continue
  ov="$other/Versions/Current"
  for nested in "$ov"/XPCServices/*.xpc "$ov"/*.app; do
    [ -e "$nested" ] && sign --preserve-metadata=entitlements "$nested"
  done
  for f in "$ov"/*; do
    [ -f "$f" ] && [ "$f" != "$ov/$(basename "$other" .framework)" ] &&
      file -b "$f" | grep -q Mach-O && sign "$f"
  done
  sign "$other"
done

if [ -n "$PROFILE" ]; then cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"; fi
if [ -n "$ENT" ]; then sign --entitlements "$ENT" "$APP"; else sign "$APP"; fi

codesign --verify --deep --strict "$APP"
codesign -dv "$APP" 2>&1 | grep -E "^(Identifier|TeamIdentifier|Authority=)"
