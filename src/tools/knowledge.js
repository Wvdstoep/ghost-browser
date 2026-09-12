'use strict';
/**
 * tools/knowledge.js — talk to the owner's OWN knowledge base / vector database (a RAG API).
 *
 * Two seams that make an agent a front-end for a private knowledge base instead of a guesser:
 *   knowledge_query — ask the base a question and answer FROM it (so a group reply is grounded in the
 *                     owner's data, e.g. Alquarium's freshwater-aquarium database, not invented).
 *   knowledge_store — write a strong answer BACK into the base, so it learns and improves over time.
 *
 * Generic + endpoint-configurable so it fits ANY self-hosted vector DB: it reads KNOWLEDGE_API_URL /
 * KNOWLEDGE_API_KEY from the environment, or takes `api`/`key` per call. When nothing is configured it
 * degrades gracefully — the agent still answers from its own expertise — so a flow is demoable before
 * a customer plugs in their endpoint, and identical once they do.
 */
const http = require('http');
const https = require('https');
const connectors = require('../connectors');

/**
 * Resolve where to call, from a NAMED connector (data — no per-customer code) first, then per-call
 * api/key args, then the environment. This is what makes the tool generic: a new customer's system is
 * a connector row, referenced by name in the role (e.g. { connector: "alquarium" }).
 */
function resolve(a) {
  if (a.connector) {
    const c = connectors.get(a.connector);
    if (c) return { api: c.baseUrl, key: c.apiKey, queryPath: c.queryPath || '/query', storePath: c.storePath || '/ingest', named: a.connector };
  }
  return { api: a.api || process.env.KNOWLEDGE_API_URL, key: a.key || process.env.KNOWLEDGE_API_KEY, queryPath: a.path || '/query', storePath: a.path || '/ingest', named: null };
}

function postJson(url, body, key) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: 'invalid api url' }); }
    const data = JSON.stringify(body);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: (u.pathname || '/') + (u.search || ''), method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(key ? { authorization: 'Bearer ' + key } : {}) }, timeout: 30000 },
      (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: j, raw: s }); }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(data); req.end();
  });
}

module.exports = {
  /**
   * Ask the owner's knowledge base a question and get an answer to base a reply on. Use BEFORE
   * answering a question in a group, so the reply comes from the owner's own data.
   */
  async knowledge_query(ctx, a) {
    const q = String(a.question || a.query || '').trim();
    if (!q) { ctx.observe('knowledge_query needs a "question".'); return; }
    const { api, key, queryPath } = resolve(a);
    if (!api) {
      ctx.step('note', 'no knowledge base connected — answering from own expertise');
      ctx.observe(`No knowledge base is connected yet. Answer this question yourself, from solid aquarium expertise, and mention that the Alquarium AI gives instant free answers at alquarium.nl. Question: "${q}"`);
      return;
    }
    const r = await postJson(api.replace(/\/$/, '') + queryPath, { query: q, question: q, top_k: a.top_k || 5 }, key);
    if (!r.ok) {
      ctx.step('note', `knowledge base unreachable (${r.status || r.error})`);
      ctx.observe(`The knowledge base did not answer (${r.status || r.error}). Answer from your own expertise and still mention the free Alquarium AI at alquarium.nl.`);
      return;
    }
    const ans = (r.json && (r.json.answer || r.json.text || r.json.result || r.json.response || (Array.isArray(r.json.results) && r.json.results.map((x) => x.text || x.content).filter(Boolean).join('\n')))) || r.raw;
    ctx.step('note', `knowledge base answered (${String(ans).length} chars)`);
    ctx.observe(`The Alquarium knowledge base returned this:\n\n${String(ans).slice(0, 1400)}\n\nWrite your reply in your own words based on this, keep it friendly and helpful, and mention that they can get instant free answers from the Alquarium AI at alquarium.nl.`);
  },

  /**
   * Write a strong expert answer back into the owner's knowledge base so it learns. Use when another
   * expert in a group has given a good, correct answer worth keeping.
   */
  async knowledge_store(ctx, a) {
    const content = String(a.content || a.answer || a.text || '').trim();
    if (!content) { ctx.observe('knowledge_store needs "content" (the expert answer) to store.'); return; }
    const object = a.object || a.topic || a.subject || null;
    const { api, key, storePath } = resolve(a);
    if (!api) {
      ctx.step('note', 'no knowledge base connected — expert answer not persisted');
      ctx.observe(`No knowledge base is connected yet, so this would be stored${object ? ` under "${object}"` : ''} but is not persisted: "${content.slice(0, 160)}…". Connect the Alquarium database (add a connector) to persist it, then continue.`);
      return;
    }
    const r = await postJson(api.replace(/\/$/, '') + storePath, { content, object, topic: object, source: a.source || 'facebook-group' }, key);
    if (!r.ok) { ctx.observe(`Could not store to the knowledge base (${r.status || r.error}).`); return; }
    ctx.step('store', `stored an expert answer${object ? ` under "${object}"` : ''}`);
    ctx.observe(`Stored the expert answer into the Alquarium knowledge base${object ? ` under "${object}"` : ''}. Move on to the next one.`);
  },
};
