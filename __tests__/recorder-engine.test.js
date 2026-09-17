/**
 * A recording is a job with a journal: it starts, records into segments on disk, ends by a rule (the
 * video ended, a duration, the owner's stop, the disk guard, the encoder gone), and is closed as a
 * playable partial when the process that held it is gone. Every process is faked: no browser, no
 * ffmpeg, no display — the state machine alone, in a temp dir.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recorder, statsOf, closePlaylist, trimPlaylist, servePlaylist, segmentList, concatArgs, videoKey, MIN_FREE_BYTES } from '../src/recorder/engine.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake sidecar: a fake ffmpeg writes a segment + playlist line per "tick" until stopped. */
function fakeDeps(o = {}) {
  const calls = { display: 0, pulse: 0, browser: 0, ffmpeg: 0, cookies: 0, stopped: 0, torn: [] };
  const video = { ended: false, paused: false, muted: false, currentTime: 0, duration: 100, href: o.href || 'https://www.youtube.com/watch?v=abc', fullscreen: true, ...(o.video || {}) };
  let free = o.free != null ? o.free : 100 * MIN_FREE_BYTES;
  const deps = {
    capabilities: () => ({ ok: o.caps !== false, hint: 'install stuff' }),
    freeBytes: () => free, sizeOf: () => ({ width: 1280, height: 720 }),
    cookiesFor: async () => { calls.cookies++; return o.cookies || [{ name: 'a', value: 'b', domain: '.x.com', path: '/' }]; },
    startDisplay: async () => { calls.display++; return { n: 101, stop: () => calls.torn.push('display') }; },
    startPulse: async () => { calls.pulse++; return { server: 'unix:/tmp/p', stop: () => calls.torn.push('pulse') }; },
    launchBrowser: async () => { calls.browser++; return { pages: () => [{ goto: async () => {}, title: async () => 'A video', }], addCookies: async () => {}, close: async () => calls.torn.push('browser') }; },
    preparePage: async () => ({ consent: true, playing: true, fullscreen: true }),
    videoState: async () => (o.pageGone ? null : { ...video }),
    startFfmpeg: ({ out }) => {
      calls.ffmpeg++; let n = 0; const proc = { exitCode: null };
      fs.writeFileSync(path.join(out, 'index.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n');
      const timer = setInterval(() => { n++; fs.writeFileSync(path.join(out, `seg-${String(n).padStart(5, '0')}.ts`), Buffer.alloc(1000)); fs.appendFileSync(path.join(out, 'index.m3u8'), `#EXTINF:10.000,\nseg-${String(n).padStart(5, '0')}.ts\n`); if (o.ffmpegDiesAfter && n >= o.ffmpegDiesAfter) { proc.exitCode = 1; clearInterval(timer); } }, 8);
      return { proc, stop: async () => { calls.stopped++; clearInterval(timer); proc.exitCode = 0; fs.appendFileSync(path.join(out, 'index.m3u8'), '#EXT-X-ENDLIST\n'); return { code: 0, err: '' }; } };
    },
    concat: async (dir) => { fs.writeFileSync(path.join(dir, 'final.mp4'), Buffer.alloc(10)); return { code: 0 }; },
  };
  return { deps, calls, video, setFree: (b) => { free = b; } };
}
const quiet = { info() {}, warn() {}, debug() {} };
const mk = (f, o = {}) => new Recorder({ root: tmp(), deps: f.deps, log: quiet, tickMs: 20, ...o });
async function untilState(r, id, states, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = r.get(id); if (v && states.includes(v.state)) return v; await sleep(10); } return r.get(id); }

