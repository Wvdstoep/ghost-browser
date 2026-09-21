// A flow step that costs no tokens.
//
// Every reading step used to be an `agent` step, and the model is what a run costs: one Workshop
// build spent 2,972,801 tokens over 90 calls and produced no flow, and four such builds exhausted a
// weekly allowance — after which the master cannot think at all. The builder itself reached the right
// conclusion twice before it died: "bypass the agent role entirely and use a fetch_data node to GET
// the page HTML, then a simple agent step to parse titles+budgets". There was no such node.
//
// So `fetch` and `extract` carry no model. A listing scout becomes trigger → fetch → extract → verify:
// nothing per run, nothing to drift, and dry-runs during the build that are free as well.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import workflows from '../src/workflows.js';

const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');

const FEED = JSON.stringify({ data: { children: [
  { title: 'Need a Stripe checkout fixed', budget: '300 PLN' },
  { title: 'Small Django dashboard', budget: '1200 PLN' },
] } });

const LISTING = `
  <li class="project"><a href="/p/1">Sklep internetowy na Shopify</a><span class="budget">2 500 zł</span></li>
  <li class="project"><a href="/p/2">Poprawki na stronie WordPress</a><span class="budget">400 zł</span></li>
  <li class="project"><a href="/p/3">Integracja API Allegro</a><span class="budget">3 000 zł</span></li>
`;

const flow = (nodes, edges) => ({ id: 'scout', name: 'scout', nodes, edges });
const drive = (wf, over = {}) => workflows.drive(wf, {
  runAgent: async () => { throw new Error('a data flow must not need an agent step'); },
  runVerify: async () => ({ found: true }),
  persist: () => {}, runId: 'r1', now: () => 't', ...over,
});

describe('the engine knows two steps that need no model', () => {
  it('offers fetch and extract, and every one of them is dispatched', () => {
    expect(workflows.NODE_TYPES).toContain('fetch');
    expect(workflows.NODE_TYPES).toContain('extract');
    const src = readFileSync(fileURLToPath(new URL('../src/workflows.js', import.meta.url)), 'utf8');
    expect(src).toMatch(/node\.type === 'fetch'/);
    expect(src).toMatch(/node\.type === 'extract'/);
  });

  it('refuses one that cannot work, in plain language', () => {
    const errs = workflows.validate(flow(
      [{ id: 't', type: 'trigger' }, { id: 'f', type: 'fetch' }, { id: 'x', type: 'extract' }], []));
    expect(errs.join(' | ')).toMatch(/the fetch step "f" needs a url to get/);
    expect(errs.join(' | ')).toMatch(/needs the text to read/);
    expect(errs.join(' | ')).toMatch(/needs a pattern/);
  });

  it('refuses a pattern that is not a valid expression, rather than failing mid-run', () => {
    const errs = workflows.validate(flow(
      [{ id: 't', type: 'trigger' }, { id: 'x', type: 'extract', inKey: 'f', pattern: '([unclosed' }], []));
    expect(errs.join(' ')).toMatch(/pattern that is not a valid expression/);
  });

  it('stores what each kind actually needs and nothing else', () => {
    const saved = workflows.validate(flow([{ id: 't', type: 'trigger' },
      { id: 'f', type: 'fetch', url: 'https://x.test/feed.json', pick: 'data.children', outKey: 'feed' },
      { id: 'x', type: 'extract', inKey: 'feed', pattern: '<a>(?<title>[^<]+)</a>', flags: 'gis!!', limit: 9999, outKey: 'rows' }],
    [{ from: 't', to: 'f' }, { from: 'f', to: 'x' }]));
    expect(saved).toEqual([]);
  });
});

