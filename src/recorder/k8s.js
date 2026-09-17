'use strict';
/**
 * recorder/k8s.js — the smallest Kubernetes client a recording needs: the pod's own service-account
 * credentials, Jobs in the pod's own namespace, nothing else. No dependency, no cluster-wide rights.
 * `jobSpec` is pure so the tests pin exactly what a recorder Job asks for.
 */
const fs = require('fs');
const https = require('https');

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

function creds() {
  try {
    return { token: fs.readFileSync(`${SA}/token`, 'utf8').trim(), ca: fs.readFileSync(`${SA}/ca.crt`), namespace: fs.readFileSync(`${SA}/namespace`, 'utf8').trim(),
      host: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc', port: Number(process.env.KUBERNETES_SERVICE_PORT || 443) };
  } catch { return null; }
}
function available() { return !!creds(); }

function call(method, path, body) {
  const c = creds(); if (!c) return Promise.reject(new Error('not in a cluster (no service account)'));
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ host: c.host, port: c.port, path, method, ca: c.ca, headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, timeout: 15000 }, (res) => {
      let out = ''; res.on('data', (d) => { out += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch { j = { raw: out }; } if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(Object.assign(new Error(`${method} ${path} → ${res.statusCode}: ${(j && j.message) || out.slice(0, 200)}`), { status: res.statusCode, body: j })); });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('kubernetes api timeout')));
    if (data) req.write(data); req.end();
  });
}

/**
 * The Job a recording runs as: the same image in recorder mode, its own requests and limits (added to the
 * cluster, not borrowed from the browser pod), a scratch disk for segments on their way up, labels so a
 * restarted GB finds it again, and a TTL so a finished Job cleans itself up.
 */
function jobSpec({ id, namespace, image, gbUrl, token, cpu = '1', memory = '1536Mi', cpuLimit = '2', memoryLimit = '3Gi', scratch = '20Gi', imagePullSecrets = [], ttlSeconds = 600, serviceAccount = '' }) {
  const name = `ghost-browser-rec-${String(id).replace(/[^a-z0-9-]/g, '').slice(0, 40)}`;
  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name, namespace, labels: { app: 'ghost-browser-recorder', 'gb/recording': String(id) } },
    spec: {
      backoffLimit: 0, ttlSecondsAfterFinished: ttlSeconds, activeDeadlineSeconds: 13 * 3600,
      template: {
        metadata: { labels: { app: 'ghost-browser-recorder', 'gb/recording': String(id) } },
        spec: {
          restartPolicy: 'Never', ...(serviceAccount ? { serviceAccountName: serviceAccount } : {}), automountServiceAccountToken: false,
          ...(imagePullSecrets.length ? { imagePullSecrets: imagePullSecrets.map((n) => ({ name: n })) } : {}),
          securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'recorder', image, imagePullPolicy: 'IfNotPresent',
            env: [{ name: 'MODE', value: 'recorder' }, { name: 'RECORDING_ID', value: String(id) }, { name: 'GB_URL', value: gbUrl }, { name: 'RECORDING_TOKEN', value: token }, { name: 'RECORDINGS_DIR', value: '/scratch' }, { name: 'HOME', value: '/tmp' }],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: false, capabilities: { drop: ['ALL'] } },
            resources: { requests: { cpu, memory }, limits: { cpu: cpuLimit, memory: memoryLimit } },
            volumeMounts: [{ name: 'scratch', mountPath: '/scratch' }, { name: 'shm', mountPath: '/dev/shm' }],
          }],
          volumes: [{ name: 'scratch', emptyDir: { sizeLimit: scratch } }, { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } }],
        },
      },
    },
  };
}

const ns = () => (creds() || {}).namespace || process.env.POD_NAMESPACE || 'default';
async function createJob(spec) { return call('POST', `/apis/batch/v1/namespaces/${spec.metadata.namespace}/jobs`, spec); }
async function getJob(name) { return call('GET', `/apis/batch/v1/namespaces/${ns()}/jobs/${name}`); }
async function listJobs(selector = 'app=ghost-browser-recorder') { const r = await call('GET', `/apis/batch/v1/namespaces/${ns()}/jobs?labelSelector=${encodeURIComponent(selector)}`); return (r && r.items) || []; }
async function listPods(selector) { const r = await call('GET', `/api/v1/namespaces/${ns()}/pods?labelSelector=${encodeURIComponent(selector)}`); return (r && r.items) || []; }
async function deleteJob(name) { return call('DELETE', `/apis/batch/v1/namespaces/${ns()}/jobs/${name}?propagationPolicy=Background`, null); }
/** The image this very deployment runs, so a recorder Job is always the same build. */
async function ownImage(deployment = 'ghost-browser') { const d = await call('GET', `/apis/apps/v1/namespaces/${ns()}/deployments/${deployment}`); const c = d && d.spec && d.spec.template.spec.containers[0]; return { image: c && c.image, imagePullSecrets: ((d && d.spec.template.spec.imagePullSecrets) || []).map((s) => s.name), serviceAccount: (d && d.spec.template.spec.serviceAccountName) || '' }; }
/** Is the Job still going? active > 0, or not yet reported at all (just created). */
function jobAlive(job) { if (!job || !job.status) return true; const s = job.status; if (s.succeeded || s.failed) return false; return (s.active || 0) > 0 || !s.startTime; }

module.exports = { available, creds, call, jobSpec, createJob, getJob, listJobs, listPods, deleteJob, ownImage, jobAlive, ns };