describe('the recording engine', () => {
  it('records until the video ends, then closes the playlist, tears everything down and is done', async () => {
    const f = fakeDeps(); const r = mk(f);
    const v = r.start({ url: 'https://www.youtube.com/watch?v=abc', profile: 'google', until: 'video-ends' });
    expect(v.state).toBe('starting'); expect(v.until).toBe('video-ends'); expect(v.maxMinutes).toBe(240); expect(r.running()).toEqual([v.id]);
    await untilState(r, v.id, ['recording']);
    await sleep(60); f.video.ended = true;
    const d = await untilState(r, v.id, ['done', 'failed']);
    expect(d.state).toBe('done'); expect(d.reason).toBe('the video ended'); expect(d.segments).toBeGreaterThan(0); expect(d.seconds).toBe(d.segments * 10); expect(d.bytes).toBe(d.segments * 1000);
    expect(d.pageTitle).toBe('A video'); expect(d.display).toBe(101); expect(d.live).toBe(false);
    expect(f.calls).toMatchObject({ display: 1, pulse: 1, browser: 1, ffmpeg: 1, cookies: 1 }); expect(f.calls.stopped).toBeGreaterThanOrEqual(1);
    expect(f.calls.torn).toEqual(expect.arrayContaining(['browser', 'pulse', 'display']));
    expect(fs.readFileSync(path.join(r.dirOf(v.id), 'index.m3u8'), 'utf8')).toMatch(/#EXT-X-ENDLIST/);
    expect(fs.existsSync(path.join(r.dirOf(v.id), 'profile'))).toBe(false);
    expect(r.list()[0].id).toBe(v.id); expect(r.running()).toEqual([]);
    expect(await r.mp4(v.id)).toBe(path.join(r.dirOf(v.id), 'final.mp4'));
  });

  it('the owner\'s stop ends it with that reason; a second stop is idle; remove refuses while live', async () => {
    const f = fakeDeps(); const r = mk(f);
    const v = r.start({ url: 'https://x.com/v', until: 'owner-stop' });
    expect(v.maxMinutes).toBe(360);
    await untilState(r, v.id, ['recording']); await sleep(40);
    expect(r.remove(v.id)).toEqual({ error: 'still recording — stop it first' });
    expect(r.stop(v.id)).toEqual({ ok: true, id: v.id });
    const d = await untilState(r, v.id, ['done']); expect(d.reason).toBe('stopped by the owner');
    expect(r.stop(v.id)).toEqual({ error: 'not recording' });
    expect(r.remove(v.id)).toEqual({ removed: true }); expect(r.get(v.id)).toBeNull();
  });

  it('a duration ends at its length; the clock decides, not the video', async () => {
    let t = 1000; const f = fakeDeps(); const r = mk(f, { clock: () => t });
    const v = r.start({ url: 'https://x.com/v', until: 'duration', maxMinutes: 2 });
    await untilState(r, v.id, ['recording']); t += 3 * 60000;
    const d = await untilState(r, v.id, ['done']); expect(d.reason).toBe('the requested length is reached');
  });

  it('the disk guard ends a recording cleanly and refuses a new one', async () => {
    const f = fakeDeps(); const r = mk(f);
    const v = r.start({ url: 'https://x.com/v', until: 'owner-stop' });
    await untilState(r, v.id, ['recording']); await sleep(30); f.setFree(MIN_FREE_BYTES - 1);
    const d = await untilState(r, v.id, ['done']); expect(d.reason).toBe('the recordings volume is nearly full');
    expect(() => r.start({ url: 'https://x.com/v' })).toThrow(/2 GiB/);
  });

  it('the encoder dying ends it; the page moving to another video ends it after the first minute', async () => {
    const f = fakeDeps({ ffmpegDiesAfter: 3 }); const r = mk(f);
    const v = r.start({ url: 'https://x.com/v', until: 'owner-stop' });
    const d = await untilState(r, v.id, ['done', 'failed']); expect(d.reason).toMatch(/the encoder ended/); expect(d.state).toBe('done');
    let t = 1000; const g = fakeDeps(); const r2 = mk(g, { clock: () => t });
    const w = r2.start({ url: 'https://www.youtube.com/watch?v=abc', until: 'video-ends' });
    await untilState(r2, w.id, ['recording']); g.video.href = 'https://www.youtube.com/watch?v=next'; await sleep(40);
    expect(r2.get(w.id).state).toBe('recording');   // inside the first minute a redirect is not "moved on"
    t += 61000; const e = await untilState(r2, w.id, ['done']); expect(e.reason).toBe('the page moved on to another video');
  });

  it('refuses when the machine cannot record and with a bad url', () => {
    expect(() => mk(fakeDeps({ caps: false })).start({ url: 'https://x.com/v' })).toThrow(/cannot record here/);
    expect(() => mk(fakeDeps()).start({ url: 'ftp://x' })).toThrow(/url required/);
  });

  it('one at a time: a second ask waits in the queue, starts by itself when the first ends, and can be taken out', async () => {
    const f = fakeDeps(); const r = mk(f);   // maxTotal defaults to 1
    const a = r.start({ url: 'https://x.com/a', until: 'owner-stop' }); await untilState(r, a.id, ['recording']);
    const b = r.start({ url: 'https://x.com/b', until: 'owner-stop' }); const c = r.start({ url: 'https://x.com/c', until: 'owner-stop' });
    expect(b.state).toBe('queued'); expect(c.state).toBe('queued'); expect(r.queued().map((x) => x.id)).toEqual([b.id, c.id]); expect(r.running()).toEqual([a.id]);
    expect(r.stop(c.id)).toEqual({ ok: true, id: c.id, queued: true }); expect(r.get(c.id)).toMatchObject({ state: 'failed', reason: 'taken out of the queue' }); expect(r.queued().map((x) => x.id)).toEqual([b.id]);
    r.stop(a.id); await untilState(r, a.id, ['done']);
    const bb = await untilState(r, b.id, ['recording']); expect(bb.state).toBe('recording'); expect(bb.queuedFor).toBeGreaterThanOrEqual(0); expect(r.running()).toEqual([b.id]); expect(r.queued()).toEqual([]);
    expect(f.calls.ffmpeg).toBe(2);
    r.stop(b.id); await untilState(r, b.id, ['done']);
  });

  it('after a restart a journal left recording becomes a playable partial; nothing written becomes failed', () => {
    const root = tmp(); const d1 = path.join(root, 'rec-old'); fs.mkdirSync(d1);
    fs.writeFileSync(path.join(d1, 'recording.json'), JSON.stringify({ id: 'rec-old', url: 'https://x', state: 'recording', startedAt: 5, recordingAt: 6 }));
    fs.writeFileSync(path.join(d1, 'index.m3u8'), '#EXTM3U\n#EXTINF:10.000,\nseg-00001.ts\n#EXTINF:10.000,\nseg-00002.ts\n'); fs.writeFileSync(path.join(d1, 'seg-00001.ts'), Buffer.alloc(5)); fs.writeFileSync(path.join(d1, 'seg-00002.ts'), Buffer.alloc(5));
    fs.mkdirSync(path.join(d1, 'profile')); fs.writeFileSync(path.join(d1, 'profile', 'x'), '');
    const d2 = path.join(root, 'rec-empty'); fs.mkdirSync(d2); fs.writeFileSync(path.join(d2, 'recording.json'), JSON.stringify({ id: 'rec-empty', url: 'https://y', state: 'starting', startedAt: 7 }));
    const r = new Recorder({ root, deps: fakeDeps().deps, log: quiet });
    expect(r.adopt()).toBe(2);
    const a = r.get('rec-old'); expect(a.state).toBe('partial'); expect(a.segments).toBe(2); expect(a.seconds).toBe(20); expect(a.reason).toMatch(/restart/);
    expect(fs.readFileSync(path.join(d1, 'index.m3u8'), 'utf8')).toMatch(/#EXT-X-ENDLIST/); expect(fs.existsSync(path.join(d1, 'profile'))).toBe(false);
    expect(r.get('rec-empty').state).toBe('failed');
    expect(r.adopt()).toBe(0);
  });

  it('retention removes the old first, then the oldest until the budget fits, never a live one', () => {
    const root = tmp(); const day = 86400000; const t = 100 * day;
    const put = (id, startedAt, bytes, state = 'done') => { const d = path.join(root, id); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'recording.json'), JSON.stringify({ id, url: 'https://x', state, startedAt, endedAt: startedAt + 60000, bytes, segments: 1 })); };
    put('rec-ancient', t - 30 * day, 100); put('rec-big-old', t - 5 * day, 900); put('rec-mid', t - 3 * day, 500); put('rec-new', t - 1 * day, 400);
    const r = new Recorder({ root, deps: fakeDeps().deps, log: quiet, clock: () => t });
    const out = r.prune({ days: 14, maxBytes: 1000, now: t });
    expect(out.removed.map((x) => x.id)).toEqual(['rec-ancient', 'rec-big-old']);   // ancient by age, big-old by budget (oldest first)
    expect(out.removed[0].why).toMatch(/older than 14 days/); expect(out.removed[1].why).toMatch(/budget/);
    expect(out.kept).toBe(2); expect(out.bytes).toBe(900); expect(r.get('rec-mid')).not.toBeNull(); expect(r.get('rec-new')).not.toBeNull();
    expect(r.prune({ days: 14, maxBytes: 1000, now: t }).removed).toEqual([]);
  });

  it('stats come from the files, a playlist is closed once, concat copies streams, video keys compare the video not the page', () => {
    const d = tmp(); expect(statsOf(d)).toEqual({ segments: 0, bytes: 0, seconds: 0 });
    fs.writeFileSync(path.join(d, 'index.m3u8'), '#EXTM3U\n#EXTINF:10.000,\nseg-00001.ts\n#EXTINF:4.500,\nseg-00002.ts\n'); fs.writeFileSync(path.join(d, 'seg-00001.ts'), Buffer.alloc(30)); fs.writeFileSync(path.join(d, 'seg-00002.ts'), Buffer.alloc(12));
    expect(statsOf(d)).toEqual({ segments: 2, bytes: 42, seconds: 15 });
    expect(closePlaylist(d)).toBe(true); closePlaylist(d); expect(fs.readFileSync(path.join(d, 'index.m3u8'), 'utf8').match(/ENDLIST/g).length).toBe(1);
    const a = concatArgs('/r/x'); expect(a).toContain('copy'); expect(a[a.length - 1]).toBe('/r/x/final.mp4'); expect(a).toContain('/r/x/list.txt'); expect(a).toContain('aac_adtstoasc');
    // the mp4 is built from the FILES that are here; a playlist naming a missing segment is trimmed for players and at close
    fs.writeFileSync(path.join(d, 'index.m3u8'), '#EXTM3U\n#EXTINF:10.000,\nseg-00001.ts\n#EXTINF:4.500,\nseg-00002.ts\n#EXTINF:10.000,\nseg-00003.ts\n');
    expect(segmentList(d)).toBe(`file '${path.join(d, 'seg-00001.ts')}'\nfile '${path.join(d, 'seg-00002.ts')}'\n`);
    expect(servePlaylist(d)).not.toMatch(/seg-00003/); expect(servePlaylist(d)).toMatch(/seg-00002/); expect(servePlaylist(d).match(/#EXTINF/g).length).toBe(2);
    expect(trimPlaylist('#EXTM3U\n#EXTINF:10.000,\nseg-00007.ts\n', () => false)).toBe('#EXTM3U\n');
    closePlaylist(d); const closed = fs.readFileSync(path.join(d, 'index.m3u8'), 'utf8'); expect(closed).not.toMatch(/seg-00003/); expect(closed).toMatch(/ENDLIST/); expect(closed.match(/ENDLIST/g).length).toBe(1);
    expect(videoKey('https://www.youtube.com/watch?v=abc&t=5s')).toBe('abc'); expect(videoKey('https://www.youtube.com/watch?v=abc')).toBe(videoKey('https://www.youtube.com/watch?v=abc&list=x'));
    expect(videoKey('https://site.com/v#t=1')).toBe('https://site.com/v'); expect(videoKey('https://site.com/v')).not.toBe(videoKey('https://site.com/w'));
  });
});
