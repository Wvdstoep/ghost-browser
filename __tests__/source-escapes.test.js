/*
 * NO CONTROL CHARACTERS IN THE SOURCE, BECAUSE A MANGLED ESCAPE IS INVISIBLE.
 *
 * Patches to this tree are written through a script, and a regex escape has been eaten five times
 * on the way in: a Python-side "backslash-b" arrives as a single BACKSPACE byte, so the source
 * reads as an ordinary word boundary in every editor and matches nothing at all.
 *
 * It cost a real bug that sat unnoticed: verify.js had /...|BACKSPACE 429 BACKSPACE|.../ where a
 * word-bounded 429 was meant, so a report whose only sign of an API failure was a bare 429 was
 * never recognised as void. `rate limit` caught most cases, which is exactly why nobody saw it.
 *
 * A grep cannot find what it cannot see, so this test looks for the bytes instead. It is cheap,
 * it runs on every commit, and it is the only thing that makes the trap self-reporting.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/* Tab, newline and carriage return are legitimate; everything else in the C0 range is not. */
const ALLOWED = new Set([9, 10, 13]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('the source carries no mangled escapes', () => {
  it('has no control characters anywhere in src/', () => {
    const root = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const bad = [];
    for (const file of walk(root)) {
      const text = fs.readFileSync(file, 'utf8');
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 32 && !ALLOWED.has(c)) {
          const line = text.slice(0, i).split(String.fromCharCode(10)).length;
          bad.push(`${path.basename(file)}:${line} has byte ${c}`);
          break;
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
