'use strict';
/**
 * ringauth.js — carry a passkey prompt from the cluster's browser to the owner's device and back,
 * over the device ring that already exists.
 *
 * authrelay.js intercepts the page's WebAuthn call and hands it to an `ask(request)`. This is the
 * `ask` that reaches a real node: it queues a command on the device hub (the same long-poll channel
 * every ring node already holds open), the node's authenticator answers after the owner approves, and
 * only the signed assertion comes back.
 *
 * THE WIRE CONTRACT a node implements (nothing else is needed on the device):
 *
 *   it advertises   caps.features includes "webauthn"            (so it can be found and routed to)
 *   it is sent      POST /v1/webauthn   body = the relay request  { kind: 'get'|'create', rpId, origin,
 *                                                                   challenge, allowCredentials, user, site }
 *   it answers      { response: { id, rawId, type, response: {...} } }     on approval
 *                   { error: "…" }                                          when the owner declines
 *
 * The device shows the owner WHAT is asking (site, rpId, kind) before it signs: that screen is the
 * security boundary, since a cluster that is compromised can ask for anything. A request the owner
 * did not expect is a request to decline.
 *
 * Fails SAFE. No device online, a device that does not answer in time, or a decline all end the same
 * way for the page: NotAllowedError, exactly what a dismissed prompt gives. A login that needs a
 * passkey simply does not complete; nothing is ever approved by default.
 */

const FEATURE = 'webauthn';
const PATH = '/v1/webauthn';

/** Online devices of this owner that can answer WebAuthn, freshest first. */
function candidates(hub, owner) {
  return (hub.deviceList() || [])
    .filter((d) => d.online && (!owner || d.owner === owner) && d.caps && (d.caps.features || []).includes(FEATURE))
    .sort((a, b) => (b.caps.realIp ? 1 : 0) - (a.caps.realIp ? 1 : 0));
}

/**
 * Build the `ask` for a session. `target()` returns the deviceId to use right now (a fixed one the
 * owner chose, or null to pick the best online device at the moment of the prompt).
 */
function makeAsk(hub, { owner = null, target = () => null, timeoutMs = 120000, log = console } = {}) {
  return async (req) => {
    const want = target();
    const list = candidates(hub, owner);
    const dev = want ? list.find((d) => d.deviceId === want) : list[0];
    if (!dev) throw new Error(want ? `the device "${want}" is not online or cannot answer passkey prompts` : 'no device that can answer passkey prompts is online');
    log.info?.(`[ringauth] asking ${dev.name} to answer a ${req.kind} for ${req.site}`);
    let out;
    try { out = await hub.runCommand(dev.deviceId, { method: 'POST', path: PATH, body: req }, timeoutMs); }
    catch (e) { throw new Error(/did not respond/.test(e.message) ? 'the device did not answer in time' : e.message); }
    const r = (out && out.result) || {};
    if (r.error) throw new Error(r.error);
    const resp = r.response || (r.result && r.result.response);
    if (!resp || !resp.response) throw new Error('the device answered without an assertion');
    return resp;
  };
}

module.exports = { makeAsk, candidates, FEATURE, PATH };
