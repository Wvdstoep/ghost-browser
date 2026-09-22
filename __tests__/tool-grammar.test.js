/*
 * HOLDING A MODEL TO THE TOOL CATALOGUE.
 *
 * A small model's largest failure is not picking the wrong tool — it is producing something that is
 * not a tool call at all: prose wrapped round the JSON, the tool under "name", arguments arriving as
 * a string, a tool invented on the spot. None of that needs training to fix; it needs a decoder that
 * cannot emit it, and a check that measures how often it tried.
 *
 * Three runtimes serve this agent and each constrains differently — Ollama takes a JSON Schema,
 * llama.cpp takes a GBNF grammar, and neither can know that `click` needs an index — so all three
 * come out of one catalogue here rather than three hand-kept copies drifting apart.
 */
import { describe, it, expect } from 'vitest';
import { schemaFor, gbnfFor, validateCall, auditCatalogue, toolNames, firstJsonObject } from '../src/toolGrammar.js';

const fn = (name, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description: `does ${name}`, parameters: { type: 'object', properties, required } },
});

const TOOLS = [
  fn('look'),
  fn('click', { index: { type: 'integer' } }, ['index']),
  fn('type', { index: { type: 'integer' }, text: { type: 'string' } }, ['index', 'text']),
  fn('finish', { summary: { type: 'string' } }),
];

describe('the catalogue is audited before any model is blamed for it', () => {
  it('finds nothing wrong with a clean catalogue', () => {
    const a = auditCatalogue(TOOLS);
    expect(a.count).toBe(4);
    expect(a.problems).toEqual([]);
  });

  it('catches a duplicate name — the defect that is actually in the live catalogue', () => {
    /*
     * `download_file` is declared twice in agent.js, at 419 and 457, with different descriptions and
     * different parameters. A model shown two tools with one name has no way to choose, a role
     * listing it gets both, and every recorded call to it is ambiguous evidence — which matters,
     * because those calls are training data.
     */
    const dupes = [...TOOLS, fn('click', { url: { type: 'string' } })];
    const a = auditCatalogue(dupes);
    expect(a.count).toBe(4);
    expect(a.problems).toHaveLength(1);
    expect(a.problems[0]).toMatchObject({ kind: 'duplicate', name: 'click' });
  });

  it('catches a tool that requires an argument it never declares', () => {
    const a = auditCatalogue([fn('click', {}, ['index'])]);
    expect(a.problems.map((p) => p.kind)).toContain('required-missing');
  });

  it('catches a nameless or undescribed tool', () => {
    const a = auditCatalogue([
      { type: 'function', function: { name: '', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'x', description: '  ', parameters: { type: 'object' } } },
    ]);
    expect(a.problems.map((p) => p.kind)).toEqual(expect.arrayContaining(['nameless', 'undescribed']));
  });

  it('keeps the first declaration of a duplicate, as the running code already does', () => {
    expect(toolNames([...TOOLS, fn('look', { x: {} })])).toEqual(['look', 'click', 'type', 'finish']);
  });
});

describe('the JSON Schema, for a provider that takes one', () => {
  it('pins the tool name to the list and nothing else', () => {
    const s = schemaFor(TOOLS);
    expect(s.properties.tool.enum).toEqual(['look', 'click', 'type', 'finish']);
    expect(s.required).toEqual(['tool']);
    expect(s.additionalProperties).toBe(false);
  });

  it('leaves args permissive on purpose', () => {
    /* The exact schema would be a union of per-tool shapes, and support for that varies by provider
       and version. A schema the server silently declines leaves you believing you are constrained
       when you are not — so the schema guarantees what every provider enforces, and the validator
       checks the arguments where a rejection is visible. */
    expect(schemaFor(TOOLS).properties.args).toEqual({ type: 'object' });
  });
});

describe('the GBNF grammar, for llama.cpp on a device', () => {
  it('admits every tool name and requires the two keys', () => {
    const g = gbnfFor(TOOLS);
    expect(g).toMatch(/^root\s+::=/m);
    expect(g).toMatch(/\\"tool\\"/);
    expect(g).toMatch(/\\"args\\"/);
    for (const n of ['look', 'click', 'type', 'finish']) expect(g).toContain(`\\"${n}\\"`);
  });

  it('covers every value kind an argument can be', () => {
    const g = gbnfFor(TOOLS);
    for (const rule of ['object', 'array', 'string', 'number', 'char', 'escape', 'hex', 'ws']) {
      expect(g).toMatch(new RegExp(`^${rule}\\s+::=`, 'm'));
    }
  });

  it('avoids {m,n} repetition, so it parses on older builds too', () => {
    expect(gbnfFor(TOOLS)).not.toMatch(/\{\d+(,\d+)?\}/);
  });

  it('refuses to produce a grammar with no tools, rather than one that admits nothing', () => {
    expect(() => gbnfFor([])).toThrow(/at least one tool/);
  });
});

