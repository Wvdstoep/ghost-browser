// Keep installed browsers current on the platform and in every hosted user cluster.
const { execFileSync } = require('node:child_process');

function syncRegistryCredentials(source, target, prefix, run) {
  const refs = source?.spec?.template?.spec?.imagePullSecrets || [];
  if (!refs.length) return;
  const existing = target.spec.template.spec.imagePullSecrets || [];
  const names = new Set(existing.map(r => r.name));
  for (const ref of refs) {
    try {
      const secret = JSON.parse(run(['-n', source.metadata.namespace, 'get', 'secret', ref.name, '-o', 'json']));
      if (secret.type !== 'kubernetes.io/dockerconfigjson' || typeof secret.data?.['.dockerconfigjson'] !== 'string') throw new Error('invalid registry secret');
      // Credentials travel only on stdin within this owner's cluster boundary, never in args/logs.
      const manifest = {apiVersion:'v1',kind:'Secret',metadata:{name:ref.name,namespace:target.metadata.namespace},type:secret.type,data:secret.data};
      run([...prefix, '-n', target.metadata.namespace, 'apply', '-f', '-'], JSON.stringify(manifest));
      names.add(ref.name);
    } catch { throw new Error('registry credential synchronization failed; no credential data logged'); }
  }
  if (names.size !== existing.length) run([...prefix, '-n', target.metadata.namespace, 'patch', 'deployment/' + target.metadata.name, '--type=merge', '-p', JSON.stringify({spec:{template:{spec:{imagePullSecrets:[...names].map(name=>({name}))}}}})]);
}

/*
 * BACK OFF AFTER A FAILED DELIVERY (2026-11-21). An owned cluster that would not take the 2.7 GB image was sent it
 * again every 15 minutes, 154 times, each attempt a full stream through the node's one disk; etcd shares that disk,
 * and at 10:31 k3s lost its leader election and restarted. A target that failed waits 1, 3, 6, 12, then 24 hours
 * before the same release is sent again; a new release is tried at once. state = { "<cluster>/<namespace>":
 * { image, fails, retryAt, why } }, kept by the caller.
 */
const BACKOFF_H = [1, 3, 6, 12, 24];
const backoffMs = (fails) => BACKOFF_H[Math.min(Math.max(fails, 1), BACKOFF_H.length) - 1] * 3600 * 1000;

