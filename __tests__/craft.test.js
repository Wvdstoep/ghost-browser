// Making the things a browser is asked for, not only finding them.
//
// A freelance brief wants a CV. A marketplace wants a portfolio PDF. A signup wants a code from an
// authenticator app. A menu opens only under the pointer. Every one of those is an ordinary part of
// earning money online, and every one of them stopped the work dead while the browser could find,
// read and click perfectly well. These tests pin the parts that must be exactly right — the RFC
// vectors, what counts as a secret, the print wrapper, the filename — and that the tools are on the
// palette, in the registry, and within every role's reach.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import craft from '../src/tools/craft.js';
import parts from '../src/tools/craft-parts.js';
import tools from '../src/tools/index.js';
import agent from '../src/agent.js';
import roles from '../src/roles.js';

const { totp, base32Decode, secretFrom, documentHtml, safeName } = parts;
const craftSrc = readFileSync(fileURLToPath(new URL('../src/tools/craft.js', import.meta.url)), 'utf8')
  + readFileSync(fileURLToPath(new URL('../src/tools/craft-parts.js', import.meta.url)), 'utf8');
const NEW = ['make_document', 'save_totp_secret', 'totp_code', 'hover'];

describe('the four are real hands, reachable by every role', () => {
  it('each is on the palette, in the registry, and described', () => {
    for (const n of NEW) {
      const def = agent.TOOLS.find((t) => t.function && t.function.name === n);
      expect(def, `${n} is on the palette`).toBeTruthy();
      expect(String(def.function.description).length).toBeGreaterThan(60);
      expect(tools.has(n), `${n} is registered`).toBe(true);
    }
    // and nothing but tools: Object.assign would turn any other export into a callable name the
    // palette does not carry (the registry's own guard catches that, so keep this module honest).
    expect(Object.keys(craft).sort()).toEqual([...NEW].sort());
  });

  it('a role with its own tool list can still reach them — and attach what it made', () => {
    for (const role of ['general', 'research.reddit', 'qa.web']) {
      const got = roles.toolsFor(role, agent.TOOLS).map((t) => t.function.name);
      for (const n of [...NEW, 'upload_file']) expect(got, `${role} → ${n}`).toContain(n);
    }
  });
});

