/**
 * diagnostics — what the browser saw, and the redirect loop it exists to name.
 *
 * The run behind this: a freshly built app bounced from its landing page to /login over and over,
 * fast enough that the login form could not be filled in. The console said it in one line —
 * `GET /api/me 401 (Unauthorized)` — and the address bar looped. QA saw none of it, reported
 * "0 things to click" fifty times, and the fixer it fed spent 1.37M tokens on the wrong layer.
 */
import { describe, it, expect } from 'vitest';
import { attach, summarise, dump, loopOf, clear, smokeVerdict, platformFaultOf, MAX } from '../src/diagnostics.js';

const nav = (url) => ({ at: '10:00:00', url });
const session = (over = {}) => ({ diag: { console: [], errors: [], network: [], navigations: [], ...over } });

describe('loopOf — the pattern a person spots instantly', () => {
  it('names a bounce between two addresses', () => {
    const navs = [];
    for (let i = 0; i < 8; i++) { navs.push(nav('https://x.app/'), nav('https://x.app/login')); }
    const l = loopOf(navs);
    expect(l).toBeTruthy();
    expect(l.distinct).toBe(2);
    expect(l.times).toBeGreaterThanOrEqual(4);
  });
  it('ignores query strings, which differ on every bounce', () => {
    const navs = Array.from({ length: 10 }, (_, i) => nav(`https://x.app/login?r=${i}`));
    expect(loopOf(navs).url).toBe('https://x.app/login');
  });
  it('normal browsing is not a loop', () => {
    expect(loopOf([nav('/a'), nav('/b'), nav('/c'), nav('/d'), nav('/e'), nav('/f')])).toBe(null);
    expect(loopOf([nav('/a'), nav('/b')])).toBe(null);   // too few to judge
  });
});

describe('summarise — the sentence a person would say out loud', () => {
  it('leads with the loop and says every other symptom is downstream of it', () => {
    const navs = [];
    for (let i = 0; i < 8; i++) { navs.push(nav('https://x.app/'), nav('https://x.app/login')); }
    const s = summarise(session({ navigations: navs }));
    expect(s).toMatch(/^REDIRECT LOOP/);
    expect(s).toMatch(/Nothing can be clicked or filled in/);
    expect(s).toMatch(/this IS the bug/);
  });
  it('reports failed requests with their status and the most recent urls', () => {
    const s = summarise(session({ network: [
      { at: '10:00:01', status: 401, url: 'https://x.app/api/me' },
      { at: '10:00:02', status: 401, url: 'https://x.app/api/me' },
      { at: '10:00:03', status: 500, url: 'https://x.app/api/orders' },
    ] }));
    expect(s).toMatch(/FAILED REQUESTS/);
    expect(s).toMatch(/2× 401/);
    expect(s).toMatch(/api\/orders/);
  });
  it('surfaces uncaught errors and console errors separately', () => {
    const s = summarise(session({
      errors: [{ at: '10:00:00', text: 'TypeError: x is not a function' }],
      console: [{ at: '10:00:00', type: 'error', text: 'Failed to fetch' }],
    }));
    expect(s).toMatch(/UNCAUGHT ERRORS/);
    expect(s).toMatch(/TypeError/);
    expect(s).toMatch(/CONSOLE ERRORS/);
  });
  it('a healthy page says so plainly rather than inventing a problem', () => {
    expect(summarise(session())).toMatch(/Nothing abnormal/);
  });
});

describe('attach — safe to call, bounded, and per-page once', () => {
  // The real thing only records the MAIN frame's navigations — an iframe moving is not the page
  // moving — so the fake has to carry a real frame identity for that check to mean anything.
  const fakePage = () => {
    const handlers = {};
    const main = { url: () => 'https://x.app/' };
    return { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, _h: handlers, _main: main, mainFrame: () => main };
  };
  it('listens for the four signals that matter', () => {
    const p = fakePage(); const s = {};
    attach(p, s, { warn() {} });
    expect(Object.keys(p._h).sort()).toEqual(['console', 'framenavigated', 'pageerror', 'response']);
  });
  it('attaching twice does not double every entry', () => {
    const p = fakePage(); const s = {};
    attach(p, s, { warn() {} });
    attach(p, s, { warn() {} });
    expect(p._h.console).toHaveLength(1);
  });
  it('only errors and warnings are kept — info is noise, not signal', () => {
    const p = fakePage(); const s = {};
    attach(p, s, { warn() {} });
    const fire = (type, text) => p._h.console[0]({ type: () => type, text: () => text });
    fire('log', 'hello'); fire('info', 'hi'); fire('error', 'boom'); fire('warning', 'careful');
    expect(s.diag.console.map((c) => c.type)).toEqual(['error', 'warning']);
  });
  it('only failed responses are kept', () => {
    const p = fakePage(); const s = {};
    attach(p, s, { warn() {} });
    const res = (status, url) => p._h.response[0]({ status: () => status, url: () => url });
    res(200, '/ok'); res(304, '/cached'); res(401, '/api/me'); res(500, '/api/x');
    expect(s.diag.network.map((n) => n.status)).toEqual([401, 500]);
  });
  it('a bad page cannot crash the browser — a listener that throws is swallowed', () => {
    const p = fakePage(); const s = {};
    attach(p, s, { warn() {} });
    expect(() => p._h.console[0]({ type: () => { throw new Error('detached'); } })).not.toThrow();
    expect(() => p._h.response[0]({ status: () => { throw new Error('gone'); } })).not.toThrow();
  });
  it('the buffer is bounded, so a loop cannot exhaust memory', () => {
    const p = fakePage(); const s = {};
    attach(p, s, { warn() {} });
    let n = 0;
    p._main.url = () => `/x${n}`;
    for (; n < MAX + 50; n++) p._h.framenavigated[0](p._main);
    expect(s.diag.navigations.length).toBe(MAX);
  });
  it('an iframe navigating is not the page navigating', () => {
    const p = fakePage(); const s = {};
    attach(p, s, { warn() {} });
    p._h.framenavigated[0]({ url: () => 'https://ads.example/frame' });   // not the main frame
    expect(s.diag.navigations).toHaveLength(0);
  });
  it('clear() forgets, so one run never reads another run\'s page', () => {
    const s = session({ errors: [{ at: 'x', text: 'old' }] });
    clear(s);
    expect(dump(s).errors).toEqual([]);
  });
});

