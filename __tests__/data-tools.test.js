// The hands for when a page will not simply be read.
//
// Live, 2026-09-11: a Workshop build spent 122 steps on a Reddit listing, got nothing, and reasoned
// its own way to "the read tool truncates, so I need to run a script" and "I should fetch the JSON
// feed directly" — then announced "I see http-request is available". It was not. It spent the rest of
// its budget on a tool that never existed. The gap was not the site's: a browser that cannot read
// structured data, press a key, wait for a lazy list, pick a dropdown value or follow a new tab meets
// a wall on every second site. These tests pin the six hands that closed it, and — the part that
// matters most — that a script may READ the page and never ACT on it, so the owner's approval gate
// can never be walked around by a snippet.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import agent from '../src/agent.js';
import roles from '../src/roles.js';

const agentSrc = readFileSync(fileURLToPath(new URL('../src/agent.js', import.meta.url)), 'utf8');
const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const names = () => agent.TOOLS.map((t) => t.function && t.function.name);
const NEW = ['run_script', 'fetch_data', 'press_key', 'wait_for', 'choose_option', 'tabs', 'switch_tab'];

describe('the browser has the hands a person at a laptop has', () => {
  it('offers all six, each with a described shape', () => {
    for (const n of NEW) {
      const t = agent.TOOLS.find((x) => x.function && x.function.name === n);
      expect(t, n + ' is in the palette').toBeTruthy();
      expect(String(t.function.description).length).toBeGreaterThan(40);
      expect(t.function.parameters.type).toBe('object');
    }
    // and every one of them is dispatched, not merely advertised
    for (const n of NEW) expect(agentSrc, n + ' has a handler').toMatch(new RegExp(`case '${n}'`));
  });

  it('gives them to EVERY role — including one with its own tool list', () => {
    // A role naming its own tools would not see a newly added one, and the symptom (an agent that
    // mysteriously will not use a tool) is miserable to diagnose. So they sit with look() and read().
    for (const role of ['general', 'research.reddit', 'qa.web']) {
      const got = roles.toolsFor(role, agent.TOOLS).map((t) => t.function.name);
      for (const n of ['run_script', 'fetch_data', 'press_key', 'wait_for']) {
        expect(got, `${role} can reach ${n}`).toContain(n);
      }
    }
  });

  it('publishes the palette, so nobody composing a role has to guess a tool name', () => {
    expect(serverSrc).toMatch(/app\.get\('\/v1\/agent\/tools'/);
    expect(serverSrc).toMatch(/takes: Object\.keys/);
  });

  it('gives data a bigger budget than prose, and says so when it still does not fit', () => {
    expect(agentSrc).toMatch(/const DATA_CAP = 24000;/);
    expect(agentSrc).toMatch(/observeData/);
    expect(agentSrc).toMatch(/more characters — return less/);
    // the prose observation is untouched
    expect(agentSrc).toMatch(/const observe = \(text\) => \{ messages\.push\(\{ role: 'tool', content: String\(text\)\.slice\(0, 6000\) \}\); \};/);
  });
});

describe('a script may READ the page; it may never ACT on it', () => {
  const refused = (src) => agent.scriptRefusal(src);

  it('allows the reading a scout actually needs', () => {
    for (const ok of [
      "return [...document.querySelectorAll('article')].map(a => ({ title: a.querySelector('h3')?.innerText, url: a.querySelector('a')?.href }))",
      'return JSON.parse(document.querySelector("#data").textContent).items.length',
      'document.title',
      "return [...document.querySelectorAll('tr')].map(r => [...r.cells].map(c => c.innerText))",
      'return window.__NEXT_DATA__ && Object.keys(window.__NEXT_DATA__)',
    ]) expect(refused(ok), ok.slice(0, 50)).toBeNull();
  });

  it('refuses every way a snippet could act instead of read — and names the tool that does it properly', () => {
    const cases = [
      ['return fetch("/api/x").then(r => r.json())', /fetch_data/],
      ['const x = new XMLHttpRequest(); return x', /fetch_data/],
      ['navigator.sendBeacon("/x")', /fetch_data/],
      ['return await import("/evil.js")', /fetch_data/],
      ['document.querySelector("button").click()', /owner's approval gate/],
      ['document.forms[0].submit()', /owner's approval gate/],
      ['el.dispatchEvent(new MouseEvent("click"))', /click, type or act/],
      ['return document.cookie', /session token must never leave/],
      ['localStorage.setItem("a", 1)', /may not write storage/],
      ['window.open("https://x.com")', /may not navigate/],
      ['location.href = "https://x.com"', /may not navigate/],
      ['location.assign("https://x.com")', /may not navigate/],
      ['document.body.innerHTML = "<h1>hi</h1>"', /may not rewrite the page/],
      ['document.write("x")', /may not rewrite the page/],
    ];
    for (const [src, why] of cases) {
      const r = refused(src);
      expect(r, src).toBeTruthy();
      expect(r, src).toMatch(why);
    }
  });

  it('refuses the empty and the enormous', () => {
    expect(refused('')).toMatch(/empty/);
    expect(refused('   ')).toMatch(/empty/);
    expect(refused('return "' + 'x'.repeat(9000) + '"')).toMatch(/too long/);
  });

  it('wraps a snippet so both `return` and a bare expression work', () => {
    expect(agentSrc).toMatch(/\/\\breturn\\b\/\.test\(src\)/);
    expect(agentSrc).toMatch(/\(async \(\) => \{ \$\{src\} \}\)\(\)/);
    expect(agentSrc).toMatch(/\(async \(\) => \(\$\{src\}\)\)\(\)/);
  });
});

describe('fetch_data fetches in this session and cannot act', () => {
  it('uses the browser context\'s own request context (its cookies) and only ever GETs', () => {
    expect(agentSrc).toMatch(/session\.context && session\.context\.request/);
    expect(agentSrc).toMatch(/rq\.get\(url, \{ timeout: 30000, failOnStatusCode: false \}\)/);
    expect(agentSrc).not.toMatch(/rq\.(post|put|patch|delete)\(/);
  });

  it('refuses anything that is not a full http(s) address', () => {
    expect(agentSrc).toMatch(/fetch_data needs a full http\(s\) address/);
  });

  it('says what a 401/403 means instead of leaving a dead end', () => {
    expect(agentSrc).toMatch(/needs a login this profile does not have/);
  });

  it('pickPath walks into JSON, and says so when the path leads nowhere', () => {
    const data = { data: { children: [{ title: 'a' }, { title: 'b' }] }, after: 't3_x' };
    expect(agent.pickPath(data, 'data.children')).toHaveLength(2);
    expect(agent.pickPath(data, 'data.children.1.title')).toBe('b');
    expect(agent.pickPath(data, '')).toBe(data);
    expect(agent.pickPath(data, 'data.nope.deeper')).toBeUndefined();
    expect(agentSrc).toMatch(/does not lead anywhere in that JSON/);
  });
});

describe('the other four behave like a person would expect', () => {
  it('press_key takes only real keys, and Enter still answers to the act gate', () => {
    expect(agentSrc).toMatch(/const KEYS = \['Escape', 'Enter', 'Tab', 'PageDown'/);
    expect(agentSrc).toMatch(/key === 'Enter' && !settings\.autoAct/);
    expect(agentSrc).toMatch(/Refused: pressing Enter there publishes it/);
  });

  it('wait_for is bounded, works both ways, and explains a timeout', () => {
    expect(agentSrc).toMatch(/Math\.min\(30, Math\.max\(1, Number\(a\.seconds\) \|\| 15\)\)/);
    expect(agentSrc).toMatch(/g \? !has : has/);
    expect(agentSrc).toMatch(/never appeared/);
  });

  it('choose_option sets a real select and tells the page it changed', () => {
    expect(agentSrc).toMatch(/at\.tagName === 'SELECT' \? at : \(at\.closest \? at\.closest\('select'\) : null\)/);
    expect(agentSrc).toMatch(/new Event\('change', \{ bubbles: true \}\)/);
    expect(agentSrc).toMatch(/is not a dropdown/);
    expect(agentSrc).toMatch(/inside a frame/);
  });

  it('switching tabs moves the session and voids the old numbers', () => {
    expect(agentSrc).toMatch(/session\.page = open\[idx\];/);
    expect(agentSrc).toMatch(/session\.lastAnalysis = null;/);
    expect(agentSrc).toMatch(/The old numbers are void/);
  });
});
