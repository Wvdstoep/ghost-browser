/*
 * Device hub — the REVERSE (poll) channel. A device (a phone running GB Mobile) can't be reached
 * inbound (Android/tailnet won't accept it), so instead it DIALS IN: it registers, long-polls for
 * commands, runs each on its own real WebView, and posts the result back. The operator/master enqueues
 * a command and awaits its result. Everything is behind `authed` (SSO cookie or Bearer key); the
 * deviceId is the device's own secret token, so knowing it is what targets a specific device.
 * In-memory (single GB instance), which is all this needs.
 */
/*
 * WHAT A DEVICE IS MISSING FOR A JOB — the one predicate, at module scope so both the route and the
 * in-process picker use it and so a test can reach it.
 *
 * It used to exist twice: /v1/device/route checked need.features, and capableDevice (whose own
 * comment said it mirrored the route) did not. The scheduler goes through capableDevice, so a run
 * that required a named primitive could be handed to a device without it — silently, because a
 * missing feature looks exactly like a device that simply has fewer of them.
 *
 * Returns the list of unmet requirements: empty means this device can do the job.
 */
function missesFor(caps, need) {
  const c = caps || {};
  const n = need || {};
  const m = [];
  for (const k of ["mobileApp", "cdp", "model", "realIp"]) if (n[k] && !c[k]) m.push(k);
  if (n.platform && c.platform !== n.platform) m.push("platform:" + n.platform);
  if (n.profile && !(c.profiles || []).includes(n.profile)) m.push("profile:" + n.profile);
  for (const f of (n.features || [])) if (!(c.features || []).includes(f)) m.push("feature:" + f);
  return m;
}

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

      /*
       * CAN THIS MACHINE TRAIN, AND IF NOT, WHAT IS IT MISSING.
       *
       * A whitelist is the right shape here — a device must not be able to invent capabilities — but
       * what it does not know it drops in silence. The desktop reported `trainer`, its free space and
       * a list of what it still needed; the cluster received only `features` and the machine looked
       * mute while it was in fact talking. Anything a device says that the ring routes on has to be
       * named here, deliberately, which is exactly why the list is a whitelist.
       *
       * `trainerMissing` is for a person, never for the scheduler: routing happens on `trainer`
       * alone, and the sentences exist so "why is nothing happening" has an answer on screen.
       */
      trainer: !!c.trainer,                                  // ready to take a round right now
      trainerFreeGb: Math.max(0, Math.min(99999, Number(c.trainerFreeGb) || 0)),
      trainerHome: String(c.trainerHome || '').slice(0, 200),
      trainerCanSetUp: !!c.trainerCanSetUp,                  // not ready, but could be made ready
      trainerMissing: arr(c.trainerMissing).map((s) => String(s).slice(0, 160)).slice(0, 8),
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

    const misses = (c) => missesFor(c.caps, need);
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
  /*
   * WHAT THE RING IS WORKING ON, ACROSS EVERY DEVICE.
   *
   * One UI, two devices, one engine: the owner asks on the phone and the job may run on the
   * desktop, so "what is happening" cannot be a thing each device only knows about itself. The
   * hub is where both meet, so the answer lives here and every app reads the same one.
   *
   * Set when a goal is dispatched (not when a device chooses to mention it), cleared when the
   * device reports it finished or when the entry ages out — a device that dies mid-job must not
   * leave the UI claiming work forever.
   */
  const work = new Map();   // deviceId -> { goal, role, at }
  const WORK_TTL_MS = 45 * 60 * 1000;
  const ringWork = () => {
    const now = Date.now();
    const out = [];
    for (const [id, w] of [...work.entries()]) {
      if (now - w.at > WORK_TTL_MS) { work.delete(id); continue; }
      const d = devices.get(id);
      if (!d) { work.delete(id); continue; }
      out.push({
        deviceId: id, name: d.name, online: (now - d.lastSeen) < 40000,
        goal: w.goal, role: w.role, startedAt: w.at,
        minutes: Math.round((now - w.at) / 60000),
        lines: (d.log || []).map((e) => (e && e.line != null ? e.line : String(e))),
        next: d.logSeq || 0,
      });
    }
    return out;
  };

  app.post("/v1/device/log", authed, (req, res) => {
    const b = req.body || {};
    const d = dev(b.deviceId);
    if (!d) return res.status(404).json({ error: "no device" });
    d.lastSeen = Date.now();
    const note = (l) => {
      pushLog(d, l);
      /* The node marks the end of a handed-over job with a leading block. Reading it here means the
         UI stops saying "working" the moment the device says it is done, rather than on a timer. */
      if (typeof l === 'string' && l.trim().startsWith('■')) work.delete(String(b.deviceId));
    };
    if (Array.isArray(b.lines)) b.lines.forEach(note);
    else if (b.line != null) note(b.line);
    res.json({ ok: true, next: d.logSeq });
  });

  // In-process API for the scheduler: is there an online device of this owner that can run a job with
  // these requirements? Mirrors /v1/device/route's scoring. Returns {deviceId,name,caps} or null.
  const onlineOf = (owner) => {
    const now = Date.now();
    return [...devices.entries()]
      .filter(([, d]) => d.owner === owner && (now - d.lastSeen) < 40000)
      .map(([id, d]) => ({ id, name: d.name, caps: d.caps || normCaps({}) }));
  };

  /*
   * WHO CAN DO IT, AND IF NOBODY — WHY NOT.
   *
   * capableDevice returns a device or null, which is right for work that may fall back to the cluster
   * (a residential exit is nice to have). It is wrong for work the cluster physically cannot do: a
   * CapCut edit needs CDP drag-interception, and "nothing qualified, use the cluster" is how a run
   * ends up in a web editor it cannot drag in, spending its whole budget and reporting on the page.
   *
   * So routeDevice hands back the reason too. A caller with a hard requirement refuses with something
   * a person can act on ("bring the desktop node online") instead of starting work that cannot finish.
   */
  const routeDevice = (owner, need = {}) => {
    const online = onlineOf(owner);
    const candidates = online.map((c) => ({ deviceId: c.id, name: c.name, caps: c.caps, misses: missesFor(c.caps, need) }));
    const pick = candidates.find((c) => c.misses.length === 0) || null;
    if (pick) return { deviceId: pick.deviceId, name: pick.name, caps: pick.caps, candidates, reason: `matched ${pick.name}` };
    const wanted = [
      ...["mobileApp", "cdp", "model", "realIp"].filter((k) => need[k]),
      ...(need.platform ? ["platform:" + need.platform] : []),
      ...(need.profile ? ["profile:" + need.profile] : []),
      ...(need.features || []).map((f) => "feature:" + f),
    ];
    return {
      deviceId: null, name: null, caps: null, candidates,
      reason: online.length
        ? `no online device has ${wanted.join(", ") || "the requirements"} — ${candidates.map((c) => `${c.name} lacks ${c.misses.join("/")}`).join("; ")}`
        : `no devices are online, and ${wanted.join(", ") || "these requirements"} cannot be met by the cluster`,
    };
  };

  const capableDevice = (owner, need = {}) => {
    const r = routeDevice(owner, need);
    return r.deviceId ? { deviceId: r.deviceId, name: r.name, caps: r.caps } : null;
  };

  // The operator/master reads a device's recent log; ?after=<n> returns only newer lines.
  /*
   * ONE UI, TWO DEVICES, ONE ENGINE.
   *
   * Ask on the phone and the job may run on the desktop; ask on the desktop and it may run on the
   * phone. "What is happening" therefore cannot be something each device only knows about itself,
   * and it was: a handed-over walk was invisible to the app that asked for it AND to the console.
   * This is the one answer all three surfaces read.
   */
  app.get("/v1/ring/work", authed, (_req, res) => res.json({ working: ringWork() }));

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

  /*
   * ENQUEUE AND AWAIT, AS FUNCTIONS RATHER THAN AS A ROUTE BODY.
   *
   * This logic lived only inside the HTTP handler below, so the scheduler could not run a command on
   * a device without making an HTTP request to itself: minting an auth header and travelling through
   * its own middleware to reach code in the same process. The route now calls these, and so does the
   * ring dispatcher in the scheduler. One mechanism with two callers, rather than two mechanisms.
   */
  const enqueue = (deviceId, { method = "POST", path = "/v1/info", body = {} } = {}) => {
    const d = dev(deviceId);
    if (!d) throw new Error("device not registered / offline");
    const cmd = { id: "c" + (++seq), method, path, body };
    /*
     * A HANDED-OVER JOB IS RECORDED AT DISPATCH, not when the device mentions it.
     *
     * The other way round leaves the UI blank for however long the device takes to say its first
     * word — and an older app that never reports at all would look like nothing was ever sent,
     * which is exactly the state that had the assistant hand the same goal over twice.
     */
    if (path === '/v1/run_goal') {
      work.set(String(deviceId), { goal: String((body && body.goal) || ''), role: String((body && body.role) || ''), at: Date.now() });
    }
    const w = d.pollWaiters.shift();
    if (w) w.deliver(cmd); else d.queue.push(cmd);
    return { d, cmd, delivered: !!w };
  };

  /** Run one command on a device and resolve with its result. Rejects on timeout, never hangs. */
  const runCommand = (deviceId, spec = {}, timeoutMs = 180000) => new Promise((resolve, reject) => {
    let e;
    try { e = enqueue(deviceId, spec); } catch (err) { reject(err); return; }
    const { d, cmd } = e;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      d.resultWaiters.delete(cmd.id);
      reject(new Error("device did not respond in time"));
    }, timeoutMs);
    d.resultWaiters.set(cmd.id, (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ id: cmd.id, result: r });
    });
  });

  // The operator/master enqueues a command and (by default) waits for the device's result.
  app.post("/v1/device/:deviceId/command", authed, (req, res) => {
    const b = req.body || {};
    const spec = { method: b.method || "POST", path: b.path || "/v1/info", body: b.body || {} };
    if (b.wait === false) {
      try { const e = enqueue(req.params.deviceId, spec); return res.json({ ok: true, id: e.cmd.id, queued: !e.delivered }); }
      catch (err) { return res.status(404).json({ error: err.message }); }
    }
    runCommand(req.params.deviceId, spec)
      .then(({ id, result }) => res.json({ ok: true, id, result }))
      .catch((err) => res.status(/not registered/.test(err.message) ? 404 : 504).json({ error: err.message }));
  });
  return {
    capableDevice,
    routeDevice,
    runCommand,
    enqueue,
    deviceList: () => [...devices.entries()].map(([id, d]) => ({ deviceId: id, name: d.name, owner: d.owner, online: (Date.now() - d.lastSeen) < 40000, caps: d.caps })),
    /*
     * WHAT A DEVICE HAS BEEN SAYING — the same log GET /v1/device/:id/log serves, as a function.
     *
     * A walk handed to a device has no cluster job, so the assistant had nothing to watch: it
     * called gb_walk_wait with the device NAME, got "no such job", and handed the same goal over a
     * second time. The log was already here and only reachable over HTTP.
     */
    ringWork,
    deviceLog: (deviceId, after = 0) => {
      const d = devices.get(String(deviceId || ''));
      if (!d) return { lines: [], next: 0 };
      const n = parseInt(after, 10) || 0;
      return { next: d.logSeq || 0, lines: (d.log || []).filter((e) => e.n > n) };
    },
  };
}
module.exports = { mountDeviceHub, missesFor };
