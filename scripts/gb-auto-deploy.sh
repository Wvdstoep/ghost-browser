#!/usr/bin/env bash
# gb-auto-deploy.sh — when the canonical Ghost Browser repo (GitHub) advances (a PR was merged),
# rebuild the platform tool image, smoke-test it, and roll the running tool — but ONLY when GB is
# idle, never under a live session. The MERGE stays the human review gate; this only ships what a
# human already merged. Runs from cron; safe to run every few minutes (it no-ops until main moves).
set -uo pipefail

REPO_URL="https://github.com/Wvdstoep/ghost-browser.git"
SRC="/home/carla/gb-autobuild"          # a clone of the canonical repo
NS="pod-mavicpro-fan"
DEPLOY="ghost-browser"
CONTAINER="ghost-browser"               # single container (Tailscale exit node is in-image)
IMG="wvdstoep/ghost-browser"
STATE="/home/carla/.gb-autodeploy-last" # last GitHub commit we built+rolled
LOG="/home/carla/gb-autodeploy.log"
LOCK="/home/carla/.gb-autodeploy.lock"
SMOKE_PORT=39321

exec >>"$LOG" 2>&1
echo "=== $(date -Is) ==="

# one instance at a time
exec 9>"$LOCK" || exit 0
flock -n 9 || { echo "another run holds the lock; exit"; exit 0; }

# never pile onto another heavy build (e.g. the platform CI building an image)
if pgrep -af 'docker build|go install' | grep -qv 'gb-auto-deploy'; then
  echo "a heavy build is already running; deferring to next cycle"; exit 0
fi

# fresh clone or update
if [ -d "$SRC/.git" ]; then sudo chown -R carla:carla "$SRC" 2>/dev/null; git -C "$SRC" fetch origin main --quiet || { echo "fetch failed"; exit 1; }
else rm -rf "$SRC"; git clone --quiet --depth 50 "$REPO_URL" "$SRC" || { echo "clone failed"; exit 1; }; fi
NEW=$(git -C "$SRC" rev-parse origin/main 2>/dev/null || git -C "$SRC" rev-parse HEAD)
LAST=$(cat "$STATE" 2>/dev/null || echo "")
if [ "$NEW" = "$LAST" ]; then echo "no new commit ($NEW)"; exit 0; fi
git -C "$SRC" checkout --quiet -B main origin/main 2>/dev/null || git -C "$SRC" reset --hard "$NEW"
echo "canonical advanced: ${LAST:-none} -> $NEW"

# next version tag = current running tag + 1 (vNNN)
CUR=$(sudo kubectl -n "$NS" get deploy "$DEPLOY" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | sed -E 's/.*:v?//')
case "$CUR" in ''|*[!0-9]*) echo "cannot read current tag ('$CUR'); abort"; exit 1;; esac
TAG="v$((CUR + 1))"
echo "building $IMG:$TAG (current v$CUR)"
# THE COMPOSE CONSOLE IS A BUILD ARTIFACT, NOT A COMMIT.
# public/console/ is ~28MB of Kotlin/Wasm output and is gitignored on purpose, so a fresh clone of
# main NEVER carries it. That is why every auto-deployed image silently shipped the OLD html console
# while hand-builds from gb.new shipped the shared Compose UI: the dist only ever existed on disk.
# Copy the dist (and the loader index.html that points at it) into the build context before the
# image is built, so an auto-deploy stops reverting the console.
CONSOLE_SRC="/home/carla/gb.new/public/console"
LOADER_SRC="/home/carla/gb.new/public/index.html"
if [ -d "$CONSOLE_SRC" ]; then
  rm -rf "$SRC/public/console"
  cp -a "$CONSOLE_SRC" "$SRC/public/console"
  if grep -q 'base href="/console/"' "$LOADER_SRC" 2>/dev/null; then
    cp -a "$LOADER_SRC" "$SRC/public/index.html"
    echo "compose console + loader copied in ($(du -sh "$SRC/public/console" | cut -f1))"
  else
    echo "WARN: $LOADER_SRC is not the console loader — shipping console/ without swapping index.html"
  fi
else
  echo "WARN: no console dist at $CONSOLE_SRC — this image will ship the OLD console"
fi

if ! sudo docker build --network host -t "$IMG:$TAG" "$SRC"; then echo "BUILD FAILED — not rolling"; exit 1; fi

# smoke: the image boots and answers /healthz
CID=$(sudo docker run -d --rm -p 127.0.0.1:${SMOKE_PORT}:3000 "$IMG:$TAG" 2>/dev/null || true)
sleep 8
OK=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SMOKE_PORT}/healthz" 2>/dev/null || echo 000)
[ -n "$CID" ] && sudo docker rm -f "$CID" >/dev/null 2>&1 || true
if [ "$OK" != "200" ]; then echo "SMOKE FAILED (healthz=$OK) — not rolling, not recording"; exit 1; fi
echo "smoke ok"

# publish so pods can pull it
sudo docker push "$IMG:$TAG" || echo "push to Hub failed (continuing; ctr-importing locally)"

