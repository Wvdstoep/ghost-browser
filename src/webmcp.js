'use strict';
/**
 * webmcp.js — use the tools a page offers, before guessing at its buttons.
 *
 * WebMCP (a W3C community-group proposal from Google and Microsoft) lets a page register callable
 * tools with the browser: a name, a description, a JSON input schema and an `execute` function. An
 * agent that finds them can call "add_to_cart({sku})" instead of locating and clicking things. The
 * surface has been moving: it was `navigator.modelContext`, and recent sources put it at
 * `document.modelContext`. So this does not depend on either. It installs a capture on BOTH where
 * the browser has none, and wraps the native one where it has, so a page that registers tools is
 * heard whichever object it uses and whether or not this Chromium implements the API.
 *
 * Calls run INSIDE the page (the tool's own execute()), so whatever request they make passes the
 * session's write lease like any other request: a tool is not a way around the gate.
 */

/* Runs in the page, before any page script. */
function installCapture() {
  if (window.__gbWebMcp) return;
  const tools = new Map();
  const store = { tools, calls: 0 };
  Object.defineProperty(window, '__gbWebMcp', { value: store, enumerable: false });

  /* Two sources, kept apart: registerTool adds one tool and provideContext replaces the SET it
     previously provided. A provideContext must not wipe tools that were registered one by one. */
  const keep = (t, src) => {
    if (!t || typeof t.name !== 'string' || typeof t.execute !== 'function') return;
    tools.set(t.name, { src, name: t.name, description: String(t.description || ''), inputSchema: t.inputSchema || { type: 'object', properties: {} }, execute: t.execute });
  };
  const patch = (owner) => {
    if (!owner) return;
    const mc = owner.modelContext;
    if (mc && mc.__gbWrapped) return;
    const real = mc || {};
    const wrapped = Object.create(real);
    const hook = (name, fn) => { wrapped[name] = function (...a) { try { fn(...a); } catch (e) { /* capture must never break the page */ } return typeof real[name] === 'function' ? real[name].apply(real, a) : undefined; }; };
    hook('registerTool', (t) => keep(t, 'reg'));
    hook('unregisterTool', (n) => tools.delete(typeof n === 'string' ? n : n && n.name));
    const dropProvided = () => { for (const [n, t] of [...tools]) if (t.src === 'prov') tools.delete(n); };
    hook('provideContext', (c) => { dropProvided(); for (const t of (c && c.tools) || []) keep(t, 'prov'); });
    hook('clearContext', dropProvided);
    Object.defineProperty(wrapped, '__gbWrapped', { value: true });
    try { Object.defineProperty(owner, 'modelContext', { value: wrapped, configurable: true, writable: true }); } catch (e) { /* a frozen owner: leave it */ }
  };
  patch(navigator); patch(document);
}

/** Install on a context: every page and frame, before its own scripts run. */
async function attach(context) { await context.addInitScript(installCapture); }

/** The tools this page has registered. Never throws: a page with none is the common case. */
async function list(page) {
  try {
    return await page.evaluate(() => {
      const s = window.__gbWebMcp; if (!s) return [];
      return [...s.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    });
  } catch { return []; }
}

/** Call one by name. The result is whatever the tool returned, as JSON-safe data; a refusal is an error string, not a throw. */
async function call(page, name, args = {}) {
  return page.evaluate(async ({ name, args }) => {
    const s = window.__gbWebMcp; const t = s && s.tools.get(name);
    if (!t) return { ok: false, error: `this page has no tool called "${name}"` };
    s.calls += 1;
    try {
      const out = await t.execute(args, { requestUserInteraction: async (fn) => (typeof fn === 'function' ? fn() : undefined) });
      return { ok: true, result: JSON.parse(JSON.stringify(out === undefined ? null : out)) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }, { name: String(name), args });
}

module.exports = { installCapture, attach, list, call };
