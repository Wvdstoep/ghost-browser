#!/usr/bin/env bash
# ── SHIP THE BROWSER: build, push, SIGN, and say what to do next ─────────────────────────────────
#
# The browser is built by hand on purpose (it is not in the webnpm pipeline), and for as long as that
# was three commands typed from memory, one of them kept being forgotten: the SIGNATURE. Every image
# the cluster runs is checked against the platform's cosign key, and an unsigned first-party image is
# refused at admission — so a browser built the old way would push fine, roll, and never start.
#
# So the three commands live here, in the order that works, with the signature not optional.
#
# Usage:   ./ship.sh v407            # build, push, sign
#          ./ship.sh v407 --roll     # …and roll the tenant's browser straight away
#
# The tag is deliberately an argument with no default. A shipped browser is a version somebody chose.
set -euo pipefail

TAG="${1:-}"
ROLL="${2:-}"
IMAGE="wvdstoep/ghost-browser:${TAG}"
NS="${GB_NAMESPACE:-pod-mavicpro-fan}"
KEY="${COSIGN_KEY:-/etc/cosign/cosign.key}"
export COSIGN_PASSWORD="${COSIGN_PASSWORD:-}"

if [[ -z "$TAG" || ! "$TAG" =~ ^v[0-9]+$ ]]; then
  echo "usage: ./ship.sh vNNN [--roll]"
  echo "  the last shipped tag: $(sudo kubectl get deploy ghost-browser -n "$NS" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo unknown)"
  exit 2
fi

# A tag that already exists in the registry is almost always a typo — the alternative is silently
# replacing the image a running browser is pinned to, which is the one mistake with no undo.
if sudo docker manifest inspect "$IMAGE" >/dev/null 2>&1; then
  echo "✋ $IMAGE already exists in the registry. Pick the next tag."
  exit 2
fi

echo "🔨 building $IMAGE"
sudo docker build -t "$IMAGE" .

echo "📤 pushing"
sudo docker push "$IMAGE"

# THE STEP THAT USED TO BE FORGOTTEN. Not best-effort here: this script exists so that a browser
# cannot be shipped unsigned, and a signing failure now is infinitely cheaper than a browser that
# will not start at 3am. tlog-free, same key the Kyverno policy carries.
echo "🔏 signing"
sudo COSIGN_PASSWORD="$COSIGN_PASSWORD" cosign sign --yes --tlog-upload=false --key "$KEY" "$IMAGE"
sudo cosign verify --key /etc/cosign/cosign.pub --insecure-ignore-tlog "$IMAGE" >/dev/null
echo "   ✓ signature verifies"

echo ""
echo "✅ $IMAGE is shipped and signed."
echo ""
if [[ "$ROLL" == "--roll" ]]; then
  # NEVER while a long browser job is in flight: every API call the job makes comes back
  # `fetch failed`. The script asks rather than assuming, because only a person knows what is running.
  echo "⚠️  rolling now — anything the browser is doing right now dies with the pod."
  read -r -p "    a pass or a build in flight? [y/N] to continue: " ans
  if [[ "${ans:-N}" =~ ^[Yy]$ ]]; then
    sudo kubectl set image "deploy/ghost-browser" -n "$NS" "ghost-browser=$IMAGE"
    sudo kubectl rollout status "deploy/ghost-browser" -n "$NS" --timeout=300s
  else
    echo "    not rolled."
  fi
else
  echo "To roll it now:"
  echo "  sudo kubectl set image deploy/ghost-browser -n $NS ghost-browser=$IMAGE"
fi
echo ""
echo "And bump the pin so a FRESH install gets this one too (a re-apply keeps whatever is running,"
echo "but a brand-new tenant's browser comes from the pin):"
echo "  ai_agent_standalone/agent-cluster/provisioner/src/cluster-tools-manifests.js  (opts.tag || '$TAG')"
