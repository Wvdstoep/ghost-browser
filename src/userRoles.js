'use strict';
/**
 * userRoles — the roles a PERSON authored, kept as data, alongside the ones the codebase ships.
 *
 * WHY THIS EXISTS. Until now a role was a code entry in roles.js: a site, a set of tools and a
 * playbook, hand-written and shipped in the image. That is the right home for the built-ins, but it
 * makes the agent a thing only we can teach. The marketplace turns a role into something a user can
 * write, share and import — so it has to be DATA, not code, and it has to live somewhere that
 * survives a restart. This is that store.
 *
 * WHERE IT LIVES. One JSON file per role under /profiles/roles — the same PVC the browser profiles
 * and jobs already persist to, so a user's roles outlive the pod exactly the way their logins do.
 * No database to add, no schema to migrate: a role is a small document, and a directory of documents
 * is the honest shape of it.
 *
 * THE ONE RULE THAT KEEPS THIS SAFE. A built-in ALWAYS wins a name collision (see roles.js), so
 * nothing a user or a downloaded pack authors can shadow, redefine or break a role the factory
 * depends on. User roles are strictly additive. The act gate is unchanged and un-bypassable: a role
 * may LIST `act` in its tools, but every act still stops for the owner's approval — a role decides
 * what the agent reaches for, never whether it may act without asking.
 */

const fs = require('fs');
const path = require('path');

// Same volume the profiles live on. Deliberately derived from PROFILE_DIR so the two move together.
const DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'roles');

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* first write will surface a real error */ }
}

const fileFor = (id) => path.join(DIR, `${id}.json`);

/** A stable, filesystem-safe id from a human label. Not the label — labels change, ids must not. */
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Read one role document, or null if it is not there / not readable. Never throws. */
function read(id) {
  try { return JSON.parse(fs.readFileSync(fileFor(String(id)), 'utf8')); }
  catch { return null; }
}

/** Every stored role, newest first. A directory that does not exist yet is simply empty. */
function all() {
  ensureDir();
  let names;
  try { names = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); }
  catch { return []; }
  return names
    .map((f) => read(f.replace(/\.json$/, '')))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** An id nothing else already uses, based on the label. */
function uniqueId(label, keep) {
  const base = slug(label) || 'role';
  let id = base, n = 2;
  while (read(id) && id !== keep) { id = `${base}-${n}`; n += 1; }
  return id;
}

/**
 * Is this a role we are willing to store? `paletteNames` is the set of real tool names, passed in so
 * this file never has to require the agent (and cause a cycle). Returns a list of what is missing, in
 * plain words a person can act on — empty means it is good.
 */
function validate(role, paletteNames) {
  const errs = [];
  const label = String(role && role.label || '').trim();
  if (label.length < 3) errs.push('a name of at least 3 characters');

  const prompt = String(role && role.prompt || '').trim();
  if (prompt.length < 20) errs.push('a playbook of at least 20 characters — tell it plainly what its job is');

  // tools: null/absent means "every tool", which the built-ins use too and is allowed on purpose.
  // A list must name only real tools: a typo would silently narrow the agent, which is miserable to
  // diagnose, so we refuse it at the door rather than let it through and confuse someone later.
  const tools = role && role.tools;
  if (tools !== null && tools !== undefined) {
    if (!Array.isArray(tools)) {
      errs.push('tools must be a list (or left empty to allow all)');
    } else if (tools.length === 0) {
      errs.push('at least one tool selected (or leave it empty to allow all)');
    } else if (Array.isArray(paletteNames)) {
      const bad = tools.filter((t) => !paletteNames.includes(t));
      if (bad.length) errs.push(`tool(s) that do not exist: ${bad.join(', ')}`);
    }
  }
  return errs;
}

/** Store a role. Throws a 400-carrying error listing what it needs if it does not validate. */
function save(role, paletteNames) {
  ensureDir();
  const errs = validate(role, paletteNames);
  if (errs.length) {
    const e = new Error(`This role still needs ${errs.join('; ')}.`);
    e.status = 400;
    throw e;
  }
  // Editing keeps the id; creating mints a fresh one. `keep` lets a rename of an existing role hold
  // its id even though the slug of the new label would differ.
  const existing = role.id ? read(role.id) : null;
  const id = existing ? role.id : uniqueId(role.label);

  const rec = {
    id,
    site: role.site ? String(role.site).toLowerCase().slice(0, 40) : null,
    group: String(role.group || 'Yours').slice(0, 40),
    label: String(role.label).trim().slice(0, 120),
    description: String(role.description || '').trim().slice(0, 400),
    tools: (role.tools === null || role.tools === undefined) ? null : role.tools.slice(0, 80),
    prompt: String(role.prompt).trim().slice(0, 20000),
    source: String(role.source || (existing && existing.source) || 'user').slice(0, 80),
    author: String(role.author || (existing && existing.author) || '').slice(0, 120),
    createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), { mode: 0o600 });
  return rec;
}

