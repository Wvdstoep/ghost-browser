/*
 * FILING WHAT THE BROWSER READ, WITHOUT A COURIER.
 *
 * The old chain was: the browser reads Search Console and stores findings on the job, the master
 * polls the job and forwards them to Pulse. The middle step was the single point of failure — a
 * locked-out walk spent the master's whole daily audit slot, and nothing reached Pulse for eleven
 * days while the screen showed a 2026-09-10 reading as if it were current.
 *
 * So the browser files directly. These tests pin the two things that decide whether that is safe:
 *
 *   NOTHING THROWS UPWARD. A watcher's job is to read the console and show what it read. If Pulse is
 *   unconnected, unreachable, or refuses the key, the walk still happened and the findings are still
 *   worth showing. Every call answers with what happened rather than failing the pass.
 *
 *   "FILED" IS A NUMBER THAT MEANS SOMETHING. Pulse silently skips a finding with no kind or no
 *   label, so sending one and reporting success would make the count a lie. They are counted here.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pulse = require('../src/pulse');

const WIRED = { PULSE_OPS_URL: 'http://pulse:3000', PULSE_REPORTER_KEY: 'k_reporter' };
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

describe('is Pulse connected to this browser at all', () => {
  it('needs both halves — a URL with no key is a 401 waiting to happen', () => {
    expect(pulse.wired(WIRED)).toBe(true);
    expect(pulse.wired({ PULSE_OPS_URL: 'http://pulse:3000' })).toBe(false);
    expect(pulse.wired({ PULSE_REPORTER_KEY: 'k' })).toBe(false);
    expect(pulse.wired({})).toBe(false);
  });

  it('says WHICH half is missing, rather than a silent false', () => {
    expect(pulse.why({})).toMatch(/not connected/i);
    expect(pulse.why({ PULSE_REPORTER_KEY: 'k' })).toMatch(/no address/i);
    expect(pulse.why({ PULSE_OPS_URL: 'http://pulse:3000' })).toMatch(/no reporter key/i);
    expect(pulse.why(WIRED)).toBe('');
  });

  /*
   * PULSE_URL is the APP door's name and on this cluster points at a service that does not resolve,
   * so the operator URL is preferred and PULSE_URL is only ever a last resort.
   */
  it('prefers the operator address over the app one', () => {
    expect(pulse.opsUrl({ PULSE_OPS_URL: 'http://pulse:3000', PULSE_URL: 'http://broken:3000' })).toBe('http://pulse:3000');
    expect(pulse.opsUrl({ PULSE_URL: 'http://fallback:3000' })).toBe('http://fallback:3000');
  });

  it('never reads the app key as a credential', () => {
    expect(pulse.opsKey({ PULSE_APP_KEY: 'pls_app' })).toBe('');
    expect(pulse.wired({ PULSE_OPS_URL: 'http://pulse:3000', PULSE_APP_KEY: 'pls_app' })).toBe(false);
  });

  it('tolerates a trailing slash on the address', () => {
    expect(pulse.opsUrl({ PULSE_OPS_URL: 'http://pulse:3000/' })).toBe('http://pulse:3000');
  });
});

describe('the rows Pulse will actually store', () => {
  it('drops what Pulse would drop, so the count is honest', () => {
    const rows = pulse.rowsFor([
      { kind: 'indexing', label: 'not indexed', value: '12' },
      { kind: 'manual_action', label: '' },            // no label: Pulse skips it
      { label: 'orphan', value: 'x' },                 // no kind: Pulse skips it
      null,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'indexing', label: 'not indexed', value: '12' });
  });

  it('keeps every kind the console actually has', () => {
    for (const k of ['message', 'indexing', 'sitemap', 'manual_action', 'vitals']) {
      expect(pulse.rowsFor([{ kind: k, label: 'x' }])[0].kind).toBe(k);
    }
  });

  /* An unknown kind is data we still want, filed under the one that means "about the pages". */
  it('files an unknown kind rather than losing the finding', () => {
    expect(pulse.rowsFor([{ kind: 'weather', label: 'x' }])[0].kind).toBe('indexing');
  });

  it('clamps to the lengths Pulse stores, instead of being truncated silently there', () => {
    const r = pulse.rowsFor([{ kind: 'indexing', label: 'L'.repeat(400), value: 'V'.repeat(400), detail: 'D'.repeat(900) }])[0];
    expect(r.label).toHaveLength(200);
    expect(r.value).toHaveLength(200);
    expect(r.detail).toHaveLength(600);
  });

  it('turns a missing value into an empty string, never the word undefined', () => {
    expect(pulse.rowsFor([{ kind: 'sitemap', label: 'sitemap.xml' }])[0].value).toBe('');
  });
});

