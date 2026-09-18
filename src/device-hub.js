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

  // S4: normalise a device's advertised capability record to a stable shape so the router can trust it.
  const normCaps = (c) => {
    c = c || {};
    const arr = (v) => Array.isArray(v) ? [...new Set(v.map((x) => String(x)))].slice(0, 100) : [];
    return {
      platform: (c.platform === "android" || c.platform === "desktop" || c.platform === "cluster") ? c.platform : "",
      mobileApp: !!c.mobileApp,   // native Android app: real touch events
      cdp: !!c.cdp,               // Chrome DevTools: drag-interception + self-saving downloads (desktop node)
      model: !!c.model,           // an on-device LLM is present (can run the agent locally)
      realIp: !!c.realIp,         // has a residential/stealth exit IP
      profiles: arr(c.profiles),  // browser profiles held locally
      features: arr(c.features),  // named primitives, e.g. upload_file, drag_xy, native_tap
    };
  };

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
    // S4: capability registry — the device advertises what it can DO so Auto/the ring can route to it
    // instead of guessing. Merge (a device may re-register with a partial caps patch, e.g. profiles only).
    if (req.body && req.body.caps && typeof req.body.caps === "object") {
      d.caps = normCaps(Object.assign({}, d.caps || {}, req.body.caps));
    } else if (!d.caps) {
      d.caps = normCaps({});
    }
    d.lastSeen = Date.now();
    devices.set(id, d);
    res.json({ ok: true, deviceId: id, caps: d.caps });
  });

  app.get("/v1/device/list", authed, (_req, res) => {
    const now = Date.now();
    res.json({ devices: [...devices.entries()].map(([id, d]) => ({
      deviceId: id, name: d.name, owner: d.owner, queued: d.queue.length,
      lastSeen: d.lastSeen, online: (now - d.lastSeen) < 40000, caps: d.caps || normCaps({}),
    })) });
  });

  // S4: given a run's requirements, pick the device that can actually do it (not a guess). The device
  // ring reads this; when nothing qualifies it returns deviceId:null so the caller falls back to the
  // cluster. Body: { require:{ mobileApp?, cdp?, model?, realIp?, platform?, profile?, features?:[] },
  //                   prefer?:{ profile?, model?, platform? } }. Scored, owner-scoped, online only.
  app.post("/v1/device/route", authed, (req, res) => {
    const now = Date.now();
    const owner = ownerOf(req);
    const b = req.body || {};
    const need = b.require || {};
    const prefer = b.prefer || {};
    const online = [...devices.entries()]
      .map(([id, d]) => ({ id, d }))
      .filter(({ d }) => d.owner === owner && (now - d.lastSeen) < 40000)
      .map(({ id, d }) => ({ id, name: d.name, caps: d.caps || normCaps({}), lastSeen: d.lastSeen }));

    const misses = (c) => {
      const m = [];
      for (const k of ["mobileApp", "cdp", "model", "realIp"]) if (need[k] && !c.caps[k]) m.push(k);
      if (need.platform && c.caps.platform !== need.platform) m.push("platform:" + need.platform);
      if (need.profile && !(c.caps.profiles || []).includes(need.profile)) m.push("profile:" + need.profile);
      for (const f of (need.features || [])) if (!(c.caps.features || []).includes(f)) m.push("feature:" + f);
      return m;
    };
    const score = (c) => {
      let s = 0;
      if (prefer.profile && (c.caps.profiles || []).includes(prefer.profile)) s += 3;
      if (prefer.model && c.caps.model) s += 2;
      if (prefer.platform && c.caps.platform === prefer.platform) s += 2;
      if (c.caps.model) s += 1;         // a device that can run the agent itself beats one that can't
      if (c.caps.realIp) s += 1;        // stealth exit is generally desirable
      s += Math.min(1, c.lastSeen / (now + 1)); // freshest as a tiebreak (0..1)
      return s;
    };

    const candidates = online
      .map((c) => ({ deviceId: c.id, name: c.name, caps: c.caps, misses: misses(c), score: score(c) }))
      .sort((a, b2) => b2.score - a.score);
    const eligible = candidates.filter((c) => c.misses.length === 0);
    const pick = eligible[0] || null;
    res.json({
      deviceId: pick ? pick.deviceId : null,
      name: pick ? pick.name : null,
      reason: pick
        ? `matched ${pick.name} (score ${pick.score.toFixed(2)})`
        : (online.length ? "no online device meets the requirements → use cluster" : "no online devices → use cluster"),
      candidates,
    });
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

  // In-process API for the scheduler: is there an online device of this owner that can run a job with
  // these requirements? Mirrors /v1/device/route's scoring. Returns {deviceId,name,caps} or null.
  const capableDevice = (owner, need = {}) => {
    const now = Date.now();
    const online = [...devices.entries()].filter(([, d]) => d.owner === owner && (now - d.lastSeen) < 40000).map(([id, d]) => ({ id, name: d.name, caps: d.caps || normCaps({}) }));
    const ok = (c) => {
      for (const k of ["mobileApp", "cdp", "model", "realIp"]) if (need[k] && !c.caps[k]) return false;
      if (need.platform && c.caps.platform !== need.platform) return false;
      if (need.profile && !(c.caps.profiles || []).includes(need.profile)) return false;
      return true;
    };
    const pick = online.find(ok) || null;
    return pick ? { deviceId: pick.id, name: pick.name, caps: pick.caps } : null;
  };

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
  return { capableDevice, deviceList: () => [...devices.entries()].map(([id, d]) => ({ deviceId: id, name: d.name, owner: d.owner, online: (Date.now() - d.lastSeen) < 40000, caps: d.caps })) };
}
module.exports = { mountDeviceHub };
