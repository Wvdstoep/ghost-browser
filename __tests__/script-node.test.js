// A `script` STEP READS A RENDERED PAGE WITH NO MODEL.
//
// The meter counts requests. The proven useme scout's read step was told "open this page, run this
// exact script, return it verbatim" — two acts — and still averaged 14 model calls, because an agent
// looks, dismisses, re-looks, verifies and narrates around the act. Every run of the one flow that
// worked paid that. fetch could not take the job: useme answers a plain request with 403, so the page
// has to be rendered in the real, cookied browser.
//
// This step is fetch's sibling for exactly that case: open the page as the profile, clear a consent
// wall, run one read-only script in the page, hand back its value. The engine is pure — runScript is
// injected — so all of this is tested without a browser, the way fetch already is.
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-script-'));
process.env.PROFILE_DIR = TMP;
const wf = await import('../src/workflows.js');
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const ROLE_NAMES = ['general'];

const SCRIPT = "return [...document.querySelectorAll('article.job')].slice(0, 15).map(a => ({ title: a.querySelector('h3')?.innerText, budget: a.querySelector('.budget')?.innerText, url: a.querySelector('a')?.href }))";

const scoutFlow = (over = {}) => ({
  name: 'useme briefs, no model',
  nodes: [
    { id: 'start', type: 'trigger', trigger: { type: 'manual' } },
    { id: 'read', type: 'script', label: 'read the listing', url: 'https://useme.com/pl/jobs/', profile: 'useme', script: SCRIPT, outKey: 'briefs' },
    { id: 'check', type: 'verify', profile: 'useme', url: 'https://useme.com/pl/jobs/', text: 'PLN', outKey: 'check' },
  ],
  edges: [{ from: 'start', to: 'read' }, { from: 'read', to: 'check' }],
  ...over,
});

describe('the step is a real node kind', () => {
  it('is accepted, cleaned and capped like fetch', () => {
    expect(wf.NODE_TYPES).toContain('script');
    const saved = wf.save(scoutFlow(), ROLE_NAMES);
    const read = saved.nodes.find((n) => n.id === 'read');
    expect(read).toMatchObject({ type: 'script', url: 'https://useme.com/pl/jobs/', profile: 'useme', outKey: 'briefs' });
    expect(read.script).toBe(SCRIPT);
    // the same ceiling run_script has: a script is a snippet, not a program
    const long = wf.save(scoutFlow({ nodes: scoutFlow().nodes.map((n) => (n.type === 'script' ? { ...n, script: 'x'.repeat(9000) } : n)) }), ROLE_NAMES);
    expect(long.nodes.find((n) => n.id === 'read').script.length).toBe(8000);
  });

  it('refuses a step with no page or no script, in the builder\'s own words', () => {
    const noUrl = scoutFlow({ nodes: scoutFlow().nodes.map((n) => (n.type === 'script' ? { ...n, url: '' } : n)) });
    expect(() => wf.save(noUrl, ROLE_NAMES)).toThrow(/needs the url of the page to open/);
    const noScript = scoutFlow({ nodes: scoutFlow().nodes.map((n) => (n.type === 'script' ? { ...n, script: '' } : n)) });
    expect(() => wf.save(noScript, ROLE_NAMES)).toThrow(/needs the script to run in that page/);
  });
});

