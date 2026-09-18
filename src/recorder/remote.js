'use strict';
/**
 * recorder/remote.js — GB's side of "a recording is a pod of its own" (Phase 3): create the Job with
 * the recording's token, know whether it is still alive, ask it to stop. The pod does the recording
 * (recorder-main.js) and pushes segments and its journal back over HTTP; GB stores and serves them
 * exactly as it does its own. Nothing here is required outside a cluster: available() says no and
 * the engine records in this pod.
 */
const k8s = require('./k8s');

/* The pod reaches GB through the HEADLESS twin of the service (ghost-browser-pods): its name resolves straight
   to the pod IP — the cluster-IP translation refused pod-to-pod traffic on the live node — and re-resolves to
   the new pod after a roll, which is what lets a recording outlive one. */
function makeRemote({ log, gbUrl = process.env.RECORDER_GB_URL || 'http://ghost-browser-pods:3000', image = process.env.RECORDER_IMAGE || '', enabled = String(process.env.RECORDER_JOBS || 'on') !== 'off' } = {}) {
  let imageInfo = null;
  async function imageOf() {
    if (image) return { image, imagePullSecrets: [], serviceAccount: '' };
    if (imageInfo) return imageInfo;
    imageInfo = await k8s.ownImage(); if (!imageInfo.image) throw new Error('could not read the deployment image'); return imageInfo;
  }
  let host = 'ghost-browser-pods'; try { host = new URL(gbUrl).hostname; } catch { /* keep */ }
  return {
    host,
    available: () => enabled && k8s.available(),
    /** Create the Job; the recording's token is its only key to GB. */
    async launch(rec) {
      const img = await imageOf();
      const spec = k8s.jobSpec({ id: rec.id, namespace: k8s.ns(), image: img.image, imagePullSecrets: img.imagePullSecrets, serviceAccount: '', gbUrl, token: rec.token,
        // 1080p YouTube in software + a 1080p x264 encode: measured OOM at 3 GiB, so 6 GiB and 4 CPUs to burst into.
        // The REQUEST stays small: a tenant namespace has a quota on requests (10 GiB here, 8.6 in use), and a
        // request the quota cannot hold means no pod at all — the limit is what the recording actually gets.
        cpu: process.env.RECORDER_CPU || '500m', memory: process.env.RECORDER_MEMORY || '1Gi', cpuLimit: process.env.RECORDER_CPU_LIMIT || '4', memoryLimit: process.env.RECORDER_MEMORY_LIMIT || '6Gi' });
      await k8s.createJob(spec);
      return { jobName: spec.metadata.name };
    },
    /** Alive = the Job exists and is active (or too new to say). */
    async alive(rec) {
      const name = rec.jobName || k8s.jobSpec({ id: rec.id, namespace: 'x', image: 'x', gbUrl: '', token: '' }).metadata.name;
      try { return k8s.jobAlive(await k8s.getJob(name)); } catch (e) { if (e.status === 404) return false; return true; }   // an API hiccup is not a dead pod
    },
    /** The pod polls the handoff for the stop flag; nothing to push here. Deleting the Job would lose the last segments. */
    stop() { return true; },
    /** Did the Job get a pod at all? A namespace quota can refuse the pod while the Job sits there retrying. */
    async podExists(rec) { try { return (await k8s.listPods(`gb/recording=${rec.id}`)).length > 0; } catch { return true; } },
    /** Take a Job back that never got a pod (the recording restarts in this pod instead). */
    async cancel(rec) { const name = rec.jobName || k8s.jobSpec({ id: rec.id, namespace: 'x', image: 'x', gbUrl: '', token: '' }).metadata.name; try { await k8s.deleteJob(name); } catch { /* gone already */ } return true; },
    /** A recorder Job with no journal behind it (deleted while it ran) is removed; called by reconcile's neighbour on boot. */
    async sweep(knownIds) {
      let n = 0;
      try { for (const j of await k8s.listJobs()) { const id = j.metadata.labels && j.metadata.labels['gb/recording']; if (id && !knownIds.has(id) && k8s.jobAlive(j)) { await k8s.deleteJob(j.metadata.name).catch(() => {}); n++; log && log.info && log.info(`[recorder] removed orphan Job ${j.metadata.name}`); } } } catch (e) { log && log.warn && log.warn(`[recorder] sweep: ${e.message}`); }
      return n;
    },
  };
}

