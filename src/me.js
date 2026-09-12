/**
 * me.js — what the agent knows about the person it is acting as.
 *
 * WHY THIS EXISTS. An agent replying under someone's real name has one job before all the others:
 * sound like them. Not "professional", not "friendly" — like the specific person whose name is on
 * the comment, who has been posting in these groups for years and whose neighbours recognise how
 * they write. Anything else reads as a bot to the humans in the thread, which is the failure that
 * actually matters, long before any platform's detection notices.
 *
 * The material for that already exists: their own posts and their own replies, on the accounts this
 * browser is already logged into. So the agent goes and reads them, and writes down what it learns.
 *
 * TWO KINDS OF KNOWLEDGE, kept apart on purpose:
 *
 *   FACTS — where they live, what they do, which groups they are in, how they sign off. Short,
 *   editable, and the thing that makes a reply specific rather than generic.
 *
 *   SAMPLES — actual sentences they actually wrote, kept verbatim with where they came from. A
 *   description of a writing style produces an imitation of a description. Real examples produce
 *   something closer to the real thing, and they are also auditable: a person can read them back
 *   and delete anything that should not be in there.
 *
 * WHOSE DATA THIS IS. It is the owner's own account, read by the owner's own browser, stored on the
 * owner's own volume, and never sent anywhere except to the model they configured. It is visible
 * and deletable in the UI for the same reason: a profile of a person that the person cannot read is
 * not something this should be building.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.PROFILE_DIR || '/profiles', 'me.json');

const BLANK = {
  name: '',
  /*
   * Deliberately a free-form map rather than fixed columns. What matters about one person is their
   * trade and their region; about another it is the four groups they moderate. A fixed schema would
   * throw away whichever of those did not fit.
   */
  facts: {},          // label -> value
  samples: [],        // { text, where, at }
  style: '',          // the agent's own summary, written after reading the samples
  sources: [],        // which profiles it has already studied, so it does not redo them
  updatedAt: null,
};

function read() {
  try { return { ...BLANK, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch { return { ...BLANK }; }
}

function save(next) {
  const out = { ...next, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

/** One thing learned. Overwrites the same label rather than accumulating contradictions. */
function remember(label, value, source) {
  const m = read();
  const k = String(label || '').trim().slice(0, 80);
  if (!k) return m;
  const v = String(value || '').trim().slice(0, 600);
  if (!v) delete m.facts[k];
  else m.facts[k] = source ? `${v} (${String(source).slice(0, 60)})` : v;
  return save(m);
}

/**
 * A sentence they actually wrote. Capped in both directions: under twenty characters is "ok thanks"
 * and teaches nothing, and the cap on the count keeps the prompt affordable — forty examples is
 * already far more than a model needs to catch a voice.
 */
function addSample(text, where) {
  const m = read();
  const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 700);
  if (t.length < 20) return null;
  if (m.samples.some((s) => s.text === t)) return null;
  const sample = { text: t, where: String(where || '').slice(0, 200), at: new Date().toISOString() };
  m.samples.push(sample);
  if (m.samples.length > 40) m.samples.splice(0, m.samples.length - 40);
  save(m);
  return sample;
}

const setStyle = (style) => save({ ...read(), style: String(style || '').trim().slice(0, 2000) });

/** Note that a profile has been studied, so a later run can skip it or deliberately redo it. */
function markStudied(profile, note) {
  const m = read();
  const at = new Date().toISOString();
  const existing = m.sources.find((s) => s.profile === profile);
  if (existing) Object.assign(existing, { at, note: String(note || '').slice(0, 300) });
  else m.sources.push({ profile, at, note: String(note || '').slice(0, 300) });
  return save(m);
}

const forget = () => save({ ...BLANK });

/**
 * How this reaches the model.
 *
 * The samples go in RAW and last, because that is what actually transfers a voice — an instruction
 * to "write informally" produces a generic informal sentence, while five of someone's own sentences
 * produce a sixth that belongs with them.
 */
function asContext() {
  const m = read();
  const parts = [];
  if (m.name) parts.push(`You are writing as ${m.name}.`);
  const facts = Object.entries(m.facts || {});
  if (facts.length) parts.push(`About them:\n${facts.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
  if (m.style) parts.push(`How they write:\n${m.style}`);
  if (m.samples.length) {
    // The most recent, because a voice from six years ago is not the current one.
    const recent = m.samples.slice(-12);
    parts.push(`Things they have actually written — match this, do not copy it:\n${recent.map((s) => `"${s.text}"`).join('\n')}`);
  }
  return parts.join('\n\n');
}

const summary = () => {
  const m = read();
  return { name: m.name, facts: m.facts, style: m.style, sampleCount: m.samples.length,
           samples: m.samples, sources: m.sources, updatedAt: m.updatedAt };
};

module.exports = { read, save, remember, addSample, setStyle, markStudied, forget, asContext, summary, FILE, BLANK };
