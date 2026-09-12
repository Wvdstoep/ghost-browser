/**
 * `reuse` + `profile` on POST /v1/sessions means "the session I already have ON THAT PROFILE".
 *
 * It used to mean "whatever session I have first". With one signed-out session open for a hunt,
 * every job a client dispatched for its reddit or linkedin login was handed that same session,
 * refused there (one conversation per session), and the client waited for a job that was never
 * going to be in the browser it asked for. The master's whole go-to-market research stalled on
 * this while its plan allowed three browsers.
 *
 * server.js opens Chromium on import, so this asserts the property against the source.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js'), 'utf8');
const at = src.indexOf("app.post('/v1/sessions'");
const handler = src.slice(at, src.indexOf('pool.createSession', at));

describe('POST /v1/sessions with reuse', () => {
  it('matches the existing session BY PROFILE when one is named', () => {
    expect(at).toBeGreaterThan(-1);
    expect(handler).toMatch(/const want = req\.body\.profile \? profiles\.safeName\(req\.body\.profile\) : null/);
    expect(handler).toMatch(/want \? mine\.find\(\(s\) => s\.profile === want\) : mine\[0\]/);
  });

  it('compares on the safe name — sessions carry the sanitised profile, callers send the raw one', () => {
    expect(handler).toMatch(/profiles\.safeName\(req\.body\.profile\)/);
  });

  it('falls through to opening one on that profile when none is open there', () => {
    // the reuse block only returns when something matched; createSession follows with the profile
    expect(handler).toMatch(/if \(existing\) return res\.json/);
    // a generous window: the single-browser block now sits between the preset setup and this call
    expect(src.slice(at, at + 4200)).toMatch(/pool\.createSession\(\{[\s\S]{0,320}profile: profileName/);
  });

  it('keeps the old meaning for a caller that names no profile', () => {
    expect(handler).toMatch(/: mine\[0\]/);
  });
});
