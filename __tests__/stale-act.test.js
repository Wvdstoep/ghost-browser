// AN APPROVED ACT FIRES ON THE PAGE IT WAS PROPOSED ON, OR NOT AT ALL.
//
// Live, 2026-09-11: a [For Hire] post parked at the gate on r/forhire/submit. Minutes later the owner
// released it. The agent clicked element [5] — the number it had held while it waited — and the page
// had moved on, so "Post" was a link into a random r/wordchain thread. Nothing was published, by luck.
// The proposal had recorded the url it was made on and nobody compared it before clicking.
//
// The act loop is not unit-drivable without a browser, so this pins the guard where it lives: between
// the decision coming back and the click, checking the page and the label, refusing with a reason,
// and only for an act that actually parked.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../src/agent.js', import.meta.url)), 'utf8');
const act = src.slice(src.indexOf("case 'act': {"), src.indexOf('SEAL THE ROUTE CARD AT THE ACT'));

describe('a parked act is checked against its own page before it fires', () => {
  it('remembers the page the act was proposed on, and only then', () => {
    expect(act).toMatch(/let proposedUrl = null;/);
    expect(act).toMatch(/proposedUrl = p\.url \|\| page\(\)\.url\(\);/);
    // set inside the parking branch, after propose — an act approved on the spot never waited
    const propose = act.indexOf('jobsStore.propose(job, {');
    const remember = act.indexOf('proposedUrl = p.url');
    expect(remember).toBeGreaterThan(propose);
  });

  it('the check sits after the decision and before the click', () => {
    const decided = act.indexOf('await awaitDecision(job, p.pid');
    const guard = act.indexOf('const stale = proposedUrl ?');
    const click = act.indexOf('else await clickIndex(a.index);');
    expect(decided).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(decided);
    expect(click).toBeGreaterThan(guard);
  });

  it('refuses when the page moved, and when the element under that number changed label', () => {
    expect(act).toMatch(/the page moved while the act waited/);
    expect(act).toMatch(/is now "\$\{labelNow \|\| 'nothing'\}", not "\$\{label\}"/);
    // compared by path: a query string or a fragment is not a different page
    expect(act).toMatch(/replace\(\/\[\?#\]\.\*\$\/, ''\)/);
  });

  it('records the refusal, tells the agent to look and ask again, and clicks nothing', () => {
    // the refusal block ends where the real click begins — `if (toSend) await typeInto` is the click
    const block = act.slice(act.indexOf('if (stale) {'), act.indexOf('if (toSend) await typeInto(a.index'));
    expect(block).toMatch(/jobsStore\.step\(job, 'blocked', `approved \$\{kind\} NOT fired: \$\{stale\}`/);
    expect(block).toMatch(/Nothing was clicked\. Call look, find "\$\{label\}" again on the right page, and ask again/);
    expect(block).toMatch(/break;/);
    expect(block).not.toMatch(/clickIndex|typeInto/);
  });

  it('never blocks an act approved on the spot — there was no wait for the page to move', () => {
    expect(act).toMatch(/const stale = proposedUrl \? \(\(\) => \{/);
    expect(act).toMatch(/\}\)\(\) : null;/);
  });

  it('a check that itself fails is a refusal, not a click', () => {
    expect(act).toMatch(/the page could not be checked before the act/);
  });
});
