#!/usr/bin/env bash
# auto-release.sh — release the phone and/or desktop app by itself after a push, on THIS machine.
#
# Owner (2026-11-20): "i dont want to build it on the server i want to keep it here i do want the builds to
# be automatic updated on the github as it does and to the download site". scripts/push-changes.sh calls
# this after every push with the commits it pushed. It decides what to release and starts release-apps.sh
# in the background, so the push returns at once and the build (about 11 minutes) runs here:
#
#     ghost-browser/mobile/auto-release.sh <old-commit> <new-commit>      (what push-changes.sh does)
#     ghost-browser/mobile/auto-release.sh --plan <old> <new>             only print what it would do
#
# An app is released when its VERSION changed in the pushed commits:
#   phone   — versionName or versionCode in mobile/app/build.gradle.kts
#   desktop — packageVersion in mobile/desktop/build.gradle.kts
# A version is the signal on purpose: an installed app only updates to a higher version (the Windows
# installer upgrades in place only then), so a release without a new version would not reach anyone.
# Changed app code WITHOUT a new version is not released; the push says so, with what to bump.
#
# The build's output goes to mobile/dist/auto-release.log; the last result to mobile/dist/auto-release.status.
# Turn it off for one push with GB_AUTO_RELEASE=0.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
PLAN=0; [ "${1:-}" = "--plan" ] && { PLAN=1; shift; }
OLD="${1:-}"; NEW="${2:-HEAD}"
[ "${GB_AUTO_RELEASE:-1}" = "0" ] && exit 0
[ -n "$OLD" ] || { echo "usage: $0 [--plan] <old-commit> <new-commit>"; exit 2; }
git -C "$REPO" cat-file -e "$OLD^{commit}" 2>/dev/null || exit 0     # first push of a branch: nothing to compare

APP=ghost-browser/mobile/app/build.gradle.kts
DESK=ghost-browser/mobile/desktop/build.gradle.kts
at() { git -C "$REPO" show "$1:$2" 2>/dev/null; }
phoneVer() { at "$1" "$APP" | sed -n 's/.*\(versionName = "[^"]*"\|versionCode = [0-9]*\).*/\1/p' | tr '\n' ' '; }
deskVer() { at "$1" "$DESK" | sed -n 's/.*packageVersion = "\([^"]*\)".*/\1/p' | head -1; }
changed() { [ -n "$(git -C "$REPO" diff --name-only "$OLD" "$NEW" -- "$@")" ]; }

PHONE=0; DESKTOP=0
[ "$(phoneVer "$OLD")" != "$(phoneVer "$NEW")" ] && PHONE=1
[ "$(deskVer "$OLD")" != "$(deskVer "$NEW")" ] && DESKTOP=1
# Code that changed without a new version: worth a line, never a release.
if [ "$PHONE" = 0 ] && changed ghost-browser/mobile/app ghost-browser/mobile/shared; then
  echo "ℹ️  the phone app changed but its version did not (versionName/versionCode in $APP): not released"
fi
if [ "$DESKTOP" = 0 ] && changed ghost-browser/mobile/desktop ghost-browser/mobile/shared; then
  echo "ℹ️  the desktop app changed but its version did not (packageVersion in $DESK): not released"
fi

WHAT=""
if [ "$PHONE" = 1 ] && [ "$DESKTOP" = 1 ]; then WHAT=all; elif [ "$PHONE" = 1 ]; then WHAT=apk; elif [ "$DESKTOP" = 1 ]; then WHAT=msi; fi
[ -n "$WHAT" ] || exit 0
if [ "$PLAN" = 1 ]; then echo "$WHAT"; exit 0; fi

DIST="$HERE/dist"; mkdir -p "$DIST"
LOG="$DIST/auto-release.log"; STATUS="$DIST/auto-release.status"; LOCK="$DIST/auto-release.lock"
# One build at a time: Gradle and the upload do not share. A second push while one builds waits for it.
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "⏳ a release is already building (pid $(cat "$LOCK")); this one ($WHAT) starts when it is done"
fi
echo "🚀 releasing the $( [ "$WHAT" = all ] && echo 'phone and desktop apps' || { [ "$WHAT" = apk ] && echo 'phone app' || echo 'desktop app'; } ) from ${NEW:0:8} in the background (about 11 minutes)"
echo "   follow it: tail -f ghost-browser/mobile/dist/auto-release.log"
nohup bash -c '
  LOCK="$1"; WHAT="$2"; STATUS="$3"; HERE="$4"; NEW="$5"
  while [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; do sleep 20; done
  echo $$ > "$LOCK"
  echo "building $WHAT from $NEW since $(date "+%F %T")" > "$STATUS"
  echo "===== $(date "+%F %T") release $WHAT from $NEW ====="
  if bash "$HERE/release-apps.sh" "$WHAT"; then echo "released $WHAT from $NEW at $(date "+%F %T")" > "$STATUS"
  else echo "FAILED $WHAT from $NEW at $(date "+%F %T") (see auto-release.log)" > "$STATUS"; fi
  rm -f "$LOCK"
' _ "$LOCK" "$WHAT" "$STATUS" "$HERE" "$NEW" >> "$LOG" 2>&1 < /dev/null &
disown 2>/dev/null || true
exit 0
