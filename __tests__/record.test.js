/**
 * screen_record — the browser filming its own screen. These cover the control flow (start sets up the
 * capture, the guards hold) without needing ffmpeg or a real Chromium, since encoding is only reached
 * once real frames exist.
 */
import { describe, it, expect } from 'vitest';
const record = await import('../src/tools/record.js');

function mkCtx() {
  const obs = [];
  let onFrame = null;
  const cdp = { send: async () => {}, on: (ev, cb) => { if (ev === 'Page.screencastFrame') onFrame = cb; }, detach: async () => {} };
  const session = { context: { newCDPSession: async () => cdp } };
  const ctx = { page: () => ({}), session: () => session, observe: (t) => obs.push(t), step: () => {} };
  return { ctx, session, obs, frame: () => onFrame };
}

describe('screen_record', () => {
  it('start_recording opens a capture and stashes it on the session', async () => {
    const { ctx, session, obs } = mkCtx();
    await record.start_recording(ctx, {});
    expect(session._rec).toBeTruthy();
    expect(session._rec.frames).toEqual([]);
    expect(obs.join(' ')).toMatch(/recording/i);
  });

  it('refuses to start a second recording over a running one', async () => {
    const { ctx, obs } = mkCtx();
    await record.start_recording(ctx, {});
    await record.start_recording(ctx, {});
    expect(obs.join(' ')).toMatch(/already recording/i);
  });

  it('stop_recording with nothing running says so, does not throw', async () => {
    const { ctx, obs } = mkCtx();
    await record.stop_recording(ctx, {});
    expect(obs.join(' ')).toMatch(/nothing is recording/i);
  });

  it('stop_recording with no captured frames reports it rather than making an empty video', async () => {
    const { ctx, session, obs } = mkCtx();
    await record.start_recording(ctx, {});
    expect(session._rec).toBeTruthy();
    await record.stop_recording(ctx, {});     // zero frames captured
    expect(session._rec).toBeNull();          // recording state is cleared either way
    expect(obs.join(' ')).toMatch(/no frames/i);
  });

  // The workflow driver auto-records a node with these helpers directly (no agent ctx), so a flow step
  // ticked "record" in the builder films itself server-side — independent of the agent calling tools.
  it('exposes reusable beginRecording/endRecording helpers', () => {
    expect(typeof record.beginRecording).toBe('function');
    expect(typeof record.endRecording).toBe('function');
  });

  it('endRecording returns null (never throws) when nothing is recording', async () => {
    const nothing = await record.endRecording({});
    expect(nothing).toBeNull();
  });

  it('beginRecording stashes the capture; endRecording with no frames clears it and returns null', async () => {
    const { session } = mkCtx();
    const ok = await record.beginRecording(session, {});
    expect(ok).toBe(true);
    expect(session._rec).toBeTruthy();
    const saved = await record.endRecording(session, { name: 'x.mp4' }); // zero frames → null
    expect(saved).toBeNull();
    expect(session._rec).toBeNull();
  });

  it('beginRecording refuses a second capture over a running one', async () => {
    const { session } = mkCtx();
    expect(await record.beginRecording(session, {})).toBe(true);
    expect(await record.beginRecording(session, {})).toBe(false);
  });
});
