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
import { Recorder, statsOf, closePlaylist, concatArgs, videoKey, MIN_FREE_BYTES } from '../src/recorder/engine.js';

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

  it('refuses when the machine cannot record, when too many run, and with a bad url', () => {
    expect(() => mk(fakeDeps({ caps: false })).start({ url: 'https://x.com/v' })).toThrow(/cannot record here/);
    expect(() => mk(fakeDeps()).start({ url: 'ftp://x' })).toThrow(/url required/);
    const f = fakeDeps(); const r = mk(f, { maxConcurrent: 1 }); r.start({ url: 'https://x.com/a', until: 'owner-stop' });
    expect(() => r.start({ url: 'https://x.com/b' })).toThrow(/limit is 1/);
    r.stop(r.running()[0]);
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

  it('stats come from the files, a playlist is closed once, concat copies streams, video keys compare the video not the page', () => {
    const d = tmp(); expect(statsOf(d)).toEqual({ segments: 0, bytes: 0, seconds: 0 });
    fs.writeFileSync(path.join(d, 'index.m3u8'), '#EXTM3U\n#EXTINF:10.000,\nseg-00001.ts\n#EXTINF:4.500,\nseg-00002.ts\n'); fs.writeFileSync(path.join(d, 'seg-00001.ts'), Buffer.alloc(30)); fs.writeFileSync(path.join(d, 'seg-00002.ts'), Buffer.alloc(12));
    expect(statsOf(d)).toEqual({ segments: 2, bytes: 42, seconds: 15 });
    expect(closePlaylist(d)).toBe(true); closePlaylist(d); expect(fs.readFileSync(path.join(d, 'index.m3u8'), 'utf8').match(/ENDLIST/g).length).toBe(1);
    const a = concatArgs('/r/x'); expect(a).toContain('copy'); expect(a[a.length - 1]).toBe('/r/x/final.mp4'); expect(a).toContain('/r/x/index.m3u8');
    expect(videoKey('https://www.youtube.com/watch?v=abc&t=5s')).toBe('abc'); expect(videoKey('https://www.youtube.com/watch?v=abc')).toBe(videoKey('https://www.youtube.com/watch?v=abc&list=x'));
    expect(videoKey('https://site.com/v#t=1')).toBe('https://site.com/v'); expect(videoKey('https://site.com/v')).not.toBe(videoKey('https://site.com/w'));
  });
});