describe('driving it — zero model calls, the value becomes data for the next step', () => {
  const drive = async (runScript, extra = {}) => {
    const saved = wf.save(scoutFlow(), ROLE_NAMES);
    const runAgent = vi.fn();                      // must never be asked for anything
    const runVerify = vi.fn(async () => ({ found: true }));
    const run = await wf.drive(saved, { runAgent, runVerify, runScript, persist: () => {}, runId: 'r-' + Date.now(), ...extra });
    return { run, runAgent, runVerify };
  };

  it('opens the url as the profile, runs the script, and hands the value on under outKey', async () => {
    const briefs = [{ title: 'Sklep WooCommerce', budget: '2 500 PLN', url: 'https://useme.com/pl/jobs/1' }, { title: 'Landing', budget: '900 PLN', url: 'https://useme.com/pl/jobs/2' }];
    const runScript = vi.fn(async ({ node, url, script }) => {
      expect(url).toBe('https://useme.com/pl/jobs/');
      expect(node.profile).toBe('useme');
      expect(script).toBe(SCRIPT);
      return { value: briefs };
    });
    const { run, runAgent } = await drive(runScript);
    expect(runAgent).not.toHaveBeenCalled();                          // THE POINT: no model
    expect(runScript).toHaveBeenCalledTimes(1);
    const read = run.steps.find((s) => s.node_id === 'read');
    expect(read.status).toBe('done');
    expect(read.output).toMatchObject({ url: 'https://useme.com/pl/jobs/', kind: 'list', count: 2 });
    expect(read.output.preview).toContain('Sklep WooCommerce');
    expect(run.status).toBe('done');
    expect(run.steps.find((s) => s.node_id === 'check').output).toMatchObject({ found: true });
  });

  it('journals a preview, never the whole value — a run record is read by a person', async () => {
    const big = Array.from({ length: 300 }, (_, i) => ({ title: 'brief number ' + i, url: 'https://useme.com/pl/jobs/' + i }));
    const { run } = await drive(async () => ({ value: big }));
    const read = run.steps.find((s) => s.node_id === 'read');
    expect(read.output.count).toBe(300);
    expect(read.output.preview.length).toBeLessThanOrEqual(400);
    expect(read.output.chars).toBeGreaterThan(400);
    expect(JSON.stringify(read.output)).not.toContain('brief number 299');
  });

  it('a script that returns nothing is null, not an error', async () => {
    const { run } = await drive(async () => ({ value: null }));
    const read = run.steps.find((s) => s.node_id === 'read');
    expect(read.status).toBe('done');
    expect(read.output).toMatchObject({ kind: 'null' });
  });

  it('a page that will not open, or a script that throws, fails the step honestly', async () => {
    const { run } = await drive(async () => { throw new Error('could not open https://useme.com/pl/jobs/: net::ERR_NAME_NOT_RESOLVED'); });
    const read = run.steps.find((s) => s.node_id === 'read');
    expect(read.status).toBe('error');
    expect(read.error).toMatch(/could not open/);
    expect(run.status).not.toBe('done');
  });

  it('a templated url is filled from the run input, and a non-http one is refused before anything opens', async () => {
    const saved = wf.save(scoutFlow({ nodes: scoutFlow().nodes.map((n) => (n.type === 'script' ? { ...n, url: '{{input.page}}' } : n)) }), ROLE_NAMES);
    const seen = [];
    const runScript = vi.fn(async ({ url }) => { seen.push(url); return { value: [] }; });
    await wf.drive(saved, { runAgent: vi.fn(), runVerify: async () => ({ found: true }), runScript, input: { page: 'https://useme.com/pl/jobs/?page=2' }, persist: () => {}, runId: 'r-a' });
    expect(seen).toEqual(['https://useme.com/pl/jobs/?page=2']);
    const bad = await wf.drive(saved, { runAgent: vi.fn(), runVerify: async () => ({ found: true }), runScript, input: { page: '' }, persist: () => {}, runId: 'r-b' });
    expect(runScript).toHaveBeenCalledTimes(1);                      // not called for the empty url
    expect(bad.steps.find((s) => s.node_id === 'read').error).toMatch(/not an http\(s\) address/);
  });

  it('a browser without the driver says so instead of pretending', async () => {
    const { run } = await drive(null);
    expect(run.steps.find((s) => s.node_id === 'read').error).toMatch(/cannot run a script step/);
  });
});

describe('the refusal list refuses acts, not reads', () => {
  // The first zero-model run of the scout was refused as "navigation" because the pattern meant for
  // location.replace( matched String.replace( in a whitespace clean-up. A guard that refuses reading
  // is a guard builders route around, which is worse than no guard.
  it('String.replace and Object.assign are reads; location.assign, location.replace and location.href= are not', async () => {
    const { scriptRefusal } = await import('../src/agent.js');
    expect(scriptRefusal("return [...document.querySelectorAll('a')].map((a) => a.innerText.replace(/\\s+/g, ' '))")).toBeNull();
    expect(scriptRefusal('return Object.assign({}, window.__data)')).toBeNull();
    expect(scriptRefusal("location.replace('/login')")).toMatch(/may not navigate/);
    expect(scriptRefusal("window.location.assign('/x')")).toMatch(/may not navigate/);
    expect(scriptRefusal("location.href = '/x'")).toMatch(/may not navigate/);
    expect(scriptRefusal("window.open('/x')")).toMatch(/may not navigate/);
  });
});

describe('the browser side holds the script to the same line as run_script', () => {
  const fn = serverSrc.slice(serverSrc.indexOf('function makeRunScript'), serverSrc.indexOf('function makeRunAgent'));

  it('refuses through scriptRefusal before opening anything', () => {
    expect(fn).toMatch(/const \{ scriptRefusal \} = require\('\.\/agent'\);/);
    const refuse = fn.indexOf('scriptRefusal(script)');
    const open = fn.indexOf('s.page.goto');
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(open);
  });

  it('opens as the profile, clears a consent wall, wraps the snippet exactly as run_script does', () => {
    expect(fn).toMatch(/profiles\.safeName\(node\.profile\)/);
    expect(fn).toMatch(/dismissConsent\(s\.page\)/);
    expect(fn).toMatch(/\/\\breturn\\b\/\.test\(src\)/);
    expect(fn).toMatch(/\(async \(\) => \{ \$\{src\} \}\)\(\)/);
  });

  it('closes a throwaway session and keeps a named profile, like fetch and verify', () => {
    expect(fn).toMatch(/if \(!want\) \{ try \{ await pool\.close\(s\.id, 'script step finished'\); \}/);
  });

  it('is handed to BOTH drivers — the manual run and the scheduler — so a scheduled scout is free too', () => {
    // each driver call sits on one line; a brace-bounded match would stop inside makeRunAgent({...})
    const calls = serverSrc.match(/workflows\.drive\(wf, .*$/gm) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c).toMatch(/runScript: makeRunScript\(/);
  });
});
