/**
 * A FLOW THAT BELONGS TO AN ORGAN SAYS SO.
 *
 * Herald's reply flow is stored where the owner's own automations are, so it already appeared on the
 * Automation tab — as an anonymous card that looked hand-drawn, whose trigger read "manual" (nobody
 * presses it; Herald does), and which offered a Delete that would have silently stopped every reply
 * the desk sends, with nothing on screen to say what broke.
 *
 * `owner` is who shipped it. Editing stays open on purpose — the owner may want to see or tune what
 * her desk runs, and the organ reconciles by name on its next restart.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-owner-'));
process.env.PROFILE_DIR = TMP;
const wf = await import('../src/workflows.js');
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const flow = (extra = {}) => ({
  name: 'a flow with an owner',
  nodes: [{ id: 'start', type: 'trigger' }, { id: 'a', type: 'agent', role: 'general', goal: 'do it' }],
  edges: [{ from: 'start', to: 'a' }],
  ...extra,
});

describe('a flow records who shipped it', () => {
  it('an organ signs its own', () => {
    expect(wf.save(flow({ owner: 'herald', name: 'organ flow' }), ['general']).owner).toBe('herald');
  });

  it('one the owner drew has none', () => {
    expect(wf.save(flow({ name: 'hand drawn' }), ['general']).owner).toBe('');
  });

  /* Editing must never orphan a flow from the organ that maintains it. */
  it('and editing it does not lose the owner', () => {
    const saved = wf.save(flow({ owner: 'herald', name: 'kept owner' }), ['general']);
    const edited = wf.save({ ...saved, name: 'kept owner, renamed', owner: undefined }, ['general']);
    expect(edited.owner).toBe('herald');
  });

  it('the name is cleaned, because it is shown on a card', () => {
    expect(wf.save(flow({ owner: '  Herald<script> ', name: 'dirty owner' }), ['general']).owner).toBe('heraldscript');
  });

  it('and an export carries it, so an import knows what it is', () => {
    const saved = wf.save(flow({ owner: 'herald', name: 'exported flow' }), ['general']);
    expect(wf.exportPack(saved.id).owner).toBe('herald');
  });
});

describe('the Automation tab shows it, and does not offer to break it', () => {
  const ui = fs.readFileSync(new URL('../public/js/automation.js', import.meta.url), 'utf8');
  const api = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  it('a card says where the flow came from', () => {
    expect(ui).toMatch(/const from = w\.owner \? '<span class="auto-pill auto-pill--from">from ' \+ esc\(w\.owner\) \+ '<\/span>' : '';/);
  });

  /* "manual" would read as "nobody has pressed this", which is the opposite of the truth. */
  it('and who starts it, instead of the misleading trigger type', () => {
    expect(ui).toMatch(/const starter = w\.owner \? 'started by ' \+ esc\(w\.owner\) : esc\(\(w\.trigger && w\.trigger\.type\) \|\| 'manual'\)/);
  });

  it('the Delete button is not offered for an organ\'s flow', () => {
    expect(ui).toMatch(/\(w\.owner \? '' : '<button class="btn btn-sm btn-ghost btn-danger" data-del=/);
  });

  it('and the API refuses it too, naming what to do instead', () => {
    expect(api).toMatch(/if \(w && w\.owner\) return res\.status\(409\)/);
    expect(api).toMatch(/Disconnect \$\{w\.owner\} to remove it/);
  });

  /*
   * The count read agent nodes only, so Herald's reply flow — post it, was it refused, is it on the
   * thread, what happened — showed as "1 step" and looked trivial. A step ACTS or DECIDES; a store
   * only writes the answer down.
   */
  it('counts what the flow does, not just what browses', () => {
    expect(ui).toMatch(/const doing = \(w\.nodes \|\| \[\]\)\.filter\(\(n\) => n\.type !== 'trigger' && n\.type !== 'store'\);/);
    expect(ui).toMatch(/const steps = doing\.length;/);
  });

  it('and says what kind, in words', () => {
    expect(ui).toMatch(/n\.type === 'agent' \? 'browses'/);
    expect(ui).toMatch(/n\.type === 'verify' \? 'checks the page'/);
    expect(ui).toMatch(/n\.type === 'branch' \? 'decides'/);
  });

  /* Opening and editing stay available: the owner may want to see exactly what her desk runs. */
  it('but it can still be opened and exported', () => {
    expect(ui).toMatch(/data-open="' \+ esc\(w\.id\)/);
    expect(ui).toMatch(/data-export="' \+ esc\(w\.id\)/);
  });
});
