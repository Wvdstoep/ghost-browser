/**
 * One harness, several specialists.
 *
 * Watching real runs, the failures were never "it could not think" — they were "it was doing the
 * wrong KIND of work": hunting for permalinks instead of recording people, inspecting page
 * furniture instead of reading posts. Narrowing what is within reach is the cheapest fix for that,
 * and it costs nothing at runtime.
 *
 * The guarantee worth pinning is the one a prompt cannot make: a scout that CANNOT post will not
 * post, however the conversation goes.
 */
import { describe, it, expect } from 'vitest';
import { ROLES, get, canonical, toolsFor, list, sites } from '../src/roles.js';
import { TOOLS, looksLikeWrite, ownGround } from '../src/agent.js';

const names = (ts) => ts.map((t) => t.function.name);

describe('picking a role', () => {
  it('falls back to the general one rather than throwing', () => {
    expect(get('nonsense')).toBe(ROLES.general);
    expect(get(undefined)).toBe(ROLES.general);
    expect(get('FACEBOOK.SCOUT')).toBe(ROLES['facebook.scout']);
  });

  it('offers them to a UI without it knowing their names', () => {
    const l = list();
    expect(l.map((r) => r.name)).toEqual(expect.arrayContaining(
      ['general', 'facebook.scout', 'facebook.conversation', 'facebook.voice',
       'linkedin.scout', 'linkedin.conversation']));
    for (const r of l) expect(r.description).toBeTruthy();
  });

  it('carries each role\'s tools and source, so a builder UI can show and clone them', () => {
    for (const r of list()) {
      expect(r.source).toBe('builtin');
      expect(r.tools === null || Array.isArray(r.tools)).toBe(true);   // null = every tool
    }
    // The scout's real toolset comes through, not just a summary.
    const scout = list().find((r) => r.name === 'facebook.scout');
    expect(scout.tools).toEqual(expect.arrayContaining(['look', 'read', 'save_lead']));
  });
});

describe('what each specialist can reach', () => {
  /*
   * THE ONE THAT MATTERS. A scout that can post is a scout that will eventually post, and the whole
   * point of separating this out is that a run which is only looking cannot write to somebody's
   * account by accident — whatever the model decides, and whatever anybody types at it.
   */
  it('a scout has no way to say anything at all', () => {
    const t = names(toolsFor('facebook.scout', TOOLS));
    expect(t).not.toContain('act');
    expect(t).toContain('sweep');
    expect(t).toContain('save_lead');
  });

  it('the voice role can neither post nor save leads — it is only reading a history', () => {
    const t = names(toolsFor('facebook.voice', TOOLS));
    expect(t).not.toContain('act');
    expect(t).not.toContain('save_lead');
    expect(t).toContain('save_my_writing');
  });

  /* The only one that writes, and it works from who is already waiting rather than going looking. */
  it('the conversation role can act but cannot go hunting for more', () => {
    const t = names(toolsFor('facebook.conversation', TOOLS));
    expect(t).toContain('act');
    expect(t).toContain('waiting_on');
    expect(t).not.toContain('sweep');
  });

  it('the general role keeps everything, so nothing was taken away from anyone', () => {
    expect(toolsFor('general', TOOLS)).toHaveLength(TOOLS.length);
  });

  /* A cookie wall does not care which specialist met it, and every role eventually meets one. */
  it.each(['facebook.scout', 'facebook.conversation', 'facebook.voice', 'linkedin.scout', 'linkedin.conversation', 'google.research', 'google.prospect', 'research.company', 'research.person'])('%s can still work a page by hand', (role) => {
    const t = names(toolsFor(role, TOOLS));
    for (const need of ['look', 'read', 'open', 'click', 'note', 'finish']) expect(t).toContain(need);
  });

  /*
   * A role naming a tool that no longer exists would silently narrow what it can do, and "the agent
   * mysteriously will not use a tool" is miserable to diagnose. Better to fall back to everything.
   */
  it('falls back to every tool rather than running a crippled specialist', () => {
    expect(toolsFor('typo', TOOLS)).toHaveLength(TOOLS.length);
  });

  it('every tool a role names actually exists', () => {
    const real = new Set(names(TOOLS));
    for (const [name, role] of Object.entries(ROLES)) {
      for (const t of role.tools || []) {
        expect(real.has(t), `role "${name}" names a tool that does not exist: ${t}`).toBe(true);
      }
    }
  });
});

