/**
 * connectors-as-data — a customer's external API (vector DB, CRM, knowledge base) is a DATA row, not
 * per-customer tool code. This guards the store: create normalises the base URL, get() returns the
 * key for the in-process tool, list() NEVER leaks the key, remove() deletes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the store at a throwaway dir BEFORE requiring it (it reads PROFILE_DIR at load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-'));
process.env.PROFILE_DIR = TMP;
const connectors = require('../src/connectors');

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

describe('connectors are data, not code', () => {
  let key;
  it('create normalises the base URL and returns a redacted row', () => {
    const c = connectors.create({ label: 'Alquarium', baseUrl: 'alquarium.nl/api/', apiKey: 'secret-xyz', queryPath: '/ask', storePath: '/learn' });
    key = c.key;
    expect(c.key).toBeTruthy();
    expect(c.baseUrl).toBe('https://alquarium.nl/api'); // scheme added, trailing slash trimmed
    expect(c.hasKey).toBe(true);
    expect(c.queryPath).toBe('/ask');
    expect(c).not.toHaveProperty('apiKey'); // redacted
  });

  it('get() returns the full row WITH the key for the in-process tool', () => {
    const full = connectors.get(key);
    expect(full.apiKey).toBe('secret-xyz');
    expect(full.baseUrl).toBe('https://alquarium.nl/api');
  });

  it('list() never leaks the key', () => {
    const rows = connectors.list();
    const row = rows.find((r) => r.key === key);
    expect(row.hasKey).toBe(true);
    expect(row).not.toHaveProperty('apiKey');
    expect(JSON.stringify(rows)).not.toContain('secret-xyz');
  });

  it('a base URL is required', () => {
    expect(() => connectors.create({ label: 'no url' })).toThrow();
  });

  it('remove() deletes it', () => {
    expect(connectors.remove(key)).toBe(true);
    expect(connectors.get(key)).toBeNull();
  });
});
