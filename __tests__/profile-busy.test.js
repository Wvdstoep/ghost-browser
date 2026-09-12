// A JOB DOES NOT TAKE A PROFILE FROM ANOTHER JOB.
//
// Watched live on 2026-09-11. Workshop build run#42 probed olx.pl on the google profile while
// product#3's web research read Clio on the SAME profile. The build kept landing on legal-software
// pages and concluded the browser had been hijacked by malware. It had not: the two jobs were taking
// the browser from each other, repeatedly, and each takeover closed the other's context.
//
// The pool is right to allow ONE browser per profile — two Chromiums on one profile directory corrupt
// it. The hole was TAKEOVER, whose condition is `holder.owner === owner`. That condition exists for a
// person: closing a tab does not close the session behind it, so someone who opens a profile on their
// phone and comes back on a laptop must not be refused by a session nobody can see. But every organ
// job runs under ONE shared key, so agent B always satisfied it and always stole agent A's browser.
//
// The distinction is whether the holder is actively driving a job. These tests pin both halves: busy
// means 409 even for the same owner, and an idle session can still be taken over exactly as before.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../src/pool.js', import.meta.url)), 'utf8');
/* The profile branch of createSession — the only place a profile can change hands. */
const branch = (() => {
  const at = src.indexOf('    if (profile) {');
  expect(at, 'the profile branch must exist').toBeGreaterThan(-1);
  const end = src.indexOf('const dir = path.join(PROFILE_DIR, safe);', at);
  expect(end, 'the branch must reach the profile dir').toBeGreaterThan(at);
  return src.slice(at, end);
})();

describe('a profile in use by a running job is busy', () => {
  it('refuses with 409 BEFORE the takeover branch is even considered', () => {
    const busy = branch.indexOf('const driving = holder.job');
    const take = branch.indexOf('if (takeover && holder.owner === owner)');
    expect(busy).toBeGreaterThan(-1);
    expect(take).toBeGreaterThan(-1);
    expect(busy).toBeLessThan(take);          // asked first, so a busy profile never reaches takeover
  });

  it('says it is busy, names the job holding it, and does not offer a takeover', () => {
    const block = branch.slice(branch.indexOf('const driving = holder.job'), branch.indexOf('if (takeover && holder.owner === owner)'));
    expect(block).toMatch(/status: 409/);
    expect(block).toMatch(/is busy: another job/);
    expect(block).toMatch(/wait for it to finish/);
    expect(block).toMatch(/canTakeover: false/);
    expect(block).toMatch(/busyJob:/);        // so a caller can say WHICH job it is waiting on
    expect(block).toMatch(/this\.stats\.rejected\+\+/);
  });

  it('counts only a job that is actually still going — a finished one holds nothing', () => {
    const block = branch.slice(branch.indexOf('const driving = holder.job'), branch.indexOf('if (takeover'));
    for (const over of ['idle', 'done', 'failed', 'stopped']) {
      expect(block, over).toMatch(new RegExp(`!== '${over}'`));
    }
  });

  it('explains why owner is not enough, so the condition is not simplified back', () => {
    expect(branch).toMatch(/BUSY MEANS BUSY, EVEN FOR THE SAME OWNER/);
    expect(branch).toMatch(/Every organ job shares one key/);
    expect(branch).toMatch(/olx\.pl and a research walk reading Clio/);
  });
});

describe('what takeover was written for still works', () => {
  it('an idle session held by the same owner is still taken over, not refused', () => {
    const take = branch.slice(branch.indexOf('if (takeover && holder.owner === owner)'));
    expect(take).toMatch(/taking over profile/);
    expect(take).toMatch(/await this\.close\(holder\.id, 'taken over by a newer session'\)/);
  });

  it("someone else's profile is still refused, and one browser per profile still holds", () => {
    expect(branch).toMatch(/is in use by someone else/);
    expect(branch).toMatch(/One browser per profile, enforced here/);
  });
});
