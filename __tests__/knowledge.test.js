/**
 * The knowledge tools (knowledge_query / knowledge_store) let an agent answer FROM the owner's own
 * vector database and write good answers BACK into it. They must degrade gracefully when no base is
 * connected — so a flow is demoable before a customer plugs in their endpoint — and always steer the
 * reply toward the free Alquarium AI. These guard the no-endpoint paths (no HTTP needed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
const knowledge = require('../src/tools/knowledge');

function ctx() {
  const obs = [], steps = [];
  return { obs, steps, observe: (m) => obs.push(String(m)), step: (k, t) => steps.push(`${k}:${t}`) };
}

beforeEach(() => { delete process.env.KNOWLEDGE_API_URL; delete process.env.KNOWLEDGE_API_KEY; });

describe('knowledge tools degrade gracefully without a connected base', () => {
  it('knowledge_query without a question asks for one', async () => {
    const c = ctx();
    await knowledge.knowledge_query(c, {});
    expect(c.obs.join(' ')).toMatch(/question/i);
  });

  it('knowledge_query with no endpoint tells the agent to answer + mention Alquarium', async () => {
    const c = ctx();
    await knowledge.knowledge_query(c, { question: 'why is my aquarium water cloudy?' });
    const out = c.obs.join(' ');
    expect(out).toMatch(/alquarium\.nl/i);
    expect(out).toContain('cloudy');
  });

  it('knowledge_store without content asks for it', async () => {
    const c = ctx();
    await knowledge.knowledge_store(c, {});
    expect(c.obs.join(' ')).toMatch(/content/i);
  });

  it('knowledge_store with no endpoint notes it is not persisted, keeps the object', async () => {
    const c = ctx();
    await knowledge.knowledge_store(c, { content: 'Do a 30% water change weekly', object: 'water quality' });
    const out = c.obs.join(' ');
    expect(out).toMatch(/not persisted|configure/i);
    expect(out).toContain('water quality');
  });
});

describe('the knowledge tools are wired into the palette and registry', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  it('both are declared in the agent TOOLS palette', () => {
    const agent = fs.readFileSync(path.join(root, 'agent.js'), 'utf8');
    expect(agent).toContain("name: 'knowledge_query'");
    expect(agent).toContain("name: 'knowledge_store'");
  });
  it('the tools index registers the knowledge module', () => {
    const idx = fs.readFileSync(path.join(root, 'tools', 'index.js'), 'utf8');
    expect(idx).toMatch(/require\('\.\/knowledge'\)/);
    expect(idx).toContain('knowledge, craft)');   // craft.js joined the line (make_document, totp_code, hover)
  });
});
