/*
 * A SESSION THAT TIMED OUT COMES BACK WHEN IT IS USED AGAIN (2026-11-07). 74 sessions in 40 hours closed
 * for being idle and the AI using them read "no such session" as the browser restarting. These keep the
 * reopening honest: same id, same owner only, same profile and page, same device, and it says so.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import express from 'express';

const require = createRequire(import.meta.url);
const { makeReviver, revivedNote } = require('../src/sessionRevive');
const { BrowserPool } = require('../src/pool');

function fakePool({ failCreate = false } = {}) {
  const pool = { sessions: new Map(), resting: new Map(), created: [], visited: [] };
  pool.putResting = BrowserPool.prototype.putResting.bind(pool);
  pool.takeResting = BrowserPool.prototype.takeResting.bind(pool);
  pool.createSession = async (o) => {
    if (failCreate) throw Object.assign(new Error('profile "facebook" is in use'), { status: 409 });
    pool.created.push(o);
    pool.sessions.set(o.id, { id: o.id, owner: o.owner, profile: o.profile, page: { goto: async (u) => { pool.visited.push(u); } } });
    return { sessionId: o.id };
  };
  pool.get = (id) => { const s = pool.sessions.get(id); if (!s) throw Object.assign(new Error('no such session'), { status: 404 }); return s; };
  return pool;
}
/* A tiny stand-in for supertest (not a dependency here): listen, call, close. */
function request(a) {
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const srv = a.listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch {}
        resolve({ status: r.status, body: json, headers: Object.fromEntries(r.headers) });
      } catch (e) { reject(e); } finally { srv.close(); }
    });
  });
  return { post: (p) => ({ send: (b) => call('POST', p, b) }), delete: (p) => call('DELETE', p) };
}
function app(pool, owner = 'carla') {
  const a = express();
  a.use((req, _res, next) => { req.client = { owner, maxConcurrent: 6, console: false }; next(); });
  a.use('/v1/sessions/:id', makeReviver({ pool, log: { info() {}, warn() {} } }));
  a.post('/v1/sessions/:id/navigate', (req, res) => { const s = pool.get(req.params.id); res.json({ ok: true, ring: s.ring || null }); });
  a.delete('/v1/sessions/:id', (req, res) => { try { pool.get(req.params.id); res.json({ closed: true }); } catch { res.status(404).json({ error: 'no such session' }); } });
  return a;
}
const rest = (o = {}) => ({ owner: 'carla', profile: 'facebook', url: 'https://www.facebook.com/profile.php?id=1', ring: null, closedAt: Date.now() - 7 * 60000, unusedMs: 20 * 60000, why: 'idle', ...o });

describe('a timed-out session is reopened by its next call', () => {
  it('under the same id, in the same profile, back on the same page — and the reply says so', async () => {
    const pool = fakePool(); pool.putResting('s-1', rest());
    const r = await request(app(pool)).post('/v1/sessions/s-1/navigate').send({});
    expect(r.status).toBe(200);
    expect(pool.created[0]).toMatchObject({ id: 's-1', owner: 'carla', profile: 'facebook' });
    expect(pool.visited).toEqual(['https://www.facebook.com/profile.php?id=1']);
    const note = revivedNote(r.headers['x-gb-revived']);
    expect(note).toMatch(/was closed 7 minutes ago after 20 minutes without use and was reopened with the same id in the "facebook" profile/);
    expect(revivedNote(encodeURIComponent(JSON.stringify({ unusedMinutes: 20, closedMinutesAgo: 1 })))).toMatch(/closed 1 minute ago after 20 minutes without use/);
    expect(note).toMatch(/anything typed or uploaded but not saved is gone/);
  });
  it('a session that ran on a device goes back to that device', async () => {
    const pool = fakePool(); pool.putResting('s-2', rest({ ring: { deviceId: 'd1', name: 'SM-F926B', profile: '' } }));
    const r = await request(app(pool)).post('/v1/sessions/s-2/navigate').send({});
    expect(r.body.ring).toMatchObject({ deviceId: 'd1', name: 'SM-F926B', elements: [] });
    expect(pool.visited).toEqual([]);   // the device holds its own page
  });
  it('only for its own owner, once, and not after two hours', async () => {
    const pool = fakePool(); pool.putResting('s-3', rest());
    expect((await request(app(pool, 'someone-else')).post('/v1/sessions/s-3/navigate').send({})).status).toBe(404);   // the route's own 'no such session'
    expect(pool.created).toEqual([]);
    pool.putResting('s-4', rest({ closedAt: Date.now() - 3 * 60 * 60 * 1000 }));
    expect(pool.takeResting('s-4', 'carla')).toBeNull();
  });
  it('closing a session that already closed opens no browser', async () => {
    const pool = fakePool(); pool.putResting('s-5', rest());
    const r = await request(app(pool)).delete('/v1/sessions/s-5');
    expect(r.body).toMatchObject({ closed: true });
    expect(pool.created).toEqual([]);
  });
  it('when it cannot be reopened, says why and keeps it for another try', async () => {
    const pool = fakePool({ failCreate: true }); pool.putResting('s-6', rest());
    const r = await request(app(pool)).post('/v1/sessions/s-6/navigate').send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/closed after inactivity and could not be reopened: profile "facebook" is in use/);
    expect(pool.resting.has('s-6')).toBe(true);
  });
  it('a live session is left alone', async () => {
    const pool = fakePool(); pool.sessions.set('s-7', { id: 's-7', owner: 'carla' });
    const r = await request(app(pool)).post('/v1/sessions/s-7/navigate').send({});
    expect(r.status).toBe(200);
    expect(r.headers['x-gb-revived']).toBeUndefined();
    expect(pool.created).toEqual([]);
  });
});
