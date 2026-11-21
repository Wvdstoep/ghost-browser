// build-vm.test.js — the pipeline builds on a rented VM, not on the server customers use (2026-11-21).
//
// Builds ran on the production node, on the disk etcd shares; with an image copy on top, etcd waited 1-3 s per write
// and k3s restarted (2026-10-02, 11-04, 11-21). deploy.sh's dk() now points every build's Docker command at a VM that
// scripts/build-vm.sh rents per pipeline and deletes after it, and builds here only when no VM can be had.
// Measured live on 2026-11-21: a cpx42 in hel1 was ready in 71 s, built an image (8 cpus, 16 GB) and was deleted.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const deploy = read('scripts/deploy.sh');
const vm = read('scripts/build-vm.sh');
const ci = read('.gitlab-ci.yml');
const watch = read('ops/host/bin/node-pressure-watch.sh');

describe('deploy.sh builds through dk', () => {
  it('every Docker command of a build goes through dk; only dk and the containerd import call this server\'s docker', () => {
    const lines = deploy.split('\n').filter((l) => /sudo (env DOCKER_HOST=\S+ )?docker /.test(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\s+if \[ "\$BUILD_DOCKER_HOST" != local \]; then sudo env DOCKER_HOST="\$BUILD_DOCKER_HOST" docker "\$@"; else sudo docker "\$@"; fi$/);
    // the import pulls what the build pushed onto THIS server and saves it here: a VM's newer Docker saved a format
    // this containerd refused ("ctr: unrecognized image format", pipeline 2901)
    expect(lines[1]).toMatch(/sudo docker pull -q "\$image"/);
    expect(lines[2]).toMatch(/if sudo docker save "\$image" \| node/);
    expect((deploy.match(/\bdk (build|buildx|push|tag|run|save|inspect|image|builder|rm|exec|logs|container) /g) || []).length).toBeGreaterThan(30);
  });
  it('rents the VM only in the pipeline, and builds here when it cannot be had', () => {
    expect(deploy).toMatch(/if \[ -n "\$\{CI:-\}" \] && \[ -z "\$\{BUILD_VM_OFF:-\}" \][\s\S]{0,200}build-vm\.sh" up [^\n]*\|\| BUILD_DOCKER_HOST=local/);
    expect(deploy).toMatch(/no build VM [^\n]*building on this server/);
  });
  it('an image copied into the node is paced (an unpaced import restarted k3s on 2026-11-04)', () => {
    expect(deploy).toMatch(/sudo docker save "\$image" \| node "\$BASE_DIR\/ghost-browser\/scripts\/throttle-stream\.js" 40 \| sudo ctr/);
  });
  it('an image built on the VM is pushed before the server pulls it for the import (2902-2903 imported the previous release)', () => {
    expect(deploy).toMatch(/dk push -q "\$image" >\/dev\/null \|\| \{[^}]*return 1; \}\n\s+sudo docker pull -q "\$image" >\/dev\/null \|\| \{[^}]*return 1; \}/);
  });
  it('the VM address is kept for the whole run, also for builds in a subshell', () => {
    expect(deploy).toMatch(/\[ -s "\/tmp\/build-vm-host-\$\$" \] && BUILD_DOCKER_HOST=\$\(cat "\/tmp\/build-vm-host-\$\$"\)/);
    expect(deploy).toMatch(/echo "\$BUILD_DOCKER_HOST" > "\/tmp\/build-vm-host-\$\$"/);
  });
  it('both deploy jobs delete the VM afterwards, also when they failed', () => {
    for (const job of ['\ndeploy:\n', '\nmanual-deploy:\n']) {
      const start = ci.indexOf(job); const body = ci.slice(start, ci.indexOf('\n\n', start + job.length + 200) > 0 ? start + 1500 : undefined);
      expect(body).toMatch(/after_script:\n {4}- bash scripts\/build-vm\.sh down \|\| true/);
    }
  });
});

describe('build-vm.sh', () => {
  it('rents a cpx42 in Helsinki, next to the server, from the Docker image, labelled as a build VM', () => {
    expect(vm).toMatch(/TYPE=\$\{BUILD_VM_TYPE:-cpx42\}/);
    expect(vm).toMatch(/LOCATION=\$\{BUILD_VM_LOCATION:-hel1\}/);
    expect(vm).toMatch(/IMAGE=\$\{BUILD_VM_IMAGE:-docker-ce\}/);
    expect(vm).toMatch(/"labels":\{"purpose":"build","created"/);
  });
  it('lets only this server in, over SSH, with its own key and a pinned host key', () => {
    expect(vm).toMatch(/"rules":\[\{"direction":"in","protocol":"tcp","port":"22","source_ips":\[sys\.argv\[2\]\+"\/32"\]\}\]/);
    expect(vm).toMatch(/StrictHostKeyChecking yes/);
    expect(vm).toMatch(/IdentitiesOnly yes/);
  });
  it('never puts the Hetzner token on a command line', () => {
    expect(vm).toMatch(/printf 'Authorization: Bearer %s\\n' "\$TOKEN" > "\$hdr"/);
    expect(vm).toMatch(/-H @"\$hdr"/);
    expect(vm).not.toMatch(/-H "Authorization: Bearer \$/);
  });
  it('reuses a live VM, deletes it on down, and sweeps any build VM older than its limit', () => {
    expect(vm).toMatch(/if alive; then echo "ssh:\/\/build-vm"; return 0; fi/);
    expect(vm).toMatch(/hc DELETE "\/servers\/\$id"/);
    expect(vm).toMatch(/label_selector=purpose%3Dbuild/);
    expect(vm).toMatch(/MAX_AGE_MIN=\$\{BUILD_VM_MAX_AGE_MIN:-120\}/);
  });
  it('scripts that run on Linux keep LF line endings, also from a Windows checkout ("env: bash\\r", 2026-11-21)', () => {
    const ga = readFileSync(new URL('../../.gitattributes', import.meta.url), 'utf8');
    expect(ga).toMatch(/^\*\.sh text eol=lf$/m);
    expect(ga).toMatch(/^ops\/host\/\*\* text eol=lf$/m);
    expect(ga).toMatch(/^ghost-browser\/scripts\/\*\.js text eol=lf$/m);
  });
  it('the server watchdog sweeps every 15 minutes and reports a VM left running', () => {
    expect(watch).toMatch(/build-vm\.sh sweep/);
    expect(watch).toMatch(/report build-vm warn "A rented build VM is still running"/);
  });
});
