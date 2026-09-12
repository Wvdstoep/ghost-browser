// CLICK BY TEXT — the escape hatch for a control the numbered list did not index, through the same gate.
//
// Live, 2026-09-11: the register button on login.olx.pl exists — the agent proved it with a script —
// and look() listed only three things on that page, never that button. The agent can only click by
// number, so it could see the button and could not press it, burned sixty steps on Tab keys, a
// /register url and a refused script click, and reported blocked without reaching the form.
//
// The handler cannot be unit-driven without a browser, so this pins the parts that matter at source:
// the tool exists and every hand that can click has it; the gate check runs BEFORE the click and is
// the same looksLikeWrite that guards a numbered click; not-found and a failed click are observations,
// never crashes; and the script step now settles before it reads.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import agent from '../src/agent.js';

const src = readFileSync(fileURLToPath(new URL('../src/agent.js', import.meta.url)), 'utf8');
const roles = readFileSync(fileURLToPath(new URL('../src/roles.js', import.meta.url)), 'utf8');
const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const handler = src.slice(src.indexOf("case 'click_text': {"), src.indexOf("case 'run_script': {"));

describe('the tool exists and is in every hand that can click', () => {
  it('is a real tool with the one argument it needs', () => {
    const t = agent.TOOLS.find((x) => x.function && x.function.name === 'click_text');
    expect(t).toBeTruthy();
    expect(t.function.parameters.required).toEqual(['text']);
    expect(t.function.description).toMatch(/when look\(\) did not list it/);
    expect(t.function.description).toMatch(/passes the SAME gate as click/);
  });

  it('sits in HANDS beside click, so a general role has it', () => {
    expect(roles).toMatch(/'open', 'click', 'click_text', 'type', 'scroll',/);
  });
});

describe('the handler', () => {
  it('exists, and finds by folded text on visible controls only', () => {
    expect(handler.length).toBeGreaterThan(200);
    expect(handler).toMatch(/normalize\('NFD'\)/);                       // accents ignored: "Załóż konto" matches "zaloz konto"
    expect(handler).toMatch(/if \(!t \|\| !t\.visible\) continue;/);        // a hidden control is not a candidate
    expect(handler).toMatch(/button, a, \[role=button\], \[role=tab\]/);   // tabs are exactly the case that was missed
  });

  it('THE GATE — runs the same looksLikeWrite check as a numbered click, before any click', () => {
    const gate = handler.indexOf('looksLikeWrite(info)');
    const click = handler.indexOf('await loc.click(');
    expect(gate).toBeGreaterThan(-1);
    expect(click).toBeGreaterThan(gate);
    expect(handler).toMatch(/!settings\.autoAct && !ground\.covers\(page\(\)\.url\(\)\) && looksLikeWrite\(info\)/);
    expect(handler).toMatch(/that is visible to other people, so it needs act/);
    // and the numbered click uses the identical condition, so the two doors are one door
    expect(src).toMatch(/!settings\.autoAct && !ground\.covers\(page\(\)\.url\(\)\) && looksLikeWrite\(el\)/);
  });

  it('a register tab passes the gate; a post button does not — the gate is the word, not the tool', () => {
    expect(agent.looksLikeWrite({ text: 'Załóż konto' })).toBe(false);
    expect(agent.looksLikeWrite({ text: 'Zaloguj się' })).toBe(false);
    expect(agent.looksLikeWrite({ text: 'Post' })).toBe(true);
    expect(agent.looksLikeWrite({ text: 'Send' })).toBe(true);
  });

  it('not found, and a click that does not land, are observations the agent can act on', () => {
    expect(handler).toMatch(/No visible control on this page carries the words/);
    expect(handler).toMatch(/the control may sit inside an iframe/);
    expect(handler).toMatch(/but the click did not land/);
    expect(handler).not.toMatch(/throw new Error/);
  });

  it('a real mouse click, then a fresh look next time', () => {
    expect(handler).toMatch(/await loc\.click\(\{ timeout: 8000 \}\);/);
    expect(handler).toMatch(/session\.lastAnalysis = null;/);
    expect(handler).toMatch(/Call look to see what changed/);
  });
});

describe('the script step settles before it reads', () => {
  it('waits for the page after consent and before the script, using the inspector\'s settle', () => {
    const fn = server.slice(server.indexOf('function makeRunScript'), server.indexOf('function makeRunAgent'));
    expect(fn).toMatch(/const \{ dismissConsent, settle \} = require\('\.\/inspector'\);/);
    const consent = fn.indexOf('await dismissConsent(s.page)');
    const settleAt = fn.indexOf('await settle(s.page)');
    const evaluate = fn.indexOf('await s.page.evaluate(wrapped)');
    expect(settleAt).toBeGreaterThan(consent);
    expect(evaluate).toBeGreaterThan(settleAt);
  });
});
