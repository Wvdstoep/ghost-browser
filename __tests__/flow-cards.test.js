// Route cards for a flow's steps.
//
// The card mechanism was built for Herald and gated to it (`/^herald\./`). A flow STEP is the better
// candidate by a wide margin: it performs the same act on the same site on EVERY run, which is the
// repetition a card pays for — a scout that walks eight pages to read a listing walks them again
// tomorrow, and once the browser knows which request actually returned that listing the whole walk
// becomes one in-page fetch. Cheaper in tokens, faster, and immune to the layout moving.
//
// The intent is the STEP (`flow:<flow>:<node>`), never the role: several flows may share a role, and
// two steps of one flow must learn two different cards.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jobs from '../src/jobs.js';

const agentSrc = readFileSync(fileURLToPath(new URL('../src/agent.js', import.meta.url)), 'utf8');
const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');

describe('a flow step learns a card of its own', () => {
  it('keys the intent on the STEP, so a shared role never collides with itself', () => {
    expect(agentSrc).toMatch(/const flowIntent = \(job\.workflowId && job\.nodeId\) \? `flow:\$\{job\.workflowId\}:\$\{job\.nodeId\}` : null;/);
    expect(agentSrc).toMatch(/const cardIntent = flowIntent \|\| roles\.canonical\(role\);/);
  });

  it('learns for a flow step AND still for a Herald walk', () => {
    expect(agentSrc).toMatch(/const learnsCards = !!flowIntent \|\| \/\^herald\\.\/\.test\(String\(role \|\| ''\)\);/);
  });

  it('arms the recorder and asks the store with that same intent — one name, both directions', () => {
    expect(agentSrc).toMatch(/session\.recorder\.arm\(\{ intent: cardIntent \}\)/);
    expect(agentSrc).toMatch(/const intent = cardIntent;/);
    // never the role name again in either place
    expect(agentSrc).not.toMatch(/recorder\.arm\(\{ intent: roles\.canonical\(role\) \}\)/);
  });

  it('the safety is untouched: an unproven card still walks the UI, a failure quarantines', () => {
    expect(agentSrc).toMatch(/An unproven card \(freshly recorded, never verified\) plans to 'ui' on/);
    expect(agentSrc).toMatch(/route card — \$\{plan\.reason\}/);
    expect(agentSrc).toMatch(/LEARN THE CARD — but only from a walk that actually SUCCEEDED/);
  });
});

describe('the step id reaches the job that does the work', () => {
  it('the flow driver passes it', () => {
    expect(serverSrc).toMatch(/runId: runId \|\| null, nodeId: node\.id \|\| null,/);
  });

  it('a job keeps it, and every view of that job hands it back', () => {
    const j = jobs.create({ owner: 'o', goal: 'read the listing', workflowId: 'useme-scout', runId: 'useme-scout-1', nodeId: 'extract' });
    expect(j.nodeId).toBe('extract');
    expect(jobs.view(j).nodeId).toBe('extract');
    expect(jobs.get(j.id).nodeId).toBe('extract');
  });

  it('a job that is not part of a flow simply has none, and learns nothing', () => {
    const j = jobs.create({ owner: 'o', goal: 'look around' });
    expect(j.nodeId).toBeNull();
    expect(j.workflowId).toBeNull();
  });
});
