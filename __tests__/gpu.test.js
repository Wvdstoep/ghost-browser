/*
 * A RENTED MACHINE, AND THE EXPENSIVE WAYS IT GOES WRONG: it boots into the wrong script, it is
 * never destroyed, it is destroyed while still training. Each test is one of those.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import gpu from '../src/gpu.js';

describe('the boot script', () => {
  const s = gpu.bootstrap({ hub: 'https://gb.example', token: 'tok-1', hours: 1.5, base: 'Qwen/Qwen2.5-0.5B-Instruct', adapter: 'hub:r-abc', tag: 'gb-general-r-abc' });

  it('trains with the hub reporting, on the GPU, with a full slice and the big exam', () => {
    expect(s).toContain("export GB_HUB='https://gb.example' GB_TOKEN='tok-1'");
    expect(s).toMatch(/train_round\.py .*--bf16/);
    expect(s).toMatch(/--hours 1\.5 --epochs 3 --slice 10000 --eval-turns 500/);
    expect(s).toContain("--adapter 'hub:r-abc'");
    expect(s).toContain('/v1/training/script/train_round.py');
  });

  it('hands the adapter back, exports the tag, and asks to be destroyed - in that order', () => {
    const a = s.indexOf('/v1/training/gpu/adapter');
    const e = s.indexOf('export_model.py');
    const r = s.indexOf('/v1/training/gpu/release');
    expect(a).toBeGreaterThan(0);
    expect(e).toBeGreaterThan(a);
    expect(r).toBeGreaterThan(e);
    expect(s).toContain("--tag 'gb-general-r-abc'");
  });

  it('quotes a token with a quote in it rather than breaking the shell', () => {
    const t = gpu.bootstrap({ hub: 'h', token: "a'b" });
    expect(t).toContain(`GB_TOKEN='a'\\''b'`);
  });

  it('does not export when no tag was asked for', () => {
    expect(gpu.bootstrap({ hub: 'h', token: 't' })).toContain('not exporting');
  });
});

describe('the request', () => {
  it('asks RunPod for one card of the chosen type running our script', () => {
    const r = gpu.requestFor({ name: 'gb-round r-1', gpuType: 'NVIDIA RTX A5000', script: 'echo hi' });
    expect(r.gpuTypeIds).toEqual(['NVIDIA RTX A5000']);
    expect(r.gpuCount).toBe(1);
    expect(r.cloudType).toBe('COMMUNITY');
    expect(r.dockerStartCmd).toEqual(['bash', '-c', 'echo hi']);
    expect(r.imageName).toMatch(/pytorch/);
    expect(r.volumeInGb).toBe(0);
  });
  it('falls back to the default card', () => {
    expect(gpu.requestFor({}).gpuTypeIds).toEqual([gpu.DEFAULT_TYPE]);
  });
});

describe('when a rental must end', () => {
  const now = Date.UTC(2026, 8, 24, 15, 0, 0);
  const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();

  it('lets a round that is reporting run', () => {
    expect(gpu.shouldEnd({ pod: { since: at(20), lastNoteAt: at(2) }, round: { status: 'running' }, maxHours: 2, now })).toBeNull();
  });
  it('ends it when the round is over', () => {
    expect(gpu.shouldEnd({ pod: { since: at(25), lastNoteAt: at(1) }, round: { status: 'done' }, now })).toMatch(/round is done/);
  });
  it('ends it when the machine asked', () => {
    expect(gpu.shouldEnd({ pod: { since: at(25), released: true }, now })).toMatch(/asked/);
  });
  it('ends it past the hours allowed, whatever it says', () => {
    expect(gpu.shouldEnd({ pod: { since: at(130), lastNoteAt: at(1) }, round: { status: 'running' }, maxHours: 2, now })).toMatch(/past the 2 h/);
  });
  it('ends a machine that has gone silent, but gives a fresh one time to boot', () => {
    expect(gpu.shouldEnd({ pod: { since: at(50), lastNoteAt: at(40) }, round: { status: 'running' }, now })).toMatch(/nothing heard/);
    expect(gpu.shouldEnd({ pod: { since: at(10) }, now })).toBeNull();
  });
});

describe('the record', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-gpu-')); process.env.PROFILE_DIR = dir; });
  afterEach(() => { delete process.env.PROFILE_DIR; try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

  it('estimates the cost so far from the rate and the clock', () => {
    const st = gpu.load();
    st.pod = { id: 'p1', since: new Date(Date.now() - 30 * 60000).toISOString(), costPerHr: 0.6 };
    gpu.save(st);
    const s = gpu.state();
    expect(s.pod.costSoFar).toBeGreaterThan(0.28);
    expect(s.pod.costSoFar).toBeLessThan(0.32);
  });

  it('calls RunPod with the key and reads a refusal as an error', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'bad key' }) }; };
    await expect(gpu.rent({ key: 'k', request: { name: 'x' }, fetchImpl })).rejects.toThrow(/401.*bad key/);
    expect(calls[0].url).toBe('https://rest.runpod.io/v1/pods');
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
  });
});
