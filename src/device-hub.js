/*
 * Device hub — the REVERSE (poll) channel. A device (a phone running GB Mobile) can't be reached
 * inbound (Android/tailnet won't accept it), so instead it DIALS IN: it registers, long-polls for
 * commands, runs each on its own real WebView, and posts the result back. The operator/master enqueues
 * a command and awaits its result. Everything is behind `authed` (SSO cookie or Bearer key); the
 * deviceId is the device's own secret token, so knowing it is what targets a specific device.
 * In-memory (single GB instance), which is all this needs.
 */
function mountDeviceHub(app, authed) {
  const devices = new Map(); // id -> {name, owner, queue:[], pollWaiters:[], resultWaiters:Map, lastSeen, log:[], logSeq}
  let seq = 0;
  const dev = (id) => devices.get(String(id || ""));
  const ownerOf = (req) => (req.client && req.client.owner) || "anon";

  // Per-device activity log (ring buffer) so the operator/master can watch what the phone is doing —
  // both the on-device agent's own runs and commands we drive. Kept small and in-memory.
  const pushLog = (d, line) => {
    if (!d) return;
    if (!d.log) { d.log = []; d.logSeq = 0; }
    d.log.push({ n: ++d.logSeq, t: Date.now(), line: String(line).slice(0, 500) });
    if (d.log.length > 400) d.log.splice(0, d.log.length - 400);
  };

  app.post("/v1/device/register", authed, (req, res) => {
    const id = String((req.body && req.body.deviceId) || "").trim();
    if (!id) return res.status(400).json({ error: "deviceId required" });
    let d = devices.get(id);
    if (!d) d = { name: "", owner: ownerOf(req), queue: [], pollWaiters: [], resultWaiters: new Map(), lastSeen: 0, log: [], logSeq: 0 };
    if (!d.log) { d.log = []; d.logSeq = 0; }
    d.name = (req.body && req.body.name) || d.name || id;
    d.owner = ownerOf(req);
    d.lastSeen = Date.now();
    devices.set(id, d);
    res.json({ ok: true, deviceId: id });
  });

  app.get("/v1/device/list", authed, (_req, res) => {
    const now = Date.now();
    res.json({ devices: [...devices.entries()].map(([id, d]) => ({
      deviceId: id, name: d.name, owner: d.owner, queued: d.queue.length,
      lastSeen: d.lastSeen, online: (now - d.lastSeen) < 40000,
    })) });
  });

  // The device long-polls this: returns the next command immediately, or holds ~25s then 204.
  app.get("/v1/device/poll", authed, (req, res) => {
    const d = dev(req.query.deviceId);
    if (!d) return res.status(404).json({ error: "register first" });
    d.lastSeen = Date.now();
    if (d.queue.length) return res.json(d.queue.shift());
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); d.pollWaiters = d.pollWaiters.filter((w) => w.res !== res); fn(); };
    const timer = setTimeout(() => finish(() => res.status(204).end()), 25000);
    const waiter = { res, deliver: (cmd) => finish(() => res.json(cmd)) };
    d.pollWaiters.push(waiter);
    req.on("close", () => finish(() => {}));
  });

  // The device posts a command's result here.
  app.post("/v1/device/result", authed, (req, res) => {
    const b = req.body || {};
    const d = dev(b.deviceId);
    if (!d) return res.status(404).json({ error: "no device" });
    d.lastSeen = Date.now();
    const w = d.resultWaiters.get(String(b.id));
    if (w) { d.resultWaiters.delete(String(b.id)); w(b); }
    res.json({ ok: true });
  });

  // The device streams its activity-log lines here (one {line} or many {lines:[]}).
  app.post("/v1/device/log", authed, (req, res) => {
    const b = req.body || {};
    const d = dev(b.deviceId);
    if (!d) return res.status(404).json({ error: "no device" });
    d.lastSeen = Date.now();
    if (Array.isArray(b.lines)) b.lines.forEach((l) => pushLog(d, l));
    else if (b.line != null) pushLog(d, b.line);
    res.json({ ok: true, next: d.logSeq });
  });

  // The operator/master reads a device's recent log; ?after=<n> returns only newer lines.
  app.get("/v1/device/:deviceId/log", authed, (req, res) => {
    const d = dev(req.params.deviceId);
    if (!d) return res.status(404).json({ error: "no device" });
    const after = parseInt(req.query.after, 10) || 0;
    res.json({
      deviceId: req.params.deviceId, name: d.name,
      online: (Date.now() - d.lastSeen) < 40000, next: d.logSeq || 0,
      lines: (d.log || []).filter((e) => e.n > after),
    });
  });

  // The operator/master enqueues a command and (by default) waits for the device's result.
  app.post("/v1/device/:deviceId/command", authed, (req, res) => {
    const d = dev(req.params.deviceId);
    if (!d) return res.status(404).json({ error: "device not registered / offline" });
    const b = req.body || {};
    const cmd = { id: "c" + (++seq), method: b.method || "POST", path: b.path || "/v1/info", body: b.body || {} };
    const w = d.pollWaiters.shift();
    if (w) w.deliver(cmd); else d.queue.push(cmd);
    if (b.wait === false) return res.json({ ok: true, id: cmd.id, queued: !w });
    let settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; d.resultWaiters.delete(cmd.id); res.status(504).json({ error: "device did not respond in time", id: cmd.id }); }, 60000);
    d.resultWaiters.set(cmd.id, (r) => { if (settled) return; settled = true; clearTimeout(timer); res.json({ ok: true, id: cmd.id, result: r }); });
  });
}
module.exports = { mountDeviceHub };