# ── SIGNEREN HOORT BIJ DUWEN ───────────────────────────────────────────────────────────────────────
# Het cluster controleert elk eigen image tegen de cosign-sleutel van het platform: een ongesigneerd
# image wordt bij admission GEWEIGERD. Deze stap ontbrak, en dat viel niet op doordat cosign de
# DIGEST signeert en niet de tag: v411 had exact dezelfde digest als de v410 die met de hand
# gesigneerd was, dus hij kwam er toevallig door. De eerste build met echt nieuwe inhoud zou zijn
# geweigerd, en dan is het symptoom "de pod start niet" in plaats van "de build klopt niet".
#
# Gecontroleerd in plaats van gehoopt, met dezelfde publieke sleutel die het cluster gebruikt, zodat
# het hier faalt om precies de redenen waarom het daar zou falen.
COSIGN_KEY="${COSIGN_KEY:-/etc/cosign/cosign.key}"
COSIGN_PUB="${COSIGN_KEY%.key}.pub"
export COSIGN_PASSWORD="${COSIGN_PASSWORD:-}"
if sudo -E cosign sign --yes --tlog-upload=false --key "$COSIGN_KEY" "$IMG:$TAG" >/dev/null 2>&1; then
  if sudo cosign verify --key "$COSIGN_PUB" --insecure-ignore-tlog "$IMG:$TAG" >/dev/null 2>&1; then
    echo "signed $IMG:$TAG"
  else
    echo "SIGNATURE DOES NOT VERIFY for $IMG:$TAG — Kyverno will refuse this image, not rolling"; exit 1
  fi
else
  echo "cosign sign FAILED for $IMG:$TAG — Kyverno will refuse this image, not rolling"; exit 1
fi
sudo docker save "$IMG:$TAG" | sudo ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import - || true

# ── IS THE BROWSER ACTUALLY WORKING? GB ANSWERS THAT ITSELF NOW ────────────────────────────────────
# This gate used to reimplement GB's idea of "busy" here: three Node one-liners over three
# endpoints, the three counts added together, and the total printed as "GB has N active session(s)".
# It was wrong in the one direction that costs, and unreadable when it was.
#
#   - A session holding no job counted as busy forever. The rule was "no job means the owner is in
#     their own browser" — true while someone is there, but the job is looked up in the job store,
#     and once that record ages out the lookup answers null. So a session nobody had touched for an
#     hour read exactly like a person typing in it, and a built image waited for the pool's
#     two-hour absolute TTL. Seen three times.
#   - A parked conversation counted as work. `idle` in GB means finished and waiting for a person to
#     say carry on; the agent keeps that session alive for half an hour on purpose. Rolling costs it
#     nothing that is not already written to its report.
#   - The log said a number, not a name. With the three counts already summed there was no way to
#     tell a session from a watcher from a chat without asking the cluster all three again by hand.
#
# So: one question to /v1/deploy/readiness, which decides where the facts are (src/deployReadiness.js
# — a pure function, with its rules under test), and which answers with every holder and why it does
# or does not block. On any error, busy=1: defer rather than roll blind.
READY=$(sudo kubectl -n "$NS" exec -i deploy/master -- node -e 'fetch(process.env.GHOST_URL+"/v1/deploy/readiness",{headers:{authorization:"Bearer "+process.env.GHOST_API_KEY}}).then(r=>r.json()).then(j=>{console.log("BUSY="+(j.busy==null?1:j.busy));console.log(j.explain||"(no reasons given)")}).catch(e=>{console.log("BUSY=1");console.log("could not ask GB: "+e.message)})' 2>/dev/null)
BUSY=$(printf '%s\n' "$READY" | sed -n 's/^BUSY=//p' | tail -1)
case "${BUSY:-1}" in ''|*[!0-9]*) BUSY=1;; esac
echo "who is holding the browser:"
printf '%s\n' "$READY" | grep -v '^BUSY=' | sed '/^$/d;s/^/  /'

# ── AND A CEILING ON DEFERRING, BECAUSE THERE WAS NONE ─────────────────────────────────────────────
# Deferring had no end: every cycle that read busy pushed the roll to the next one, so one
# misread holder could park a finished, signed, smoke-tested image indefinitely — and did.
# Waiting for an idle browser is a courtesy, not a correctness requirement: the roll costs whoever
# is in the browser their session, and after this long there is no longer plausibly anyone there.
# The wait is measured from the FIRST deferral of this pending image, not from this cycle.
PENDING_SINCE="${STATE}.pending-since"
MAX_DEFER_MIN="${MAX_DEFER_MIN:-45}"
if [ "${BUSY:-1}" -gt 0 ]; then
  NOW_S=$(date +%s)
  SINCE=$(cat "$PENDING_SINCE" 2>/dev/null || echo "")
  case "$SINCE" in ''|*[!0-9]*) SINCE=$NOW_S; echo "$NOW_S" > "$PENDING_SINCE";; esac
  WAITED=$(( (NOW_S - SINCE) / 60 ))
  if [ "$WAITED" -ge "$MAX_DEFER_MIN" ]; then
    echo "ROLLING ANYWAY: ${BUSY} holder(s) still read as blocking after ${WAITED} min of deferring"
    echo "  (ceiling MAX_DEFER_MIN=${MAX_DEFER_MIN}. If a real walk was cut short, that is the trade:"
    echo "   an image that never ships is worse than a session that has to be started again.)"
  else
    echo "GB is busy (${BUSY} blocking) — image $TAG built+pushed, deferring the ROLL (waited ${WAITED}/${MAX_DEFER_MIN} min)"
    echo "$NEW" > "${STATE}.pending"
    exit 0
  fi
else
  rm -f "$PENDING_SINCE"
fi

# roll only the GB container (sticks: the tools reconciler leaves an existing tool alone)
sudo kubectl -n "$NS" set image deploy/"$DEPLOY" "${CONTAINER}=${IMG}:${TAG}"
if sudo kubectl -n "$NS" rollout status deploy/"$DEPLOY" --timeout=180s; then
  echo "$NEW" > "$STATE"; rm -f "${STATE}.pending" "${STATE}.pending-since"
  echo "ROLLED $DEPLOY -> $TAG"
else
  echo "rollout did not become ready in time — check the pod"; exit 1
fi
