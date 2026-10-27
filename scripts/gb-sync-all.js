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

function syncAll(image, run, log = console.log) {
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
        if (source) syncRegistryCredentials(source, dep, prefix, run);
        run([...args, 'set', 'image', name, `${container.name}=${image}`]);
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

if (require.main === module) {
  try {
    const run = (args, input) => execFileSync('sudo', ['kubectl', ...args], { input, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
    if (!syncAll(process.argv[2], run)) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { syncAll, syncRegistryCredentials };
