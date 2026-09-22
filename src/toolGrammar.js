/*
 * toolGrammar.js — ONE TOOL CATALOGUE, THREE WAYS OF HOLDING A MODEL TO IT.
 *
 * A small model's largest failure is not choosing the wrong tool, it is producing something that is
 * not a tool call at all: prose around the JSON, a trailing comma, a field renamed, a tool invented.
 * None of that needs training to fix — it needs the decoder to be unable to emit it.
 *
 * Three runtimes serve this agent and each constrains differently, so one definition produces all
 * three rather than three hand-kept copies drifting apart:
 *
 *   - THE CLOUD MODEL today is Ollama's /api/chat, which takes `format` with a JSON Schema.
 *   - A LOCAL MODEL on a device will be llama.cpp, which takes a GBNF grammar.
 *   - AND NEITHER IS ENOUGH ALONE: a constrained decoder still cannot know that `click` needs an
 *     index, so a validator checks the call against the catalogue afterwards.
 *
 * The validator is also the measuring instrument. "How often is the reply malformed" is the baseline
 * a fine-tune has to beat, and it cannot be measured by a thing that guesses.
 */
'use strict';

/** The shape agent.js declares: { type:'function', function:{ name, description, parameters } }. */
const fnOf = (t) => (t && t.function) || {};
const nameOf = (t) => String(fnOf(t).name || '');
const paramsOf = (t) => fnOf(t).parameters || { type: 'object', properties: {} };

/* ── the catalogue itself ───────────────────────────────────────────────────────────────────── */

/**
 * PROBLEMS IN THE CATALOGUE, BEFORE ANY MODEL IS BLAMED FOR THEM.
 *
 * Found by running this over the real list: `download_file` is declared TWICE, at agent.js:419 and
 * agent.js:457, with different descriptions and different parameters. A model shown two tools with
 * one name and conflicting instructions has no way to choose, a role listing `download_file` gets
 * both, and every recorded call to it is ambiguous evidence. That is a catalogue defect wearing the
 * costume of a model defect, and the difference matters when the reward signal is being built out of
 * those very calls.
 */
function auditCatalogue(tools) {
  const problems = [];
  const seen = new Map();
  for (const t of (tools || [])) {
    const n = nameOf(t);
    if (!n) { problems.push({ kind: 'nameless', detail: 'a tool with no name' }); continue; }
    if (seen.has(n)) {
      problems.push({ kind: 'duplicate', name: n, detail: `"${n}" is declared more than once, with different descriptions` });
    } else seen.set(n, t);
    if (!String(fnOf(t).description || '').trim()) problems.push({ kind: 'undescribed', name: n, detail: `"${n}" has no description` });
    const p = paramsOf(t);
    if (p && p.type !== 'object') problems.push({ kind: 'params', name: n, detail: `"${n}" parameters are ${p.type}, not an object` });
    for (const r of (p && Array.isArray(p.required) ? p.required : [])) {
      if (!p.properties || !p.properties[r]) {
        problems.push({ kind: 'required-missing', name: n, detail: `"${n}" requires "${r}" but never declares it` });
      }
    }
  }
  return { count: seen.size, problems };
}

/** Unique names, in declaration order — the first declaration of a duplicate wins, as it does today. */
function toolNames(tools) {
  const out = [];
  const seen = new Set();
  for (const t of (tools || [])) {
    const n = nameOf(t);
    if (!n || seen.has(n)) continue;
    seen.add(n); out.push(n);
  }
  return out;
}

/* ── the JSON Schema, for a cloud model that takes `format` ─────────────────────────────────── */

/**
 * WHY `args` IS LEFT PERMISSIVE, DELIBERATELY.
 *
 * The exact schema would be a union: one argument shape per tool, chosen by the name. Support for
 * `oneOf` in a structured-output decoder varies by provider and by version, and a schema the server
 * silently declines leaves you believing you are constrained when you are not. So the schema
 * guarantees the two things every provider does enforce — valid JSON, and a tool name from the list
 * — and the validator below checks the arguments, where a rejection is visible and testable.
 */
function schemaFor(tools) {
  return {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: toolNames(tools) },
      args: { type: 'object' },
    },
    required: ['tool'],
    additionalProperties: false,
  };
}

/* ── the GBNF grammar, for llama.cpp on a device ────────────────────────────────────────────── */

/** A GBNF string literal: only the quote and the backslash need escaping inside one. */
const gbnfLit = (s) => `"\\"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}\\""`;

/**
 * A grammar that can only produce a tool call.
 *
 * Written out rather than generated from the JSON Schema on purpose: the value rules have to cover
 * every argument any tool takes — strings with escapes, integers, booleans, nested objects, arrays —
 * and a grammar derived from a permissive `args: object` would be exactly this anyway. `{m,n}`
 * repetition is avoided so it parses on older llama.cpp builds as well.
 */
