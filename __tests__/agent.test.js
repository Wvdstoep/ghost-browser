/**
 * The agent: what it may do on its own, and what it must ask about first.
 *
 * This runs on a real account under a real name. Reading a page is free and reversible; a comment,
 * a join, a follow or a message is not — the notification has already reached a person and there is
 * no undo. Everything below is about that line, because everything else the agent does can be
 * fixed by pressing back.
 *
 * The browser is stubbed. What is being tested is the DECIDING, not Chromium: given what the model
 * asked for, does the loop act, refuse, or ask?
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-agent-'));
process.env.PROFILE_DIR = dir;

const agent = await import('../src/agent.js');
const jobsStore = await import('../src/jobs.js');
const company = await import('../src/company.js');
const me = await import('../src/me.js');

const ELEMENTS = [
  { index: 1, tag: 'a', text: 'Open the post', x: 10, y: 10 },
  { index: 2, tag: 'div', text: 'Reageren', ariaLabel: 'Reageren', x: 20, y: 20 },
  { index: 3, tag: 'button', text: 'Lid worden', x: 30, y: 30 },
];

/* A page that records what was done to it and answers everything else plausibly. */
function fakePage(url = 'https://www.facebook.com/groups/123') {
  const acted = [];
  const evaluate = async (fn) => {
    const src = String(fn);
    if (src.includes('innerText')) return 'a post about a leaking roof';
    if (src.includes('querySelectorAll')) return ELEMENTS;
    return 0;
  };
  const mainFrame = { evaluate, url: () => url, frameElement: async () => null };
  return {
    acted,
    url: () => url,
    title: async () => 'a group',
    /* The real inspector asks the page three things: the elements, the scroll position, and the
       text. Answering all three keeps look() on the same path it takes for real. */
    evaluate,
    screenshot: async () => Buffer.from(''),
    /* A REAL page always has at least one frame — itself — and the inspector tells the main frame
       apart from an iframe BY IDENTITY (`frame !== main`). So this has to be the same object every
       time: a fresh one each call reads as a cross-origin iframe, gets skipped, and look() comes
       back with nothing to click. The fake had no frames() at all, which threw the moment the page
       text was short enough to send read() looking inside frames — which this fixture's
       27-character post always is. */
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    goto: async (u) => { url = u; acted.push(['goto', u]); },
    goBack: async () => {},
    waitForLoadState: async () => {},
    mouse: { click: async (x, y, opts) => acted.push(['click', x, y, (opts && opts.clickCount) || 1]), wheel: async () => {} },
    keyboard: { type: async (t) => acted.push(['type', t]), press: async (k) => acted.push(['press', k]), insertText: async (t) => acted.push(['insert', t]) },
  };
}

function fakeSession(page = fakePage()) {
  return { id: 's1', owner: 'carla', profile: 'fb', page,
           lastAnalysis: { elements: ELEMENTS, url: page.url(), scrollY: 0 } };
}

/* The model, scripted: each entry is one turn's worth of tool calls. Handed to run() rather than
   patched onto the module — the loop takes `chat` as a parameter for exactly this. */
let chat;
function scriptedModel(turns) {
  const seen = [];
  chat = async ({ messages }) => {
    seen.push(JSON.parse(JSON.stringify(messages)));
    const next = turns.shift();
    if (!next) return { content: '', toolCalls: [{ name: 'finish', args: { summary: 'out of script' } }], raw: {} };
    return { content: next.content || '', toolCalls: next.calls || [], raw: {} };
  };
  return seen;
}

const SETTINGS = { llmHost: 'http://x', llmModel: 'm', llmKey: 'k', autoAct: false, maxSteps: 20 };
const start = (goal = 'find leads') =>
  jobsStore.create({ owner: 'carla', goal, companyId: null, profile: 'fb', sessionId: 's1' });

