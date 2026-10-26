#!/usr/bin/env bash
# Builds Shiny: Chromium at CHROMIUM_VERSION plus patches/, compiled with args.gn.
#
#   scripts/build.sh WORKDIR
#
# WORKDIR receives depot_tools (unless gclient is already on PATH), the Chromium
# checkout and src/out/Release/Shiny.app. Rerunning it resumes an interrupted
# fetch or build. JOBS caps the parallel compile jobs.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:?usage: scripts/build.sh WORKDIR}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
VERSION="$(tr -d '[:space:]' < "$REPO/CHROMIUM_VERSION")"
SRC="$WORK/src"
BASE="base-$VERSION"
OUT="out/Release"

if ! command -v gclient >/dev/null; then
  [ -d "$WORK/depot_tools" ] ||
    git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$WORK/depot_tools"
  export PATH="$WORK/depot_tools:$PATH"
fi

if ! git -C "$SRC" rev-parse -q --verify "refs/tags/$BASE" >/dev/null 2>&1; then
  echo "Fetching Chromium $VERSION"
  URL=https://chromium.googlesource.com/chromium/src.git
  # The peeled line, when there is one, sorts last.
  REV="$(git ls-remote "$URL" "refs/tags/$VERSION" "refs/tags/$VERSION^{}" | sort -k2 | tail -1 | cut -f1)"
  [ -n "$REV" ] || { echo "Chromium has no tag $VERSION" >&2; exit 1; }
  [ -f "$WORK/.gclient" ] || cat > "$WORK/.gclient" <<EOF
solutions = [
  {
    "name": "src",
    "url": "$URL",
    "managed": False,
    "custom_deps": {},
    "custom_vars": {},
  },
]
EOF
  if [ -d "$SRC/.git" ]; then
    # gclient fetches the full history when an existing checkout lacks the commit.
    git -C "$SRC" fetch -q --depth 1 --no-tags origin "$REV"
    # gclient moves HEAD to the new version, which a checked-out branch would resist.
    git -C "$SRC" checkout -q --detach
  fi
  (cd "$WORK" && gclient sync --revision "src@$REV" --no-history -D --force)
  # update-ref rather than git tag, which tag.gpgSign would turn into an annotated tag needing a message.
  git -C "$SRC" update-ref "refs/tags/$BASE" HEAD
fi

# Re-applying touches every patched file, so it only happens when the patches or the base change.
STAMP="$BASE-$(cat "$REPO"/patches/*.patch | git hash-object --stdin)"
if [ "$(git -C "$SRC" config --get shiny.applied || true)" != "$STAMP" ]; then
  echo "Applying patches"
  git -C "$SRC" checkout -q -B shiny "$BASE"
  # git am needs a committer; these commits never leave the checkout.
  git -C "$SRC" -c user.name=shiny-build -c user.email=shiny-build@localhost -c commit.gpgsign=false \
    am --quiet --3way "$REPO"/patches/*.patch || {
    echo "A patch did not apply. Resolve it in $SRC, run git am --continue there," >&2
    echo "then scripts/export-patches.sh $SRC and run this script again." >&2
    exit 1
  }
  git -C "$SRC" config shiny.applied "$STAMP"
fi

mkdir -p "$SRC/$OUT"
cmp -s "$REPO/args.gn" "$SRC/$OUT/args.gn" || cp "$REPO/args.gn" "$SRC/$OUT/args.gn"
cd "$SRC"
gn gen "$OUT"
autoninja -C "$OUT" ${JOBS:+-j "$JOBS"} chrome
echo "Built $SRC/$OUT/Shiny.app"