function gbnfFor(tools) {
  const names = toolNames(tools);
  if (!names.length) throw new Error('a grammar needs at least one tool');
  return [
    'root    ::= "{" ws "\\"tool\\"" ws ":" ws toolname ws "," ws "\\"args\\"" ws ":" ws object ws "}"',
    `toolname ::= ${names.map(gbnfLit).join(' | ')}`,
    'object  ::= "{" ws ( pair ( ws "," ws pair )* )? ws "}"',
    'pair    ::= string ws ":" ws value',
    'array   ::= "[" ws ( value ( ws "," ws value )* )? ws "]"',
    'value   ::= object | array | string | number | "true" | "false" | "null"',
    'string  ::= "\\"" char* "\\""',
    'char    ::= [^"\\\\] | "\\\\" escape',
    'escape  ::= ["\\\\/bfnrt] | "u" hex hex hex hex',
    'hex     ::= [0-9a-fA-F]',
    'number  ::= "-"? int frac? exp?',
    'int     ::= "0" | [1-9] [0-9]*',
    'frac    ::= "." [0-9]+',
    'exp     ::= [eE] ("+" | "-")? [0-9]+',
    'ws      ::= [ \\t\\n]*',
    '',
  ].join('\n');
}

/* ── the validator, which works whatever produced the reply ─────────────────────────────────── */

/**
 * Is this a usable tool call?
 *
 * Takes the raw reply or a parsed object. Returns every problem rather than the first, because the
 * point is to measure how wrong a model is, not merely whether it is wrong.
 *
 * `unknownArgs` is reported but not fatal: a model passing an extra field is untidy and harmless,
 * while a MISSING required field means the call cannot be run at all. Conflating the two would make
 * the malformed rate meaningless as a baseline.
 */
function validateCall(input, tools) {
  const errors = [];
  let obj = input;

  if (typeof input === 'string') {
    const first = firstJsonObject(input);
    if (first == null) return { ok: false, tool: null, args: null, errors: ['no JSON object in the reply'], strayText: input.trim().slice(0, 120) };
    /* Text around the JSON is the classic small-model failure and worth counting separately: the
       call may be perfectly good and still break a strict parser. */
    const stray = input.replace(first, '').trim();
    try { obj = JSON.parse(first); } catch (e) { return { ok: false, tool: null, args: null, errors: [`the JSON did not parse: ${e.message}`] }; }
    if (stray) errors.push('there was text around the JSON');
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, tool: null, args: null, errors: ['the reply was not an object'] };
  }

  const tool = typeof obj.tool === 'string' ? obj.tool : (typeof obj.name === 'string' ? obj.name : null);
  if (typeof obj.tool !== 'string' && typeof obj.name === 'string') errors.push('the tool was under "name" rather than "tool"');
  if (!tool) errors.push('no tool was named');

  const known = new Map((tools || []).map((t) => [nameOf(t), t]));
  const spec = tool ? known.get(tool) : null;
  if (tool && !spec) errors.push(`"${tool}" is not a tool that exists`);

  let args = obj.args;
  if (args == null && obj.arguments != null) { args = obj.arguments; errors.push('the arguments were under "arguments" rather than "args"'); }
  if (typeof args === 'string') {
    try { args = JSON.parse(args); errors.push('the arguments arrived as a string of JSON'); }
    catch (e) { errors.push('the arguments were a string that is not JSON'); args = null; }
  }
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) { errors.push('the arguments were not an object'); args = {}; }

  const missing = [];
  const unknownArgs = [];
  if (spec) {
    const p = paramsOf(spec);
    for (const r of (Array.isArray(p.required) ? p.required : [])) {
      if (args[r] === undefined || args[r] === null || args[r] === '') missing.push(r);
    }
    const declared = new Set(Object.keys(p.properties || {}));
    for (const k of Object.keys(args)) if (declared.size && !declared.has(k)) unknownArgs.push(k);
  }
  if (missing.length) errors.push(`"${tool}" needs ${missing.join(', ')}`);

  return {
    /* Runnable: a real tool, and nothing required is absent. Untidiness does not make it unusable. */
    ok: !!spec && missing.length === 0,
    tool: tool || null,
    args,
    missing,
    unknownArgs,
    errors,
  };
}

/** The first balanced {...} in a string, ignoring braces inside strings. */
function firstJsonObject(s) {
  const text = String(s || '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

module.exports = { schemaFor, gbnfFor, validateCall, auditCatalogue, toolNames, firstJsonObject };
