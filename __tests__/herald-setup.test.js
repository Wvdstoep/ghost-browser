/**
 * Herald setup roles — the intelligence of the multi-step create flows. A role's prompt is its
 * brain, so these pin the guardrails that a vague prompt would drop: the Facebook page walk must
 * name the profile-switcher bottom sheet and choose "Create a new Page" NEVER "Use existing profile"
 * (which would convert the owner's account); the group walk must default to Public and invite nobody;
 * every setup walk must STOP on a human-only step rather than fake it, and act through the gate.
 */
import { describe, it, expect } from 'vitest';
import { get, ROLES } from '../src/roles.js';

const SETUP = ['herald.facebook.setup', 'herald.facebook.group.setup', 'herald.linkedin.setup', 'herald.reddit.setup'];

describe('every Herald setup role shares the safety spine', () => {
  it('is a WRITER (has act) so nothing is created without the owner approving', () => {
    for (const name of SETUP) expect(get(name).tools, name).toContain('act');
  });
  it('STOPS on a human-only step rather than faking past it', () => {
    for (const name of SETUP) {
      const p = get(name).prompt;
      expect(p, name).toMatch(/STOP/);
      expect(p, name).toMatch(/CAPTCHA|verification|phone/i);
      expect(p, name).toMatch(/never (guess past it|fake it)/i);
    }
  });
  it('is decisive, not an explorer — the wandering failure is named and bounded', () => {
    for (const name of SETUP) expect(get(name).prompt, name).toMatch(/TWO looks|not an explorer|decisive/i);
  });
});

describe('the Facebook PAGE walk knows the real flow', () => {
  const p = get('herald.facebook.setup').prompt;
  it('names the profile switcher and its bottom sheet — the landmark from the real UI', () => {
    expect(p).toMatch(/RED DOT/);
    expect(p).toMatch(/BOTTOM SHEET/i);
    expect(p).toMatch(/Create Facebook Page/);
  });
  it('chooses "Create a new Page" and REFUSES "Use your existing profile" — never convert the owner', () => {
    expect(p).toMatch(/Create a new Page/);
    expect(p).toMatch(/DO NOT choose "Use your existing profile"/);
    expect(p).toMatch(/destructive|converts?|turns the OWNER/i);
  });
  it('fills name, category and bio from the goal EXACTLY, and never posts or boosts in setup', () => {
    expect(p).toMatch(/NAME/);
    expect(p).toMatch(/CATEGORY/i);
    expect(p).toMatch(/BIO|description/i);
    expect(p).toMatch(/EXACTLY/);
    expect(p).toMatch(/do NOT post yet|do NOT run ads/i);
  });
  it('has a desktop fallback so a non-mobile layout is not a dead end', () => {
    expect(p).toMatch(/pages\/create/);
  });
  it('treats the Create act as the FINISH LINE — the welcome tour confirms it, never re-create', () => {
    // The live CaseHandoff run created the page, then wandered looking for the URL, landed back on
    // /pages/create and started a SECOND create. These guards are the fix.
    expect(p).toMatch(/THE PAGE EXISTS/);
    expect(p).toMatch(/finish line/i);
    expect(p).toMatch(/tour IS YOUR CONFIRMATION|welcome tour that confirms/i);
    expect(p).toMatch(/CREATE ONCE|never (create )?twice|duplicate pages/i);
    expect(p).toMatch(/never (search for the page|go looking)|do not (go looking|reopen)/i);
  });
});

describe('the Facebook GROUP walk builds a community, not a page', () => {
  const p = get('herald.facebook.group.setup').prompt;
  it('distinguishes a GROUP (community) from a PAGE (broadcast)', () => {
    expect(p).toMatch(/COMMUNITY/i);
    expect(p).toMatch(/distinct from a PAGE|not a PAGE/i);
  });
  it('defaults to PUBLIC and never makes it secret unless told', () => {
    expect(p).toMatch(/Public/);
    expect(p).toMatch(/never make it Secret\/Private unless/i);
  });
  it('invites NOBODY this run — no spamming the owner\'s friends', () => {
    expect(p).toMatch(/invite NOBODY|invite no one/i);
  });
});

