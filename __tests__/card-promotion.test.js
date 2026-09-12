// A REPEATING JOB SHOULD WALK ONCE AND REPLAY AFTER — why it never did, and what now closes it.
//
// Route cards were built, wired, tested and completely unreachable. Three cards recorded from real
// Herald acts sat at confidence 0 for months, never quarantined, never replayed, because the logic
// was a closed loop: planFor opens the fast path only for a card with `lastVerified`, the only thing
// that sets `lastVerified` is a successful replay, and a replay is only attempted for a card that
// already has it. No card could earn the trust that trust was the precondition for.
//
// A second, independent gap sat behind it: the agent reads `settings.replayValues` when it rebuilds a
// card, and nothing in the codebase ever assigned it — so even a trusted card came back null from
// buildReplay and every repeat paid for a full model walk anyway.
//
// The fix is the ride-along this file's sibling comment always promised: a UI walk that just did the
// act IS the verification. If the request it made matches the shape the stored card predicted, the
// card is confirmed BY OBSERVATION. Nothing is ever re-fired — re-firing a create to prove a card is
// the destructive act the design refuses, and it still refuses it.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distill, planFor, onFailed, buildReplay, learnFrom, sameShape, pathOf } from '../src/routecards.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cards-'));
process.env.PROFILE_DIR = TMP;
const wf = await import('../src/workflows.js');
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });
const ROLE_NAMES = ['mail.reply', 'mail.read', 'r'];

const agentSrc = readFileSync(fileURLToPath(new URL('../src/agent.js', import.meta.url)), 'utf8');
const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const wfSrc = readFileSync(fileURLToPath(new URL('../src/workflows.js', import.meta.url)), 'utf8');

/* A clean-API act: a send whose body is meaningful fields, which is the case a card actually pays for
   (a fingerprint-heavy platform like Facebook cannot be rebuilt and keeps walking the UI by design). */
const send = (over = {}) => ({
  method: 'POST',
  url: 'https://mail.example.com/api/messages?ik=session-one',
  headers: { 'x-csrf-token': 'tok' },
  postData: '{"to":"a@b.c","subject":"re: brief","body":"yes, happy to take it on"}',
  ...over,
});
const record = (over = {}, now = 1) => distill({ intent: 'flow:inbox:reply', origin: 'https://mail.example.com', requests: [send(over)], now }).card;

describe('the loop is open: two sightings earn the fast path', () => {
  it('THE REGRESSION — record, record again, and the step may now replay instead of walking', () => {
    // first run: the walk does the act and the card is kept, untrusted
    const first = record();
    expect(first.lastVerified).toBeNull();
    expect(planFor(first).mode).toBe('ui');

    // second run: the walk does the same act, and watching it do so is the verification
    const second = learnFrom(first, record({}, 2), 2);
    expect(second.promoted).toBe(true);
    expect(second.card.lastVerified).toBe(2);
    expect(second.card.confidence).toBe(1);
    expect(planFor(second.card).mode).toBe('fast');     // before this change: unreachable, forever

    // and with the step's letter supplied it actually rebuilds into a request
    const built = buildReplay(second.card, { to: 'a@b.c', subject: 're: brief', body: 'different words this run' });
    expect(built).toBeTruthy();
    expect(built.url).toContain('/api/messages');
    expect(built.values.body).toBe('different words this run');
  });

  it('one sighting is never enough — a single recording stays untrusted', () => {
    const out = learnFrom(null, record());
    expect(out.promoted).toBe(false);
    expect(out.card.lastVerified).toBeNull();
    expect(out.reason).toMatch(/first sighting/);
  });

  it('confidence keeps climbing with each sighting, capped where onVerified caps it', () => {
    let card = record();
    for (let i = 2; i < 12; i++) card = learnFrom(card, record({}, i), i).card;
    expect(card.confidence).toBe(5);
  });

  it('nothing recorded changes nothing', () => {
    expect(learnFrom(record(), null).card).toBeNull();
  });
});

describe('what must NOT be promoted', () => {
  it('a request that changed shape resets trust instead of inheriting it', () => {
    const trusted = learnFrom(record(), record({}, 2), 2).card;
    expect(trusted.lastVerified).toBe(2);
    // the site moved its endpoint: a different path is a different request
    const moved = learnFrom(trusted, record({ url: 'https://mail.example.com/api/v2/messages' }, 3), 3);
    expect(moved.promoted).toBe(false);
    expect(moved.card.lastVerified).toBeNull();
    expect(moved.reason).toMatch(/changed shape/);
    expect(planFor(moved.card).mode).toBe('ui');
  });

  it('a changed body shape is also a different request, even at the same url', () => {
    const trusted = learnFrom(record(), record({}, 2), 2).card;
    const different = learnFrom(trusted, record({ postData: '{"to":"a@b.c","html":"<p>x</p>"}' }, 3), 3);
    expect(different.promoted).toBe(false);
    expect(different.card.lastVerified).toBeNull();
  });

  it('a quarantined card needs TWO clean sightings, not one — a failed replay is not forgotten cheaply', () => {
    const trusted = learnFrom(record(), record({}, 2), 2).card;
    const burned = onFailed(trusted, 3);
    expect(burned.quarantined).toBe(true);

    const lifted = learnFrom(burned, record({}, 4), 4);
    expect(lifted.card.quarantined).toBe(false);          // the walk worked, so the door is unlocked
    expect(lifted.promoted).toBe(false);
    expect(lifted.card.lastVerified).toBeNull();           // but it may not replay yet
    expect(planFor(lifted.card).mode).toBe('ui');
    expect(lifted.reason).toMatch(/quarantine lifted/);

    const earned = learnFrom(lifted.card, record({}, 5), 5);
    expect(earned.promoted).toBe(true);
    expect(planFor(earned.card).mode).toBe('fast');
  });
});

