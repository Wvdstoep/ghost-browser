#!/bin/sh
# Start a display, then the server.
#
# This was `xvfb-run` in the CMD for exactly one deploy, and the pod came up with nothing listening
# and NOT ONE LINE of output — which is the worst way for anything to fail, because there is no
# thread to pull. xvfb-run is a wrapper script that manages a display, an auth cookie and a retry
# loop, and when any of that goes wrong inside a container it takes stdout with it.
#
# Doing it explicitly costs eight lines and gives back the thing that matters: if the display does
# not come up, this says so and exits, instead of hanging silently while a readiness probe counts
# down. Every line here is printed on purpose.
set -e

DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"

echo "[ghost] starting Xvfb on ${DISPLAY}"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_SIZE:-1280x800x24}" -nolisten tcp &
XVFB_PID=$!

# Wait for the socket rather than sleeping a fixed amount: a slow node makes a fixed sleep too
# short, and a fast one makes it wasted startup time on every restart.
i=0
while [ ! -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "[ghost] Xvfb did not come up within 10s — the browser would be headless-in-disguise, so refusing to start"
    exit 1
  fi
  # `kill -0` asks "is it still alive" without signalling it. If Xvfb died, say so now.
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "[ghost] Xvfb exited immediately — check the screen geometry and the X extensions requested"
    exit 1
  fi
  sleep 0.1
done
echo "[ghost] Xvfb ready on ${DISPLAY} (pid ${XVFB_PID})"

# exec so node becomes PID 1's child directly and receives SIGTERM — the server closes its browser
# sessions on that signal, and an orphaned Chromium holds a node's memory until something kills it.
exec node src/server.js
