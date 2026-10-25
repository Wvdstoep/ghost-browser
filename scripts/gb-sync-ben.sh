#!/usr/bin/env bash
# Keep Ben's dedicated Ghost Browser on the already-built, signed mavicpro release.
# Called after a successful rollout and on no-change cron runs, so a busy Ben retries later.
set -euo pipefail

image="${1:-}"
if [[ ! "$image" =~ ^wvdstoep/ghost-browser:v[0-9]+$ ]]; then
  echo "Ben sync: invalid image '$image'" >&2
  exit 2
fi

namespace=ghost-browser
if [ -n "${GB_KUBECTL_BIN:-}" ]; then k=( "$GB_KUBECTL_BIN" ); else k=( sudo kubectl ); fi
# The tool moved into Ben's dedicated k3s; the platform namespace is only its proxy.
k+=( -n byon-cp-ben-magrill exec -i deployment/byon-ben-magrill -c k3s -- kubectl )
current=$("${k[@]}" -n "$namespace" get deployment ghost-browser -o jsonpath='{.spec.template.spec.containers[0].image}') || {
  echo "Ben sync: cannot read deployment; retry next cycle" >&2; exit 1;
}
if [ "$current" = "$image" ]; then
  echo "Ben sync: already on $image"
  exit 0
fi

# A browser that cannot pull its old image cannot answer readiness or have active jobs.
# Recover only when every reported container is blocked on image pull and no replica is available.
available=$("${k[@]}" -n "$namespace" get deployment ghost-browser -o jsonpath='{.status.availableReplicas}')
waiting=$("${k[@]}" -n "$namespace" get pods -l app=ghost-browser -o jsonpath='{range .items[*].status.containerStatuses[*]}{.state.waiting.reason}{"\n"}{end}')
pull_blocked=false
if [ "${available:-0}" = 0 ] && [ -n "$waiting" ] && ! printf '%s\n' "$waiting" | grep -qEv '^(ErrImagePull|ImagePullBackOff)$'; then
  pull_blocked=true
fi

ready=$("${k[@]}" -n "$namespace" exec -i deploy/ghost-browser -- node -e '
  fetch("http://127.0.0.1:3000/v1/deploy/readiness", {
    headers: { authorization: "Bearer " + (process.env.API_KEYS || "").split(",")[0].split(":")[0] }
  }).then(async r => {
    const j = await r.json();
    console.log("BUSY=" + (r.ok && j.busy === 0 ? 0 : 1));
    console.log(j.explain || "readiness unavailable");
  }).catch(e => { console.log("BUSY=1"); console.log(e.message); });
' 2>/dev/null) || ready='BUSY=1'
if [ "$pull_blocked" != true ] && ! printf '%s\n' "$ready" | grep -qx 'BUSY=0'; then
  echo "Ben sync: browser is busy or readiness is unavailable; retry next cycle"
  exit 0
fi

"${k[@]}" -n "$namespace" set image deployment/ghost-browser "ghost-browser=$image"
"${k[@]}" -n "$namespace" rollout status deployment/ghost-browser --timeout=240s
echo "Ben sync: rolled to $image"
