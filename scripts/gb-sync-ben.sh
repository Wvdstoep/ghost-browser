#!/usr/bin/env bash
# Keep Ben's dedicated Ghost Browser on the already-built, signed mavicpro release.
# Called after a successful rollout and on no-change cron runs, so a busy Ben retries later.
set -euo pipefail

image="${1:-}"
if [[ ! "$image" =~ ^wvdstoep/ghost-browser:v[0-9]+$ ]]; then
  echo "Ben sync: invalid image '$image'" >&2
  exit 2
fi

namespace=pod-ben-magrill
if [ -n "${GB_KUBECTL_BIN:-}" ]; then k=( "$GB_KUBECTL_BIN" ); else k=( sudo kubectl ); fi
current=$("${k[@]}" -n "$namespace" get deployment ghost-browser -o jsonpath='{.spec.template.spec.containers[0].image}') || {
  echo "Ben sync: cannot read deployment; retry next cycle" >&2; exit 1;
}
if [ "$current" = "$image" ]; then
  echo "Ben sync: already on $image"
  exit 0
fi

ready=$("${k[@]}" -n "$namespace" exec -i deploy/master -- node -e '
  fetch(process.env.GHOST_URL + "/v1/deploy/readiness", {
    headers: { authorization: "Bearer " + process.env.GHOST_API_KEY }
  }).then(async r => {
    const j = await r.json();
    console.log("BUSY=" + (r.ok && j.busy === 0 ? 0 : 1));
    console.log(j.explain || "readiness unavailable");
  }).catch(e => { console.log("BUSY=1"); console.log(e.message); });
' 2>/dev/null) || ready='BUSY=1'
if ! printf '%s\n' "$ready" | grep -qx 'BUSY=0'; then
  echo "Ben sync: browser is busy or readiness is unavailable; retry next cycle"
  exit 0
fi

"${k[@]}" -n "$namespace" set image deployment/ghost-browser "ghost-browser=$image"
"${k[@]}" -n "$namespace" rollout status deployment/ghost-browser --timeout=240s
echo "Ben sync: rolled to $image"