describe('the line between reading and acting', () => {
  it('asks before commenting, and does not touch the page until you say yes', async () => {
    const job = start();
    const session = fakeSession();
    scriptedModel([{ calls: [{ name: 'act', args: { kind: 'comment', index: 2, text: 'Ik kan er morgen naar kijken.', why: 'asked for a roofer' } }] }]);

    const running = agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    // Give the loop a moment to reach the proposal.
    for (let i = 0; i < 40 && !job.proposals.length; i++) await new Promise((r) => setTimeout(r, 25));

    expect(job.proposals).toHaveLength(1);
    expect(job.proposals[0]).toMatchObject({ kind: 'comment', state: 'pending' });
    expect(session.page.acted).toEqual([]);   // nothing has happened to the account yet

    jobsStore.stop(job, 'test over');
    await running;
  });

  it('sends what you approved, edits included', async () => {
    const job = start();
    const session = fakeSession();
    scriptedModel([
      { calls: [{ name: 'act', args: { kind: 'comment', index: 2, text: 'original' } }] },
      { calls: [{ name: 'finish', args: { summary: 'done' } }] },
    ]);

    const running = agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    for (let i = 0; i < 40 && !job.proposals.length; i++) await new Promise((r) => setTimeout(r, 25));
    jobsStore.decide(job, job.proposals[0].pid, 'approved', 'what I would actually say');
    await running;

    // The edited text is what was typed — not the model's draft.
    expect(session.page.acted.some(([k, v]) => k === 'type' && v === 'what I would actually say')).toBe(true);
    expect(session.page.acted.some(([k]) => k === 'press')).toBe(true);
  });

  it('sends nothing at all when you skip it', async () => {
    const job = start();
    const session = fakeSession();
    scriptedModel([
      { calls: [{ name: 'act', args: { kind: 'comment', index: 2, text: 'no thanks' } }] },
      { calls: [{ name: 'finish', args: { summary: 'moved on' } }] },
    ]);
    const running = agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    for (let i = 0; i < 40 && !job.proposals.length; i++) await new Promise((r) => setTimeout(r, 25));
    jobsStore.decide(job, job.proposals[0].pid, 'skipped');
    await running;
    expect(session.page.acted.filter(([k]) => k === 'type')).toEqual([]);
  });

  /* The second line of defence. The prompt tells the model not to click these; a model under
     pressure to finish does it anyway, and the cost lands on someone's real account. */
  it('refuses a direct click on a button that writes to the world', async () => {
    const job = start();
    const session = fakeSession();
    scriptedModel([
      { calls: [{ name: 'click', args: { index: 3, why: 'join the group' } }] },   // "Lid worden"
      { calls: [{ name: 'finish', args: { summary: 'stopped' } }] },
    ]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(session.page.acted.filter(([k]) => k === 'click')).toEqual([]);
    expect(job.steps.some((s) => s.kind === 'blocked')).toBe(true);
  });

  it('still lets it click things that only move it around', async () => {
    const job = start();
    const session = fakeSession();
    scriptedModel([
      { calls: [{ name: 'click', args: { index: 1, why: 'open the post' } }] },
      { calls: [{ name: 'finish', args: { summary: 'read it' } }] },
    ]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(session.page.acted.some(([k]) => k === 'click')).toBe(true);
  });

  /* With the guard off the person has said, explicitly, that it may act. It still goes through act
     so there is a record of every one. */
  it('acts without asking only when that was deliberately turned on', async () => {
    const job = start();
    const session = fakeSession();
    scriptedModel([
      { calls: [{ name: 'act', args: { kind: 'comment', index: 2, text: 'straight through' } }] },
      { calls: [{ name: 'finish', args: { summary: 'done' } }] },
    ]);
    await agent.run({ job, session, settings: { ...SETTINGS, autoAct: true }, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.proposals).toHaveLength(0);
    expect(session.page.acted.some(([k, v]) => k === 'type' && v === 'straight through')).toBe(true);
  });

  /* Typing into a field SETS it — a triple-click selects the field's existing text (field-scoped, NOT
     a page-wide Ctrl+A that selects the whole document), so typing replaces it. */
  it('triple-clicks to select the field, then types, so the value is replaced not appended', async () => {
    const job = start();
    const session = fakeSession();
    scriptedModel([
      { calls: [{ name: 'type', args: { index: 2, text: 'AI That Pays' } }] },
      { calls: [{ name: 'finish', args: { summary: 'done' } }] },
    ]);
    await agent.run({ job, session, settings: { ...SETTINGS, autoAct: true }, chat, pace: 0, idleTimeoutMs: 0 });
    const acted = session.page.acted;
    const iSel = acted.findIndex(([k, , , cc]) => k === 'click' && cc === 3);   // triple-click select
    const iType = acted.findIndex(([k, v]) => k === 'type' && v === 'AI That Pays');
    expect(iSel).toBeGreaterThanOrEqual(0);
    expect(iType).toBeGreaterThan(iSel);   // selected, THEN typed
    expect(acted.some(([k, v]) => k === 'press' && v === 'Control+A')).toBe(false);  // never page-wide
  });

  /* A weak model can look/read/scroll forever without ever changing the page. After the limit, the
     loop must FORCE it to act rather than let it observe the whole budget away. */
  it('forces an action after repeated observe-only calls with no page change', async () => {
    const job = start();
    const session = fakeSession();
    scriptedModel([
      { calls: [{ name: 'scroll', args: { direction: 'down' } }] },
      { calls: [{ name: 'scroll', args: { direction: 'down' } }] },
      { calls: [{ name: 'scroll', args: { direction: 'down' } }] },
      { calls: [{ name: 'scroll', args: { direction: 'down' } }] },
      { calls: [{ name: 'finish', args: { summary: 'done' } }] },
    ]);
    await agent.run({ job, session, settings: { ...SETTINGS, autoAct: true }, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.steps.some((s) => s.kind === 'blocked' && /forcing an action/i.test(s.text || ''))).toBe(true);
  });
});

describe('the write guard, on labels alone', () => {
  it.each([
    ['Reageren', true], ['Plaatsen', true], ['Lid worden', true], ['Verzenden', true],
    ['Volgen', true], ['Vind ik leuk', true], ['Post', true],
    ['Open the post', false], ['Zoeken', false], ['Terug', false], ['', false],
  ])('%s -> %s', (text, expected) => {
    expect(agent.looksLikeWrite({ text })).toBe(expected);
  });

  it('reads the accessible label too, since the visible text is often an icon', () => {
    expect(agent.looksLikeWrite({ text: '', ariaLabel: 'Reageren op deze post' })).toBe(true);
  });

  it('says no to an element that is not there rather than throwing', () => {
    expect(agent.looksLikeWrite(undefined)).toBe(false);
  });
});

describe('finishing, stopping and not running forever', () => {
  it('stops at the step limit instead of working an account all night', async () => {
    const job = start();
    // A model that never calls finish — the case the limit exists for.
    const never = async () => ({ content: '', toolCalls: [{ name: 'note', args: { text: 'thinking' } }], raw: {} });
    await agent.run({ job, session: fakeSession(), settings: { ...SETTINGS, maxSteps: 3 }, chat: never, pace: 0, idleTimeoutMs: 0 });
    // It PAUSES rather than ending: everything it read is still there, and "carry on" resumes it.
    expect(job.steps.some((st) => /3-step limit/.test(st.text))).toBe(true);
  });

  it('a failing model ends the job with the reason, not silence', async () => {
    const job = start();
    const rejects = async () => { throw Object.assign(new Error('the API key was rejected (401)'), { status: 401 }); };
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat: rejects, pace: 0, idleTimeoutMs: 0 });
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/key was rejected/);
  });

  /* One bad action is not a bad job — the whole value of a loop is that it can recover. */
  it('carries on after a tool throws, and tells the model what broke', async () => {
    const job = start();
    const page = fakePage();
    page.goto = async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); };
    scriptedModel([
      { calls: [{ name: 'open', args: { url: 'https://nope.invalid' } }] },
      { calls: [{ name: 'finish', args: { summary: 'recovered' } }] },
    ]);
    await agent.run({ job, session: fakeSession(page), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.steps.some((s) => s.kind === 'error')).toBe(true);
  });

  it('a model that answers in prose is asked for an action rather than left to stall', async () => {
    const job = start();
    const seen = scriptedModel([
      { content: 'I think I should look at the group first.' },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.steps.some((s) => s.kind === 'think')).toBe(true);
    expect(JSON.stringify(seen.at(-1))).toMatch(/Choose one tool/);
  });
});

describe('what the model is told', () => {
  it('puts the company profile in front of it', () => {
    const p = agent.systemPrompt({ goal: 'find leads', companyContext: 'Company: Dijkstra Dakwerken', autoAct: false });
    expect(p).toContain('Dijkstra Dakwerken');
    expect(p).toContain('find leads');
  });

  it('spells out the approval rule when approval is required', () => {
    expect(agent.systemPrompt({ goal: 'x', autoAct: false })).toMatch(/act, never through click/);
  });

  it('does not pretend approval is required when it is not', () => {
    expect(agent.systemPrompt({ goal: 'x', autoAct: true })).toMatch(/allowed you to act without asking/);
  });

  it('carries the owner’s own writing, which is what makes a reply sound like them', () => {
    const p = agent.systemPrompt({ goal: 'x', meContext: 'Things they have actually written:\n"heb je al een offerte?"', autoAct: false });
    expect(p).toContain('heb je al een offerte?');
    expect(p).toMatch(/under this person's name/);
  });

  it('lists the logins so it can pick the right account for the site', () => {
    const p = agent.systemPrompt({ goal: 'search linkedin', profileList: '- work-linkedin: linkedin.com', autoAct: false });
    expect(p).toContain('work-linkedin');
    expect(p).toMatch(/use_profile/);
  });
});

describe('keeping the transcript affordable', () => {
  it('shrinks old observations and leaves the recent ones whole', () => {
    const long = 'x'.repeat(3000);
    const msgs = Array.from({ length: 12 }, () => ({ role: 'tool', content: long }));
    agent.trimTranscript(msgs, 3);
    expect(msgs[0].content.length).toBeLessThan(400);
    expect(msgs.at(-1).content.length).toBe(3000);
  });

  it('leaves anything that is not an observation alone', () => {
    const msgs = [{ role: 'system', content: 'y'.repeat(3000) }, { role: 'tool', content: 'z'.repeat(3000) }];
    agent.trimTranscript(msgs, 0);
    expect(msgs[0].content.length).toBe(3000);
  });
});

describe('learning the person it acts as', () => {
  beforeEach(() => me.forget());

  it('keeps what they wrote verbatim, because that is the part that transfers', () => {
    me.addSample('Heb je al een offerte gehad? Wij doen dat gratis hoor.', 'Dakwerken NL');
    expect(me.asContext()).toContain('Heb je al een offerte gehad?');
  });

  it('throws away a sample too short to teach anything', () => {
    expect(me.addSample('ok thanks', 'somewhere')).toBeNull();
  });

  it('does not keep the same sentence twice', () => {
    me.addSample('Dat herken ik wel, bij ons lekte het ook bij de dakkapel.', 'a');
    expect(me.addSample('Dat herken ik wel, bij ons lekte het ook bij de dakkapel.', 'b')).toBeNull();
  });

  it('replaces a fact instead of collecting contradictions', () => {
    me.remember('region', 'Noord-Holland');
    me.remember('region', 'Amsterdam');
    expect(me.read().facts.region).toMatch(/Amsterdam/);
    expect(me.read().facts.region).not.toMatch(/Noord-Holland/);
  });

  it('forgetting really forgets', () => {
    me.remember('trade', 'roofer');
    me.addSample('Wij werken al twintig jaar in de regio.', 'x');
    me.forget();
    expect(me.summary().sampleCount).toBe(0);
    expect(me.asContext()).toBe('');
  });

  it('records what it learns during a job', async () => {
    const job = start('study me');
    scriptedModel([
      { calls: [
        { name: 'remember_about_me', args: { label: 'trade', value: 'dakdekker', source: 'his profile' } },
        { name: 'save_my_writing', args: { text: 'Zal ik even langskomen om te kijken?', where: 'a comment' } },
        { name: 'describe_my_voice', args: { style: 'Short, direct, no emoji.' } },
      ] },
      { calls: [{ name: 'finish', args: { summary: 'learned' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    const m = me.summary();
    expect(m.facts.trade).toMatch(/dakdekker/);
    expect(m.sampleCount).toBe(1);
    expect(m.style).toMatch(/no emoji/);
  });
});

describe('working across more than one account', () => {
  it('switches to another stored login and keeps working there', async () => {
    const job = start('search linkedin');
    const first = fakeSession();
    const second = fakeSession(fakePage('https://www.linkedin.com/feed/'));
    second.id = 's2'; second.profile = 'work-linkedin';

    scriptedModel([
      { calls: [{ name: 'use_profile', args: { profile: 'work-linkedin' } }] },
      { calls: [{ name: 'finish', args: { summary: 'on linkedin now' } }] },
    ]);
    await agent.run({ job, session: first, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, switchProfile: async () => second });

    expect(job.sessionId).toBe('s2');
    expect(job.steps.some((s) => s.text.includes('work-linkedin'))).toBe(true);
  });

  it('says so rather than pretending, when switching is not available', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'use_profile', args: { profile: 'nope' } }] },
      { calls: [{ name: 'finish', args: { summary: 'stayed put' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.sessionId).toBe('s1');
  });
});

describe('the leads, which are the actual product', () => {
  it('records one the moment it is found', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'save_lead', args: { name: 'Jan de Vries', why: 'asked for a roofer', url: 'https://fb/p/1' } }] },
      { calls: [{ name: 'finish', args: { summary: 'one found' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.leads).toHaveLength(1);
    expect(job.leads[0].name).toBe('Jan de Vries');
  });

  /* A group post with no link is the dead lead that once made the reply step wander every group. */
  it('refuses a group-post lead that has no post link', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'save_lead', args: { name: 'Rae', why: 'building an app', groupName: 'Lovable AI' } }] },
      { calls: [{ name: 'finish', args: { summary: 'done' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.leads).toHaveLength(0);                                  // not saved
    expect(job.steps.some((s) => s.kind === 'blocked' && /no link/.test(s.text))).toBe(true);
  });

  it('still saves a group lead when the post link IS there', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'save_lead', args: { name: 'Rae', why: 'building an app', groupName: 'Lovable AI', postUrl: 'https://facebook.com/groups/1/posts/2' } }] },
      { calls: [{ name: 'finish', args: { summary: 'done' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.leads).toHaveLength(1);
  });

  it('looksGarbled catches corrupted drafts but passes clean ones', () => {
    // the real failure: the model fused two candidates and ended with the whole message duplicated
    const dup = 'Też cię bardzo kocham ❤️ Morgen kunnen we lekker samen iets doen, jij mag kiezen schat.Też cię bardzo kocham ❤️ Morgen kunnen we lekker samen iets doen, jij mag kiezen schat.';
    expect(agent.looksGarbled(dup)).toBe(true);
    // word-salad interleaving (capitals inside words + nonsense consonant runs)
    const salad = 'hebT eje ż zicn iom ę erbgaenrsd nzaaor toke otce hgaaamn kchtzj vmena szij';
    expect(agent.looksGarbled(salad)).toBe(true);
    // clean messages pass, including normal multilingual + emoji
    expect(agent.looksGarbled('Też cię bardzo kocham ❤️ Tomorrow we can do something together, you choose.')).toBe(false);
    expect(agent.looksGarbled('Hi Rae, welcome to the group! What kind of app are you looking to build?')).toBe(false);
    expect(agent.looksGarbled('ok thanks!')).toBe(false);
  });

  /* The data seam: a planning step hands a structured object to the next step. */
  it('stores a structured object under a key with store_data', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'store_data', args: { key: 'storyboard', value: { style_anchor: 'moody', scenes: [{ i: 1 }, { i: 2 }] } } }] },
      { calls: [{ name: 'finish', args: { summary: 'planned' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.data.storyboard.scenes).toHaveLength(2);
    expect(job.data.storyboard.style_anchor).toBe('moody');
  });

  it('store_data parses a JSON string into structure (models often stringify)', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'store_data', args: { key: 'storyboard', value: '{"scenes":[{"i":1},{"i":2},{"i":3}]}' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(Array.isArray(job.data.storyboard.scenes)).toBe(true);   // parsed, not left a string
    expect(job.data.storyboard.scenes).toHaveLength(3);
  });

  /* The same post reached through two groups is one lead. Without this the list looks productive
     and is not — and a person has to check every duplicate by hand. */
  it('does not count the same person twice', async () => {
    const job = start();
    const lead = { name: 'Jan de Vries', why: 'roof', url: 'https://fb/p/1' };
    scriptedModel([
      { calls: [{ name: 'save_lead', args: lead }, { name: 'save_lead', args: lead }] },
      { calls: [{ name: 'finish', args: { summary: 'done' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.leads).toHaveLength(1);
  });
});

describe('being steered while it works', () => {
  it('passes a mid-run message to the model at the next step', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'note', args: { text: 'looking around' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    jobsStore.say(job, 'not that group, try Dakwerken NL');
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(JSON.stringify(seen)).toMatch(/Dakwerken NL/);
  });
});

describe('the company profile the agent judges posts against', () => {
  it('leaves out what was not filled in, rather than teaching it that blanks are normal', () => {
    const c = company.save({ name: 'Dijkstra', signals: 'mentions a leak' });
    const ctx = company.asContext(c);
    expect(ctx).toContain('mentions a leak');
    expect(ctx).not.toMatch(/audience/i);
  });

  it('keeps the do-not-approach list, which is the one nobody thinks to check', () => {
    const c = company.save({ name: 'Dijkstra', avoid: 'competitors and existing customers' });
    expect(company.asContext(c)).toMatch(/Never approach: competitors/);
  });
});

/**
 * A conversation, not a job.
 *
 * The first version ran once, reported, and died — so the second thing you said started a fresh
 * agent that had never seen the first. That is not how anyone works with an assistant. Finishing
 * now means going IDLE: the transcript stays, and the next message continues from it.
 */
describe('carrying on where it left off', () => {
  it('goes idle rather than ending, and idle is not over', async () => {
    const job = start();
    scriptedModel([{ calls: [{ name: 'finish', args: { summary: 'found three' } }] }]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    // idleTimeoutMs 0 closes it immediately here; what matters is that finish did not mark it over.
    expect(job.steps.some((s) => s.kind === 'done' && /found three/.test(s.text))).toBe(true);
  });

  it('picks the next message up with everything it already read', async () => {
    const job = start('find leads in the roofing group');
    const seen = scriptedModel([
      { calls: [{ name: 'read', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'read the group' } }] },
      { calls: [{ name: 'finish', args: { summary: 'and the second thing too' } }] },
    ]);
    const running = agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 60000 });
    for (let i = 0; i < 60 && job.status !== 'idle'; i++) await new Promise((r) => setTimeout(r, 25));

    jobsStore.say(job, 'now do the same in the second group');
    for (let i = 0; i < 60 && job.status === 'running'; i++) await new Promise((r) => setTimeout(r, 25));
    jobsStore.stop(job);
    await running;

    // The SAME transcript: the last turn still carries the first message and the page it read.
    const last = JSON.stringify(seen.at(-1));
    expect(last).toMatch(/find leads in the roofing group/);
    expect(last).toMatch(/second group/);
    expect(last).toMatch(/leaking roof/);     // the page text from before it went idle
  });

  it('saying something wakes it', async () => {
    const job = start();
    scriptedModel([{ calls: [{ name: 'finish', args: { summary: 'done' } }] }]);
    const running = agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 60000 });
    for (let i = 0; i < 60 && job.status !== 'idle'; i++) await new Promise((r) => setTimeout(r, 25));
    expect(job.status).toBe('idle');
    jobsStore.say(job, 'carry on');
    expect(job.status).toBe('running');
    jobsStore.stop(job);
    await running;
  });

  /* A parked conversation holds one of only two browser contexts. An agent still nominally alive at
     three in the morning is a session nobody else can open. */
  it('closes itself after sitting idle, instead of holding a browser forever', async () => {
    const job = start();
    scriptedModel([{ calls: [{ name: 'finish', args: { summary: 'done' } }] }]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.status).toBe('stopped');
    expect(jobsStore.isOver(job)).toBe(true);
  });

  it('stopped stays stopped — a late message cannot restart it', async () => {
    const job = start();
    jobsStore.stop(job);
    jobsStore.say(job, 'hello?');
    expect(job.status).toBe('stopped');
  });
});

describe('the transcript a person reads', () => {
  it('records the call before the result, so a refusal is visible as a refusal', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'click', args: { index: 3, why: 'join' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    const tool = job.steps.find((s) => s.kind === 'tool');
    expect(tool.text).toBe('click([3])');
    expect(tool.tool).toBe('click');
    // ...and immediately after it, the page's answer: refused.
    expect(job.steps[job.steps.indexOf(tool) + 1].kind).toBe('blocked');
  });

  it('summarises a call by what identifies it, not by dumping the arguments', () => {
    expect(agent.summariseCall('open', { url: 'https://facebook.com/groups/1' })).toBe('open(https://facebook.com/groups/1)');
    expect(agent.summariseCall('act', { kind: 'comment', index: 4, text: 'x'.repeat(400) }).length).toBeLessThan(200);
    expect(agent.summariseCall('look', {})).toBe('look()');
  });
});

/**
 * Following the agent when it changes browsers.
 *
 * Seen live and it was the worst kind of bug: everything worked. The agent opened on a throwaway
 * profile, saw the job was about Facebook groups, listed the stored logins, switched to the real
 * one and got on with it — and the screen kept showing the throwaway sitting on a cookie wall,
 * because the live view was bound to the session the conversation STARTED with.
 *
 * The transcript said one thing and the picture said another, and people believe the picture.
 */
describe('when it moves to another login', () => {
  /* Announced on the bus, which is what the UI's socket listens to. Tested directly rather than
     through the loop: vitest hands the CJS require() inside agent.js a different module instance
     from this file's import, so the two do not share an event bus — an artefact of the test runner,
     not of the code, and worth knowing before chasing it a second time. */
  it('announces the move on the bus a watcher is listening to', () => {
    const job = start();
    const events = [];
    jobsStore.bus.on(job.id, (e) => events.push(e));
    jobsStore.switchedSession(job, { sessionId: 's2', profile: 'work-linkedin' });
    expect(events.find((e) => e.type === 'session')).toMatchObject({ sessionId: 's2', profile: 'work-linkedin' });
  });

  it('leaves the job naming the browser it is really in, so a reconnect lands there', async () => {
    const job = start('search linkedin');
    const second = fakeSession(fakePage('https://www.linkedin.com/feed/'));
    second.id = 's2'; second.profile = 'work-linkedin';
    scriptedModel([
      { calls: [{ name: 'use_profile', args: { profile: 'work-linkedin' } }] },
      { calls: [{ name: 'finish', args: { summary: 'there now' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0,
                      switchProfile: async () => second });
    expect(jobsStore.view(job)).toMatchObject({ sessionId: 's2', profile: 'work-linkedin' });
  });

  it('does not rewrite the session when it stays put', async () => {
    const job = start();
    scriptedModel([{ calls: [{ name: 'finish', args: { summary: 'done' } }] }]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.sessionId).toBe('s1');
  });
});

/**
 * A hiccup from the model is not the end of the conversation.
 *
 * Seen live after forty minutes of reading Facebook groups:
 *
 *     the model returned 500: Internal Server Error (ref: 1b6a44b1-…)
 *
 * and the whole thing went to `failed`, which is terminal — the leads were on disk but there was
 * nothing left to say "carry on" to. A hosted model returning a 500 with a support reference is
 * their side having a moment. It should cost seconds, not the session.
 */
describe('when the model has a moment', () => {
  const boom = (status, msg = 'the model returned 500: Internal Server Error') =>
    Object.assign(new Error(msg), { status });

  it('tries again, and carries on when the second attempt works', async () => {
    let n = 0;
    const flaky = async () => {
      if (++n === 1) throw boom(502);
      return { content: '', toolCalls: [{ name: 'finish', args: { summary: 'fine after all' } }], raw: {} };
    };
    const job = start();
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat: flaky, pace: 0, idleTimeoutMs: 0 });
    expect(n).toBe(2);
    expect(job.steps.some((s) => s.kind === 'done' && /fine after all/.test(s.text))).toBe(true);
  });

  it('pauses instead of dying when it keeps failing, so nothing is lost', async () => {
    const job = start();
    const always = async () => { throw boom(500); };
    // idleTimeoutMs 0 closes it straight after; what matters is that it was not marked failed.
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat: always, pace: 0, idleTimeoutMs: 0 });
    expect(job.status).not.toBe('failed');
    expect(job.steps.some((s) => /carry on/.test(s.text))).toBe(true);
  });

  /* A rejected key is not something another attempt fixes — it needs a person to change a setting,
     and three more failed requests only delay telling them. */
  it('does not retry a rejected key, and says so plainly', async () => {
    let n = 0;
    const job = start();
    const rejected = async () => { n++; throw boom(401, 'the API key was rejected (401)'); };
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat: rejected, pace: 0, idleTimeoutMs: 0 });
    expect(n).toBe(1);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/key was rejected/);
  });

  it.each([[500], [502], [503], [504], [undefined]])('retries a %s', async (status) => {
    let n = 0;
    const chatty = async () => { n++; throw Object.assign(new Error('x'), { status }); };
    await agent.run({ job: start(), session: fakeSession(), settings: SETTINGS, chat: chatty, pace: 0, idleTimeoutMs: 0 });
    expect(n).toBe(3);
  });

  it.each([[400], [401], [403], [404]])('does not retry a %s', async (status) => {
    let n = 0;
    const chatty = async () => { n++; throw Object.assign(new Error('x'), { status }); };
    await agent.run({ job: start(), session: fakeSession(), settings: SETTINGS, chat: chatty, pace: 0, idleTimeoutMs: 0 });
    expect(n).toBe(1);
  });
});

/**
 * Not paying twice for the same page.
 *
 * Every look() sent sixty element lines and every read() up to six thousand characters, on EVERY
 * step — most of the bill, and on a hosted model a large part of why one eventually 500s. Worse,
 * a scroll that loaded nothing followed by a read returning identical text taught the model that
 * the group was worth another pass.
 */
describe('not resending what it has already seen', () => {
  it('says the page has not changed instead of repeating the whole element list', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'look', args: {} }] },
      { calls: [{ name: 'look', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    const observations = seen.at(-1).filter((m) => m.role === 'tool').map((m) => m.content);
    expect(observations.some((c) => /nothing on it has changed/.test(c))).toBe(true);
  });

  it('says the text is the same rather than handing back an identical page', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'read', args: {} }] },
      { calls: [{ name: 'read', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    const observations = seen.at(-1).filter((m) => m.role === 'tool').map((m) => m.content);
    expect(observations.some((c) => /same text you already read/.test(c))).toBe(true);
    // ...and it says what to do about it, rather than leaving the model to guess.
    expect(observations.some((c) => /Scroll further, or move on/.test(c))).toBe(true);
  });

  /* THE FAILURE THAT LOST A LINKEDIN RUN. The agent built search URLs, opened them and read the raw
     page - which returns the frame, not the posts, because the posts stream in on scroll. Reading a
     SEARCH page now redirects to sweep instead of handing back useless text. */
  it('sends the agent to sweep when it reads a search page by hand', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'read', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    const sess = fakeSession(fakePage('https://www.linkedin.com/search/results/content/?keywords=developer'));
    await agent.run({ job, session: sess, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    const observations = seen.at(-1).filter((m) => m.role === 'tool').map((m) => m.content);
    expect(observations.some((c) => /sweep\(/.test(c))).toBe(true);
    expect(observations.some((c) => /Do NOT read it by hand/i.test(c))).toBe(true);
  });

  it('still reads a group page normally', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'read', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(fakePage('https://www.facebook.com/groups/123')),
                      settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    const observations = seen.at(-1).filter((m) => m.role === 'tool').map((m) => m.content);
    expect(observations.some((c) => /Page text:/.test(c))).toBe(true);
  });
});

