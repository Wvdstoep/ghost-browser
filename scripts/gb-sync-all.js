// Keep installed browsers current on the platform and in every hosted user cluster.
const { execFileSync } = require('node:child_process');

function syncAll(image, run, log = console.log) {
  if (!/^wvdstoep\/ghost-browser:v\d+$/.test(image)) throw new Error('Invalid release image');
  const root = JSON.parse(run(['get', 'deployments', '-A', '-o', 'json'])).items;
  let failed = false;
  function sync(items, prefix = []) {
    for (const dep of items) {
      const container = dep.spec.template.spec.containers.find(c => c.name === 'ghost-browser' && /^wvdstoep\/ghost-browser:/.test(c.image));
      if (!container || container.image === image || dep.spec.replicas === 0) continue;
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
        if (!pullBlocked) {
          const ready = JSON.parse(run([...args, 'exec', name, '-c', container.name, '--', 'node', '-e',
            'fetch("http://127.0.0.1:3000/v1/deploy/readiness",{headers:{authorization:"Bearer "+require("/app/src/keys").parseKeys().keys().next().value}}).then(async r=>{if(!r.ok)throw Error("readiness failed");console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))']));
          if (ready.busy !== 0) { log(`${dep.metadata.namespace}: busy; retry next cycle`); continue; }
        }
        run([...args, 'set', 'image', name, `${container.name}=${image}`]);
        run([...args, 'rollout', 'status', name, '--timeout=240s']);
        log(`${dep.metadata.namespace}: rolled to ${image}`);
      } catch (error) { failed = true; log(`${dep.metadata.namespace}: rollout deferred: ${error.message}`); }
    }
  }
  sync(root);
  for (const dep of root.filter(d => d.metadata.namespace.startsWith('byon-cp-') && d.spec.template.spec.containers.some(c => c.name === 'k3s'))) {
    const prefix = ['-n', dep.metadata.namespace, 'exec', '-i', 'deployment/' + dep.metadata.name, '-c', 'k3s', '--', 'kubectl'];
    try { sync(JSON.parse(run([...prefix, 'get', 'deployments', '-A', '-o', 'json'])).items, prefix); }
    catch (error) { failed = true; log(`${dep.metadata.namespace}: discovery failed: ${error.message}`); }
  }
  return !failed;
}

if (require.main === module) {
  try {
    const run = args => execFileSync('sudo', ['kubectl', ...args], { encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
    if (!syncAll(process.argv[2], run)) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { syncAll };
