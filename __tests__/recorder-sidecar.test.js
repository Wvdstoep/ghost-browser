/**
 * The recording sidecar's pure parts: the display above the pool's, a private PulseAudio with one
 * null sink, Chromium sized to the recording in kiosk mode, ffmpeg grabbing exactly that display and
 * that sink with capped threads — and a probe's verdict on sound. No processes are spawned here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sizeOf, xvfbArgs, pulseArgs, chromeArgs, ffmpegArgs, allocDisplay, capabilities, recordingsRoot, DISPLAY_LOW, SINK } from '../src/recorder/sidecar.js';

describe('recording sidecar', () => {
  it('says what this machine can do, and where recordings go on a laptop (beside the profiles folder)', () => {
    const c = capabilities();
    expect(c.tools).toHaveProperty('Xvfb'); expect(c.tools).toHaveProperty('pulseaudio'); expect(c.tools).toHaveProperty('ffmpeg');
    expect(typeof c.ok).toBe('boolean'); if (!c.ok) expect(c.hint).toMatch(/docker|apt install/);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-'));
    const saved = { R: process.env.RECORDINGS_DIR, P: process.env.PROFILE_DIR };
    try {
      delete process.env.RECORDINGS_DIR; process.env.PROFILE_DIR = path.join(base, 'profiles');
      if (!fs.existsSync('/recordings')) expect(recordingsRoot()).toBe(path.join(base, 'recordings'));
      process.env.RECORDINGS_DIR = path.join(base, 'elsewhere'); expect(recordingsRoot()).toBe(path.join(base, 'elsewhere'));
    } finally { if (saved.R) process.env.RECORDINGS_DIR = saved.R; else delete process.env.RECORDINGS_DIR; if (saved.P) process.env.PROFILE_DIR = saved.P; else delete process.env.PROFILE_DIR; }
  });
  it('sizes come from a small ladder and default to 720p', () => {
    expect(sizeOf('720p')).toEqual({ width: 1280, height: 720 }); expect(sizeOf('1080p')).toEqual({ width: 1920, height: 1080 }); expect(sizeOf('4k')).toEqual({ width: 1280, height: 720 });
  });
  it('the display is its own, sized to the recording, and never the pool\'s :99', () => {
    const a = xvfbArgs(101, sizeOf('720p'));
    expect(a[0]).toBe(':101'); expect(a).toContain('1280x720x24'); expect(a).toContain('-nolisten');
    expect(DISPLAY_LOW).toBeGreaterThan(99);
  });
  it('picks the first free display number, skipping ones an X server or this process holds', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x11-'));
    fs.mkdirSync(path.join(dir, '.X11-unix'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.X11-unix', 'X100'), ''); fs.writeFileSync(path.join(dir, '.X102-lock'), '');
    expect(allocDisplay(new Set([101]), dir)).toBe(103);
    expect(allocDisplay(new Set(), dir)).toBe(101);
  });
  it('pulse is private: no default config, its own socket, one null sink named for the recording', () => {
    const a = pulseArgs('/tmp/pulse-abc');
    expect(a).toContain('-n'); expect(a).toContain('--daemonize=no'); expect(a).toContain('--exit-idle-time=-1');
    expect(a.find((x) => x.includes('module-native-protocol-unix'))).toContain('socket=/tmp/pulse-abc/native');
    expect(a.find((x) => x.includes('module-null-sink'))).toContain(`sink_name=${SINK}`);
  });
  it('chromium keeps the pool\'s flags but takes the recording\'s size, kiosk and autoplay', () => {
    const a = chromeArgs(['--no-sandbox', '--window-size=1280,800', '--disable-dev-shm-usage'], sizeOf('1080p'));
    expect(a).toContain('--no-sandbox'); expect(a).toContain('--disable-dev-shm-usage');
    expect(a).not.toContain('--window-size=1280,800'); expect(a).toContain('--window-size=1920,1080');
    expect(a).toContain('--kiosk'); expect(a).toContain('--autoplay-policy=no-user-gesture-required');
  });
  it('ffmpeg grabs that display and that sink, capped threads, mp4 with a duration or hls segments', () => {
    const mp4 = ffmpegArgs({ display: 101, size: sizeOf('720p'), out: '/tmp/x.mp4', seconds: 20 });
    const i = mp4.indexOf('-i'); expect(mp4[i + 1]).toBe(':101');
    expect(mp4).toContain('x11grab'); expect(mp4).toContain('pulse'); expect(mp4).toContain(`${SINK}.monitor`);
    expect(mp4[mp4.indexOf('-threads') + 1]).toBe('2'); expect(mp4[mp4.indexOf('-t') + 1]).toBe('20'); expect(mp4[mp4.length - 1]).toBe('/tmp/x.mp4');
    expect(mp4).toContain('libx264'); expect(mp4).toContain('aac');
    const hls = ffmpegArgs({ display: 102, size: sizeOf('720p'), out: '/recordings/r1', mode: 'hls' });
    expect(hls).toContain('hls'); expect(hls[hls.indexOf('-hls_time') + 1]).toBe('10'); expect(hls[hls.length - 1]).toBe('/recordings/r1/index.m3u8');
    expect(hls).not.toContain('-t');
  });
});