describe('filing, and every way it can fail without failing the pass', () => {
  it('files and reports how many Pulse saved', async () => {
    const r = await pulse.recordGscHealth('my-app.engineer',
      [{ kind: 'indexing', label: 'indexed', value: '4' }],
      { env: WIRED, fetch: ok({ app: 'my-app.engineer', day: '2026-09-21', saved: 1 }) });
    expect(r).toMatchObject({ ok: true, filed: 1, skipped: 0 });
  });

  it('counts what it skipped, so "filed 1" is not mistaken for "read 2"', async () => {
    const r = await pulse.recordGscHealth('my-app.engineer',
      [{ kind: 'indexing', label: 'indexed', value: '4' }, { kind: 'indexing' }],
      { env: WIRED, fetch: ok({ saved: 1 }) });
    expect(r).toMatchObject({ filed: 1, skipped: 1 });
  });

  it('does not throw when Pulse was never connected', async () => {
    const r = await pulse.recordGscHealth('my-app.engineer', [{ kind: 'indexing', label: 'indexed' }], { env: {} });
    expect(r.ok).toBe(false);
    expect(r.wired).toBe(false);
    expect(r.why).toMatch(/not connected/i);
  });

  it('does not throw when Pulse is unreachable, and says so', async () => {
    const r = await pulse.recordGscHealth('my-app.engineer', [{ kind: 'indexing', label: 'indexed' }], {
      env: WIRED, fetch: async () => { throw new Error('getaddrinfo ENOTFOUND pulse'); },
    });
    expect(r.ok).toBe(false);
    expect(r.wired).toBe(true);
    expect(r.why).toMatch(/could not reach Pulse/);
  });

  it('does not throw when Pulse refuses the key, and keeps its words', async () => {
    const r = await pulse.recordGscHealth('my-app.engineer', [{ kind: 'indexing', label: 'indexed' }], {
      env: WIRED,
      fetch: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: 'an app key only reports events' }) }),
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.why).toMatch(/an app key only reports events/);
  });

  it('does not call Pulse at all when there is nothing worth filing', async () => {
    let called = 0;
    const r = await pulse.recordGscHealth('my-app.engineer', [{ kind: 'indexing' }], {
      env: WIRED, fetch: async () => { called += 1; return ok({})(); },
    });
    expect(called).toBe(0);
    expect(r).toMatchObject({ ok: false, filed: 0, skipped: 1 });
    expect(r.why).toMatch(/nothing worth filing/);
  });

  it('sends the day in the only format Pulse accepts', async () => {
    let sent = null;
    await pulse.recordGscHealth('my-app.engineer', [{ kind: 'indexing', label: 'indexed' }], {
      env: WIRED,
      fetch: async (url, init) => { sent = JSON.parse(init.body); return ok({ saved: 1 })(); },
    });
    expect(sent.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.app).toBe('my-app.engineer');
  });

  it('carries the reporter key as a bearer token, and the app key never', async () => {
    let hdr = null;
    await pulse.recordGscHealth('a', [{ kind: 'indexing', label: 'x' }], {
      env: { ...WIRED, PULSE_APP_KEY: 'pls_app' },
      fetch: async (url, init) => { hdr = init.headers.authorization; return ok({ saved: 1 })(); },
    });
    expect(hdr).toBe('Bearer k_reporter');
    expect(hdr).not.toMatch(/pls_app/);
  });
});

describe('is Pulse up to date — read back, never assumed', () => {
  it('reports the newest day Pulse actually holds', async () => {
    const r = await pulse.gscHealth('my-app.engineer', {
      env: WIRED,
      fetch: ok({ findings: [{ kind: 'indexing', label: 'indexed', day: '2026-09-10' }, { kind: 'sitemap', label: 's', day: '2026-09-21' }] }),
    });
    expect(r.ok).toBe(true);
    expect(r.latestDay).toBe('2026-09-21');
    expect(r.findings).toHaveLength(2);
  });

  it('says nothing rather than something when it cannot read', async () => {
    const r = await pulse.gscHealth('my-app.engineer', { env: {} });
    expect(r.ok).toBe(false);
    expect(r.latestDay).toBe(null);
    expect(r.findings).toEqual([]);
  });

  /* Eleven days of a stale reading shown as current is what this rule exists to prevent. */
  it('calls only today up to date', () => {
    const now = new Date('2026-09-21T18:00:00Z');
    expect(pulse.upToDate('2026-09-21', now)).toBe(true);
    expect(pulse.upToDate('2026-09-10', now)).toBe(false);
    expect(pulse.upToDate(null, now)).toBe(false);
    expect(pulse.upToDate('', now)).toBe(false);
  });
});
