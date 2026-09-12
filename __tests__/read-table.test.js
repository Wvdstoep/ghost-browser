/**
 * READING A TABLE AS DATA — the tool that stops numbers being retyped out of prose.
 *
 * `read` hands the page back as text and the model picks the figures out of it. For a paragraph that
 * is fine. For a table of numbers it is the one step in the chain that can be silently wrong: a
 * column off by one, a separator read as a decimal point, a wrapped row skipped. Nothing downstream
 * can tell, because a wrong impression count looks exactly like a right one.
 *
 * It is also the slow way. Reading a Search Console report by eye was look → read → scroll → read,
 * and that loop is most of the difference between a four-step walk and the 166-step one we measured.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const perceive = read('../src/tools/perceive.js');
const agent = read('../src/agent.js');
const roles = read('../src/roles.js');

describe('the table reader returns cells, not a summary', () => {
  it('it finds a plain table and an ARIA grid, which is what component libraries render', () => {
    expect(perceive).toMatch(/document\.querySelectorAll\('table,\[role="table"\],\[role="grid"\],\[role="treegrid"\]'\)/);
    expect(perceive).toMatch(/\[role="cell"\],\[role="gridcell"\]/);
  });

  /* A nested table's cells belong to the nested table, or every row reads as one enormous row. */
  it('and a nested table does not swallow its parent', () => {
    expect(perceive).toMatch(/cs\.filter\(\(c\) => c\.closest\('\[role="row"\],tr'\) === row\)/);
    expect(perceive).toMatch(/rs\.filter\(\(r\) => r\.closest\('table,\[role="table"\],\[role="grid"\],\[role="treegrid"\]'\) === t\)/);
  });

  /* A header alone is not a table worth returning, and an invisible one is not on the page. */
  it('an empty or hidden table is not offered', () => {
    expect(perceive).toMatch(/if \(rows\.length < 2\) continue;/);
    expect(perceive).toMatch(/st\.display !== 'none' && st\.visibility !== 'hidden' && Number\(st\.opacity\) !== 0/);
  });

  it('the cells are handed over verbatim, with the arithmetic forbidden', () => {
    expect(perceive).toMatch(/never round, convert or add them up/);
  });

  /* Frames, for the same reason `read` walks them: a dashboard's content often lives in one. */
  it('and a table inside a frame is still found', () => {
    expect(perceive).toMatch(/for \(const fr of ctx\.page\(\)\.frames\(\)\)/);
  });

  it('an empty page says so, and says what to do instead of clicking about', () => {
    expect(perceive).toMatch(/There is no table on this page/);
    expect(perceive).toMatch(/open the right one rather than clicking about/);
  });
});

describe('every role that can read a page can read a table', () => {
  it('it is one of the hands, and it changes nothing', () => {
    expect(roles).toMatch(/const HANDS = \['look', 'read', 'read_table',/);
    expect(agent).toMatch(/const OBSERVE_ONLY = new Set\(\['look', 'read', 'read_table',/);
  });

  it('the model is told to prefer it for figures', () => {
    expect(agent).toMatch(/name: 'read_table'/);
    expect(agent).toMatch(/instead of read: the figures come back verbatim rather than retyped/);
  });

  /* The reader that measured the cost of not having it. */
  it('and the search console reader is told to use it rather than read', () => {
    const role = roles.slice(roles.indexOf("'reach.search': {"), roles.indexOf("'gsc.audit': {"));
    expect(role).toMatch(/USE read_table, NOT read/);
    expect(role).toMatch(/Never round them, never convert them, never add them up/);
    /* `read` keeps one honest job: saying the property has no data yet. */
    expect(role).toMatch(/Plain read is for when you need to explain something the table does not show/);
  });
});
