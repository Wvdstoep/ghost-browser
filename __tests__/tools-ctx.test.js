/*
 * EVERY ctx.<name> A TOOL CALLS MUST EXIST ON THE CONTEXT THE AGENT HANDS IT.
 *
 * hover called ctx.elementAt for weeks and the context never had it; every call threw, the
 * failure was filed as "the call itself threw" and dropped, and the tool simply had no examples.
 * Nothing pointed at the cause because the two files never meet in a test. Now they do: the
 * names the tools use are read off their source, the names the agent offers off its own, and
 * a tool reaching for a name that is not there fails here, before it fails on a page.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');

function offered() {
  const agent = fs.readFileSync(path.join(SRC, 'agent.js'), 'utf8');
  const start = agent.indexOf('const toolCtx = {');
  expect(start).toBeGreaterThan(0);
  /* The object runs to the first line that is exactly `  };` after it. */
  const end = agent.indexOf('\n  };', start);
  const body = agent.slice(start, end);
  const names = new Set();
  /* `name: ...`, `name(...) {`, and the shorthand `name,` - observe and switchProfile are shorthand. */
  for (const m of body.matchAll(/^\s{4}([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:[:(]|,\s*(?:\/\/.*)?$)/gm)) names.add(m[1]);
  /* ...and everything spread in from elsewhere is out of reach of a source-level check; name the spreads. */
  const spreads = [...body.matchAll(/^\s{4}\.\.\.([a-zA-Z_][a-zA-Z0-9_.()]*)/gm)].map((m) => m[1]);
  return { names, spreads };
}

function used() {
  const dir = path.join(SRC, 'tools');
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/\bctx\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
      if (!out.has(m[1])) out.set(m[1], new Set());
      out.get(m[1]).add(f);
    }
  }
  return out;
}

describe('the tool context', () => {
  it('offers every ctx.<name> the tools call', () => {
    const { names, spreads } = offered();
    const calls = used();
    const missing = [...calls.entries()].filter(([n]) => !names.has(n)).map(([n, files]) => `${n} (${[...files].join(', ')})`);
    /* A spread hides names from this check; if one exists, this test cannot be sure and says so. */
    if (spreads.length) expect(spreads).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('offers elementAt in particular, because hover needs it', () => {
    expect(offered().names.has('elementAt')).toBe(true);
  });
});
