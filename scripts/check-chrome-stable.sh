#!/usr/bin/env bash
# Opens an issue when Chrome stable for Mac is newer than CHROMIUM_VERSION.
# DRY_RUN=1 prints the issue instead of creating it; ASSUME_CURRENT overrides the file.
set -euo pipefail
cd "$(dirname "$0")/.."
current="${ASSUME_CURRENT:-$(tr -d '[:space:]' < CHROMIUM_VERSION)}"
api="https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/stable/versions?pageSize=20"
latest="$(curl -fsSL "$api" | jq -r '.versions[].version' | sort -V | tail -1)"
[ -n "$latest" ] || { echo "no version from $api" >&2; exit 1; }
echo "current=$current latest=$latest"
if [ "$latest" = "$current" ] || [ "$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -1)" = "$current" ]; then
  echo "up to date"; exit 0
fi
title="Chrome stable $latest"
body="$(cat <<BODY
Chrome stable for Mac is now **$latest** (Shiny is on $current).

- Release notes: https://chromereleases.googleblog.com/search/label/Stable%20updates
- Version history: https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/stable/versions

Update checklist:
- [ ] Studio builds it with scripts/auto-build.sh; a patch that no longer applies stops the build
- [ ] Smoke test
- [ ] Install on the MacBook
- [ ] Run scripts/export-patches.sh, commit, close this issue
BODY
)"
# The same version only ever gets one issue, open or closed.
titles="$(gh issue list --state all --search "\"$title\" in:title" --json title --jq '.[].title')"
if grep -qxF "$title" <<<"$titles"; then
  echo "issue already exists: $title"; exit 0
fi
if [ "${DRY_RUN:-0}" = "1" ]; then
  printf 'DRY RUN, would open:\n# %s\n%s\n' "$title" "$body"; exit 0
fi
gh label create chrome-update --color 1f6feb --description "New Chrome stable to rebase onto" --force >/dev/null
gh issue create --title "$title" --label chrome-update --body "$body"
