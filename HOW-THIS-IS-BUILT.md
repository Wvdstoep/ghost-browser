# Ghost Browser — how this is built and deployed

Hand-built on purpose: the image is NOT built by the webnpm pipeline.

```bash
cd /home/carla/gb.new
sudo docker build -t wvdstoep/ghost-browser:vNNN .
sudo docker push wvdstoep/ghost-browser:vNNN
```

Then bump the tag the provisioner reconciles — **both** occurrences in the webnpm repo:

    ai_agent_standalone/agent-cluster/provisioner/src/cluster-tools-manifests.js   (opts.tag || 'vNNN')

and push webnpm. The provisioner re-applies the tool manifest and the tenant's browser rolls. Setting
the image by hand (`kubectl set image`) works for a test but is reverted the next time the
provisioner reconciles, so the pin is the source of truth.

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
