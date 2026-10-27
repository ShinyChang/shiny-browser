#!/usr/bin/env bash
# Builds Shy on the newest Chrome stable for Mac once it is newer than CHROMIUM_VERSION.
#
#   scripts/auto-build.sh BUILDS_DIR
#
# Each version is tried once, in BUILDS_DIR/<version>; its status file ends as
# "ok" or "failed: <reason>", and deleting it allows another try. AFTER_BUILD,
# when set, runs with the app's path and has to succeed for "ok". When gh is
# logged in, the version's chrome-update issue gets the result as a comment.
# Only the newest build is kept. ASSUME_CURRENT overrides CHROMIUM_VERSION.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUILDS="${1:?usage: scripts/auto-build.sh BUILDS_DIR}"
mkdir -p "$BUILDS"
BUILDS="$(cd "$BUILDS" && pwd)"
now() { date '+%F %T'; }

# Offline, the patches already here are still a valid build.
git -C "$REPO" pull -q --ff-only origin main || echo "$(now) pull failed, using the local patches"

current="${ASSUME_CURRENT:-$(tr -d '[:space:]' < "$REPO/CHROMIUM_VERSION")}"
api="https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/stable/versions?pageSize=20"
latest="$(curl -fsSL "$api" | jq -r '.versions[].version' | sort -V | tail -1)"
[ -n "$latest" ] || { echo "$(now) no version from $api" >&2; exit 1; }
if [ "$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -1)" = "$current" ]; then
  echo "$(now) up to date ($current)"
  exit 0
fi

DIR="$BUILDS/$latest"
if [ -f "$DIR/status" ]; then
  echo "$(now) $latest already tried: $(cat "$DIR/status")"
  exit 0
fi
mkdir -p "$DIR"
echo "running since $(now)" > "$DIR/status"
echo "$(now) building $latest in $DIR"

APP="$DIR/src/out/Release/Shy.app"
if ! caffeinate -ims nice -n 10 "$REPO/scripts/build.sh" "$DIR" "$latest" > "$DIR/build.log" 2>&1; then
  reason="$(grep -m1 '^Patch failed at' "$DIR/build.log" || echo 'build error')"
  result="failed: $reason"
elif [ -n "${AFTER_BUILD:-}" ] && ! "$AFTER_BUILD" "$APP" >> "$DIR/build.log" 2>&1; then
  result="failed: AFTER_BUILD check"
else
  result="ok"
fi
echo "$result" > "$DIR/status"
echo "$(now) $latest: $result"

if gh auth status > /dev/null 2>&1; then
  issue="$(cd "$REPO" && gh issue list --state open --search "\"Chrome stable $latest\" in:title" \
    --json number,title --jq ".[] | select(.title == \"Chrome stable $latest\") | .number" | head -1)" || issue=""
  if [ -n "$issue" ]; then
    if [ "$result" = ok ]; then
      body="Studio built Shy on $latest and the post-build checks passed: \`$APP\`"
    else
      body="Studio could not build Shy on $latest ($result). Log: \`$DIR/build.log\`"
    fi
    (cd "$REPO" && gh issue comment "$issue" --body "$body" > /dev/null) || echo "$(now) could not comment on #$issue"
  fi
fi

# Each build takes about 41 GB, so only the newest stays.
for v in $(ls -1 "$BUILDS" | grep -E '^[0-9]+(\.[0-9]+)+$' | sort -rV | awk 'NR > 1' || true); do
  if [ -f "$BUILDS/$v/status" ] && ! grep -q '^running' "$BUILDS/$v/status"; then
    echo "$(now) removing old build $v"
    rm -rf "${BUILDS:?}/$v"
  fi
done
