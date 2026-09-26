import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Beating your own starting point is easy for a round that starts from nothing. "Beat what
 * actually serves" is the gate that stops such a round installing itself, and it works by looking
 * the serving adapter's score up in the baseline cache. Twice now that lookup has quietly missed -
 * once because the score was filed under a machine-local directory and asked for by name, once
 * because the answer budget joined the key and the lookup did not. A gate that finds nothing does
 * not refuse; it waves the round through.
 */
describe('the bar can find what serves', () => {
  let dir, training;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-bar-'));
    process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    training = require('../src/training');
    fs.mkdirSync(path.join(dir, 'training'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'training', 'rounds.json'), JSON.stringify([
      { id: 'r-serving', status: 'done', promoted: true, adapterHub: 'hub:r-serving',
        scope: { level: 'base', name: '', key: 'base' },
        recipe: { base: 'Qwen/Qwen2.5-0.5B-Instruct', answerTokens: 320 },
        result: { agreement_pct: 36.44, turns: 354 } },
    ]));
    fs.writeFileSync(path.join(dir, 'training', 'current.json'), JSON.stringify({
      adapter: 'hub:r-serving', scopes: { base: { adapter: 'hub:r-serving' } },
    }));
    /* The score of what serves, filed the way the trainer files it now: by NAME, with the budget. */
    fs.writeFileSync(path.join(dir, 'training', 'baselines.json'), JSON.stringify({
      [training.baselineKey({ scope: 'base', base: 'hub:r-serving', paper: 'p1', turns: 354, answer: 320 })]:
        { agreement_pct: 36.44, args_agreement_pct: 19.21, turns: 354 },
    }));
  });
  afterEach(() => {
    delete process.env.PROFILE_DIR;
    delete require.cache[require.resolve('../src/training')];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const challenger = {
    id: 'r-new', status: 'done', base: '', paper: 'p1',
    scope: { level: 'base', name: '', key: 'base' },
    recipe: { base: 'Qwen/Qwen3-0.6B', answerTokens: 320 },
    result: { agreement_pct: 30.0, args_agreement_pct: 15.0, turns: 354 },
  };

  it('finds the serving score for a round that started from nothing', () => {
    const bar = training.servingBar(challenger);
    expect(bar).toBeTruthy();
    expect(bar.agreement_pct).toBe(36.44);
    expect(bar.args_agreement_pct).toBe(19.21);
  });

  it('and does not ask for one when the round measured what serves itself', () => {
    expect(training.servingBar({ ...challenger, base: 'hub:r-serving' })).toBe(null);
  });

  it('a score filed under a different answer budget is not this one', () => {
    const at48 = training.baselineKey({ scope: 'base', base: 'hub:r-serving', paper: 'p1', turns: 354, answer: 48 });
    const at320 = training.baselineKey({ scope: 'base', base: 'hub:r-serving', paper: 'p1', turns: 354, answer: 320 });
    expect(at48).not.toBe(at320);
  });

  it('a name is not a path, and the gate asks by name', () => {
    const byName = training.baselineKey({ scope: 'base', base: 'hub:r-serving', paper: 'p1', turns: 354, answer: 320 });
    const byPath = training.baselineKey({ scope: 'base', base: '/root/gb-train/rounds/adapters/r-serving', paper: 'p1', turns: 354, answer: 320 });
    expect(byName).not.toBe(byPath);
    /* The bar asks for the name; a score filed under the path would never be found. */
    expect(training.servingBar(challenger)).toBeTruthy();
  });
});