/** Forget a role. Returns whether there was one to forget. */
function remove(id) {
  try { fs.unlinkSync(fileFor(String(id))); return true; }
  catch { return false; }
}

// ── The two shapes roles.js asks of an external provider ─────────────────────────────────────────

/**
 * By id, in the exact shape the agent reads a built-in role in (site/group/label/description/tools/
 * prompt) — so a user role runs through agent.js on the identical path, with nothing special-cased.
 */
function getRole(id) {
  const r = read(id);
  if (!r) return null;
  return {
    site: r.site || null,
    group: r.group || 'Yours',
    label: r.label,
    description: r.description,
    tools: r.tools === undefined ? null : r.tools,
    prompt: r.prompt || '',
  };
}

/** For a picker: the display row for every user role, tagged so the UI can say where it came from. */
function listRoles() {
  return all().map((r) => ({
    name: r.id,
    label: r.label,
    description: r.description,
    site: r.site || null,
    group: r.group || 'Yours',
    source: r.source || 'user',
    tools: r.tools === undefined ? null : r.tools,
  }));
}

// ── Packs: a platform-and-its-roles as one shareable document ────────────────────────────────────

/**
 * Gather the named roles into a pack — the unit of sharing. Ids and timestamps are dropped: a pack is
 * a recipe, not a copy of someone's install, and it should slot cleanly into whoever imports it.
 */
function exportPack(ids, name) {
  const wanted = new Set((ids || []).map(String));
  const picked = all().filter((r) => wanted.has(r.id));
  return {
    kind: 'ghost-roles-pack',
    name: String(name || 'My roles').slice(0, 120),
    exportedAt: new Date().toISOString(),
    roles: picked.map((r) => ({
      site: r.site || null,
      group: r.group || 'Yours',
      label: r.label,
      description: r.description,
      tools: r.tools === undefined ? null : r.tools,
      prompt: r.prompt,
    })),
  };
}

/**
 * Install a pack. Every role is validated against the real palette FIRST — a pack that names a tool
 * this build does not have is refused whole, not half-installed — then each is stored, tagged with
 * the pack it came from so a user can see (and later remove) a set as one thing. Returns what landed.
 */
function importPack(pack, paletteNames) {
  if (!pack || pack.kind !== 'ghost-roles-pack' || !Array.isArray(pack.roles)) {
    const e = new Error('That is not a roles pack.');
    e.status = 400;
    throw e;
  }
  const tag = `pack:${slug(pack.name) || 'imported'}`;
  const problems = [];
  pack.roles.forEach((r, i) => {
    const errs = validate(r, paletteNames);
    if (errs.length) problems.push(`role ${i + 1} (${r.label || 'unnamed'}) needs ${errs.join('; ')}`);
  });
  if (problems.length) {
    const e = new Error(`This pack cannot be installed as-is: ${problems.join(' · ')}.`);
    e.status = 400;
    throw e;
  }
  return pack.roles.map((r) => save({ ...r, id: null, source: tag, author: pack.name }, paletteNames));
}

// The toolset every role should have unless it needs less: getting around, plus the account tools.
// A default, not a source of truth — used only when a draft names nothing usable.
const BASICS = ['look', 'read', 'open', 'click', 'type', 'scroll', 'back', 'note', 'finish', 'list_profiles', 'use_profile'];
const DRAFT_SITES = ['facebook', 'linkedin', 'google', 'reddit', 'x', 'youtube', 'instagram'];

/**
 * Turn a model's reply into a SAFE role draft. The reply is untrusted text — it may wrap its JSON in
 * prose or a ```json fence, name tools that do not exist, or be garbled entirely. So: pull the first
 * {...} out, parse what we can, and COERCE the rest — unknown tools dropped, site normalised, empty
 * fields defaulted rather than trusted. Never throws; a hopeless reply yields a draft a person can
 * still finish by hand. Returns a draft only — saving is a separate, deliberate act.
 */
function coerceDraft(text, paletteNames) {
  let obj = {};
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (m) obj = JSON.parse(m[0]);
  } catch { /* fall through to the defaulted draft */ }
  const allow = new Set(Array.isArray(paletteNames) ? paletteNames : []);
  let tools = Array.isArray(obj.tools) ? obj.tools.filter((t) => allow.has(t)) : [];
  if (!tools.length) tools = BASICS.filter((t) => !allow.size || allow.has(t));
  const site = DRAFT_SITES.includes(String(obj.site || '').toLowerCase()) ? String(obj.site).toLowerCase() : null;
  return {
    label: String(obj.label || '').slice(0, 120),
    site,
    description: String(obj.description || '').slice(0, 400),
    tools,
    prompt: String(obj.prompt || '').slice(0, 20000),
  };
}

module.exports = {
  DIR, slug, read, all, validate, save, remove,
  getRole, listRoles, exportPack, importPack, coerceDraft, BASICS,
};
