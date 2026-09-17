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
  return {
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

module.exports = { makeRemote };
