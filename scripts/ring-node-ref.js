'use strict';
/**
 * scripts/ring-node-ref.js — the smallest ring node that can answer passkey prompts.
 *
 * A REFERENCE for the wire contract in src/ringauth.js, and the node the tests drive the real device
 * hub with. It registers with the hub, long-polls for commands, answers POST /v1/webauthn with a
 * software authenticator, and posts the result back. A phone or laptop app does the same with its
 * platform authenticator and a real approval screen; the server side does not change.
 *
 *   node scripts/ring-node-ref.js        env: GB_URL, GB_KEY, DEVICE_ID, DEVICE_NAME, APPROVE=auto|never
 *
 * `approve: auto` exists for tests and demos ONLY. A real node asks the owner, every time.
 */
const { makeSoftAuthenticator } = require('../src/authrelay');

async function runNode({ base, key, deviceId = 'ref-node', name = 'Reference node', authenticator = makeSoftAuthenticator(), fetchImpl = fetch, pollMs = 100 }) {
  const stopper = new AbortController();
  const H = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  const post = (p, body) => fetchImpl(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const reg = await post('/v1/device/register', { deviceId, name, caps: { platform: 'desktop', realIp: true, features: ['webauthn'] } });
  if (!reg.ok) throw new Error('could not register: ' + reg.status);

  const loop = (async () => {
    while (!stopper.signal.aborted) {
      let r;
      try { r = await fetchImpl(`${base}/v1/device/poll?deviceId=${encodeURIComponent(deviceId)}`, { headers: H, signal: AbortSignal.any([AbortSignal.timeout(30000), stopper.signal]) }); }
      catch { await new Promise((x) => setTimeout(x, pollMs)); continue; }
      if (r.status === 204) continue;
      if (!r.ok) { await new Promise((x) => setTimeout(x, pollMs)); continue; }
      const cmd = await r.json();
      let result;
      if (cmd.path === '/v1/webauthn') {
        try { const response = cmd.body.kind === 'create' ? await authenticator.create(cmd.body) : await authenticator.get(cmd.body); result = { response }; }
        catch (e) { result = { error: e.message }; }
      } else result = { error: 'this node only answers /v1/webauthn' };
      await post('/v1/device/result', { deviceId, id: cmd.id, ...result });
    }
  })();
  return { authenticator, stop: () => { stopper.abort(); return loop.catch(() => {}); }, loop };
}

module.exports = { runNode };

if (require.main === module) {
  const approve = process.env.APPROVE === 'auto' ? async () => true : async () => false;
  runNode({ base: process.env.GB_URL, key: process.env.GB_KEY, deviceId: process.env.DEVICE_ID || 'ref-node', name: process.env.DEVICE_NAME || 'Reference node', authenticator: makeSoftAuthenticator({ approve }) })
    .then(() => console.log('ring node up; waiting for prompts'))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
