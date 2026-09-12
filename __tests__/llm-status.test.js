/**
 * llm.js must PRESERVE the upstream status — the keyring only rolls to the backup key when isSpent
 * sees status===429. A 429 flattened to 502 (the old bug) meant a weekly-limit walk died on the
 * exhausted primary while a good backup sat unused. This pins that a 429 stays a 429, and that
 * isSpent then catches it. A stubbed fetch, no network.
 */
import { describe, it, expect } from 'vitest';
import { chat } from '../src/llm.js';
import { isSpent } from '../src/keyring.js';

function stubFetch(status, body) {
  return async () => ({ ok: status < 400, status, json: async () => ({ error: body }), text: async () => JSON.stringify({ error: body }) });
}

describe('the model error carries its real status', () => {
  it('a 429 weekly-limit stays status 429, and isSpent catches it — the ring will roll', async () => {
    const err = await chat({ host: 'https://ollama.com', model: 'm', key: 'k', messages: [], fetchImpl: stubFetch(429, 'you (carla) have reached your weekly usage limit') })
      .catch((e) => e);
    expect(err.status).toBe(429);
    expect(isSpent(err)).toBe(true);
  });

  it('a plain rate-limit 429 stays 429 but is NOT spent — a busy minute must not burn a key', async () => {
    const err = await chat({ host: 'https://ollama.com', model: 'm', key: 'k', messages: [], fetchImpl: stubFetch(429, 'too many requests, slow down') })
      .catch((e) => e);
    expect(err.status).toBe(429);
    expect(isSpent(err)).toBe(false);
  });

  it('a 500 stays a real server error, not conflated with anything', async () => {
    const err = await chat({ host: 'https://ollama.com', model: 'm', key: 'k', messages: [], fetchImpl: stubFetch(500, 'boom') })
      .catch((e) => e);
    expect(err.status).toBe(500);
    expect(isSpent(err)).toBe(false);
  });
});
