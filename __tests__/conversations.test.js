/**
 * The managed-conversations allowlist — the seam that scopes the reply watcher to only the chats the
 * owner deliberately started, so a stranger's DM never gets an automatic reply.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-convo-'));
process.env.PROFILE_DIR = dir;
const c = await import('../src/conversations.js');

beforeEach(() => { try { fs.rmSync(c.FILE, { force: true }); } catch {} });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('managed conversations', () => {
  it('remembers a chat and lists it, persisting to disk', () => {
    c.remember({ name: 'Karolina Woj', threadUrl: 'https://www.facebook.com/messages/t/123' });
    expect(c.all()).toHaveLength(1);
    expect(c.all()[0].name).toBe('Karolina Woj');
    expect(fs.existsSync(c.FILE)).toBe(true);
  });

  it('does not add the same thread twice (dedup by thread link)', () => {
    c.remember({ name: 'Karolina', threadUrl: 'https://fb/messages/t/1' });
    c.remember({ name: 'Karolina Woj', threadUrl: 'https://fb/messages/t/1' });   // same thread
    expect(c.all()).toHaveLength(1);
    expect(c.all()[0].name).toBe('Karolina Woj');   // updated in place
  });

  it('dedups by name when there is no thread link', () => {
    c.remember({ name: 'Kris Baudoin' });
    c.remember({ name: 'kris baudoin' });   // same name, different case
    expect(c.all()).toHaveLength(1);
  });

  it('ignores an empty entry with nothing to key on', () => {
    c.remember({});
    expect(c.all()).toHaveLength(0);
  });

  it('isManaged matches on thread link or name, and is false for a stranger', () => {
    c.remember({ name: 'Karolina Woj', threadUrl: 'https://fb/messages/t/9' });
    expect(c.isManaged({ threadUrl: 'https://fb/messages/t/9' })).toBe(true);
    expect(c.isManaged({ name: 'karolina woj' })).toBe(true);
    expect(c.isManaged({ name: 'Some Stranger' })).toBe(false);
  });
});
