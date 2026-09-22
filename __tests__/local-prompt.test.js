/*
 * THE PROMPT, AND THE ONE BUG IN IT THAT COSTS A WHOLE TRAINING ROUND.
 *
 * Everything here guards a failure that produces a working-looking model and a bad one:
 *
 *   - the catalogue is missing, so the model must memorise the tool list and every new tool needs a
 *     training round before it can ever be chosen;
 *   - the catalogue describes a tool that is not the tool that runs, which is how `download_file`
 *     sat in the live catalogue for months pointing at dead code;
 *   - the numbered list is absent, so `click [13]` is a target derived from nothing and the model
 *     learns to guess indices — the exact mistake the fine-tune exists to remove;
 *   - a STALE numbered list is included, which is worse than none: it teaches the model to act on
 *     numbers that have already expired.
 */
import { describe, it, expect } from 'vitest';
import { systemFor, userFor, catalogue, signatureOf, purposeOf } from '../src/localPrompt.js';

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const TOOLS = [
  fn('look', 'Every clickable thing, numbered. The numbers are only valid until the page changes.'),
  fn('click', 'Click a numbered element on the page.', { index: { type: 'integer' }, why: { type: 'string' } }, ['index']),
  fn('type', 'Type into a numbered field.', { index: { type: 'integer' }, text: { type: 'string' } }, ['index', 'text']),
];

describe('the catalogue', () => {
  it('lists every tool with its arguments, so an unseen tool can still be chosen', () => {
    const c = catalogue(TOOLS);
    expect(c).toContain('look()');
    expect(c).toContain('click(index, why?)');
    /* Required arguments bare, optional marked — the shape of the answer reads left to right. */
    expect(c).toContain('type(index, text)');
  });

  it('keeps the LAST declaration when a name is declared twice', () => {
    /* The live agent merges handlers with Object.assign, so the later declaration is the one that
       runs. A catalogue that documents the earlier one describes behaviour that does not exist —
       which is precisely how one tool in this codebase was unreachable for months while being
       advertised to the model on every single call. */
    const dupes = [...TOOLS, fn('click', 'Actually follows a link by url.', { url: { type: 'string' } }, ['url'])];
    const c = catalogue(dupes);
    expect(c).toContain('click(url)');
    expect(c).not.toContain('click(index, why?)');
    expect(c.match(/^click\(/gm)).toHaveLength(1);
  });

  it('clips a paragraph to one clause instead of paying for it on every example', () => {
    /* The live descriptions are paragraphs, and prompt length sets training time directly. */
    const long = fn('dig', 'Read the page properly. '.repeat(40));
    expect(purposeOf(long.function.description).length).toBeLessThanOrEqual(90);
  });

  it('leaves a short description whole instead of eating its last word', () => {
    /* "Go to a web address." has no whitespace after the full stop, so a sentence search finds
       nothing; trimming a partial word off a string that was never truncated then produced
       "Go to a web" — every brief tool in the catalogue lost its object. */
    expect(purposeOf('Go to a web address.')).toBe('Go to a web address');
    expect(purposeOf('Go back to the previous page.')).toBe('Go back to the previous page');
  });

  it('cuts a long description at its first sentence, not mid-word', () => {
    const p = purposeOf('The CONTROLS on this page — buttons, links and fields — as a numbered list. More text here.');
    expect(p).toBe('The CONTROLS on this page');
  });

  it('survives a tool with no description and one with no arguments', () => {
    expect(catalogue([fn('back', '')])).toBe('back()');
    expect(signatureOf({ name: 'look' })).toBe('look()');
  });
});

describe('the system message', () => {
  it('carries the catalogue and the answer shape', () => {
    const s = systemFor({ role: 'research.web', site: 'google', tools: TOOLS });
    expect(s).toContain('research.web');
    expect(s).toContain('google');
    expect(s).toContain('click(index, why?)');
    expect(s).toContain('{"tool":"<name>","args":{...}}');
  });

  it('puts the role playbook in the prompt, not in the adapter', () => {
    /* Playbooks are edited by hand between rounds. In the prompt a correction lands this afternoon;
       baked into an adapter it waits for a night of training on somebody's laptop. */
    const s = systemFor({ role: 'sales', tools: TOOLS, playbook: 'Never quote a price.' });
    expect(s).toContain('Never quote a price.');
  });

  it('is identical for identical inputs, because train and serve both call it', () => {
    const a = systemFor({ role: 'r', site: 's', tools: TOOLS });
    const b = systemFor({ role: 'r', site: 's', tools: TOOLS });
    expect(a).toBe(b);
  });
});

describe('the user message', () => {
  const marks = '[1] Sign in\n[2] Dodaj ofertę\n[3] Close';

  it('INCLUDES THE NUMBERED LIST, which is the only thing that makes an index learnable', () => {
    const u = userFor({ goal: 'Submit the offer', observed: [{ kind: 'look', text: 'useme.com — 3 things to click', marks }] });
    expect(u).toContain('[2] Dodaj ofertę');
  });

  it('includes only the MOST RECENT list, never an expired one', () => {
    /* Two lists in one prompt is worse than none. The older numbers no longer refer to anything on
       screen, and including them teaches exactly the stale-index click this is meant to prevent. */
    const u = userFor({
      goal: 'g',
      observed: [
        { kind: 'look', text: 'page one — 2 things', marks: '[1] Old thing\n[2] Older thing' },
        { kind: 'open', text: 'https://example.com/two' },
        { kind: 'look', text: 'page two — 3 things', marks },
      ],
    });
    expect(u).toContain('[2] Dodaj ofertę');
    expect(u).not.toContain('Old thing');
    /* The earlier look still appears as a line — it happened — just without its expired numbers. */
    expect(u).toContain('page one — 2 things');
  });

  it('says so plainly when nothing has been seen', () => {
    expect(userFor({ goal: 'Start' })).toContain('- nothing yet');
  });

  it('keeps the goal first, because it is the thing that does not change', () => {
    expect(userFor({ goal: 'Find three suppliers', observed: [] }).startsWith('GOAL: Find three suppliers')).toBe(true);
  });
});
