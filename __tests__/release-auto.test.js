/*
 * THE APPS RELEASE THEMSELVES AFTER A PUSH, BUILT ON THE OWNER'S MACHINE (2026-11-20).
 *
 * Owner: "i dont want to build it on the server i want to keep it here i do want the builds to be automatic
 * updated on the github as it does and to the download site". scripts/push-changes.sh hands the pushed
 * commits to mobile/auto-release.sh, which releases an app when its VERSION changed (an installed app only
 * updates to a higher one) and says so when its code changed without one. These run the real script on a
 * small git repository.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const lf = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); execFileSync('bash', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }

let repo;
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const write = (rel, text) => { const p = join(repo, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
const commit = (msg) => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
const plan = (a, b) => execFileSync('bash', [join(repo, 'ghost-browser/mobile/auto-release.sh'), '--plan', a, b], { cwd: repo, encoding: 'utf8' });
const app = (name, code) => `android {\n  defaultConfig {\n    versionCode = ${code}\n    versionName = "${name}"\n  }\n}\n`;
const desk = (v) => `nativeDistributions {\n  packageVersion = "${v}"\n}\n`;

describe.skipIf(!hasGit)('what a push releases', () => {
  let c0, c1, c2, c3, c4, c5;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'gb-autorel-'));
    git('init', '-q');
    mkdirSync(join(repo, 'ghost-browser/mobile'), { recursive: true });
    writeFileSync(join(repo, 'ghost-browser/mobile/auto-release.sh'), lf(join(root, 'ghost-browser/mobile/auto-release.sh')));
    write('ghost-browser/mobile/app/build.gradle.kts', app('0.99', 119));
    write('ghost-browser/mobile/desktop/build.gradle.kts', desk('1.0.65'));
    write('ghost-browser/mobile/shared/Ui.kt', 'a');
    write('server/index.js', 'x');
    c0 = commit('start');
    write('server/index.js', 'y'); c1 = commit('a website change');
    write('ghost-browser/mobile/app/build.gradle.kts', app('1.00', 120)); write('ghost-browser/mobile/app/Main.kt', 'b'); c2 = commit('phone 1.00');
    write('ghost-browser/mobile/desktop/build.gradle.kts', desk('1.0.66')); c3 = commit('desktop 1.0.66');
    write('ghost-browser/mobile/shared/Ui.kt', 'c'); c4 = commit('shared code, no version');
    write('ghost-browser/mobile/app/build.gradle.kts', app('1.01', 121)); write('ghost-browser/mobile/desktop/build.gradle.kts', desk('1.0.67')); c5 = commit('both');
  });
  afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

  it('a push that does not touch the apps releases nothing', () => {
    expect(plan(c0, c1).trim()).toBe('');
  });
  it('a new phone version releases the phone app, a new desktop version the desktop app, both both', () => {
    expect(plan(c1, c2).trim()).toBe('apk');
    expect(plan(c2, c3).trim()).toBe('msi');
    expect(plan(c4, c5).trim()).toBe('all');
    expect(plan(c1, c3).trim()).toBe('all');      // several commits in one push
  });
  it('app code without a new version is not released, and the push says which version to raise', () => {
    const out = plan(c3, c4);
    expect(out).not.toMatch(/^(apk|msi|all)$/m);
    expect(out).toContain('the phone app changed but its version did not');
    expect(out).toContain('the desktop app changed but its version did not');
  });
  it('GB_AUTO_RELEASE=0 turns it off for one push', () => {
    const out = execFileSync('bash', [join(repo, 'ghost-browser/mobile/auto-release.sh'), '--plan', c1, c2], { cwd: repo, encoding: 'utf8', env: { ...process.env, GB_AUTO_RELEASE: '0' } });
    expect(out.trim()).toBe('');
  });
});

describe('the push scripts start it', () => {
  it('push-changes.sh and .ps1 note what GitLab had before the push and hand it to auto-release.sh', () => {
    const sh = lf(join(root, 'scripts/push-changes.sh'));
    expect(sh).toMatch(/BEFORE=\$\(git rev-parse -q --verify origin\/main[^\n]*\ngit commit/);
    expect(sh).toContain('bash ghost-browser/mobile/auto-release.sh "$BEFORE" HEAD || true');
    const ps = lf(join(root, 'scripts/push-changes.ps1'));
    expect(ps).toContain('& bash ghost-browser/mobile/auto-release.sh $before.Trim() HEAD');
  });
  it('the build runs in the background, one at a time, and releases with release-apps.sh', () => {
    const s = lf(join(root, 'ghost-browser/mobile/auto-release.sh'));
    expect(s).toContain('nohup bash -c');
    expect(s).toContain('bash "$HERE/release-apps.sh" "$WHAT"');
    expect(s).toMatch(/while \[ -f "\$LOCK" \] && kill -0/);
  });
});
