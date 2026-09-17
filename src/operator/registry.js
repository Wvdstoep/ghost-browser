/**
 * The operator's tool registry: a name, a description the model reads, a JSON schema for the
 * arguments, and the function. Nothing else — the definitions go to the model as function tools,
 * the executor runs the function with parsed arguments. `repeatable` marks tools that are legitimately
 * called again with identical arguments (waits, reads), so the harness's identical-call breaker
 * leaves them alone.
 */
class Registry {
  constructor() { this.tools = new Map(); }
  register(name, description, parameters, fn, opts = {}) {
    if (!name || typeof fn !== 'function') throw new Error('register(name, description, parameters, fn)');
    this.tools.set(name, { name, description: String(description || ''), parameters: parameters || { type: 'object', properties: {} }, fn, repeatable: !!opts.repeatable });
    return this;
  }
  has(name) { return this.tools.has(name); }
  get(name) { return this.tools.get(name) || null; }
  names() { return [...this.tools.keys()]; }
  /** OpenAI/Ollama function-tool definitions. */
  definitions() {
    return [...this.tools.values()].map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  async execute(name, args) {
    const t = this.tools.get(name);
    if (!t) return { error: `no such tool: ${name}` };
    try { const out = await t.fn(args && typeof args === 'object' ? args : {}); return out === undefined ? { ok: true } : out; }
    catch (e) { return { error: String((e && e.message) || e).slice(0, 600) }; }
  }
}

module.exports = { Registry };
