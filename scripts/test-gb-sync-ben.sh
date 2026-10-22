#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/kubectl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_LOG"
case " $* " in
  *' get deployment ghost-browser '*)
    if [ "${MOCK_GET_FAIL:-0}" = 1 ]; then exit 1; fi
    printf '%s' "$MOCK_CURRENT" ;;
  *' exec -i deploy/master '*) printf 'BUSY=%s\n' "$MOCK_BUSY" ;;
esac
EOF
chmod +x "$tmp/kubectl"
export GB_KUBECTL_BIN="$tmp/kubectl" MOCK_LOG="$tmp/log"
image='wvdstoep/ghost-browser:v645'

export MOCK_CURRENT="$image" MOCK_BUSY=0
bash "$here/gb-sync-ben.sh" "$image" > "$tmp/out"
grep -q 'already on' "$tmp/out"
! grep -q 'set image' "$tmp/log"

: > "$tmp/log"
export MOCK_CURRENT='wvdstoep/ghost-browser:v574' MOCK_BUSY=1
bash "$here/gb-sync-ben.sh" "$image" > "$tmp/out"
grep -q 'retry next cycle' "$tmp/out"
! grep -q 'set image' "$tmp/log"

: > "$tmp/log"
export MOCK_BUSY=0
bash "$here/gb-sync-ben.sh" "$image" > "$tmp/out"
grep -q 'rolled to' "$tmp/out"
grep -q 'set image deployment/ghost-browser ghost-browser=wvdstoep/ghost-browser:v645' "$tmp/log"
grep -q 'rollout status deployment/ghost-browser' "$tmp/log"

: > "$tmp/log"
if bash "$here/gb-sync-ben.sh" 'wvdstoep/ghost-browser:latest' > "$tmp/out" 2>&1; then exit 1; fi
! test -s "$tmp/log"

: > "$tmp/log"
export MOCK_GET_FAIL=1
if bash "$here/gb-sync-ben.sh" "$image" > "$tmp/out" 2>&1; then exit 1; fi
! grep -q 'set image' "$tmp/log"