describe('an authenticator app, in the browser', () => {
  it('matches the RFC 6238 vectors (SHA-1, 30s) — the thing that must be exactly right', () => {
    // RFC 6238 appendix B, seed "12345678901234567890" in base32, truncated to six digits.
    const S = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totp(S, { now: 59000 }).code).toBe('287082');
    expect(totp(S, { now: 1111111109000 }).code).toBe('081804');
    expect(totp(S, { now: 1111111111000 }).code).toBe('050471');
    expect(totp(S, { now: 1234567890000 }).code).toBe('005924');
    expect(totp(S, { now: 2000000000000 }).code).toBe('279037');
  });

  it('says how long the code has left, and rolls at the step boundary', () => {
    expect(totp('JBSWY3DPEHPK3PXP', { now: 30000 }).secondsLeft).toBe(30);
    expect(totp('JBSWY3DPEHPK3PXP', { now: 59000 }).secondsLeft).toBe(1);
    const a = totp('JBSWY3DPEHPK3PXP', { now: 29000 }).code;
    const b = totp('JBSWY3DPEHPK3PXP', { now: 31000 }).code;
    expect(a).not.toBe(b);
  });

  it('decodes base32 the way a page actually prints it — spaced, padded, lower case', () => {
    const want = base32Decode('JBSWY3DPEHPK3PXP');
    expect(base32Decode('jbsw y3dp ehpk 3pxp')).toEqual(want);
    expect(base32Decode('JBSWY3DPEHPK3PXP======')).toEqual(want);
    expect(base32Decode('')).toHaveLength(0);
    // 0, 1, 8 and 9 are not base32 — a string of only those decodes to nothing, and nothing is null.
    expect(totp('0189 !!! 0189')).toBeNull();
    expect(totp('')).toBeNull();
  });

  it('takes the secret from an otpauth link, a labelled line, or the bare key', () => {
    expect(secretFrom('otpauth://totp/Upwork:carla?secret=JBSWY3DPEHPK3PXP&issuer=Upwork')).toBe('JBSWY3DPEHPK3PXP');
    expect(secretFrom('Secret: JBSW Y3DP EHPK 3PXP')).toBe('JBSWY3DPEHPK3PXP');
    expect(secretFrom('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP');
    expect(secretFrom('scan the QR code')).toBe('');
    expect(secretFrom('')).toBe('');
  });

  it('stores the secret with the logins, mode 600 — and never hands it back', () => {
    expect(craftSrc).toMatch(/TOTP_FILE = path\.join\(PROFILE_DIR, 'totp\.json'\)/);
    expect(craftSrc).toMatch(/\{ mode: 0o600 \}/);
    // The only thing an observation may carry is the six digits of the moment. The secret is read to
    // compute them and goes nowhere else: no observe(), step() or memo() line may interpolate it.
    expect(craftSrc).toMatch(/never shown again/);
    const said = craftSrc.split('\n').filter((l) => /ctx\.(observe|step|memo)\(/.test(l));
    expect(said.length).toBeGreaterThan(6);
    for (const line of said) expect(line, line.trim().slice(0, 70)).not.toMatch(/\bsecret\b\s*[}`]|row\.secret|a\.secret/);
  });
});

describe('a document, as a document', () => {
  it('wraps a fragment with a print stylesheet, and leaves a whole document alone', () => {
    const out = documentHtml('<h1>Wesley van der stoep</h1><h2>Experience</h2>', 'CV');
    expect(out).toMatch(/^<!doctype html>/);
    expect(out).toMatch(/@page \{ size: A4/);
    expect(out).toMatch(/<title>CV<\/title>/);
    expect(out).toMatch(/<h1>Wesley van der stoep<\/h1>/);
    const mine = '<html><head><style>body{font-family:serif}</style></head><body><h1>x</h1></body></html>';
    expect(documentHtml(mine, 'CV')).toBe(mine);
    // an author's own <style> in a fragment is respected — the house sheet is a floor, not a ceiling
    expect(documentHtml('<style>h1{color:red}</style><h1>x</h1>', 'CV')).not.toMatch(/@page/);
  });

  it('names the file safely and always ends in .pdf', () => {
    expect(safeName('Wesley CV!!', 'document')).toBe('Wesley-CV.pdf');
    expect(safeName('portfolio.pdf', 'document')).toBe('portfolio.pdf');
    expect(safeName('', 'document')).toBe('document.pdf');
    expect(safeName('Wesley van der stoep CV', 'document')).toBe('Wesley-van-der-stoep-CV.pdf');
    // punctuation a recipient should never see in a filename is collapsed away, not preserved
    expect(safeName('../../etc/passwd', 'document')).toBe('etcpasswd.pdf');
    expect(safeName('...', 'document')).toBe('document.pdf');
  });

  it('prints through CDP, because this browser is headed on purpose', () => {
    // page.pdf() is headless-only in Playwright, and a headless fingerprint is the cheapest tell.
    expect(craftSrc).toMatch(/newCDPSession\(page\)/);
    expect(craftSrc).toMatch(/'Page\.printToPDF'/);
    expect(craftSrc).toMatch(/printBackground: true/);
    // and it is never CALLED (the comment explaining why may of course name it)
    expect(craftSrc).not.toMatch(/await\s+page\.pdf\s*\(/);
  });

  it('stores it as an asset upload_file can attach, and says so in one line', () => {
    expect(craftSrc).toMatch(/fileAssets\.put\(\{ mime: 'application\/pdf'/);
    expect(craftSrc).toMatch(/call upload_file with assetId/);
  });

  it('refuses an empty document instead of printing a blank page', () => {
    expect(craftSrc).toMatch(/make_document needs the document itself as HTML/);
  });

  it('closes its throwaway page whatever happens', () => {
    expect(craftSrc).toMatch(/finally \{ try \{ await page\.close\(\); \}/);
  });
});