describe('smokeVerdict — can a stranger begin?', () => {
  // The check that would have caught the app the owner opened by hand: a landing page that bounced
  // to /login and back, forever. It passed "HTTP 200 on / and /api/health", went to QA, and cost a
  // full QA run plus a 1.37M-token fix attempt before a person found it in five seconds.
  const loop = { url: 'https://app.example/login', times: 9, distinct: 2, window: 20 };

  it('a healthy page produces no problems at all', () => {
    expect(smokeVerdict({ dump: { errors: [] }, textLength: 900, clickable: 14 })).toEqual([]);
  });

  it('names the redirect loop, with the address and the count, and says what it costs a visitor', () => {
    const [p] = smokeVerdict({ dump: { loop, errors: [] }, textLength: 0, clickable: 0 });
    expect(p).toMatch(/REDIRECT LOOP/);
    expect(p).toMatch(/https:\/\/app\.example\/login/);
    expect(p).toMatch(/9 times/);
    expect(p).toMatch(/Nothing can be read, clicked or filled in/);
  });

  it('during a loop it does NOT also report a blank page — that is the loop, not a second bug', () => {
    // Naming both would send the fixer after the rendering code, which is exactly the wrong layer.
    const ps = smokeVerdict({ dump: { loop, errors: [] }, textLength: 0, clickable: 0 });
    expect(ps).toHaveLength(1);
    expect(ps.join(' ')).not.toMatch(/rendered NOTHING/);
  });

  it('a blank page IS reported when nothing else explains it', () => {
    const [p] = smokeVerdict({ dump: { errors: [] }, textLength: 3, clickable: 0, settleMs: 6000 });
    expect(p).toMatch(/rendered NOTHING/);
    expect(p).toMatch(/6s/);
    expect(p).toMatch(/blank screen/);
  });

  it('text with no controls, or controls with no text, is NOT called blank', () => {
    expect(smokeVerdict({ dump: { errors: [] }, textLength: 400, clickable: 0 })).toEqual([]);
    expect(smokeVerdict({ dump: { errors: [] }, textLength: 0, clickable: 3 })).toEqual([]);
  });

  it('a page that never loaded reports the load failure and nothing derived from it', () => {
    const ps = smokeVerdict({ loadError: 'net::ERR_CONNECTION_REFUSED', dump: { errors: [] }, textLength: 0, clickable: 0 });
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatch(/did not load/);
    expect(ps[0]).toMatch(/ERR_CONNECTION_REFUSED/);
  });

  it('uncaught errors are counted and quoted — a fixer needs the text, not a tally', () => {
    const errors = [{ text: 'old thing' }, { text: 'TypeError: x is not a function' }, { text: 'ReferenceError: y' }];
    const [p] = smokeVerdict({ dump: { errors }, textLength: 900, clickable: 9 });
    expect(p).toMatch(/3 uncaught JavaScript error/);
    expect(p).toMatch(/TypeError: x is not a function/);
    expect(p).toMatch(/ReferenceError: y/);
    expect(p).not.toMatch(/old thing/);          // bounded quote: the recent ones carry the signal
  });

  it('a page that would not answer the measurement is silent, not called blank', () => {
    // The live failure mode this guards: the route wraps `page.evaluate` in a catch, so a page caught
    // mid-navigation leaves both counters unset. Defaulting those to 0 made a working app "blank".
    expect(smokeVerdict({ dump: { errors: [] }, textLength: null, clickable: null })).toEqual([]);
    expect(smokeVerdict({ dump: { errors: [] } })).toEqual([]);
  });

  it('survives being handed nothing, because an inconclusive check must never invent a fault', () => {
    expect(smokeVerdict()).toEqual([]);
    expect(smokeVerdict({})).toEqual([]);
  });
});

describe('platformFaultOf — whose fault is it, the app or the ground it stands on?', () => {
  // The very first live run of the smoke check returned this, against a real deployed product:
  // Traefik was serving its own default self-signed certificate instead of the issued one.
  it('a certificate a browser refuses is the platform, not the app', () => {
    expect(platformFaultOf('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://prod-x.host/'))
      .toMatch(/certificate is not valid/);
  });
  it('DNS, a refused connection and an unreachable address are all the platform', () => {
    expect(platformFaultOf('net::ERR_NAME_NOT_RESOLVED')).toMatch(/does not resolve/);
    expect(platformFaultOf('net::ERR_CONNECTION_REFUSED')).toMatch(/nothing accepted the connection/);
    expect(platformFaultOf('net::ERR_CONNECTION_TIMED_OUT')).toMatch(/could not be reached/);
  });
  it('everything the browser reports AFTER the page loads is the app\'s — a redirect loop above all', () => {
    // A loop never produces a loadError at all; it is content, and it is exactly what a fix is for.
    expect(platformFaultOf(null)).toBe(null);
    expect(platformFaultOf('')).toBe(null);
    expect(platformFaultOf('net::ERR_TOO_MANY_REDIRECTS')).toBe(null);
    expect(platformFaultOf('Timeout 30000ms exceeded')).toBe(null);
  });
});