describe('a listing read for nothing', () => {
  it('fetches a JSON feed in the session, picks a subtree, and extracts rows with named fields', async () => {
    const runFetch = vi.fn(async ({ url, pick }) => {
      expect(url).toBe('https://useme.test/api/jobs.json');
      expect(pick).toBe('data.children');
      return { status: 200, shape: 'json at data.children', body: JSON.stringify(JSON.parse(FEED).data.children, null, 1) };
    });
    const run = await drive(flow([
      { id: 't', type: 'trigger' },
      { id: 'f', type: 'fetch', url: 'https://useme.test/api/jobs.json', pick: 'data.children', outKey: 'feed' },
      { id: 'x', type: 'extract', inKey: 'feed', pattern: '"title": "(?<title>[^"]+)",\\s*"budget": "(?<budget>[^"]+)"', flags: 'gi', limit: 50, outKey: 'rows' },
    ], [{ from: 't', to: 'f' }, { from: 'f', to: 'x' }]), { runFetch });

    expect(run.status).toBe('done');
    expect(runFetch).toHaveBeenCalledTimes(1);
    const x = run.steps.find((s) => s.node_id === 'x');
    expect(x.output.count).toBe(2);
    expect(x.output.rows[0]).toEqual({ title: 'Need a Stripe checkout fixed', budget: '300 PLN' });
    expect(x.output.rows[1].budget).toBe('1200 PLN');
  });

  it('reads an HTML listing with one pattern, and honours the cap', async () => {
    const runFetch = async () => ({ status: 200, shape: 'text/html', body: LISTING });
    const run = await drive(flow([
      { id: 't', type: 'trigger' },
      { id: 'f', type: 'fetch', url: 'https://useme.test/pl/projects/', pick: '', outKey: 'page' },
      { id: 'x', type: 'extract', inKey: 'page', pattern: 'href="(?<url>[^"]+)"[^>]*>(?<title>[^<]+)</a><span class="budget">(?<budget>[^<]+)</span>', flags: 'gi', limit: 2, outKey: 'rows' },
    ], [{ from: 't', to: 'f' }, { from: 'f', to: 'x' }]), { runFetch });

    const x = run.steps.find((s) => s.node_id === 'x');
    expect(x.output.count).toBe(2);                                  // the cap, not all three
    expect(x.output.rows[0]).toMatchObject({ url: '/p/1', title: 'Sklep internetowy na Shopify', budget: '2 500 zł' });
  });

  it('a pattern with no named groups returns the first group, or the whole match', async () => {
    const runFetch = async () => ({ status: 200, shape: 'text/html', body: LISTING });
    const run = await drive(flow([
      { id: 't', type: 'trigger' },
      { id: 'f', type: 'fetch', url: 'https://x.test/', pick: '', outKey: 'page' },
      { id: 'x', type: 'extract', inKey: 'page', pattern: '<a href="([^"]+)"', flags: 'gi', limit: 50, outKey: 'rows' },
    ], [{ from: 't', to: 'f' }, { from: 'f', to: 'x' }]), { runFetch });
    expect(run.steps.find((s) => s.node_id === 'x').output.rows).toEqual(['/p/1', '/p/2', '/p/3']);
  });

  it('the body is carried in the context but NOT written into the run journal', async () => {
    const big = 'x'.repeat(200000);
    const runFetch = async () => ({ status: 200, shape: 'text/plain', body: big });
    const run = await drive(flow([
      { id: 't', type: 'trigger' },
      { id: 'f', type: 'fetch', url: 'https://x.test/', pick: '', outKey: 'page' },
      { id: 'x', type: 'extract', inKey: 'page', pattern: '(x{10})', flags: 'g', limit: 3, outKey: 'rows' },
    ], [{ from: 't', to: 'f' }, { from: 'f', to: 'x' }]), { runFetch });

    const f = run.steps.find((s) => s.node_id === 'f');
    expect(f.output).toEqual({ url: 'https://x.test/', status: 200, shape: 'text/plain', chars: 200000 });
    expect(JSON.stringify(f.output)).not.toContain('xxxxxxxxxx');    // a run record is read by a person
    expect(run.steps.find((s) => s.node_id === 'x').output.count).toBe(3);
  });
});

describe('when it cannot be done, it says so instead of guessing', () => {
  it('a 4xx fails the step with the status, and stops the run', async () => {
    const runFetch = async () => ({ status: 403, shape: 'text/html', body: 'Forbidden' });
    const run = await drive(flow([
      { id: 't', type: 'trigger' },
      { id: 'f', type: 'fetch', url: 'https://x.test/', pick: '', outKey: 'page' },
    ], [{ from: 't', to: 'f' }]), { runFetch });
    expect(run.status).toBe('error');
    expect(run.steps.find((s) => s.node_id === 'f').error).toMatch(/answered 403/);
  });

  it('a url that is not an address names the fix', async () => {
    const run = await drive(flow([
      { id: 't', type: 'trigger' },
      { id: 'f', type: 'fetch', url: '{{nothing.here}}', pick: '', outKey: 'page' },
    ], [{ from: 't', to: 'f' }]), { runFetch: async () => ({ status: 200, body: '' }) });
    expect(run.steps.find((s) => s.node_id === 'f').error).toMatch(/not an http\(s\) address/);
  });

  it('a browser with no fetch step says that, rather than throwing something opaque', async () => {
    const run = await drive(flow([
      { id: 't', type: 'trigger' },
      { id: 'f', type: 'fetch', url: 'https://x.test/', pick: '', outKey: 'page' },
    ], [{ from: 't', to: 'f' }]), { runFetch: null });
    expect(run.steps.find((s) => s.node_id === 'f').error).toMatch(/cannot run a fetch step/);
  });
});

describe('every door a flow comes through gets the same steps', () => {
  it('every door that drives a flow drives it with fetch', () => {
    // A SCHEDULED flow used to be driven with runAgent alone, so one with a verify step died on
    // "this browser cannot run a verify step" — no nightly automation could ever prove itself.
    // Seven doors: the run route, the operator's run_flow tool and its runFlow context, the watcher
    // follow-up routing, the scheduler, the boot recovery, and the Search Console pass (which drives
    // its own flow so it can read the findings off the job afterwards and file them to Pulse).
    expect((serverSrc.match(/runFetch: makeRunFetch\(/g) || []).length).toBe(7);
    expect(serverSrc).toMatch(/function makeRunFetch\(client\) \{/);
    expect(serverSrc).toMatch(/The same hands as a hand-started run/);
  });

  it('it GETs in the session and never anything else', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('function makeRunFetch'), serverSrc.indexOf('function makeRunAgent'));
    expect(fn).toMatch(/s\.context && s\.context\.request/);
    expect(fn).toMatch(/rq\.get\(String\(url\), \{ timeout: 30000, failOnStatusCode: false \}\)/);
    expect(fn).not.toMatch(/rq\.(post|put|patch|delete)\(/);
    // a throwaway session is closed; a named profile — where the login lives — is kept
    expect(fn).toMatch(/if \(!want\) \{ try \{ await pool\.close\(s\.id, 'fetch step finished'\)/);
    // a stated path that does not exist is a defect, not a shrug
    expect(fn).toMatch(/does not lead anywhere in that JSON/);
  });
});