describe('a set of roles per site', () => {
  it('keeps each site as its own craft', () => {
    expect(sites().sort()).toEqual(['facebook', 'google', 'linkedin', 'upwork', 'useme']);
    expect(ROLES['facebook.scout'].site).toBe('facebook');
    expect(ROLES['linkedin.scout'].site).toBe('linkedin');
    expect(ROLES['google.research'].site).toBe('google');
  });

  /* Google is not a feed at all — it is a way of finding out. Its roles say so, and neither of
     them can post anywhere. */
  it('gives Google searching and reading, and no way to post', () => {
    for (const r of ['google.research', 'google.prospect']) {
      const t = names(toolsFor(r, TOOLS));
      expect(t).toContain('google');
      expect(t).toContain('dig');
      expect(t).not.toContain('act');
      expect(t).not.toContain('sweep');
    }
  });

  it('separates finding out from building a list, because they stop for different reasons', () => {
    expect(names(toolsFor('google.research', TOOLS))).not.toContain('save_lead');
    expect(names(toolsFor('google.prospect', TOOLS))).toContain('save_lead');
    expect(ROLES['google.research'].prompt).toMatch(/WHEN TO STOP/);
    expect(ROLES['google.prospect'].prompt).toMatch(/DO NOT SAVE A BUSINESS YOU HAVE NOT LOOKED AT/);
  });

  /* Inventing a plausible answer is worse than nothing, because somebody acts on it. */
  it('tells the researcher to admit what it did not find', () => {
    expect(ROLES['google.research'].prompt).toMatch(/Inventing a\s+plausible one is worse than nothing/);
  });

  /* Same word, different job: a comment in a Facebook group and a comment on somebody's
     professional record are not the same act, and the prompts have to say so. */
  it('gives each site its own instructions rather than one shared prompt', () => {
    expect(ROLES['facebook.scout'].prompt).not.toBe(ROLES['linkedin.scout'].prompt);
    expect(ROLES['linkedin.scout'].prompt).toMatch(/announce/);
    expect(ROLES['linkedin.conversation'].prompt).toMatch(/most despised thing on this platform/);
  });

  /* LinkedIn has its own adapter now, and its own vocabulary in the prompt — a shared one would
     have the model asking Facebook for a content search. */
  it('gives LinkedIn its own sweep and its own instructions', () => {
    expect(ROLES['linkedin.scout'].tools).toContain('sweep');
    expect(ROLES['linkedin.scout'].prompt).toMatch(/site: "linkedin"/);
  });

  /*
   * RESEARCH CROSSES SITES, which is the whole point of it, so it belongs to none — and it must not
   * be filed next to General as though it were a fallback.
   */
  it('keeps research as its own group rather than a site', () => {
    expect(ROLES['research.company'].site).toBeNull();
    const g = list().find((r) => r.name === 'research.company').group;
    expect(g).toBe('Research');
  });

  it('gives research every site’s reading tools and no way to post', () => {
    const t = names(toolsFor('research.company', TOOLS));
    for (const need of ['google', 'dig', 'sweep', 'use_profile', 'list_profiles']) expect(t).toContain(need);
    expect(t).not.toContain('act');
  });

  /* One site at a time: switching site means switching browser context, and hopping back and forth
     spends the run reopening browsers instead of reading. */
  it('tells it to finish one site before moving to the next', () => {
    expect(ROLES['research.company'].prompt).toMatch(/ONE AT A TIME/);
    expect(ROLES['research.company'].prompt).toMatch(/A gap named is useful/);
  });

  /* Names repeat, and confidently reporting the wrong person is the worst outcome here. */
  it('tells the person researcher to prove it is the same person', () => {
    expect(ROLES['research.person'].prompt).toMatch(/BE CAREFUL WITH IDENTITY/);
    expect(ROLES['research.person'].prompt).toMatch(/nobody's business/);
  });

  it('groups them for a picker without it knowing any site names', () => {
    const groups = [...new Set(list().map((r) => r.group))];
    expect(groups).toEqual(expect.arrayContaining(['Facebook', 'Linkedin', 'Google', 'Research', 'Anything']));
  });

  /* A conversation started before roles were grouped must still reopen as what it was — silently
     turning an old scout run into a general one would rewrite the record. */
  it.each([['scout', 'facebook.scout'], ['voice', 'facebook.voice'], ['conversation', 'facebook.conversation']])
    ('still resolves the old name %s', (old, now) => {
      expect(get(old)).toBe(ROLES[now]);
      expect(canonical(old)).toBe(now);
    });

  it('stores a name that will resolve later, not whatever was typed', () => {
    expect(canonical('FaceBook.Scout')).toBe('facebook.scout');
    expect(canonical('nonsense')).toBe('general');
  });
});

describe('the research gates (products) and client gates (freelance)', () => {
  /* The master dispatches these EXACT names; if a rename drops one, GB silently falls back to the
     general role and the gate loses its specialism. Pin the names as the integration contract. */
  const MARKET = ['research.reddit', 'research.linkedin', 'research.web'];
  const CLIENT = ['client.linkedin', 'client.web'];

  it.each([...MARKET, ...CLIENT])('%s exists as a real role (not a general fallback)', (name) => {
    expect(ROLES[name], `the master dispatches "${name}" — it must be a real role`).toBeTruthy();
    expect(get(name)).toBe(ROLES[name]);
  });

  it('every gate role is READ-ONLY — a research run can never post, connect or message', () => {
    for (const name of [...MARKET, ...CLIENT]) {
      const t = names(toolsFor(name, TOOLS));
      expect(t, name).not.toContain('act');
      for (const need of ['look', 'read', 'open', 'note', 'finish']) expect(t, name).toContain(need);
    }
  });

  it('Reddit is worked without a login, through the open web (google + dig, no sweep adapter)', () => {
    expect(ROLES['research.reddit'].site).toBeNull();
    const t = names(toolsFor('research.reddit', TOOLS));
    expect(t).toContain('google');
    expect(t).toContain('dig');
    expect(ROLES['research.reddit'].prompt).toMatch(/old\.reddit\.com/);
    expect(ROLES['research.reddit'].prompt).toMatch(/never post/i);
  });

  it('the LinkedIn gates use the LinkedIn adapter (sweep) on the logged-in session', () => {
    for (const name of ['research.linkedin', 'client.linkedin']) {
      expect(ROLES[name].site).toBe('linkedin');
      expect(names(toolsFor(name, TOOLS))).toContain('sweep');
      expect(ROLES[name].prompt).toMatch(/site: "linkedin"/);
    }
  });

  /*
   * Found live: the LinkedIn login had expired, the audience pass landed on the sign-in page, hopped
   * to the Facebook login (still signed out of LinkedIn), swept six searches to "0 posts" and would
   * have filed that as the finding. The rule is a fixed sentence the master recognises and HOLDS the
   * pass on, rather than a report of nothing it would judge.
   */
  it('an audience pass that meets the sign-in page says SIGNED OUT in a fixed form instead of switching login', () => {
    expect(ROLES['research.linkedin'].prompt).toMatch(/SIGNED OUT: LinkedIn — sign in on the linkedin\nprofile in Ghost Browser and rerun this pass\./);
    expect(ROLES['research.linkedin'].prompt).toMatch(/Do NOT switch\nto another login/);
    expect(ROLES['research.reddit'].prompt).toMatch(/SIGNED OUT: Reddit — sign in on the reddit profile in Ghost Browser and rerun\nthis pass\./);
  });

  it('the web gates search and read (google + dig), and never sweep a feed', () => {
    for (const name of ['research.web', 'client.web']) {
      expect(ROLES[name].site).toBe('google');
      const t = names(toolsFor(name, TOOLS));
      expect(t).toContain('google');
      expect(t).toContain('dig');
      expect(t).not.toContain('sweep');
    }
  });

  it('files the two gates as their own groups in a picker', () => {
    const byName = Object.fromEntries(list().map((r) => [r.name, r.group]));
    for (const n of MARKET) expect(byName[n]).toBe('Research');
    for (const n of CLIENT) expect(byName[n]).toBe('Client research');
  });

  it('client.web hunts for red flags — the point is protecting a scarce bid', () => {
    const flat = ROLES['client.web'].prompt.replace(/\s+/g, ' ');
    expect(flat).toContain('RED FLAGS');
    expect(flat).toContain('WALK AWAY');
  });

  it('introduces no new site (Reddit needs no adapter)', () => {
    expect(sites().sort()).toEqual(['facebook', 'google', 'linkedin', 'upwork', 'useme']);
  });
});

describe('the reach roles — reading OUR OWN numbers for the Pulse distribution hub', () => {
  const REACH = ['reach.linkedin', 'reach.x', 'reach.reddit', 'reach.producthunt', 'reach.facebook', 'reach.youtube'];

  it.each(REACH)('%s exists, is read-only, and files structured numbers via save_reach', (name) => {
    expect(ROLES[name], name).toBeTruthy();
    const t = names(toolsFor(name, TOOLS));
    expect(t, name).not.toContain('act');           // a collection run can NEVER post
    expect(t, name).toContain('save_reach');        // numbers arrive structured, never parsed from prose
    for (const need of ['look', 'read', 'open', 'note', 'finish']) expect(t, name).toContain(need);
  });

  it('every reach prompt carries the one discipline that protects the verdicts: never estimate', () => {
    for (const name of REACH) {
      expect(ROLES[name].prompt).toMatch(/never (estimate|post|vote|upload)/i);
      const flat = ROLES[name].prompt.replace(/\s+/g, ' ');
      expect(flat).toMatch(/ONLY what/i);
      expect(flat).toMatch(/shown|shows|display/i);
    }
  });

  it('reach is its own group, and reads OUR numbers — distinct from research (the market\'s)', () => {
    const byName = Object.fromEntries(list().map((r) => [r.name, r.group]));
    for (const n of REACH) expect(byName[n]).toBe('Reach');
    expect(ROLES['reach.linkedin'].site).toBe('linkedin');
    expect(ROLES['reach.facebook'].site).toBe('facebook');
    expect(ROLES['reach.reddit'].site).toBeNull();  // no adapter needed — hands + the logged-in session
  });
});

describe('the posting roles — the only new writers, and drilled for it', () => {
  it.each(['post.reddit', 'post.linkedin'])('%s can act (through the gate) and carries the one-post discipline', (name) => {
    const t = names(toolsFor(name, TOOLS));
    expect(t).toContain('act');                      // a writer — but only through the approval gate
    expect(t).not.toContain('sweep');                // delivery, not hunting
    expect(t).not.toContain('save_lead');
    for (const need of ['look', 'read', 'open', 'note', 'finish']) expect(t).toContain(need);
    const flat = ROLES[name].prompt.replace(/\s+/g, ' ');
    expect(flat).toMatch(/ONE post/i);               // never sprays
    expect(flat).toMatch(/EXACTLY as given/);        // delivery, not authorship
    expect(flat).toMatch(/act gate/i);               // nothing visible without approval
  });
  it('the reddit poster reads the sub\'s rules before anything, and refuses rather than breaks them', () => {
    expect(ROLES['post.reddit'].prompt).toMatch(/rules in its sidebar/);
    expect(ROLES['post.reddit'].prompt).toMatch(/do NOT post/);
  });
});

describe('save_opportunity — the hunt files evidence, it does not narrate it', () => {
  it('the research roles carry the opportunity tool; reddit no longer misuses save_lead for market evidence', () => {
    expect(ROLES['research.reddit'].tools).toContain('save_opportunity');
    expect(ROLES['research.reddit'].tools).not.toContain('save_lead');   // a thread is evidence, not an outreach target
    expect(ROLES['research.linkedin'].tools).toEqual(expect.arrayContaining(['save_lead', 'save_opportunity']));
    expect(ROLES['research.web'].tools).toContain('save_opportunity');
  });
  it('the outreach scouts keep save_lead and never gain the opportunity tool', () => {
    for (const r of ['facebook.scout', 'linkedin.scout']) {
      if (!ROLES[r]) continue;
      expect(ROLES[r].tools).toContain('save_lead');
      expect(ROLES[r].tools).not.toContain('save_opportunity');
    }
  });
  it('the reddit prompt demands the link and the page\'s own date, and refuses an estimated one', () => {
    const p = ROLES['research.reddit'].prompt;
    expect(p).toMatch(/save_opportunity/);
    expect(p).toMatch(/THE DATE THE PAGE\s*\n?SHOWS/);
    expect(p).toMatch(/never estimate one/);
    expect(p).toMatch(/no thread link behind it does not get saved/);
  });
  it('the research roles stay READ-ONLY — evidence gathering never gains hands that post', () => {
    for (const r of ['research.reddit', 'research.linkedin', 'research.web']) {
      expect(ROLES[r].tools).not.toContain('act');
    }
  });
  /*
   * With google() dead, a pass "remembered" Reddit thread addresses and dug them; Reddit redirected the
   * invented ids to unrelated threads, which were then quoted as evidence. Every role that digs is told
   * the rule in the same words, and the browser refuses the redirected page (sites/google.js) as backstop.
   */
  it('the dig tool itself carries the rule, so every role that digs hears it; the research roles repeat it in their craft', () => {
    const dig = TOOLS.find((t) => t.function.name === 'dig');
    expect(dig.function.description).toMatch(/Only open links you have actually SEEN/);
    expect(dig.function.description).toMatch(/Never an address composed from memory/);
    expect(dig.function.parameters.properties.url.description).toMatch(/never typed from memory/);
    for (const r of ['research.reddit', 'research.web', 'research.reviews', 'research.market']) {
      expect(ROLES[r].prompt, `${r} must carry the rule`).toMatch(/only\s+(open|dig)\s+(links|addresses)[^.]*(seen|listed)/i);
      expect(ROLES[r].prompt, `${r} must say where the rule bites`).toMatch(/from memory/i);
    }
    expect(ROLES['research.reddit'].prompt).toMatch(/Reddit does not 404 a wrong\nid, it silently redirects/);
  });
});

describe('the discovery roles — hunting where people already pay', () => {
  // A hunt routed to research.web got a DISCOVERY goal and a VALIDATION prompt ("you find the
  // competitors and prices FOR A PRODUCT IDEA") — two instructions that contradict each other when
  // no idea exists yet. These are their own roles so the craft matches the job.
  it('both exist, are read-only, and file through the structured tool', () => {
    for (const r of ['research.reviews', 'research.market']) {
      expect(ROLES[r]).toBeTruthy();
      expect(ROLES[r].tools).toContain('save_opportunity');
      expect(ROLES[r].tools).not.toContain('act');       // discovery never writes
      expect(ROLES[r].tools).toContain('google');
      expect(ROLES[r].tools).toContain('dig');
    }
  });
  it('research.web keeps its VALIDATION job — the roles are not duplicates', () => {
    expect(ROLES['research.web'].prompt).toMatch(/COMPETITORS AND THE REAL PRICES for a product idea/);
    expect(ROLES['research.reviews'].prompt).toMatch(/WHAT PEOPLE WHO ALREADY PAY SAY IS MISSING/);
  });
  it('reviews: knows the sites, goes to the ONE AND TWO star reviews, and prices the incumbent', () => {
    const p = ROLES['research.reviews'].prompt;
    for (const site of ['G2', 'Capterra', 'Trustpilot', 'GetApp']) expect(p).toContain(site);
    expect(p).toMatch(/ONE AND TWO STAR reviews/);
    expect(p).toMatch(/Five-star reviews teach\s*\n?you nothing/);
    expect(p).toMatch(/PRICE from the vendor's own pricing page/);
  });
  it('reviews: we may READ a marketplace we can never LIST in — the distinction is stated', () => {
    const p = ROLES['research.reviews'].prompt;
    expect(p).toMatch(/cannot LIST a product in someone else's store, but their\s*\n?reviews are public/);
    expect(p).toMatch(/serve those same\s*\n?people with our own standalone tool/);
  });
  it('reviews: a discontinued tool is named as the strongest signal there is', () => {
    expect(ROLES['research.reviews'].prompt).toMatch(/DISCONTINUED, sunset, acquired-and-gutted/);
    expect(ROLES['research.reviews'].prompt).toMatch(/budget and nowhere to spend it/);
  });
  it('market: reads boards for a RECURRING task and brings back the budget band', () => {
    const p = ROLES['research.market'].prompt;
    for (const board of ['Upwork', 'Fiverr', 'PeoplePerHour', 'Useme']) expect(p).toContain(board);
    expect(p).toMatch(/never bid, apply or message/);
    expect(p).toMatch(/SAME task described by many different clients/);
    expect(p).toMatch(/budget that recurs in a band/);
    expect(p).toMatch(/if a task appears twice, that is not a market/);
  });
  it('both refuse to manufacture a finding', () => {
    expect(ROLES['research.reviews'].prompt).toMatch(/Do not manufacture a\s*\n?gap because you were sent to look for one/);
    expect(ROLES['research.market'].prompt).toMatch(/Say so and finish rather than padding/);
  });
});

describe('qa.web — testing our own app is its own craft', () => {
  // QA was dispatched with NO role, so it got `general`: every tool, no craft. It opened a freshly
  // built app, looked, got "0 things to click", and repeated that for 241 steps until the step limit
  // — never reporting on one criterion. The owner then opened the same URL and saw a landing page
  // and a login form. THE APP WAS FINE. QA had looked before the SPA rendered, had no instruction to
  // wait, and no required verdict shape — so the parser read nothing and scored four blind FAILs,
  // which sent a fixer to debug the backend for 1.37M tokens and zero files changed.
  const p = () => ROLES['qa.web'].prompt;

  it('can drive a page, and acts ONLY on the app it was sent to test', () => {
    expect(ROLES['qa.web']).toBeTruthy();
    for (const t of ['look', 'read', 'open', 'click', 'type', 'scroll', 'finish']) {
      expect(ROLES['qa.web'].tools).toContain(t);   // it must be able to USE the app
    }
    /*
     * `act` WAS excluded here, and that was right until it wasn't. QA is sent to an app WE built,
     * where pressing the buttons is the whole job — and the write-guard refused "Connect Etsy shop"
     * because `connect` means something else entirely on LinkedIn. The proposal then waited for a
     * human nobody had asked to watch, and the run held the browser until the watchdog.
     *
     * So QA carries `act` now, and the safety moved from the TOOL to the ORIGIN: it is auto-approved
     * only on the one app it was sent to, and gated everywhere else — including on the OAuth screen
     * that same button hands it to. See ownGround() in agent.js.
     */
    expect(ROLES['qa.web'].tools).toContain('act');
    expect(ROLES['qa.web'].trustsOwnOrigin).toBe(true);
    // Still not a lead-gatherer or a demand-miner; that craft belongs to other roles.
    for (const t of ['save_lead', 'sweep', 'save_opportunity']) {
      expect(ROLES['qa.web'].tools).not.toContain(t);
    }
  });
  it('knows a blank first look means WAIT, not broken — the exact mistake that cost the run', () => {
    expect(p()).toMatch(/A BLANK FIRST LOOK IS NORMAL/);
    expect(p()).toMatch(/single-page apps/);
    expect(p()).toMatch(/look AGAIN/);
    expect(p()).toMatch(/read\(\) the page/);
    expect(p()).toMatch(/two looks in a row are identical/);
  });
  it('tests as a stranger, because that is who signs up', () => {
    expect(p()).toMatch(/TEST AS A STRANGER/);
    expect(p()).toMatch(/Never reuse a stored login/);
  });
  it('measures rather than repairs, one criterion at a time', () => {
    expect(p()).toMatch(/ONE CRITERION AT A TIME/);
    expect(p()).toMatch(/You are measuring, not\s*\n?repairing/);
  });
  it('reports in the exact shape the pipeline parses, and says NOT TESTED rather than guessing', () => {
    expect(p()).toMatch(/FINISH WITH THIS EXACT SHAPE/);
    expect(p()).toMatch(/— PASS/);
    expect(p()).toMatch(/— FAIL: <the exact symptom/);
    expect(p()).toMatch(/NOT TESTED: <why>/);
    expect(p()).toMatch(/an untested criterion is not a failed one/);
  });
});

describe('diagnostics — QA can finally see what the browser sees', () => {
  // The app under test bounced from the landing page to /login over and over: the console said
  // `GET /api/… 401` and the address bar looped, but GB listened to NONE of Playwright's console,
  // pageerror, response or framenavigated events. QA had only `look`, caught the page mid-navigation,
  // and reported "0 things to click" fifty times — unable to describe a bug it could not perceive.
  it('is QA\'s tool and no one else\'s — these buffers can hold tokens on a signed-in site', () => {
    expect(ROLES['qa.web'].tools).toContain('diagnostics');
    const others = Object.entries(ROLES)
      .filter(([k, r]) => k !== 'qa.web' && Array.isArray(r.tools) && r.tools.includes('diagnostics'));
    expect(others.map(([k]) => k)).toEqual([]);
  });
  it('the general role does not silently grant it — null tools means every tool', () => {
    // `general` has tools:null (everything), which is exactly why QA must never run roleless again.
    expect(ROLES.general.tools).toBe(null);
    expect(ROLES['qa.web'].tools).not.toBe(null);
  });
  it('QA is told to ask the browser before reporting a failure', () => {
    const p = ROLES['qa.web'].prompt;
    expect(p).toMatch(/ASK THE BROWSER/);
    expect(p).toMatch(/always before you report a criterion as failed/);
    expect(p).toMatch(/REDIRECT LOOP is the case to watch for/);
    expect(p).toMatch(/retrying is pointless/);
  });
});

/**
 * OUR OWN GROUND — the gate that protects nobody, and deadlocked QA instead.
 *
 * Measured, job j-mte5i8ic-d4fao: QA was testing an app we had just built, found the one button the
 * acceptance criteria are about — "Connect Etsy shop" — and was refused, because `connect` is in
 * WRITE_WORDS for LinkedIn where it messages a real person. The click became an act proposal, the
 * proposal waited for a human nobody had asked to watch, and the run held the only browser session
 * until the three-hour watchdog. QA cannot test an app by refusing to press its buttons.
 */
describe('own-origin trust — QA may press its own app\'s buttons, and nobody else\'s', () => {
  const APP = 'https://prod-profit-tracker.example';
  const CONNECT = { text: 'Connect Etsy shop' };

  it('"Connect" is still a write everywhere — the heuristic is right, it just cannot see whose site it is on', () => {
    expect(looksLikeWrite(CONNECT)).toBe(true);
    expect(looksLikeWrite({ text: 'Connect' })).toBe(true);
  });

  it('covers the app under test, and nothing else on the internet', () => {
    const g = ownGround(APP);
    expect(g.covers(APP)).toBe(true);
    expect(g.covers(APP + '/dashboard?x=1')).toBe(true);
    // The very button above hands QA to Etsy's real OAuth screen. Different origin, gate closed.
    expect(g.covers('https://www.etsy.com/oauth/connect')).toBe(false);
    expect(g.covers('https://prod-profit-tracker.example.evil.com')).toBe(false);
    expect(g.covers('http://prod-profit-tracker.example')).toBe(false);   // scheme is part of it
  });

  it('a role that never asked for it gets nothing, whatever is passed', () => {
    // The safety is that trust is declared in the registry, not supplied by the caller.
    expect(get('qa.web').trustsOwnOrigin).toBe(true);
    for (const r of ['general', 'facebook.scout', 'linkedin.scout', 'research.web']) {
      expect(get(r).trustsOwnOrigin, r).toBeFalsy();
    }
  });

  it('no origin means no trust — an absent or unparseable one must never open the gate', () => {
    for (const bad of [null, undefined, '', 'not a url', 'javascript:alert(1)', 'about:blank', 'data:text/html,x']) {
      const g = ownGround(bad);
      expect(g.covers(APP), String(bad)).toBe(false);
      expect(g.covers(bad), String(bad)).toBe(false);
    }
  });

  it('QA carries act, or it could not press anything even where it is allowed to', () => {
    expect(get('qa.web').tools).toContain('act');
  });
});

describe('Discovery / SEO roles — fully browser-native (no API, no service account)', () => {
  it('seo.keywords is read-only and files structured keywords via save_keywords', () => {
    expect(ROLES['seo.keywords']).toBeTruthy();
    const t = names(toolsFor('seo.keywords', TOOLS));
    expect(t).not.toContain('act');                 // research never acts
    expect(t).toContain('save_keywords');
    for (const need of ['look', 'read', 'open', 'note', 'finish']) expect(t).toContain(need);
    expect(ROLES['seo.keywords'].prompt).toMatch(/never invent|ONLY what a tool actually shows/i);
  });
  it('gsc.connect adds the property + reads the verification token — no service account, no API', () => {
    const t = names(toolsFor('gsc.connect', TOOLS));
    expect(t).toContain('act');
    expect(t).toContain('save_gsc_token');
    const p = ROLES['gsc.connect'].prompt;
    expect(p).toMatch(/URL prefix/);
    expect(p).toMatch(/HTML tag/);
    expect(p).toMatch(/do NOT click Verify yet/i);   // verify is a later step, after the token is planted
    expect(p).toMatch(/CAPTCHA|phone/i);
    expect(p).not.toMatch(/service account/i);       // the API path is gone
  });
  it('gsc.verify clicks Verify; reach.search READS the Performance page (read-only) and files days + queries', () => {
    expect(names(toolsFor('gsc.verify', TOOLS))).toContain('act');
    expect(ROLES['gsc.verify'].prompt).toMatch(/Verify/);
    const s = names(toolsFor('reach.search', TOOLS));
    expect(s).not.toContain('act');                  // reading only
    expect(s).toContain('save_reach');
    expect(s).toContain('save_search');
    /* Case-insensitive: the role shouts it in the opening line. What matters is that this reader
       is pointed at the performance report and nothing else. */
    expect(ROLES['reach.search'].prompt).toMatch(/performance/i);
    expect(ROLES['reach.search'].prompt).toMatch(/never (add|estimate)|only what the page shows/i);
  });
  it('the Discovery roles live on the existing google site (sites() unchanged) and are grouped sensibly', () => {
    for (const n of ['seo.keywords', 'gsc.connect', 'gsc.verify', 'reach.search']) expect(ROLES[n].site).toBe('google');
    expect(sites()).toContain('google');
    const byName = Object.fromEntries(list().map((r) => [r.name, r.group]));
    expect(byName['seo.keywords']).toBe('SEO');
    expect(byName['gsc.connect']).toBe('SEO');
    expect(byName['gsc.verify']).toBe('SEO');
    expect(byName['reach.search']).toBe('Reach');
  });
});

/*
 * THE MAPS SPECIALIST. A generic "find businesses on Maps" walk searched one ambiguous word, took
 * what Maps offered, and saved a parking garage for a car-garage search. Working Maps is a skill,
 * and this role is that skill written down — so these pin the parts a thin prompt always loses.
 */
describe('the Google Maps specialist', () => {
  const r = get('google.maps');

  it('exists, on google, and reaches save_place rather than save_lead', () => {
    expect(r).toBeTruthy();
    expect(r.site).toBe('google');
    expect(r.tools).toContain('save_place');
    expect(r.tools).not.toContain('save_lead');
  });

  it('decides which business the word means before it searches', () => {
    expect(r.prompt).toMatch(/parkeergarage/i);
    expect(r.prompt).toMatch(/autobedrijf|garagebedrijf/i);
    expect(r.prompt).toMatch(/local language/i);
  });

  it('checks the category on every card, which is what a wrong result is caught by', () => {
    expect(r.prompt).toMatch(/CATEGORY printed under the name/i);
    expect(r.prompt).toMatch(/do not save it/i);
  });

  it('reads the reviews, which is the part everyone skips', () => {
    expect(r.prompt).toMatch(/OPEN THE REVIEWS/i);
    expect(r.prompt).toMatch(/lowest-rated/i);
    expect(r.prompt).toMatch(/OWNER REPLIED/i);
    expect(r.prompt).toMatch(/how many ratings/i);
  });

  it('is read-only, like every research role', () => {
    expect(r.prompt).toMatch(/never sign in/i);
    expect(r.prompt).toMatch(/Read-only|read-only/);
    expect(r.tools).not.toContain('act');
  });
});

/*
 * THE SECOND DOOR, NAMED.
 *
 * A picture walk found Gemini unwilling — a failed generation and a sign-in control — went to AI
 * Studio on its own initiative, came back, and finished the job. I called that drift. Carla pushed
 * back: the goal is an image from the owner's own Google account, and AI Studio is the same account
 * and the same capability through another door. She was right, and the outcome proved it.
 *
 * The answer to a good improvisation is to SANCTION it, not forbid it — and to bound it. Wandering
 * costs pages and steps from a walk that has a budget, so two named addresses is a fallback and
 * three is a search. And the source is reported, because a picture whose origin nobody recorded is
 * one nobody can reproduce when it matters.
 */
describe('the image role has one fallback, named and bounded', () => {
  const roles = require('../src/roles');
  const prompt = roles.ROLES['gemini.image'].prompt;

  /*
   * THE ORDER WAS BACKWARDS AND IT COST EVERY RUN.
   *
   * Gemini was the front door and AI Studio the fallback. For this account it is the other way round:
   * the Gemini session is signed OUT, and a signed-out Gemini does not refuse — it accepts the
   * reference image, accepts the prompt, and sits on "Uploading file: 50%" for ever. So each walk
   * spent its minutes on a chat that was never going to answer before it was allowed to try the door
   * that works. AI Studio is signed in, on PRO, with the image models on it.
   */
  it('AI Studio is the FIRST door, not the fallback', () => {
    expect(prompt).toMatch(/THE FIRST DOOR — GOOGLE AI STUDIO/);
    expect(prompt).toMatch(/THE SECOND DOOR — GEMINI/);
    expect(prompt.indexOf('aistudio.google.com')).toBeLessThan(prompt.indexOf('gemini.google.com'));
  });

  /* Two addresses is a fallback; a third would be a search, and a search spends the whole walk. */
  it('and bounds it to exactly two, once each', () => {
    expect(prompt).toMatch(/Try AI Studio ONCE and Gemini ONCE/);
    expect(prompt).toMatch(/those two addresses are the only ones/);
    expect(prompt).toMatch(/never go hunting for a third/);
  });

  it('and still refuses to invent an image when neither will do it', () => {
    expect(prompt).toMatch(/NOTE exactly what each of them said and finish/);
    expect(prompt).toMatch(/Never fake an image/);
  });

  /* Asking a text model for a picture looks exactly like a refusal and is not one. */
  it('it checks the model is an image model before blaming the tool', () => {
    expect(prompt).toMatch(/It must be an IMAGE model/);
    expect(prompt).toMatch(/Asking a text model for a picture/);
  });

  it('and records which door produced the picture', () => {
    expect(prompt).toMatch(/SAY WHICH DOOR IT CAME THROUGH/);
  });
});

/*
 * ── SEARCH CONSOLE, AS A SPECIALITY RATHER THAN ONE TAB ──────────────────────────────────────────
 *
 * There was one reader and it read Performance. On a property verified yesterday Performance says
 * nought clicks, one impression, average position four — every number it has, and not one of them
 * worth a decision. Meanwhile the same console was holding an unread message from Google, a
 * page-indexing report still processing, and the table of reasons pages are refused: all actionable
 * on day one, all of it changing while the numbers cannot.
 *
 * So the console gets three walks instead of one, split by what they are ALLOWED to do rather than by
 * which screen they visit. Two look. One asks Google for something, and only that one can.
 */
describe('the Search Console specialists', () => {
  const roles = require('../src/roles');

  it('there are three, and only one of them can act', () => {
    for (const k of ['gsc.audit', 'gsc.inspect']) {
      expect(roles.ROLES[k]).toBeTruthy();
      /* A role that cannot press the button never presses it. This is the guard, not the prompt. */
      expect(roles.ROLES[k].tools).not.toContain('act');
    }
    expect(roles.ROLES['gsc.submit'].tools).toContain('act');
  });

  it('all three file what they read through the one door', () => {
    for (const k of ['gsc.audit', 'gsc.inspect', 'gsc.submit']) {
      expect(roles.ROLES[k].tools).toContain('save_gsc_health');
    }
  });

  /* The audit is the one that answers "is anything getting in at all". */
  it('the audit walks every corner that says something on a young property', () => {
    const p = roles.ROLES['gsc.audit'].prompt;
    for (const corner of ['MESSAGES', 'MANUAL ACTIONS', 'PAGE INDEXING', 'SITEMAPS', 'CORE WEB VITALS']) {
      expect(p).toContain(corner);
    }
    /* The refusal reasons are the point of the whole walk. */
    expect(p).toMatch(/EVERY row under "Why pages aren't indexed"/);
    /* And it stays off Performance: two sources for one truth is how numbers stop being trusted. */
    expect(p).toMatch(/Do not read Performance here/);
  });

  it('a console in another language is matched by meaning, because this one is Dutch', () => {
    expect(roles.ROLES['gsc.audit'].prompt).toMatch(/match by MEANING/i);
    expect(roles.ROLES['gsc.audit'].prompt).toMatch(/Berichten/);
    expect(roles.ROLES['gsc.audit'].prompt).toMatch(/Pagina's/);
  });

  /* "No manual action" is the finding that lets every other number be believed. */
  it('a clean verdict is recorded, not skipped as uninteresting', () => {
    expect(roles.ROLES['gsc.audit'].prompt).toMatch(/Record these EVEN WHEN CLEAN/);
  });

  it('the inspector answers for named pages and refuses to request anything', () => {
    const p = roles.ROLES['gsc.inspect'].prompt;
    expect(p).toMatch(/NEVER press "Request indexing"/);
    expect(p).toMatch(/A page that IS indexed is as much a finding as one that is not/);
  });

  /*
   * The submitter is the only walk here that reaches Google, and its whole discipline is not wasting
   * a quota: check first, submit only what is missing, stop at the list.
   */
  it('the submitter checks before it spends a quota, and stops at the list', () => {
    const p = roles.ROLES['gsc.submit'].prompt;
    expect(p).toMatch(/If it is ALREADY on Google, record that .* and DO NOT request it/);
    expect(p).toMatch(/STOP at the number of URLs the goal names/);
    expect(p).toMatch(/THROUGH THE ACT GATE, every time/);
    /* Removals and ownership are destructive and are nobody's automation. */
    expect(p).toMatch(/never use Removals/);
  });

  it('and none of them wanders into signing anything in or changing settings', () => {
    for (const k of ['gsc.audit', 'gsc.inspect', 'gsc.submit']) {
      expect(roles.ROLES[k].site).toBe('google');
      expect(roles.ROLES[k].group).toBe('Reach');
    }
  });
});

/*
 * ONE QUESTION, ITS WHOLE FAMILY.
 *
 * The keyword walk researches an AUDIENCE and returns a plan: fifty categories, one per line. The
 * writer takes a line and writes a page from it, so the page answers the question in the PLAN's
 * shorthand rather than in the words people type. "best ai app builder platform" is a category;
 * "which ai app builder lets me export the code" is what somebody asks, and they are not the same
 * page. This walk closes that gap for ONE term, just before it is written.
 */
describe('expanding one search term', () => {
  const roles = require('../src/roles');
  const r = roles.ROLES['seo.expand'];

  it('exists, and can only file what it read', () => {
    expect(r).toBeTruthy();
    expect(r.tools).toContain('save_keywords');
    /* Read-only: no act, so it cannot create a campaign or save anything in Google's own tools. */
    expect(r.tools).not.toContain('act');
  });

  it('reads the three places people actually reveal their words', () => {
    expect(r.prompt).toMatch(/AUTOCOMPLETE/);
    expect(r.prompt).toMatch(/PEOPLE ALSO ASK/);
    expect(r.prompt).toMatch(/KEYWORD PLANNER/);
  });

  /* Planner is an advertiser's average of everybody; the other two are the words themselves. */
  it('and Planner is the one it is allowed to give up on', () => {
    expect(r.prompt).toMatch(/IF PLANNER WILL NOT OPEN/);
    expect(r.prompt).toMatch(/never worth a fight/);
  });

  it('it stays on ONE question rather than drifting into the category', () => {
    expect(r.prompt).toMatch(/File the term's FAMILY, not the whole category/);
    expect(r.prompt).toMatch(/a page that tries to answer twenty different questions answers none of them/);
  });

  /* This feeds what gets written, so an invented figure becomes an invented page. */
  it('and nothing it did not see on a screen may be filed', () => {
    expect(r.prompt).toMatch(/NEVER invent a phrase or a number/);
    expect(r.prompt).toMatch(/an invented figure becomes an invented page/);
  });
});

/*
 * ── THE ROLE ARRIVES, IT DOES NOT EXPLORE ────────────────────────────────────────────────────────
 *
 * This role used to say "open Search Console for that property and its Performance report, last 28
 * days, with Total clicks and Total impressions turned on, then open the QUERIES tab". Every clause
 * is a click, on a console that renders in the account's own language — so a walk looking for
 * "Performance" clicked the Google apps grid, twice, and took 166 steps to read one number.
 *
 * All of it is in the address: the range, the metrics, the breakdown. The role's job is to say so
 * and to forbid the hunting, because the hunting is what costs the steps.
 */
describe('the search console reader is told to arrive, not to explore', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/roles.js'), 'utf8');
  const role = src.slice(src.indexOf("'reach.search': {"), src.indexOf("'gsc.audit': {"));

  it('the addresses are opened, never navigated to', () => {
    expect(role).toMatch(/THE GOAL GIVES YOU THE EXACT ADDRESSES\. OPEN THEM\. DO NOT NAVIGATE\./);
    expect(role).toMatch(/Never click a tab, a menu item, a date picker or a metric toggle/);
  });

  /* The failure named, so the next person widening this knows what it cost. */
  it('and it says why, in the account\'s own language', () => {
    expect(role).toMatch(/"Prestaties", "Rendimiento" or "Leistung"/);
    expect(role).toMatch(/166 steps/);
  });

  it('a drawer is escaped rather than clicked out of', () => {
    expect(role).toMatch(/press Escape and open the address again/);
  });

  /* A budget in words: still hunting after ten steps is a finding, not a reason to carry on. */
  it('and it stops hunting instead of continuing for ever', () => {
    expect(role).toMatch(/If you are still looking for the report after ten/);
    expect(role).toMatch(/saying which is far more useful than continuing to hunt/);
  });

  /* The read-only contract and the honest-empty rule both survive the rewrite. */
  it('while it still never changes anything, and an empty stays honest', () => {
    expect(role).toMatch(/never add, remove, verify or change anything/);
    expect(role).toMatch(/an honest empty is a real result; a guessed number is poison/);
  });
});

/*
 * ── THE AUDIT ARRIVES AT SIX TABS INSTEAD OF LOOKING FOR THEM ────────────────────────────────────
 *
 * The role told the walk to "go through the console" — messages, manual actions, page indexing,
 * sitemaps, vitals — and listed the Dutch names so it could recognise them. That is prompt
 * engineering against a moving target: the labels change with whatever language the account uses.
 * Measured: 21 opens, 15 reads, 15 looks, stopped at 142 steps, and the sitemaps tab never reached.
 *
 * Every one of those tabs has an address. The performance collection had the identical problem and
 * lost it the moment it was handed addresses instead of directions — 166 steps became 18.
 */
describe('the audit is given the tabs rather than sent to find them', () => {
  const role = ROLES['gsc.audit'].prompt;

  it('the addresses are opened, not navigated to', () => {
    expect(role).toMatch(/THE GOAL GIVES YOU AN ADDRESS FOR EVERY TAB\. OPEN THEM IN TURN\. DO NOT NAVIGATE\./);
    expect(role).toMatch(/there is no menu to find and no bell to click/);
  });

  /* Counts are a table; retyping them out of prose is the step that can be silently wrong. */
  it('and the counts are read as cells', () => {
    expect(role).toMatch(/call read_table first/);
    expect(role).toMatch(/Use read if the answer is prose rather than a table/);
  });

  /* One unreachable tab must not cost the other five — the last walk lost half the audit that way. */
  it('a tab that will not open costs itself, not the audit', () => {
    expect(role).toMatch(/MOVE TO THE NEXT/);
    expect(role).toMatch(/Six tabs read is a whole audit/);
  });

  /* The language hints stay as a fallback for READING values, not as a way to find the tabs. */
  it('and the language hints remain for reading, not for hunting', () => {
    expect(role).toMatch(/match by MEANING, never by the English word/);
  });
});
