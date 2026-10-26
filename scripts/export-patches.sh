#!/usr/bin/env bash
# Rewrites patches/, lottie-preview/ and CHROMIUM_VERSION from a Chromium
# checkout whose current branch holds Shiny's commits on top of base-<version>.
#
#   scripts/export-patches.sh CHROMIUM_SRC
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?usage: scripts/export-patches.sh CHROMIUM_SRC}"
VERSION="$(sed -E 's/^[A-Z]+=//' "$SRC/chrome/VERSION" | paste -sd. -)"
BASE="base-$VERSION"
git -C "$SRC" rev-parse -q --verify "refs/tags/$BASE" >/dev/null || {
  echo "$SRC has no $BASE tag" >&2
  exit 1
}

rm -f "$REPO"/patches/*.patch
mkdir -p "$REPO/patches"
# Zeroed hashes and no numbering or signature keep a rebase from rewriting every patch header.
git -C "$SRC" format-patch --quiet --binary --zero-commit --no-numbered --no-signature \
  -o "$REPO/patches" "$BASE..HEAD"
rsync -a --delete "$SRC/chrome/browser/resources/lottie_preview/" "$REPO/lottie-preview/"
echo "$VERSION" > "$REPO/CHROMIUM_VERSION"
git -C "$REPO" status --short