describe('the setup/operate split is intact', () => {
  it('setup roles CREATE (page/group), operate roles POST — never the same role doing both', () => {
    expect(get('herald.facebook.setup').prompt).toMatch(/CREATE ONE FACEBOOK PAGE/);
    expect(get('herald.facebook.operate').prompt).toMatch(/PUBLISH ONE PREPARED POST/);
    expect(get('herald.facebook.group.operate').prompt).toMatch(/PUBLISH ONE PREPARED POST inside a brand's Facebook GROUP/);
  });
  it('all twelve herald roles are registered and grouped under Herald (setup/onboard/operate + insights + two groups)', () => {
    const herald = Object.entries(ROLES).filter(([k]) => k.startsWith('herald.'));
    expect(herald).toHaveLength(12);
    for (const [, r] of herald) expect(r.group).toBe('Herald');
  });
  it('insights is READ-ONLY (no act) — it only looks', () => {
    expect(get('herald.facebook.insights').tools).not.toContain('act');
    expect(get('herald.facebook.insights').prompt).toMatch(/only LOOK|read-only|never post/i);
  });
  it('group engage is value-first and acts as the OWNER (Facebook groups are personal, not pages)', () => {
    const p = get('herald.facebook.groups.engage').prompt;
    expect(get('herald.facebook.groups.engage').tools).toContain('act');
    expect(p).toMatch(/NEVER A PITCH|DO NOT post it/i);
    expect(p).toMatch(/NO product mention|NO link|worse than silence/i);
    expect(p).toMatch(/as the OWNER|owner's own (personal )?profile/i);
    expect(p).toMatch(/NOT the brand's page|never pretending to be it|not as a page/i);
    // Replies in the POST's own language — the multilingual advantage, made an explicit rule.
    expect(p).toMatch(/REPLY IN THE POST'S OWN LANGUAGE|Read the language of the post/i);
    expect(p).toMatch(/Dutch.*Dutch|Spanish|meet each person in theirs/i);
  });
  it('group find joins to belong, never mass-joins or posts', () => {
    const p = get('herald.facebook.groups.find').prompt;
    expect(p).toMatch(/to belong|never to advertise/i);
    expect(p).toMatch(/AT MOST a few|never mass-join/i);
    expect(p).toMatch(/Do NOT post|joining only/i);
  });
  it('group find answers a private group\'s join questions HONESTLY as a vendor — never faking a professional role', () => {
    // A private group gates joins with questions ("your role in the trade?"). The owner is a vendor,
    // not a professional; answering as one would be a lie that gets the account banned.
    const p = get('herald.facebook.groups.find').prompt;
    expect(p).toMatch(/JOIN QUESTIONS|answer.*questions/i);
    expect(p).toMatch(/AS A VENDOR|you build\/run the brand/i);
    expect(p).toMatch(/NEVER claim to be a professional|do NOT fake/i);
    expect(p).toMatch(/pending/i);
  });
  it('herald.facebook.onboard is the FILL role — separate from create (setup) and posting (operate)', () => {
    const o = get('herald.facebook.onboard');
    expect(o.prompt).toMatch(/FILL ONE EMPTY FACEBOOK PAGE/);
    expect(o.tools).toContain('make_brand_image');
    expect(o.tools).toContain('upload_image');
  });
  it('onboard knows the real FB-page edit landmarks — the Edit hub, and the SECOND click (Upload photo) that reveals the file field', () => {
    // The live CaseHandoff onboard opened "Acties voor profielfoto" but never clicked "Foto uploaden",
    // so the file field never appeared and it looped. These are the fix, from the real UI.
    const p = get('herald.facebook.onboard').prompt;
    expect(p).toMatch(/EDIT HUB|Edit profile view|Profiel bewerken/i);
    expect(p).toMatch(/Foto uploaden|Upload photo/);
    expect(p).toMatch(/second (step|click)|reveals the file field/i);
    expect(p).toMatch(/Bio bewerken|Edit bio/i);      // the About lives here too
  });
  it('the photo dialog has its OWN save — never the page-level "Wijzigingen opslaan"', () => {
    // The live run uploaded the profile but clicked "Wijzigingen opslaan" (page save) instead of the
    // photo dialog\'s "Opslaan", so the picture never set while the cover (which used its own save) did.
    const p = get('herald.facebook.onboard').prompt;
    expect(p).toMatch(/PHOTO DIALOG/);
    expect(p).toMatch(/NOT .*Wijzigingen opslaan|not .*Save changes/i);
    expect(p).toMatch(/Opslaan.*Save.*Apply|dialog's OWN/i);
  });
  it('the first post uses the on-page composer, not the Planner or a plugins URL', () => {
    const p = get('herald.facebook.onboard').prompt;
    expect(p).toMatch(/Deel een gedachte|Schrijf iets|Write something|Create post/);
    expect(p).toMatch(/NOT use the Planner|do NOT open a plugins|not .*Opmerking plaatsen/i);
  });
  it('after typing the post, the only next action is Publish — never re-click the text field', () => {
    // The live run typed the post then clicked the text field over and over instead of publishing.
    const p = get('herald.facebook.onboard').prompt;
    expect(p).toMatch(/ONLY NEXT ACTION IS TO PUBLISH|Do NOT click the text box again/i);
    expect(p).toMatch(/Plaatsen|Posten|Publiceren/);
    expect(p).toMatch(/TWO DIFFERENT elements|distinct BUTTON/i);
  });
});

describe('the setup roles work in ANY language, not just English', () => {
  it('Facebook page + group setup match controls by meaning, with examples-not-a-list, in any language', () => {
    for (const name of ['herald.facebook.setup', 'herald.facebook.group.setup']) {
      const p = get(name).prompt;
      expect(p, name).toMatch(/ANY LANGUAGE/);
      expect(p, name).toMatch(/WHAT IT DOES|by their function|by MEANING/i);
      expect(p, name).toMatch(/examples?[^.]*not a list|illustrations,? not a list/i);
      expect(p, name).toMatch(/never loop waiting for an English label/i);
    }
  });
  it('the desktop page-create form is described as ONE screen (name, category, create) — no phantom Next', () => {
    const p = get('herald.facebook.setup').prompt;
    expect(p).toMatch(/ONE-SCREEN form/);
    expect(p).toMatch(/no Next on this screen|do not hunt for them/i);
  });
});

describe('the desktop create form handles the category autocomplete and cannot loop', () => {
  const p = get('herald.facebook.setup').prompt;
  it('says the category is an autocomplete — type once, then CLICK a suggestion, never retype', () => {
    expect(p).toMatch(/CATEGORY IS AN AUTOCOMPLETE/);
    expect(p).toMatch(/CLICK the closest suggestion/);
    expect(p).toMatch(/submit=true/);
    expect(p).toMatch(/AT MOST twice/);
  });
  it('has a HARD anti-loop: never type the same field more than twice', () => {
    expect(p).toMatch(/HARD ANTI-LOOP/);
    expect(p).toMatch(/never type into the SAME field more than twice/);
    expect(p).toMatch(/waiting for you to CLICK/);
  });
});