/**
 * PHASE 5 — the PLATFORM spawns the recorder. When the install carries RECORDER_PLATFORM_URL and
 * RECORDER_PLATFORM_TOKEN (the provisioner injects them), GB asks the platform for a recorder instead of
 * creating a Job in its own namespace: the platform knows the plan, the tenant's rented machines and its
 * own capacity, and places the pod where it belongs. The recording protocol does not change — the pod
 * still takes the handoff from GB and pushes segments back with the recording's token — only who
 * creates the pod. The contract:
 *   POST   {url}/api/recorders            { recordingId, gbUrl, proxyHost, token, quality, maxMinutes } → 201 { jobRef, where } | 403 { reason:'plan' } | 409 { reason:'capacity', retryAfterSec }
 *   GET    {url}/api/recorders/{jobRef}   → { alive, hasPod, state }
 *   DELETE {url}/api/recorders/{jobRef}   → 200
 */
function makePlatformRemote({ log, url = process.env.RECORDER_PLATFORM_URL || '', token = process.env.RECORDER_PLATFORM_TOKEN || '', tenant = process.env.RECORDER_PLATFORM_TENANT || '', host = '', request = null } = {}) {
  const base = String(url).replace(/\/$/, '');
  const ns = (() => { try { return k8s.ns(); } catch { return 'default'; } })();
  // the tenant's GB as seen from the platform's namespace: the headless twin by its full cluster name
  const gbHost = host || process.env.RECORDER_HOST || `ghost-browser-pods.${ns}.svc.cluster.local`;
  // the platform's door: a per-tenant recorder token and the tenant's name (the token opens no other tenant's)
  const call = request || (async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'x-recorder-token': token, 'x-pod-name': tenant || ns.replace(/^pod-/, ''), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    let j = null; try { j = await res.json(); } catch { j = {}; }
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${(j && (j.error || j.reason)) || ''}`), { status: res.status, body: j });
    return j;
  });
  return {
    host: gbHost,
    available: () => !!(base && token),
    async launch(rec) {
      const j = await call('POST', '/api/recorders', { recordingId: rec.id, gbUrl: `http://${gbHost}:3000`, proxyHost: gbHost, token: rec.token, quality: rec.quality, maxMinutes: rec.maxMinutes, title: rec.title });
      log && log.info && log.info(`[recorder] ${rec.id}: the platform runs it as ${j.jobRef} (${j.where || 'platform'})`);
      return { jobName: j.jobRef, where: j.where || 'platform' };
    },
    async alive(rec) { try { const j = await call('GET', `/api/recorders/${encodeURIComponent(rec.jobName || rec.id)}`); return j.alive !== false; } catch (e) { return e.status === 404 ? false : true; } },
    async podExists(rec) { try { const j = await call('GET', `/api/recorders/${encodeURIComponent(rec.jobName || rec.id)}`); return j.hasPod !== false; } catch { return true; } },
    async cancel(rec) { try { await call('DELETE', `/api/recorders/${encodeURIComponent(rec.jobName || rec.id)}`); } catch { /* gone already */ } return true; },
    stop() { return true; },
    async sweep() { return 0; },
  };
}

/** The remote for this install: the platform's when it is wired in, else a Job in our own namespace. */
function chooseRemote(opts = {}) {
  const pr = makePlatformRemote(opts); if (pr.available()) { opts.log && opts.log.info && opts.log.info('[recorder] recorders are spawned by the platform'); return pr; }
  return makeRemote(opts);
}

module.exports = { makeRemote, makePlatformRemote, chooseRemote };