function syncAll(image, run, log = console.log, importImage = null, { state = null, now = Date.now(), nestedHours = null, hour = new Date(now).getHours() } = {}) {
  if (!/^wvdstoep\/ghost-browser:v\d+$/.test(image)) throw new Error('Invalid release image');
  const root = JSON.parse(run(['get', 'deployments', '-A', '-o', 'json'])).items;
  let failed = false;
  function sync(items, prefix = [], source = null) {
    for (const dep of items) {
      const container = dep.spec.template.spec.containers.find(c => c.name === 'ghost-browser' && /^wvdstoep\/ghost-browser:/.test(c.image));
      if (!container || dep.spec.replicas === 0) continue;
      if (container.image === image && (!source || dep.status?.availableReplicas > 0)) continue;
      const args = [...prefix, '-n', dep.metadata.namespace];
      const name = 'deployment/' + dep.metadata.name;
      try {
        let pullBlocked = false;
        if ((dep.status?.availableReplicas || 0) === 0 && dep.spec.selector?.matchLabels) {
          const selector = Object.entries(dep.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(',');
          const pods = JSON.parse(run([...args, 'get', 'pods', '-l', selector, '-o', 'json'])).items;
          const states = pods.flatMap(p => p.status?.containerStatuses || []);
          pullBlocked = states.length > 0 && states.every(s => ['ErrImagePull', 'ImagePullBackOff'].includes(s.state?.waiting?.reason));
        }
        if (container.image === image && !pullBlocked) continue;
        if (!pullBlocked) {
          const ready = JSON.parse(run([...args, 'exec', name, '-c', container.name, '--', 'node', '-e',
            'fetch("http://127.0.0.1:3000/v1/deploy/readiness",{headers:{authorization:"Bearer "+require("/app/src/keys").parseKeys().keys().next().value}}).then(async r=>{if(!r.ok)throw Error("readiness failed");console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))']));
          if (ready.busy !== 0) { log(`${dep.metadata.namespace}: busy; retry next cycle`); continue; }
        }
        // NIGHT ONLY for an owned cluster (2026-11-21): its copy of a 2.7 GB image lands on the disk etcd shares, and
        // a browser a few hours behind costs its owner nothing. nestedHours = [from, to) in the server's local time.
        if (prefix.length && nestedHours && !(hour >= nestedHours[0] && hour < nestedHours[1])) {
          log(`${dep.metadata.namespace}: ${image} waits for the night window (${nestedHours[0]}:00-${nestedHours[1]}:00)`);
          continue;
        }
        if (source) syncRegistryCredentials(source, dep, prefix, run);
        // AN OWNED CLUSTER PULLS THE SIGNED RELEASE ITSELF (2026-11-21). It used to "set image" and pull, which left
        // its Recreate browser down while a pull was refused (v702-v704); then the image was STREAMED in (docker
        // save | kubectl exec … ctr import), 2.7 GB through the platform's API server, which timed out and failed
        // 154 times, every 15 minutes, on the disk etcd shares. Now a short-lived pull pod in that cluster fetches
        // it with the copied pull secret (no password on any command line), the browser keeps running meanwhile,
        // and only a pulled image is switched to.
        if (prefix.length && importImage) {
          const key = `${prefix[1] || 'platform'}/${dep.metadata.namespace}`;
          const was = state && state[key];
          if (was && was.image === image && now < was.retryAt) {
            log(`${dep.metadata.namespace}: waiting until ${new Date(was.retryAt).toISOString()} before sending ${image} again (failed ${was.fails}x: ${was.why})`);
            continue;
          }
          try { importImage(image, prefix, { dep, container, run, log }); if (state) delete state[key]; }
          catch (e) {
            if (state) { const fails = was && was.image === image ? was.fails + 1 : 1; state[key] = { image, fails, retryAt: now + backoffMs(fails), why: String(e.message || e).slice(0, 200) }; }
            throw e;
          }
          run([...args, 'patch', name, '--type=strategic', '-p', JSON.stringify({spec:{template:{spec:{containers:[{name:container.name,image,imagePullPolicy:'IfNotPresent'}]}}}})]);
        } else run([...args, 'set', 'image', name, `${container.name}=${image}`]);
        run([...args, 'rollout', 'status', name, '--timeout=240s']);
        log(`${dep.metadata.namespace}: rolled to ${image}`);
      } catch (error) { failed = true; log(`${dep.metadata.namespace}: rollout deferred: ${error.message}`); }
    }
  }
  sync(root);
  for (const dep of root.filter(d => d.metadata.namespace.startsWith('byon-cp-') && d.spec.template.spec.containers.some(c => c.name === 'k3s'))) {
    const prefix = ['-n', dep.metadata.namespace, 'exec', '-i', 'deployment/' + dep.metadata.name, '-c', 'k3s', '--', 'kubectl'];
    const ownerNamespace = 'pod-' + dep.metadata.namespace.slice('byon-cp-'.length);
    const source = root.find(d => d.metadata.namespace === ownerNamespace && d.spec.template.spec.containers.some(c => c.name === 'ghost-browser' && /^wvdstoep\/ghost-browser:/.test(c.image)));
    try { sync(JSON.parse(run([...prefix, 'get', 'deployments', '-A', '-o', 'json'])).items, prefix, source); }
    catch (error) { failed = true; log(`${dep.metadata.namespace}: discovery failed: ${error.message}`); }
  }
  return !failed;
}

/* Why a transfer failed, without anything private: a timeout, an exit code, the last line of stderr (kubectl, ctr
   and docker print no credentials; anything token-shaped is masked anyway). */
function transferWhy(e) {
  if (!e) return 'unknown';
  if (e.killed || e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') return 'timed out';
  const last = String(e.stderr || '').trim().split('\n').filter(Boolean).pop() || '';
  const clean = last.replace(/[A-Za-z0-9_\-]{32,}/g, '…').slice(0, 160);
  return `exit ${e.status == null ? '?' : e.status}${clean ? `: ${clean}` : ''}`;
}
const TRANSFER_MBPS = Number(process.env.GB_TRANSFER_MBPS) || 40;

function importHostedImage(image, prefix, exec = execFileSync) {
  if (!/^wvdstoep\/ghost-browser:v\d+$/.test(image) || !Array.isArray(prefix) || prefix[prefix.length - 1] !== 'kubectl') throw new Error('Invalid browser image transfer');
  // Stream the existing signed release, not publisher credentials, into the owned cluster cache.
  const args = [...prefix.slice(0, -1), 'ctr', '--address', '/run/k3s/containerd/containerd.sock', '-n', 'k8s.io', 'images', 'import', '-'];
  try {
    exec('sudo', ['cosign', 'verify', '--key', process.env.COSIGN_PUB || '/etc/cosign/cosign.pub', '--insecure-ignore-tlog', image], {stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
  } catch (e) { throw new Error(`signed browser image transfer failed: signature check (${transferWhy(e)})`); }
  // Paced (throttle-stream.js): at full speed this stream starves etcd of the disk they share.
  const throttle = require('node:path').join(__dirname, 'throttle-stream.js');
  try {
    exec('bash', ['-o', 'pipefail', '-c', `sudo docker save "$1" | node ${JSON.stringify(throttle)} ${TRANSFER_MBPS} | sudo kubectl "\${@:2}"`, 'ghost-browser-image-transfer', image, ...args], {stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:900000,maxBuffer:2*1024*1024});
  } catch (e) { throw new Error(`signed browser image transfer failed: ${transferWhy(e)}`); }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/*
 * THE OWNED CLUSTER PULLS IT (2026-11-21). The signature is checked here first; then a pull pod in the target
 * namespace, with the browser's own pull secrets and security context, asks that cluster's kubelet for the image
 * and exits at once. Kubernetes keeps the credential inside the cluster (nothing on a command line), the running
 * browser is untouched, and a refusal comes back as the kubelet's own words ("unauthorized", "not found").
 */
function prePullImage(image, prefix, { dep, container, run, log = () => {}, exec = execFileSync, sleep = sleepSync, now = Date.now, timeoutMs = 25 * 60 * 1000 } = {}) {
  if (!/^wvdstoep\/ghost-browser:v\d+$/.test(image) || !Array.isArray(prefix) || prefix[prefix.length - 1] !== 'kubectl') throw new Error('Invalid browser image transfer');
  try {
    exec('sudo', ['cosign', 'verify', '--key', process.env.COSIGN_PUB || '/etc/cosign/cosign.pub', '--insecure-ignore-tlog', image], {stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
  } catch (e) { throw new Error(`signed browser image transfer failed: signature check (${transferWhy(e)})`); }
  const ns = dep.metadata.namespace;
  const pod = `gb-prepull-v${image.split(':v')[1]}`;
  const tpl = dep.spec.template.spec;
  const manifest = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: pod, namespace: ns, labels: { 'app-cluster/gb-prepull': 'true' } },
    spec: {
      restartPolicy: 'Never', terminationGracePeriodSeconds: 0,
      ...(tpl.imagePullSecrets ? { imagePullSecrets: tpl.imagePullSecrets } : {}),
      ...(tpl.securityContext ? { securityContext: tpl.securityContext } : {}),
      containers: [{ name: 'pull', image, imagePullPolicy: 'IfNotPresent', command: ['node', '-e', '0'],
        ...(container && container.securityContext ? { securityContext: container.securityContext } : {}),
        resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { memory: '64Mi' } } }],
    },
  };
  const args = [...prefix, '-n', ns];
  const drop = () => { try { run([...args, 'delete', 'pod', pod, '--ignore-not-found', '--wait=false']); } catch { /* gone */ } };
  drop();
  run([...prefix, 'apply', '-f', '-'], JSON.stringify(manifest));
  const until = now() + timeoutMs;
  try {
    for (;;) {
      let st = null;
      try { st = ((JSON.parse(run([...args, 'get', 'pod', pod, '-o', 'json'])).status || {}).containerStatuses || [])[0] || null; } catch { st = null; }
      const waiting = st && st.state && st.state.waiting;
      if (st && (st.imageID || (st.state && (st.state.running || st.state.terminated)))) { log(`${ns}: ${image} pulled by the cluster itself`); return; }
      if (waiting && /ErrImagePull|ImagePullBackOff|InvalidImageName|ErrImageNeverPull/.test(waiting.reason || '')) {
        throw new Error(`signed browser image transfer failed: the cluster could not pull it (${waiting.reason}: ${String(waiting.message || '').slice(0, 160)})`);
      }
      if (now() > until) throw new Error('signed browser image transfer failed: the pull did not finish in 25 minutes');
      sleep(15000);
    }
  } finally { drop(); }
}

if (require.main === module) {
  try {
    const run = (args, input) => execFileSync('sudo', ['kubectl', ...args], { input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
    const fs = require('node:fs');
    const stateFile = process.env.GB_SYNC_STATE || require('node:path').join(require('node:os').homedir(), '.gb-sync-state.json');
    let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { state = {}; }
    // Owned clusters pull the release themselves, at night (GB_NESTED_HOURS="1-6", "0-24" = any time).
    const hours = String(process.env.GB_NESTED_HOURS || '1-6').split('-').map(Number);
    const nestedHours = hours.length === 2 && hours.every(Number.isFinite) ? hours : [1, 6];
    const ok = syncAll(process.argv[2], run, console.log, prePullImage, { state, nestedHours });
    try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); } catch (e) { console.error(`backoff state not saved: ${e.message}`); }
    if (!ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { syncAll, syncRegistryCredentials, importHostedImage, prePullImage, transferWhy, backoffMs };