/**
 * Leads leaving as they are found.
 *
 * Not batched at the end: a run is often forty minutes behind a login that took an afternoon to
 * get, and anything that only happens "at the end" is anything that can be lost. The other half of
 * the same rule is that the far end being unreachable must cost the run nothing.
 */
describe('handing leads to LeadFlow', () => {
  const sinkStub = () => {
    const sent = [];
    return { sent, label: 'LeadFlow', searchId: 42,
             send: async (l) => { sent.push(l); return { created: true, total: sent.length }; },
             close: async () => ({ ok: true }) };
  };

  it('sends each one immediately, not at the end', async () => {
    const job = start();
    const sink = sinkStub();
    scriptedModel([
      { calls: [{ name: 'save_lead', args: { name: 'Jan', why: 'roof' } }] },
      { calls: [{ name: 'save_lead', args: { name: 'Piet', why: 'gutter' } }] },
      { calls: [{ name: 'finish', args: { summary: 'two' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, sink });
    expect(sink.sent.map((l) => l.name)).toEqual(['Jan', 'Piet']);
  });

  it('closes the search when the run ends, so it stops saying "processing"', async () => {
    const job = start();
    const sink = sinkStub();
    let closed = null;
    sink.close = async (failed) => { closed = failed; return { ok: true }; };
    scriptedModel([{ calls: [{ name: 'finish', args: { summary: 'done' } }] }]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, sink });
    expect(closed).toBe(false);
  });

  /* The lead is already in the job record either way. Losing the run over a bad minute at the far
     end would be the expensive direction of that trade. */
  it('keeps working when the far end refuses, and says so out loud', async () => {
    const job = start();
    const sink = sinkStub();
    sink.send = async () => { throw new Error('that ingest token is expired or invalid'); };
    scriptedModel([
      { calls: [{ name: 'save_lead', args: { name: 'Jan', why: 'roof' } }] },
      { calls: [{ name: 'finish', args: { summary: 'carried on' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, sink });
    expect(job.leads).toHaveLength(1);                       // kept here
    expect(job.steps.some((s) => /expired or invalid/.test(s.text))).toBe(true);
    expect(job.steps.some((s) => s.kind === 'done')).toBe(true);
  });

  it('tells the model the lead landed, so it does not try again', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'save_lead', args: { name: 'Jan', why: 'roof' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, sink: sinkStub() });
    expect(JSON.stringify(seen.at(-1))).toMatch(/LeadFlow/);
  });

  it('works exactly as before with nowhere to send', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'save_lead', args: { name: 'Jan', why: 'roof' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.leads).toHaveLength(1);
  });
});

/**
 * The conversation, not just the find.
 *
 * Finding someone who asked for a roofer is the easy half. What turns it into money is the sequence
 * after it — you replied, they answered three days later, eventually they said "call me". That only
 * exists if every exchange is written down as it happens.
 *
 * And the Facebook mechanic is NOT an inbox: a reply arrives as a notification. So the agent asks
 * who it is waiting on, matches names it is already carrying against the notifications page, and
 * only opens the ones that matter.
 */
describe('keeping the conversation', () => {
  const convoStub = () => {
    const calls = [];
    return {
      calls, label: 'LeadFlow',
      awaiting: async () => {
        calls.push(['awaiting']);
        return { leads: [{
          id: 5, name: 'Jan de Vries', groupName: 'Dakwerken NL', postUrl: 'https://fb/p/1',
          postText: 'wie kent een goede dakdekker?',
          said: { text: 'Ik kan er morgen naar kijken', channel: 'comment', at: '2026-08-24' },
        }] };
      },
      match: async (q) => {
        calls.push(['match', q]);
        return {
          lead: { id: 5, name: 'Jan de Vries', stage: 'contacted', postText: 'wie kent een goede dakdekker?' },
          recent: [{ direction: 'out', text: 'Ik kan er morgen naar kijken' }],
        };
      },
      touch: async (t) => {
        calls.push(['touch', t]);
        return { stage: t.direction === 'in' ? 'replied' : 'contacted',
                 category: t.direction === 'in' ? 'wants_call' : null };
      },
      conversation: async (id) => {
        calls.push(['conversation', id]);
        return { lead: { name: 'Jan', stage: 'replied' }, touches: [] };
      },
    };
  };

  it('hands the agent the list, the post AND what it already said', async () => {
    const job = start();
    const convo = convoStub();
    const seen = scriptedModel([
      { calls: [{ name: 'waiting_on', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, convo });
    const obs = JSON.stringify(seen.at(-1));
    expect(obs).toMatch(/Jan de Vries/);
    expect(obs).toMatch(/wie kent een goede dakdekker/);   // their words
    expect(obs).toMatch(/Ik kan er morgen naar kijken/);   // ours, so a reply is recognisable
    // ...and told not to open every notification, which is the whole point of carrying the list.
    expect(obs).toMatch(/Only open the ones that match/);
  });

  it('matches a notification to a lead without opening the post', async () => {
    const job = start();
    const convo = convoStub();
    scriptedModel([
      { calls: [{ name: 'whose_is_this', args: { name: 'Jan de Vries' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, convo });
    expect(convo.calls.find((c) => c[0] === 'match')[1]).toMatchObject({ name: 'Jan de Vries' });
  });

  /* The verdict comes from LeadFlow's own classifier, the same one its email replies go through.
     The agent is TOLD what the pipeline decided rather than deciding it itself, or the two halves
     would disagree about the same words. */
  it('records a reply and reports the verdict rather than inventing one', async () => {
    const job = start();
    const convo = convoStub();
    const seen = scriptedModel([
      { calls: [{ name: 'record_reply', args: { leadId: 5, text: 'ja bel me maar', url: 'https://fb/c/9' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, convo });
    const t = convo.calls.find((c) => c[0] === 'touch')[1];
    expect(t).toMatchObject({ leadId: 5, direction: 'in', text: 'ja bel me maar' });
    // Wanting a call is a person's job, and the agent is told to stop rather than answer it.
    expect(JSON.stringify(seen.at(-1))).toMatch(/that is a prospect/);
  });

  /*
   * Relying on the model to remember to log what it just sent is relying on it at exactly the
   * moment it is most pleased with itself. An unrecorded outbound message is worse than none: the
   * next sweep reads the reply as an unprompted stranger.
   */
  it('records an approved message by itself, without the model asking', async () => {
    const job = start();
    const convo = convoStub();
    scriptedModel([
      { calls: [{ name: 'act', args: { kind: 'comment', index: 2, text: 'ik kijk er morgen naar', leadId: 5 } }] },
      { calls: [{ name: 'finish', args: { summary: 'sent' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: { ...SETTINGS, autoAct: true }, chat, pace: 0, idleTimeoutMs: 0, convo });
    const t = convo.calls.find((c) => c[0] === 'touch')[1];
    expect(t).toMatchObject({ leadId: 5, direction: 'out', channel: 'comment', text: 'ik kijk er morgen naar' });
  });

  it('marks a message as approved when a person approved it', async () => {
    const job = start();
    const convo = convoStub();
    scriptedModel([
      { calls: [{ name: 'act', args: { kind: 'comment', index: 2, text: 'x', leadId: 5 } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    const running = agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, convo });
    for (let i = 0; i < 40 && !job.proposals.length; i++) await new Promise((r) => setTimeout(r, 25));
    jobsStore.decide(job, job.proposals[0].pid, 'approved');
    await running;
    expect(convo.calls.find((c) => c[0] === 'touch')[1].approved).toBe(true);
  });

  it('carries on when the conversation store refuses, rather than losing the run', async () => {
    const job = start();
    const convo = convoStub();
    convo.touch = async () => { throw new Error('that token is expired or invalid'); };
    scriptedModel([
      { calls: [{ name: 'act', args: { kind: 'comment', index: 2, text: 'x', leadId: 5 } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: { ...SETTINGS, autoAct: true }, chat, pace: 0, idleTimeoutMs: 0, convo });
    expect(job.steps.some((s) => s.kind === 'error' && /expired/.test(s.text))).toBe(true);
    expect(job.steps.some((s) => s.kind === 'acted')).toBe(true);
  });

  it('says so plainly when this run has no LeadFlow behind it', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'waiting_on', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(JSON.stringify(seen.at(-1))).toMatch(/not connected to LeadFlow/i);
  });
});

describe('a lead that is a person, not a business', () => {
  it('keeps the person, the post and the group — the part an API cannot return', async () => {
    const job = start();
    const sent = [];
    const sink = { label: 'LeadFlow', searchId: 1, send: async (l) => { sent.push(l); return { id: 5, created: true }; }, close: async () => ({}) };
    scriptedModel([
      { calls: [{ name: 'save_lead', args: {
        name: 'Jan de Vries', why: 'asked for a roofer',
        postText: 'wie kent een goede dakdekker in Alkmaar?',
        postUrl: 'https://facebook.com/groups/1/posts/2',
        groupName: 'Dakwerken NL', platform: 'facebook',
      } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, sink });
    expect(sent[0]).toMatchObject({
      name: 'Jan de Vries', groupName: 'Dakwerken NL', platform: 'facebook',
      postUrl: 'https://facebook.com/groups/1/posts/2',
      postText: 'wie kent een goede dakdekker in Alkmaar?',
    });
  });

  /* Without the id there is nowhere to record what is said next, and the next sweep reads the
     reply as an unprompted stranger. */
  it('remembers the id LeadFlow gives back, and tells the model to use it', async () => {
    const job = start();
    const sink = { label: 'LeadFlow', searchId: 1, send: async () => ({ id: 77, created: true }), close: async () => ({}) };
    const seen = scriptedModel([
      { calls: [{ name: 'save_lead', args: { name: 'Jan', why: 'roof' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, sink });
    expect(job.leads[0].leadId).toBe(77);
    expect(JSON.stringify(seen.at(-1))).toMatch(/leadId 77/);
  });
});

/*
 * A PLACE IS NOT A POST — the record a live Maps walk needed and did not have.
 *
 * Carla's first real search ("Garage" in Rotterdam) came back with a review of a PARKING garage and
 * nothing else: no address, no rating, no reviews. save_lead builds a fixed, social-shaped object,
 * so every field a Maps card actually carries was dropped before LeadFlow ever saw it, and there was
 * no way for anything downstream to notice the place was the wrong KIND of business.
 */
describe('a place, which is a business and not a post', () => {
  const PLACE = {
    name: 'Autobedrijf De Vries', category: 'Auto repair shop',
    why: 'no website, no way to book online', missing: ['no website', 'no online booking'],
    address: 'Schiedamseweg 12, Rotterdam', city: 'Rotterdam', country: 'nl',
    phone: '010 123 4567', mapsUrl: 'https://maps.google.com/?cid=123',
    rating: 4.2, ratingsCount: 87, hours: 'Mon-Fri 08:00-17:30', claimed: false,
    attributes: ['Appointment required'],
    reviews: [
      { author: 'Jan', rating: 5, when: 'a week ago', text: 'Snel geholpen.', ownerReply: 'Bedankt!' },
      { author: 'Sanne', rating: 2, when: '3 weeks ago', text: 'Gebeld, niemand neemt op.' },
    ],
  };

  it('keeps the whole card and every review, and hands it to LeadFlow', async () => {
    const job = start();
    const sent = [];
    const sink = { label: 'LeadFlow', searchId: 1, send: async (l) => { sent.push(l); return { id: 9, created: true }; }, close: async () => ({}) };
    scriptedModel([
      { calls: [{ name: 'save_place', args: PLACE }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, sink });
    expect(job.leads).toHaveLength(1);
    expect(job.leads[0]).toMatchObject({
      kind: 'place', name: 'Autobedrijf De Vries', category: 'Auto repair shop',
      address: 'Schiedamseweg 12, Rotterdam', city: 'Rotterdam', country: 'NL',
      rating: 4.2, ratingsCount: 87, hours: 'Mon-Fri 08:00-17:30', claimed: false,
      mapsUrl: 'https://maps.google.com/?cid=123', platform: 'google',
    });
    expect(job.leads[0].reviews).toHaveLength(2);
    expect(job.leads[0].reviews[1].ownerReply).toBe(null);
    expect(job.leads[0].missing).toEqual(['no website', 'no online booking']);
    expect(sent[0].reviews).toHaveLength(2);
  });

  /* The quote a first line is written from should be the complaint, not the compliment. */
  it('quotes the unhappiest customer', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'save_place', args: PLACE }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.leads[0].quote).toMatch(/niemand neemt op/);
  });

  /*
   * THE REFUSAL THAT WOULD HAVE CAUGHT THE PARKING GARAGE. The category is Maps' own word for what
   * the business is; without it nothing downstream can tell a car park from a car repair shop.
   */
  it('refuses a place with no category, and says why', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'save_place', args: { ...PLACE, category: '' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.leads).toHaveLength(0);
    expect(JSON.stringify(seen.at(-1))).toMatch(/category/i);
  });

  it('refuses a place nobody can open', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'save_place', args: { ...PLACE, mapsUrl: '' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.leads).toHaveLength(0);
  });

  it('tells the walk when it saved a place without reading the reviews', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'save_place', args: { ...PLACE, reviews: [] } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.leads).toHaveLength(1);
    expect(JSON.stringify(seen.at(-1))).toMatch(/NO REVIEWS KEPT/);
  });

  it('the same business is not saved twice', async () => {
    const job = start();
    scriptedModel([
      { calls: [{ name: 'save_place', args: PLACE }] },
      { calls: [{ name: 'save_place', args: PLACE }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.leads).toHaveLength(1);
  });
});

describe('what the model is told about replies', () => {
  it('explains that a Facebook reply is a notification, not an inbox', () => {
    const p = agent.systemPrompt({ goal: 'check for replies', autoAct: false });
    expect(p).toMatch(/does NOT arrive in an inbox/);
    expect(p).toMatch(/waiting_on/);
  });

  it('tells it to stop and hand over when somebody wants a call', () => {
    expect(agent.systemPrompt({ goal: 'x', autoAct: false })).toMatch(/asks for a call, say so and stop/);
  });
});

/**
 * Who the owner sells for, read from LeadFlow rather than kept twice.
 *
 * The console used to hold its own company profile — what you offer, who you want, what to avoid.
 * LeadFlow already had all of it, on the user, feeding its templates, its campaigns and its own
 * agent. Two copies of the same facts is not redundancy; it is a guarantee that one of them is
 * stale, with no way to tell which.
 */
describe('where the company context comes from', () => {
  const withBusiness = (b) => ({
    label: 'LeadFlow',
    business: async () => b,
    awaiting: async () => ({ leads: [] }),
    match: async () => ({ lead: null }),
    touch: async () => ({ stage: 'contacted' }),
    conversation: async () => ({ lead: {}, touches: [] }),
  });

  it('uses LeadFlow’s profile in the prompt', async () => {
    const job = start();
    const seen = scriptedModel([{ calls: [{ name: 'finish', args: { summary: 'ok' } }] }]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0,
      convo: withBusiness({ configured: true, context: 'What we offer: roof repair\nNever do this: contact competitors' }) });
    const system = seen[0][0].content;
    expect(system).toMatch(/roof repair/);
    expect(system).toMatch(/Never do this: contact competitors/);
  });

  /* Saying it beats judging every lead against a blank page and finding out forty minutes later. */
  it('says so when nobody has filled it in', async () => {
    const job = start();
    scriptedModel([{ calls: [{ name: 'finish', args: { summary: 'ok' } }] }]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0,
      convo: withBusiness({ configured: false, context: '' }) });
    expect(job.steps.some((s) => /no business profile set in LeadFlow/.test(s.text))).toBe(true);
  });

  it('carries on when LeadFlow cannot be asked, rather than refusing to start', async () => {
    const job = start();
    const convo = withBusiness(null);
    convo.business = async () => { throw new Error('that token is expired or invalid'); };
    scriptedModel([{ calls: [{ name: 'finish', args: { summary: 'ok' } }] }]);
    await agent.run({ job, session: fakeSession(), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0, convo });
    expect(job.steps.some((s) => /could not read your business profile/.test(s.text))).toBe(true);
    expect(job.steps.some((s) => s.kind === 'done')).toBe(true);
  });
});

/**
 * Surviving a page that closes underneath you.
 *
 * Every one of the first three real runs died the same way: Facebook closed a page nobody asked it
 * to close, and every tool kept pointing at the dead object — "Target page, context or browser has
 * been closed", twenty times, until the step limit. It reads as an agent that is not clever enough.
 * It is nothing of the sort; the model said plainly that it needed a human to restart the browser,
 * which was true. Nothing was putting the browser back.
 */
describe('when the page closes underneath it', () => {
  const closable = () => {
    let closed = false;
    const page = fakePage();
    page.isClosed = () => closed;
    return { page, kill: () => { closed = true; } };
  };

  const contextWith = (pages) => ({
    pages: () => pages,
    newPage: async () => { const p = fakePage(); p.isClosed = () => false; pages.push(p); return p; },
    on() {},
  });

  it('picks up a live page instead of flailing at the dead one', async () => {
    const dead = closable();
    const live = fakePage(); live.isClosed = () => false;
    const session = fakeSession(dead.page);
    session.context = contextWith([dead.page, live]);
    dead.kill();

    const job = start();
    scriptedModel([
      { calls: [{ name: 'read', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });

    expect(session.page).toBe(live);
    expect(job.steps.some((s) => /page had closed/.test(s.text))).toBe(true);
  });

  /* Clicking [42] on a page that was rebuilt underneath is worse than not clicking at all — the
     number now means something else entirely. */
  it('refuses to click on numbers that belonged to the dead page', async () => {
    const dead = closable();
    const live = fakePage(); live.isClosed = () => false;
    const session = fakeSession(dead.page);
    session.context = contextWith([dead.page, live]);
    dead.kill();

    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'click', args: { index: 1 } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });

    expect(live.acted.filter(([k]) => k === 'click')).toEqual([]);
    expect(JSON.stringify(seen.at(-1))).toMatch(/call look before clicking/);
  });

  it('opens a fresh page when every one of them is gone', async () => {
    const dead = closable();
    const session = fakeSession(dead.page);
    session.context = contextWith([dead.page]);
    dead.kill();

    const job = start();
    scriptedModel([
      { calls: [{ name: 'read', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(session.page).not.toBe(dead.page);
    expect(session.page.isClosed()).toBe(false);
  });

  /* Twenty identical failures is not resilience, it is a budget being burned. If the context itself
     is gone, say so once and stop. */
  it('stops and says so when the whole context is gone', async () => {
    const dead = closable();
    const session = fakeSession(dead.page);
    session.context = { pages: () => [], newPage: async () => { throw new Error('context closed'); }, on() {} };
    dead.kill();

    const job = start();
    scriptedModel([{ calls: [{ name: 'read', args: {} }] }]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(job.steps.some((s) => /could not be reopened/.test(s.text))).toBe(true);
  });
});

describe('what it is told about finding leads on Facebook', () => {
  const p = () => agent.systemPrompt({ goal: 'find leads', autoAct: false });

  /* Counted across three real runs: 14 look against 3 read, and 12 opens hopping between groups.
     Nothing had told it where leads actually live. */
  it('points it at post search rather than browsing groups', () => {
    expect(p()).toMatch(/search\/posts\?q=/);
    expect(p()).toMatch(/A group is a place; a post is a person saying something/);
  });

  it('says a feed is empty until you scroll, because that is what it always looks like', () => {
    expect(p()).toMatch(/A FEED IS EMPTY UNTIL YOU SCROLL/);
    expect(p()).toMatch(/read, scroll, read, scroll/);
  });

  it('tells it to work one group properly instead of glancing at five', () => {
    expect(p()).toMatch(/WORK ONE PLACE PROPERLY/);
  });

  it('separates looking from reading, which the tool counts show it was conflating', () => {
    expect(p()).toMatch(/judging a page by its buttons/);
  });

  /* Somebody needing a roofer does not search the words a roofer would use. */
  it('tells it to search the words a person in trouble would write', () => {
    expect(p()).toMatch(/not the words a supplier would/);
  });
});

/**
 * Typing is not a way round the approval gate.
 *
 * `act` was guarded and `type` was not — and type takes submit:true, which presses Enter, which in
 * a Facebook comment box POSTS THE COMMENT. So the one guarantee this thing makes could be walked
 * straight past by the ordinary route of typing into a field.
 *
 * Found while working out whether the agent could talk to ChatGPT, which is the same mechanic
 * pointed at something harmless. That is usually how these turn up: the safe version of an action
 * and the dangerous one are the same keystroke.
 */
describe('typing into something that publishes', () => {
  const COMPOSER = [
    { index: 9, tag: 'div', placeholder: 'Schrijf een openbare reactie…', x: 5, y: 5 },
    { index: 8, tag: 'input', placeholder: 'Zoeken op Facebook', x: 6, y: 6 },
  ];
  const withFields = () => {
    const page = fakePage();
    const s = { id: 's1', owner: 'carla', profile: 'fb', page,
                lastAnalysis: { elements: COMPOSER, url: page.url(), scrollY: 0 } };
    return s;
  };

  it('refuses to press Enter in a comment box', async () => {
    const session = withFields();
    const job = start();
    scriptedModel([
      { calls: [{ name: 'type', args: { index: 9, text: 'ik kan helpen', submit: true } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(session.page.acted.filter(([k]) => k === 'press')).toEqual([]);
    expect(job.steps.some((s) => s.kind === 'blocked')).toBe(true);
  });

  /* Typing itself stays free — it is Enter, in a field that publishes, that needs a person. */
  it('still lets it type into a comment box without submitting', async () => {
    const session = withFields();
    const job = start();
    scriptedModel([
      { calls: [{ name: 'type', args: { index: 9, text: 'draft', submit: false } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(session.page.acted.some(([k, v]) => k === 'type' && v === 'draft')).toBe(true);
  });

  /* A search box takes Enter too, and searching is how it finds anything at all. */
  it('lets it search, which is the whole job', async () => {
    const session = withFields();
    const job = start();
    scriptedModel([
      { calls: [{ name: 'type', args: { index: 8, text: 'wie kent een dakdekker', submit: true } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(session.page.acted.some(([k]) => k === 'press')).toBe(true);
  });

  it('allows it when the owner has said it may act unasked', async () => {
    const session = withFields();
    const job = start();
    scriptedModel([
      { calls: [{ name: 'type', args: { index: 9, text: 'x', submit: true } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session, settings: { ...SETTINGS, autoAct: true }, chat, pace: 0, idleTimeoutMs: 0 });
    expect(session.page.acted.some(([k]) => k === 'press')).toBe(true);
  });

  it('paste_text drops the whole block in at once, never char by char', async () => {
    const session = withFields();
    const job = start();
    const script = 'Line one of the narration.\nLine two, a bit longer.\nLine three closes it out.';
    scriptedModel([
      { calls: [{ name: 'paste_text', args: { index: 8, text: script } }] },   // 8 = search box, not a composer
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(session.page.acted.some(([k, v]) => k === 'insert' && v === script)).toBe(true);   // one insert of the whole block
    expect(session.page.acted.some(([k]) => k === 'type')).toBe(false);                        // pasted, not typed
  });

  it('refuses to paste-and-Enter into a box that publishes', async () => {
    const session = withFields();
    const job = start();
    scriptedModel([
      { calls: [{ name: 'paste_text', args: { index: 9, text: 'a public comment', submit: true } }] },   // 9 = comment composer
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session, settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(session.page.acted.some(([k]) => k === 'insert')).toBe(false);   // blocked before it pasted anything
  });

  it.each([
    ['Schrijf een openbare reactie…', true],
    ['Write a comment…', true],
    ['Bericht schrijven', true],
    ["What's on your mind?", true],
    ['Zoeken op Facebook', false],
    ['Search', false],
    ['E-mailadres of telefoonnummer', false],
    ['', false],
  ])('%s publishes: %s', (placeholder, expected) => {
    expect(agent.looksLikeComposer({ placeholder })).toBe(expected);
  });
});

/**
 * Saving beats hunting for a link.
 *
 * The run that produced this: 42 tool calls, 16 pages read, zero leads. It was doing everything
 * right up to the last step — searching posts, opening them — and then spending the rest of its
 * budget clicking timestamps to obtain a permalink, because "ALWAYS CAPTURE THE LINK" reads as a
 * precondition. A lead with a name and the person's own words is worth a great deal; the same lead
 * never saved because something was being hunted for is worth nothing.
 */
describe('reading a post tells it where it is', () => {
  it('says the address, so it never has to hunt for one it already has', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'read', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(fakePage('https://www.facebook.com/groups/1/posts/2/')),
                      settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    const obs = JSON.stringify(seen.at(-1));
    expect(obs).toMatch(/You are on: https:\/\/www\.facebook\.com\/groups\/1\/posts\/2/);
    // ...and that this particular address is the thing it was about to go clicking for.
    expect(obs).toMatch(/that address is its permalink/);
  });

  it('does not claim a feed address is a permalink', async () => {
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'read', args: {} }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(fakePage('https://www.facebook.com/groups/feed/')),
                      settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(JSON.stringify(seen.at(-1))).not.toMatch(/is its permalink/);
  });
});

describe('a bare address', () => {
  /* The prompt listed addresses without https:// and it used one verbatim; Chromium rejected it
     outright, which costs a step and teaches nothing. Mine to fix, at both ends. */
  it('is opened rather than refused', async () => {
    const job = start();
    const page = fakePage();
    scriptedModel([
      { calls: [{ name: 'open', args: { url: 'facebook.com/groups/feed/' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(page), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(page.acted.find(([k]) => k === 'goto')[1]).toBe('https://facebook.com/groups/feed/');
  });

  it('leaves a real one alone', async () => {
    const job = start();
    const page = fakePage();
    scriptedModel([
      { calls: [{ name: 'open', args: { url: 'https://www.facebook.com/x' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(page), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(page.acted.find(([k]) => k === 'goto')[1]).toBe('https://www.facebook.com/x');
  });
});

describe('what it is told about saving', () => {
  const p = () => agent.systemPrompt({ goal: 'find leads', autoAct: false });

  it('tells it to save first and treat the link as a bonus', () => {
    expect(p()).toMatch(/SAVE FIRST\. THE LINK IS A BONUS/);
    expect(p()).toMatch(/you cannot recover a lead you never wrote down/);
  });

  it('gives whole addresses, since it copies them verbatim', () => {
    expect(p()).toMatch(/https:\/\/www\.facebook\.com\/search\/posts\?q=/);
  });
});

/**
 * sweep — the tool that replaces a dozen.
 *
 * A run spent 42 calls on look/click/read/scroll and recorded nothing: everything went on operating
 * Facebook, and there was nothing left for judging whether a person needs what the owner sells.
 * sweep reads the feed in code and hands over the posts, so the model does the part only it can do.
 */
describe('sweeping a feed', () => {
  const sweepPage = (posts) => {
    const page = fakePage();
    let scrolled = 0;
    page.evaluate = async (fn) => {
      const src = String(fn);
      /* A real feed serves the same posts again after a scroll and only appends new ones. Serving
         them once made the second sweep look like an empty page instead of a seen one, which is a
         different message — and the difference is the whole point of the test. */
      if (src.includes('role="article"')) { scrolled++; return posts; }
      if (src.includes('innerText')) return 'page text';
      if (src.includes('querySelectorAll')) return ELEMENTS;
      return 0;
    };
    return page;
  };
  const post = (n, over = {}) => ({ author: `Persoon ${n}`, group: 'Ondernemers NL',
    url: `https://www.facebook.com/groups/1/posts/${n}/`,
    text: `wie kan mij helpen met een webshop bouwen (${n})`, postedText: '2 d', ...over });

  it('hands the model the people, not the page furniture', async () => {
    const page = sweepPage([post(1), post(2)]);
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'sweep', args: { search: 'webshop bouwen' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(page), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    const obs = JSON.stringify(seen.at(-1));
    expect(obs).toMatch(/Persoon 1/);
    expect(obs).toMatch(/wie kan mij helpen met een webshop/);
    expect(obs).toMatch(/2 days ago/);
    expect(obs).toMatch(/groups\/1\/posts\/1/);          // the permalink, without going to look for it
    expect(obs).toMatch(/Save every one of these that is a lead/);
  });

  it('searches with the right address', async () => {
    const page = sweepPage([post(1)]);
    const job = start();
    scriptedModel([
      { calls: [{ name: 'sweep', args: { search: 'programmeur gezocht' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(page), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(page.acted.find(([k]) => k === 'goto')[1]).toBe('https://www.facebook.com/search/posts?q=programmeur%20gezocht');
  });

  it('reads all the account’s groups when asked', async () => {
    const page = sweepPage([post(1)]);
    const job = start();
    scriptedModel([
      { calls: [{ name: 'sweep', args: { myGroups: true } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(page), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(page.acted.find(([k]) => k === 'goto')[1]).toBe('https://www.facebook.com/groups/feed/');
  });

  /* "Nothing here" and "everything here was old" are different answers, and only one of them means
     go somewhere else. */
  it('distinguishes an empty place from a stale one', async () => {
    const page = sweepPage([post(1, { postedText: '9 september 2021' })]);
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'sweep', args: { search: 'x' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(page), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(JSON.stringify(seen.at(-1))).toMatch(/every one of the 1 posts there was older/);
  });

  /* Sweeping the same place twice should cost nothing and say nothing new — that is what makes
     checking back on a group cheap rather than a full re-read. */
  it('says nothing new on a second sweep of the same place', async () => {
    const page = sweepPage([post(1), post(2)]);
    const job = start();
    const seen = scriptedModel([
      { calls: [{ name: 'sweep', args: { search: 'x' } }] },
      { calls: [{ name: 'sweep', args: { search: 'x' } }] },
      { calls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    await agent.run({ job, session: fakeSession(page), settings: SETTINGS, chat, pace: 0, idleTimeoutMs: 0 });
    expect(JSON.stringify(seen.at(-1))).toMatch(/Nothing new since you last looked/);
  });
});

describe('what it is told to reach for', () => {
  const p = () => agent.systemPrompt({ goal: 'find leads', autoAct: false });
  it('points at sweep rather than at its hands', () => {
    expect(p()).toMatch(/sweep is the tool for this/);
    expect(p()).toMatch(/One call\s*instead of a dozen/);
  });
  it('keeps hands available for what hands are for', () => {
    expect(p()).toMatch(/still exist for when something is in the way/);
  });
});

describe('one browser: nothing to switch to', () => {
  /* In single-browser mode the run passes an empty profileList, and the prompt must then say
     nothing about use_profile — otherwise the agent spends steps hunting for a login it is already
     inside, which is the failure that lost a whole LinkedIn run. */
  it('omits the switch instructions when there is no login list', () => {
    const p = agent.systemPrompt({ goal: 'find leads', profileList: '', autoAct: false });
    expect(p).not.toMatch(/use_profile/);
    expect(p).not.toMatch(/LOGINS YOU CAN USE/);
  });
});

describe('freelance roles — the separation that makes them safe and fast', () => {
  const roles = require('../src/roles.js');
  it('scouts can save gigs and cannot act; proposal roles can act', () => {
    for (const s of ['useme.scout', 'upwork.scout']) {
      const t = roles.get(s).tools;
      expect(t).toContain('save_gig');
      expect(t).not.toContain('act');        // a scout that can write will eventually write
      expect(t).not.toContain('save_lead');  // gigs are the product here, not people
    }
    for (const p of ['useme.proposal', 'upwork.proposal']) {
      expect(roles.get(p).tools).toContain('act');   // submission goes through the approval gate
    }
  });
  it('the four roles resolve and carry their site', () => {
    for (const [name, site] of [['useme.scout', 'useme'], ['useme.proposal', 'useme'], ['upwork.scout', 'upwork'], ['upwork.proposal', 'upwork']]) {
      expect(roles.get(name).site).toBe(site);
    }
  });
});

describe('the gigs journal', () => {
  const jobs = require('../src/jobs.js');
  it('addGig records once — the same brief found twice is one opportunity', () => {
    const j = { id: 't-gigs', gigs: [], steps: [], leads: [], proposals: [], transcript: [] };
    const g1 = jobs.addGig(j, { title: 'Shop MVP', url: 'https://useme.com/x/1', budget: '3000 PLN' });
    const g2 = jobs.addGig(j, { title: 'Shop MVP again', url: 'https://useme.com/x/1' });
    expect(g1).toBeTruthy();
    expect(g2).toBeNull();
    expect(j.gigs).toHaveLength(1);
  });
});

/**
 * DRIFT, AND THE SESSION IT HOLDS.
 *
 * Measured: a LinkedIn research run read post after post for two hours, spent its whole 120-turn
 * budget, produced no report, and then PARKED — because hitting the limit marks a job idle and waits
 * half an hour for a person to say "carry on". Nobody was watching; the master had dispatched it. It
 * held the only browser session throughout, starved the QA and hunt queued behind it, pushed the pod
 * past its memory ceiling into a drain it could not recover from, and produced NOTHING, because the
 * run ended mid-thought with everything it had read still only in its head.
 */
describe('a long run concludes instead of holding the browser', () => {
  const never = async () => ({ content: '', toolCalls: [{ name: 'note', args: { text: 'reading' } }], raw: {} });

  it('a watched conversation still PARKS at the limit — someone is there to say carry on', async () => {
    const job = start();
    await agent.run({ job, session: fakeSession(), settings: { ...SETTINGS, maxSteps: 3 }, chat: never, pace: 0, idleTimeoutMs: 0 });
    expect(job.steps.some((st) => /3-step limit/.test(st.text))).toBe(true);
  });

  it('an UNATTENDED job is told to stop investigating and write down what it has', async () => {
    const job = start();
    await agent.run({ job, session: fakeSession(), settings: { ...SETTINGS, maxSteps: 3 }, chat: never,
      pace: 0, idleTimeoutMs: 0, unattended: true });
    expect(job.steps.some((st) => /budget reached — asked to report/.test(st.text))).toBe(true);
  });

  it('and it ENDS rather than sitting idle, so the session goes back to the queue', async () => {
    // The whole cost of the old behaviour: a parked job still owns the browser for idleTimeoutMs.
    const job = start();
    await agent.run({ job, session: fakeSession(), settings: { ...SETTINGS, maxSteps: 3 }, chat: never,
      pace: 0, idleTimeoutMs: 0, unattended: true });
    expect(jobsStore.isOver(job)).toBe(true);
    expect(job.steps.some((st) => /asked to conclude and did not/.test(st.text))).toBe(true);
  });

  it('a model that DOES conclude when asked keeps its report — the wrap-up is a chance, not a cut-off', async () => {
    // Two hours of reading was thrown away because the run was cut off mid-thought. Given a few
    // turns, the same run ends with something worth having.
    let turns = 0;
    const concludes = async () => {
      turns += 1;
      return turns > 3
        ? { content: '', toolCalls: [{ name: 'finish', args: { summary: 'three good threads, links attached' } }], raw: {} }
        : { content: '', toolCalls: [{ name: 'note', args: { text: 'reading' } }], raw: {} };
    };
    const job = start();
    await agent.run({ job, session: fakeSession(), settings: { ...SETTINGS, maxSteps: 3 }, chat: concludes,
      pace: 0, idleTimeoutMs: 0, unattended: true });
    expect(job.steps.some((st) => /three good threads/.test(st.text))).toBe(true);
    expect(job.steps.some((st) => /asked to conclude and did not/.test(st.text))).toBe(false);
  });

  it('re-anchors on a cadence — a reminder of the goal, never a limit', async () => {
    // Depth is not the failure mode; drift is. This never stops anything: a run still finding
    // things sails straight past it.
    const job = start('find people asking about roofers');
    await agent.run({ job, session: fakeSession(), settings: { ...SETTINGS, maxSteps: 60 }, chat: never,
      pace: 0, idleTimeoutMs: 0, unattended: true });
    const anchors = job.steps.filter((st) => /re-read the goal/.test(st.text));
    expect(anchors.length).toBeGreaterThanOrEqual(2);      // at 25 and 50 of a 60-step budget
    expect(job.steps.some((st) => /step 25 —/.test(st.text))).toBe(true);
  });
});

/*
 * "POSTED" MUST MEAN THE WORDS ARE ON THE PAGE.
 *
 * Carla opened four threads Herald showed as REPLIED and found no comment on any of them. The job
 * files agreed with Herald — each carried an `acted` step quoting the whole reply — because `acted`
 * was written the instant the text was typed. typeInto ends with Enter: that submits a Facebook
 * comment and, in Reddit's composer, usually just makes a newline. So some replies landed, some did
 * not, and every one was reported as sent. A tool claiming work it has not done is worse than one
 * that fails.
 */
describe('an act is confirmed before it is called done', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/agent.js'), 'utf8');

  it('reads the page back for the words it just sent', () => {
    expect(src).toMatch(/async function confirmPosted\(page, sent, waits/);
    /* innerText INCLUDED the comment box, so a reply typed and never sent read exactly like one
       that had posted. It reads what a reader would see instead — see composer-blind.test.js. */
    expect(src).toMatch(/body = await page\.evaluate\(readableText\);/);
  });

  it('compares on letters and digits only — platforms re-wrap and re-quote text', () => {
    expect(src).toMatch(/const lettersOnly = \(t\) => String\(t \|\| ''\)\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\+\/g, ''\);/);
  });

  /*
   * THE MIDDLE SLICE WAS NEVER THE DEFENCE IT CLAIMED TO BE. It assumed a composer holds a PREFIX
   * of what you are typing; it holds the whole thing, so the middle matched perfectly. What keeps a
   * draft out is skipping editable boxes, not where in the text we look. The slice stays because it
   * is still the most distinctive part to match on.
   */
  it('matches a distinctive slice from the middle of the text', () => {
    expect(src).toMatch(/want\.slice\(Math\.floor\(want\.length \/ 2\) - 30, Math\.floor\(want\.length \/ 2\) \+ 30\)/);
  });

  it('gives the page time, because a comment does not always render at once', () => {
    /* The default waits; a caller watching for a send that is already pending passes [0]. */
    expect(src).toMatch(/waits = \[900, 1800, 3000\]/);
  });

  it('says nothing either way when the text is too short to identify', () => {
    expect(src).toMatch(/if \(want\.length < 40\) return null;/);
  });

  it('records `unconfirmed` instead of `acted`, and tells the walk to find the real button', () => {
    expect(src).toMatch(/jobsStore\.step\(job, 'unconfirmed',/);
    expect(src).toMatch(/it may need its own Post\/Comment button/);
    /* Reworded after the walk typed the reply twice more anyway: saying it is not enough, so the
       refusal above is what holds, and the wording now names the box and the owner's language. */
    expect(src).toMatch(/THE TEXT IS STILL IN THE BOX/);
  });

  it('an act with no text — join, follow, like — is unaffected', () => {
    expect(src).toMatch(/const landed = toSend \? await confirmPosted\(page\(\), toSend\) : null;/);
    expect(src).toMatch(/if \(landed === false\) \{/);
  });
});

/*
 * IT TYPED THE SAME COMMENT THREE TIMES.
 *
 * The confirmation worked: the act typed the reply into a Facebook comment box, pressed Enter, could
 * not find the words afterwards, recorded `unconfirmed` and told the walk to find the button that
 * posts it and NOT to type the text again. The walk clicked the send button, could not tell whether
 * it had worked, and typed the whole reply again into a fresh field. Then a third time. Only Facebook
 * ignoring the first two sends kept it to one comment on the thread.
 *
 * Three fixes, all here, because an instruction the model can decline is not a guard.
 */
describe('a reply that was typed once is never typed twice', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/agent.js'), 'utf8');

  it('remembers the exact words of an act whose text never appeared', () => {
    expect(src).toMatch(/let pendingSend = null;/);
    expect(src).toMatch(/pendingSend = toSend;/);
  });

  /*
   * AND paste_text IS THE THIRD WAY IN. Refused `type`, the live walk reached straight for paste_text
   * and put the whole reply into another field. A guard that names two of the three tools that write
   * is not a guard.
   */
  it('covers every tool that puts words in a box, not just typing', () => {
    expect(src).toMatch(/\['type', 'act', 'paste_text'\]\.includes\(call\.name\)/);
  });

  it('REFUSES the same words again, rather than asking it not to', () => {
    expect(src).toMatch(/if \(pendingSend && \[[^\]]+\]\.includes\(call\.name\) && sameWords\(a && \(a\.text \?\? a\.body\), pendingSend\)\)/);
    expect(src).toMatch(/a second time — it is already in the box/);
  });

  /* The composer re-wraps and re-quotes what it holds, so it is the words that must match. */
  it('compares on the words alone, and will not call two short scraps the same message', () => {
    expect(src).toMatch(/function sameWords\(a, b\) \{/);
    expect(src).toMatch(/if \(x\.length < 25 \|\| y\.length < 25\) return false;/);
    expect(src).toMatch(/return x === y \|\| x\.includes\(y\) \|\| y\.includes\(x\);/);
  });

  it('and keeps looking for it, so the walk learns the send worked instead of guessing', () => {
    expect(src).toMatch(/if \(pendingSend\) \{/);
    expect(src).toMatch(/landedNow = await confirmPosted\(page\(\), pendingSend, \[0\]\);/);
    expect(src).toMatch(/jobsStore\.step\(job, 'acted', `sent: /);
    expect(src).toMatch(/It is on the page now — your text posted\. Do NOT type or send it again/);
  });

  /* Herald reads `acted` before `unconfirmed`, so a late landing correctly reports as replied. */
  it('the late landing writes a real acted step, not a note', () => {
    const i = src.indexOf("jobsStore.step(job, 'acted', `sent: ");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i - 400, i)).toContain('pendingSend');
  });

  /* This browser shows pages in the owner's own language: the button said "Verzenden", not "Post". */
  it('names the send control in the languages the owner actually sees', () => {
    expect(src).toMatch(/Verzenden/);
    expect(src).toMatch(/Senden/);
    expect(src).toMatch(/Envoyer/);
    expect(src).toMatch(/or just be an arrow/);
  });

  it('and says plainly that the text is still in the box', () => {
    expect(src).toMatch(/THE TEXT IS STILL IN THE BOX — typing it again would/);
  });

  it('the re-check is cheap and only runs while something is pending', () => {
    expect(src).toMatch(/async function confirmPosted\(page, sent, waits = \[900, 1800, 3000\]\) \{/);
    expect(src).toMatch(/for \(const wait of waits\) \{/);
  });
});

/*
 * WHY A FILED POST WAS ONLY EVER ITS FIRST LINE.
 *
 * Two of five drafts in Herald were written from an excerpt that was the headline again, character
 * for character, and the reply invented GitHub, Stripe and Gelato for a post that mentions none of
 * them. This is the cause, and it is not the model: Facebook COLLAPSES a long post in a feed, the
 * rest sits behind a "See more" control, and until that is pressed innerText on the article returns
 * the opening line. extractPosts read exactly that. So the walk got a post whose text WAS its title,
 * used it for both, and the drafter was asked to answer a headline.
 */
describe('a collapsed post is opened before it is read', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/sites/facebook.js'), 'utf8');
  const { expandPosts } = require('../src/sites/facebook');

  it('the feed is expanded first, and only then extracted', () => {
    expect(src.indexOf('page.evaluate(expandPosts)')).toBeGreaterThan(0);
    expect(src.indexOf('page.evaluate(expandPosts)')).toBeLessThan(src.indexOf('page.evaluate(extractPosts)'));
  });

  /* This browser shows pages in the owner's own language — the button said "Verzenden", not "Send". */
  it('knows the control by name in the languages this browser actually meets', () => {
    for (const w of ['see more', 'meer weergeven', 'mehr anzeigen', 'voir plus']) expect(src).toContain(w);
  });

  /* And by SHAPE, which needs no language at all: Facebook truncates with a CSS line-clamp. */
  it('and by shape, so a language nobody listed still works', () => {
    expect(src).toMatch(/webkitLineClamp/);
  });

  it('never throws — silence here would read as "nothing was collapsed"', () => {
    /* Injected into the page, so it runs with no document in the test. It must still not throw. */
    expect(() => expandPosts()).not.toThrow();
  });

  it('waits only when something actually opened', () => {
    expect(src).toMatch(/if \(Number\(opened\) > 0\) await new Promise/);
  });
});

/*
 * A ROLE THAT ADVERTISES ITS TOOLS BUT DOES NOT ENFORCE THEM IS NOT A LIMIT.
 *
 * toolsFor decides what the model is TOLD it has; the loop then ran whatever name came back. So a
 * read-only research.web scan of a Discord — dispatched with a goal that says in capitals do not
 * post, comment, vote, react, message, JOIN, follow or sign up — called act() and put "Join the
 * Discord Community" in front of Carla for approval. The act gate caught that one. A reply walk runs
 * auto-approved, and there would have been no gate to catch it there.
 */
describe('a walk cannot use a tool its role was never given', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/agent.js'), 'utf8');
  const roles = require('../src/roles');

  it('the allowed set comes from the role, resolved server-side', () => {
    expect(src).toMatch(/const allowedTools = new Set\(myTools\.map\(\(t\) => t\.function && t\.function\.name\)\.filter\(Boolean\)\);/);
  });

  it('and a known tool outside it is refused in the loop, where the other policy lives', () => {
    expect(src).toMatch(/if \(everyToolName\.has\(call\.name\) && !allowedTools\.has\(call\.name\)\) \{/);
    expect(src).toMatch(/does not have it/);
  });

  /* An unknown name must still reach the handling it always had, rather than being swallowed here. */
  it('only KNOWN tools are refused', () => {
    expect(src).toMatch(/everyToolName\.has\(call\.name\) &&/);
  });

  it('the read-only research roles genuinely do not carry act', () => {
    for (const r of ['research.web', 'research.reddit']) {
      const role = roles.get(r);
      expect({ r, act: (role.tools || []).includes('act') }).toEqual({ r, act: false });
    }
  });

  it('and the reply role, which runs auto-approved, does carry it', () => {
    const role = roles.get('herald.facebook.groups.engage');
    expect((role.tools || []).includes('act')).toBe(true);
  });
});