describe('the same request said twice', () => {
  it('a per-session id in the query does not make it a different request, and the newest url is adopted', () => {
    const one = record();
    const two = record({ url: 'https://mail.example.com/api/messages?ik=session-two' }, 2);
    expect(sameShape(one, two)).toBe(true);
    const out = learnFrom(one, two, 2);
    expect(out.promoted).toBe(true);
    expect(out.card.url).toContain('ik=session-two');      // trust kept, address refreshed
  });

  it('the path is what identifies it, and pathOf drops only the query and fragment', () => {
    expect(pathOf('https://x.test/a/b?c=1#d')).toBe('https://x.test/a/b');
    expect(pathOf(null)).toBe('');
    const elsewhere = distill({ intent: 'flow:inbox:reply', origin: 'https://other.test', now: 2,
      requests: [send({ url: 'https://other.test/api/messages' })] }).card;
    expect(sameShape(record(), elsewhere)).toBe(false);
  });

  it('a different place for the auth token is a different request', () => {
    const withHeader = record();
    const withoutHeader = distill({
      intent: 'flow:inbox:reply', origin: 'https://mail.example.com', now: 2,
      requests: [send({ headers: {}, postData: '{"to":"a@b.c","csrf_token":"t","subject":"s","body":"b"}' })],
    }).card;
    expect(sameShape(withHeader, withoutHeader)).toBe(false);
  });
});

describe('the step carries the letter that fills the envelope', () => {
  it('an agent step keeps its values, capped, and a step without them is unchanged', () => {
    const saved = wf.save({
      name: 'inbox reply', nodes: [
        { id: 'start', type: 'trigger', trigger: { type: 'manual' } },
        { id: 'reply', type: 'agent', role: 'mail.reply', goal: 'answer the newest brief',
          values: { to: '{{input.from}}', subject: 're: {{input.subject}}', body: '{{step.draft.text}}' } },
        { id: 'plain', type: 'agent', role: 'mail.read', goal: 'read the inbox' },
      ], edges: [{ from: 'start', to: 'reply' }, { from: 'reply', to: 'plain' }],
    }, ROLE_NAMES);
    const reply = saved.nodes.find((n) => n.id === 'reply');
    expect(reply.values).toEqual({ to: '{{input.from}}', subject: 're: {{input.subject}}', body: '{{step.draft.text}}' });
    expect(saved.nodes.find((n) => n.id === 'plain').values).toBeUndefined();
  });

  it('rubbish in the values field is dropped rather than carried', () => {
    const saved = wf.save({ name: 'rubbish values', nodes: [
      { id: 'start', type: 'trigger', trigger: { type: 'manual' } },
      { id: 'a', type: 'agent', role: 'r', goal: 'g', values: 'not an object' },
      { id: 'b', type: 'agent', role: 'r', goal: 'g', values: ['a', 'b'] },
      { id: 'c', type: 'agent', role: 'r', goal: 'g', values: {} },
    ], edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }, ROLE_NAMES);
    for (const n of saved.nodes) expect(n.values).toBeUndefined();
  });

  it('resolveNode fills them from this run, so one card serves every repeat', () => {
    const node = { id: 'reply', type: 'agent', role: 'mail.reply', profile: 'google',
      values: { to: '{{input.from}}', body: '{{draft.text}}' } };
    const filled = wf.resolveNode(node, { input: { from: 'client@studio.pl' }, draft: { text: 'yes, happy to' } });
    expect(filled.values).toEqual({ to: 'client@studio.pl', body: 'yes, happy to' });
    expect(node.values.to).toBe('{{input.from}}');            // the flow definition is not mutated
  });

  it('the wiring sits in resolveNode, not somewhere a run can miss', () => {
    expect(wfSrc).toMatch(/const values = node\.values/);
    expect(wfSrc).toMatch(/template\(e\[1\], context\)/);
    // resolveNode must template the values, so {{input.x}} becomes this run's real value
    const at = wfSrc.indexOf('function resolveNode');
    const seg = wfSrc.slice(at, wfSrc.indexOf('function template', at));
    expect(seg).toMatch(/\.\.\.\(values \? \{ values \} : \{\}\)/);
  });
});

describe('the two halves are actually wired to each other', () => {
  it('the agent promotes by observation instead of overwriting the card at zero', () => {
    expect(agentSrc).toMatch(/const prior = cardStore\.get\(out\.card\.origin, out\.card\.intent\);/);
    expect(agentSrc).toMatch(/routecards\.learnFrom\(prior, out\.card, Date\.now\(\)\)/);
    expect(agentSrc).toMatch(/cardStore\.put\(learned\.card\);/);
    expect(agentSrc).not.toMatch(/cardStore\.put\(out\.card\);/);      // the old blind overwrite is gone
    expect(agentSrc).toMatch(/PROMOTION BY OBSERVATION/);
  });

  it('the flow step hands its letter to the agent job, which is what reads replayValues', () => {
    expect(serverSrc).toMatch(/if \(node\.values && typeof node\.values === 'object'\) cfg\.replayValues = node\.values;/);
    // and the agent still reads it from exactly there
    expect(agentSrc).toMatch(/settings\.replayValues \|\| \{\}/);
    // the assignment must happen before the job is created and run
    const set = serverSrc.indexOf('cfg.replayValues = node.values');
    const run = serverSrc.indexOf('agent.run({ job, session: s, settings: cfg');
    expect(set).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(set);
  });
});
