# Ghost Browser — how this is built and deployed

Hand-built on purpose: the image is NOT built by the webnpm pipeline.

```bash
cd /home/carla/gb-ship
./ship.sh v407            # build, push, SIGN, verify the signature
./ship.sh v407 --roll     # ...and roll the tenant browser (it asks first)
```

**Use the script, not the three commands from memory.** The cluster checks every first-party image
against the platform cosign key, and an unsigned image is REFUSED at admission — so a browser built
the old way pushes fine, rolls, and never starts. The script signs and then verifies the signature
before telling you it is shipped. It also refuses a tag that already exists, because silently
replacing the image a running browser is pinned to is the one mistake with no undo.

A re-apply by the provisioner now KEEPS whatever tag is running (it reads the live deployment), so a
heal or a re-connect cannot roll the browser backwards. The pin below is what a BRAND-NEW tenant's
browser starts from, so it is still worth bumping — **both** occurrences in the webnpm repo:

    ai_agent_standalone/agent-cluster/provisioner/src/cluster-tools-manifests.js   (opts.tag || 'vNNN')

WHICH TAG WINS, now that both exist: the RUNNING one. installNamespaceTool reads the live deployment
and passes that tag back in, beside the API key it already preserved for the same reason — otherwise
a heal that exists to add one env var would have rolled a v406 browser back to the generator default
and taken the logins with it. So `kubectl set image` sticks, and the pin is the floor for a fresh
install rather than the source of truth for an existing one.

**Never roll the browser while a Workshop build is in flight** — every API call the build makes comes
back `fetch failed` and an hour of work is lost. The Workshop's tool belt now retries a restarting
browser for about a minute, but waiting for the gap costs nothing.

## What lives where

- `src/agent.js` — the loop, the tool palette (`TOOLS`), the write guard and the approval gate.
- `src/tools/` — one module per tool; `index.js` builds the registry with `Object.assign`, so every
  enumerable export becomes a callable tool name (keep helpers in a `-parts.js` file).
- `src/roles.js` — roles as data; `HANDS` is what EVERY role can reach.
- `src/workflows.js` — automations as data + the graph driver (`drive`).
- `src/platforms.js` — the platform registry (`/v1/platforms`).
- `src/inspector.js` — the numbered view of a page, and `dismissConsent`.
- `__tests__/` — `npx vitest run`. Two files need `jsdom`, which is not installed here.

## The tests

```bash
npx --yes vitest@4.1.11 run
```
