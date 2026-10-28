#!/usr/bin/env bash
# Publishes a built Shy.app as a Sparkle update into UPDATES_DIR, which a web
# server serves at the directory of FEED_URL.
#
#   scripts/publish-update.sh Shy.app UPDATES_DIR
#
# SPARKLE_DIR is an unpacked Sparkle release, ED_KEY_FILE the private EdDSA key
# exported by its generate_keys, SIGN_IDENTITY the identity the installed copy
# is signed with, and FEED_URL the appcast's URL, such as
# http://studio.local:8790/appcast.xml. Only the four newest updates are kept,
# the older three as the bases of the newest one's deltas.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:?usage: scripts/publish-update.sh Shy.app UPDATES_DIR}"
UPDATES="${2:?usage: scripts/publish-update.sh Shy.app UPDATES_DIR}"
NAME="$(basename "$APP" .app)"
: "${SPARKLE_DIR:?}" "${ED_KEY_FILE:?}" "${SIGN_IDENTITY:?}" "${FEED_URL:?}"
mkdir -p "$UPDATES"

# A build without the Sparkle loader installs fine and then never updates again.
exe="$(plutil -extract CFBundleExecutable raw "$APP/Contents/Info.plist")"
if ! grep -q SPUStandardUpdaterController "$APP/Contents/Frameworks/$exe Framework.framework/$exe Framework"; then
  echo "$APP does not load Sparkle; copies updated to it would stop updating" >&2
  exit 1
fi

# A public key that does not match the signing key makes installed copies reject
# every later update, so it is derived instead of configured.
public_key="$(swift - "$ED_KEY_FILE" <<'SWIFT'
import CryptoKit
import Foundation
let text = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
let seed = Data(base64Encoded: text.trimmingCharacters(in: .whitespacesAndNewlines))!.prefix(32)
print(try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation.base64EncodedString())
SWIFT
)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
NEW="$STAGE/$NAME.app"
ditto "$APP" "$NEW"
ditto "$SPARKLE_DIR/Sparkle.framework" "$NEW/Contents/Frameworks/Sparkle.framework"

# Sparkle orders updates by CFBundleVersion, which Chromium sets from its own
# version alone; the counter orders rebuilds of one Chromium version.
n=$(( $(cat "$UPDATES/build-number" 2>/dev/null || echo 0) + 1 ))
PLIST="$NEW/Contents/Info.plist"
short="$(plutil -extract CFBundleShortVersionString raw "$PLIST")"
plutil -replace CFBundleVersion -string "$(plutil -extract CFBundleVersion raw "$PLIST").$n" "$PLIST"
plutil -replace SUFeedURL -string "$FEED_URL" "$PLIST"
plutil -replace SUPublicEDKey -string "$public_key" "$PLIST"
plutil -replace SUEnableAutomaticChecks -bool YES "$PLIST"
plutil -replace SUScheduledCheckInterval -integer 14400 "$PLIST"

"$REPO/scripts/sign.sh" "$NEW" "$SIGN_IDENTITY"
# macOS treats an app signed with a revoked certificate as malware and moves it to the trash,
# and `security find-identity -v` still lists such an identity as valid.
if [ "$SIGN_IDENTITY" != "-" ]; then
  codesign -d --extract-certificates="$STAGE/cert" "$NEW" 2> /dev/null
  chain=()
  for c in "$STAGE"/cert*; do chain+=(-c "$c"); done
  if ! security verify-cert "${chain[@]}" -p codeSign -R ocsp -R require > "$STAGE/verify.log" 2>&1; then
    echo "$SIGN_IDENTITY failed the revocation check: $(tail -1 "$STAGE/verify.log")" >&2
    exit 1
  fi
fi
ditto -c -k --sequesterRsrc --keepParent "$NEW" "$UPDATES/$NAME-$short-$n.zip"
echo "$n" > "$UPDATES/build-number"

# A rebuild of one Chromium version changes little: a delta from each of the last three updates
# is a few MB instead of the whole app (9 MB against 194 MB), for about two minutes and 4 GB of
# memory apiece. Sparkle falls back to the full archive when a delta does not apply.
"$SPARKLE_DIR/bin/generate_appcast" --ed-key-file "$ED_KEY_FILE" \
  --download-url-prefix "${FEED_URL%/*}/" --maximum-deltas 3 --maximum-versions 4 "$UPDATES"
rm -rf "$UPDATES/old_updates"
# Its cache keeps a whole extracted app per archive and never drops old ones.
rm -rf "$HOME/Library/Caches/Sparkle_generate_appcast"
echo "published $NAME $short ($n) in $UPDATES"