describe('the validator separates untidy from unusable', () => {
  it('accepts a clean call', () => {
    const r = validateCall('{"tool":"click","args":{"index":3}}', TOOLS);
    expect(r).toMatchObject({ ok: true, tool: 'click' });
    expect(r.errors).toEqual([]);
  });

  it('accepts a call wrapped in prose, and says so', () => {
    /* The classic small-model failure: the call is perfectly good and a strict parser breaks on it. */
    const r = validateCall('Sure! Here you go:\n{"tool":"look","args":{}}\nHope that helps.', TOOLS);
    expect(r.ok).toBe(true);
    expect(r.errors).toContain('there was text around the JSON');
  });

  it('accepts the tool under "name" and arguments under "arguments", and counts both', () => {
    const r = validateCall('{"name":"click","arguments":{"index":1}}', TOOLS);
    expect(r.ok).toBe(true);
    expect(r.errors.join(' ')).toMatch(/under "name"/);
    expect(r.errors.join(' ')).toMatch(/under "arguments"/);
  });

  it('accepts arguments that arrived as a string of JSON', () => {
    const r = validateCall('{"tool":"click","args":"{\\"index\\":2}"}', TOOLS);
    expect(r.ok).toBe(true);
    expect(r.args.index).toBe(2);
    expect(r.errors.join(' ')).toMatch(/string of JSON/);
  });

  it('REFUSES a tool that does not exist', () => {
    const r = validateCall('{"tool":"teleport","args":{}}', TOOLS);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/not a tool that exists/);
  });

  it('REFUSES a call missing something required — that one cannot be run at all', () => {
    const r = validateCall('{"tool":"type","args":{"index":2}}', TOOLS);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['text']);
  });

  it('treats an empty required value as missing, because it is', () => {
    expect(validateCall('{"tool":"click","args":{"index":null}}', TOOLS).ok).toBe(false);
    expect(validateCall('{"tool":"type","args":{"index":1,"text":""}}', TOOLS).missing).toEqual(['text']);
  });

  it('notes an undeclared argument without calling the call unusable', () => {
    /* Untidy and harmless. Conflating it with a missing field would make the malformed rate
       meaningless as a baseline. */
    const r = validateCall('{"tool":"click","args":{"index":1,"colour":"red"}}', TOOLS);
    expect(r.ok).toBe(true);
    expect(r.unknownArgs).toEqual(['colour']);
  });

  it('reports every problem, not the first', () => {
    const r = validateCall('here: {"name":"type","arguments":{"index":1}}', TOOLS);
    expect(r.errors.length).toBeGreaterThan(2);
  });

  it('handles a reply with no JSON in it at all', () => {
    const r = validateCall('I am not sure what to do next.', TOOLS);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/no JSON object/);
    expect(r.strayText).toMatch(/not sure/);
  });

  it('handles JSON that does not parse', () => {
    expect(validateCall('{"tool":"look",}', TOOLS).ok).toBe(false);
  });

  it('accepts an already-parsed object too', () => {
    expect(validateCall({ tool: 'look', args: {} }, TOOLS).ok).toBe(true);
  });
});

describe('finding the JSON in a reply', () => {
  it('ignores braces inside strings', () => {
    const s = 'x {"tool":"type","args":{"text":"a } brace and a \\" quote"}} y';
    const found = firstJsonObject(s);
    expect(JSON.parse(found).args.text).toContain('}');
  });

  it('returns null when there is none, and when it never closes', () => {
    expect(firstJsonObject('no object here')).toBeNull();
    expect(firstJsonObject('{"tool":"look"')).toBeNull();
  });
});

/*
 * THE LIVE CATALOGUE, CHECKED IN CI.
 *
 * `download_file` was declared twice for months and nothing noticed, because nothing ever looked at
 * the catalogue as a whole. Worse than the duplicate name: the two declarations had two different
 * handlers, tools/index.js merges `files` after `images` so the later one won, and every careful
 * thing in the losing one — relative-url resolution, an in-page fetch with the session's cookies,
 * a real filename from content-disposition, and a guard that refuses a gated download instead of
 * storing a paywall page as a song — has been unreachable.
 *
 * This reads the real TOOLS array out of agent.js and runs the audit over it. The next duplicate
 * fails here, immediately, instead of hiding until somebody generates a grammar out of it.
 */
import { readFileSync } from 'node:fs';

describe('the live tool catalogue', () => {
  const liveTools = () => {
    const src = readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');
    const m = src.match(/const TOOLS = (\[[\s\S]*?\n\]);/);
    if (!m) throw new Error('could not find the TOOLS array in agent.js');
    // eslint-disable-next-line no-eval
    return eval(m[1]);
  };

  it('declares no tool name twice', () => {
    const a = auditCatalogue(liveTools());
    const dupes = a.problems.filter((p) => p.kind === 'duplicate');
    expect(dupes, dupes.map((d) => d.detail).join('; ')).toEqual([]);
  });

  it('has no other catalogue problems either', () => {
    const a = auditCatalogue(liveTools());
    expect(a.problems, a.problems.map((p) => p.detail).join('; ')).toEqual([]);
  });

  it('still has both download tools, under their own names', () => {
    /* One takes what a page GENERATED and hands back an asset id; the other follows a LINK. They
       are different jobs and they were sharing one name. */
    const names = toolNames(liveTools());
    expect(names).toContain('download_file');
    expect(names).toContain('download_link');
  });

  it('produces a usable grammar and schema from it', () => {
    const tools = liveTools();
    expect(schemaFor(tools).properties.tool.enum.length).toBe(toolNames(tools).length);
    expect(gbnfFor(tools)).toMatch(/^root\s+::=/m);
  });

  it('every declared tool has a handler, or is still in the agent switch', () => {
    /*
     * The other half of the same class of bug: a name in the catalogue with nothing behind it is a
     * tool the model will confidently call and never reach. Checked against the extracted registry
     * plus the switch that agent.js still holds, so this passes while the split is incremental and
     * starts failing the day a name is added with neither.
     */
    const registry = require('../src/tools/index.js').REGISTRY;
    const src = readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');
    const orphans = toolNames(liveTools()).filter((n) => {
      if (Object.prototype.hasOwnProperty.call(registry, n)) return false;
      return !new RegExp(`case '${n}'`).test(src);
    });
    expect(orphans, `no handler for: ${orphans.join(', ')}`).toEqual([]);
  });
});
