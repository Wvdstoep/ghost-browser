/**
 * Sending each lead onward.
 *
 * This browser is good at the one thing no API can do: read what people actually wrote, on sites
 * its owner is signed in to. It is deliberately bad at everything after that — scoring, finding an
 * address, drafting an approach, remembering who was contacted on Tuesday. LeadFlow already does
 * all of it, so a lead leaves the moment it is found instead of piling up in a file somebody has
 * to export.
 *
 * The two things worth pinning: WHERE it is allowed to send (a URL that arrives in a page fragment
 * and carries a token), and that a failure at the far end never costs a run that is often forty
 * minutes deep behind a login it took an afternoon to get.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeSink, checkTarget, shape } from '../src/sink.js';

describe('where a lead may be sent', () => {
  it('accepts a public https endpoint', () => {
    expect(checkTarget('https://leadflows.sale/api/leads/browser')).toBe('https://leadflows.sale/api/leads/browser');
  });

  it('trims a trailing slash, so the path is built the same way every time', () => {
    expect(checkTarget('https://leadflows.sale/api/leads/browser/')).toBe('https://leadflows.sale/api/leads/browser');
  });

  /* This URL arrives in a page fragment and the server POSTs a bearer token to it. Plain http
     would put that token on the wire in clear. */
  it('refuses plain http', () => {
    expect(() => checkTarget('http://leadflows.sale/api')).toThrow(/https/);
  });

  /* Without this the server would POST whatever a lead contains to any address someone could name
     — the same reason navigation is guarded, and a stronger one, because this carries a credential. */
  it.each([
    'https://localhost/api', 'https://127.0.0.1/api', 'https://10.0.0.5/api',
    'https://192.168.1.10/api', 'https://172.16.4.4/api', 'https://169.254.169.254/api',
    'https://registry.default.svc.cluster.local/api',
  ])('refuses %s', (u) => expect(() => checkTarget(u)).toThrow(/private network/));

  it('refuses something that is not a URL at all', () => {
    expect(() => checkTarget('leadflows.sale')).toThrow(/not a URL/);
  });

  it('is not built at all without somewhere to send to', () => {
    expect(makeSink({})).toBeNull();
    expect(makeSink({ api: 'https://x.test/api', searchId: 1 })).toBeNull();   // no token
  });
});

describe('what leaves this browser', () => {
  it('sends the lead and nothing that identifies the browser', () => {
    const out = shape({ name: 'Jan', why: 'asked for a roofer', quote: 'wie kent een dakdekker?',
                        url: 'https://fb/p/1', sessionId: 's-secret', profile: 'carla-test-facebook',
                        at: '2026-08-25T10:00:00Z' });
    expect(out).toMatchObject({ name: 'Jan', why: 'asked for a roofer', url: 'https://fb/p/1' });
    expect(out.sessionId).toBeUndefined();
    expect(out.profile).toBeUndefined();
  });
});

describe('talking to the far end', () => {
  const API = 'https://leadflows.sale/api/leads/browser';
  let calls;
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 7, created: true, total: 1 }) };
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts one lead to the search it was given, with the token', async () => {
    const sink = makeSink({ api: API, searchId: 42, token: 'tok' });
    const r = await sink.send({ name: 'Jan', why: 'roof' });
    expect(r).toMatchObject({ created: true });
    expect(calls[0].url).toBe(API + '/42/lead');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].opts.body).name).toBe('Jan');
  });

  /* A search left saying "processing" forever is worse than one that says it failed, because
     nobody watching it knows whether to keep waiting. */
  it('closes the search when the run ends, and says whether it went wrong', async () => {
    const sink = makeSink({ api: API, searchId: 42, token: 'tok' });
    await sink.close(true);
    expect(calls[0].url).toBe(API + '/42/done');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ failed: true });
  });

  it('reports the far end’s own words rather than a status code', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401,
      text: async () => JSON.stringify({ error: 'that ingest token is expired or invalid' }) }));
    const sink = makeSink({ api: API, searchId: 42, token: 'stale' });
    await expect(sink.send({ name: 'Jan' })).rejects.toThrow(/expired or invalid/);
  });

  it('survives a far end that answers with an error page instead of JSON', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' }));
    const sink = makeSink({ api: API, searchId: 42, token: 'tok' });
    await expect(sink.send({ name: 'Jan' })).rejects.toThrow(/502/);
  });
});
