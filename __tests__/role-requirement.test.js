/*
 * A ROLE MAY SAY IT CANNOT RUN JUST ANYWHERE — and the projection must not eat that.
 *
 * capcut-video-editor needs CDP drag-interception: the cluster's browser loads the CapCut editor fine
 * and then cannot drop a clip on the timeline. The requirement went into the role's data, the ring
 * can route on it, the gate in server.js reads it — and the automation still started on the cluster.
 *
 * Because getRole() does not return the role, it returns a PROJECTION of it onto a fixed list of
 * fields: site, group, label, description, tools, prompt. Anything else disappears without a word. So
 * roles.get() handed back a role with no requirement, deviceNeedOf saw null, and the gate never fired.
 *
 * save() had the same fixed list, which is worse: opening the role in the console and saving it would
 * have dropped the requirement out of the data itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

let BASE;
let userRoles;

beforeAll(() => {
  // DIR is resolved at module load from PROFILE_DIR, so it must be set before the require.
  BASE = mkdtempSync(join(tmpdir(), 'gb-roles-'));
  process.env.PROFILE_DIR = BASE;
  mkdirSync(join(BASE, 'roles'), { recursive: true });
  userRoles = require('../src/userRoles.js');

  writeFileSync(join(BASE, 'roles', 'capcut-video-editor.json'), JSON.stringify({
    id: 'capcut-video-editor', site: 'capcut.com', group: 'Video',
    label: 'CapCut - Video editor', description: 'Edits a short vertical video.',
    tools: ['look', 'read', 'open', 'click', 'type', 'scroll', 'note', 'finish', 'act'],
    prompt: 'Open CapCut, import the clip, put it on the timeline, trim it, export it.',
    require: { cdp: true, features: ['drag_xy'] },
    source: 'user',
  }, null, 2));

  writeFileSync(join(BASE, 'roles', 'plain-role.json'), JSON.stringify({
    id: 'plain-role', label: 'Plain', description: 'Runs anywhere.',
    tools: null, prompt: 'Do the ordinary thing, anywhere it happens to run.', source: 'user',
  }, null, 2));
});

afterAll(() => { try { rmSync(BASE, { recursive: true, force: true }); } catch { /* temp */ } });

describe('the requirement survives being read', () => {
  it('getRole carries require — the field the projection used to drop', () => {
    const r = userRoles.getRole('capcut-video-editor');
    expect(r, 'the role should be found').toBeTruthy();
    expect(r.require).toEqual({ cdp: true, features: ['drag_xy'] });
  });

  it('a role with no requirement reads as null, so ordinary flows are unaffected', () => {
    expect(userRoles.getRole('plain-role').require).toBeNull();
  });

  it('listRoles shows it too, so a picker can say where a role runs', () => {
    const row = userRoles.listRoles().find((x) => x.name === 'capcut-video-editor');
    expect(row.require).toEqual({ cdp: true, features: ['drag_xy'] });
  });
});

describe('the requirement survives being saved', () => {
  it('editing the role does not wipe it out of the data', () => {
    // The dangerous half: a read that drops the field is a bug, a WRITE that drops it is data loss.
    const r = userRoles.getRole('capcut-video-editor');
    userRoles.save({
      id: 'capcut-video-editor', label: r.label, site: r.site, group: r.group,
      description: 'edited description', tools: r.tools, prompt: r.prompt, require: r.require,
    }, r.tools);
    const onDisk = JSON.parse(readFileSync(join(BASE, 'roles', 'capcut-video-editor.json'), 'utf8'));
    expect(onDisk.description).toBe('edited description');
    expect(onDisk.require).toEqual({ cdp: true, features: ['drag_xy'] });
  });
});

describe('only requirements the ring understands', () => {
  it('unknown keys and unknown platforms are dropped, not passed through', () => {
    // A requirement no device could ever meet is indistinguishable from "no device is online", so a
    // typo in the data must not become one.
    expect(userRoles.normRequire({ cdp: true, features: ['drag_xy'], nonsense: 1 }))
      .toEqual({ cdp: true, features: ['drag_xy'] });
    expect(userRoles.normRequire({ platform: 'toaster', cdp: true })).toEqual({ cdp: true });
    expect(userRoles.normRequire({ platform: 'desktop' })).toEqual({ platform: 'desktop' });
  });

  it('nothing to require reads as null rather than an empty object', () => {
    // An empty object is truthy, and the gate branches on truthiness: {} would have made every role
    // a device role and stopped every flow.
    expect(userRoles.normRequire({})).toBeNull();
    expect(userRoles.normRequire(null)).toBeNull();
    expect(userRoles.normRequire({ cdp: false })).toBeNull();
  });
});
