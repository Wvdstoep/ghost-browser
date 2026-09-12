/**
 * company.js — who you are, so the agent knows what a lead looks like.
 *
 * "Find me leads" is not a task. It becomes one the moment the agent knows what is being sold, to
 * whom, where, and in whose voice — the same thing a new salesperson needs on day one, and the same
 * reason LeadFlow keeps a business profile rather than asking every time.
 *
 * The fields here are deliberately the ones that CHANGE THE ANSWER. A description of the company is
 * pleasant and useless; "roof cleaning, homeowners with a house older than 20 years, Noord-Holland,
 * never approach competitors" is what makes one post a lead and the next one noise. `avoid` is not
 * an afterthought either — an agent working an account under someone's real name needs to know
 * which doors not to knock on.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.PROFILE_DIR || '/profiles', 'companies.json');

const FIELDS = {
  name: 240,
  offer: 2000,        // what you sell, in your own words
  audience: 2000,     // who buys it — the closer to a person, the better the agent decides
  regions: 400,       // where. A group in another country is a wasted step.
  signals: 2000,      // what a post says when someone needs this. The single most useful field.
  avoid: 1000,        // who NOT to approach: competitors, existing customers, anything off-limits
  tone: 600,          // how a reply should sound, because it goes out under a real name
  language: 60,       // what to write in — a Dutch group answered in English reads as a bot
  links: 600,         // where to send someone who bites
};

const empty = () => Object.fromEntries(Object.keys(FIELDS).map((k) => [k, '']));

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeAll(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  return list;
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function normalize(input = {}) {
  const out = {};
  for (const [k, max] of Object.entries(FIELDS)) {
    if (typeof input[k] === 'string') out[k] = input[k].trim().slice(0, max);
  }
  return out;
}

function save(input = {}) {
  const list = readAll();
  const id = slug(input.id || input.name) || `company-${list.length + 1}`;
  const existing = list.find((c) => c.id === id);
  const merged = { ...empty(), ...(existing || {}), ...normalize(input), id };
  if (!merged.name) merged.name = id;
  if (existing) Object.assign(existing, merged); else list.push(merged);
  writeAll(list);
  return merged;
}

const get = (id) => readAll().find((c) => c.id === id) || null;

function remove(id) {
  const list = readAll();
  const next = list.filter((c) => c.id !== id);
  writeAll(next);
  return list.length !== next.length;
}

/**
 * The profile as the agent reads it. Empty fields are LEFT OUT rather than sent as blanks: a prompt
 * full of "audience: (not specified)" teaches the model that vagueness is normal, and it answers in
 * kind.
 */
function asContext(c) {
  if (!c) return '';
  const label = {
    name: 'Company', offer: 'What we offer', audience: 'Who we want to reach',
    regions: 'Where', signals: 'What a good lead sounds like', avoid: 'Never approach',
    tone: 'Voice to write in', language: 'Language to write in', links: 'Where to send people',
  };
  const lines = Object.keys(FIELDS)
    .filter((k) => c[k] && String(c[k]).trim())
    .map((k) => `${label[k]}: ${String(c[k]).trim()}`);
  return lines.join('\n');
}

module.exports = { readAll, save, get, remove, asContext, normalize, empty, FIELDS, FILE };
