import { describe, it, expect } from 'vitest';
const workflows = require('../src/workflows');

const reconFlow = (scan = 'exposure', target = 'https://example.org') => ({
  id: 'test-recon', name: 'Security check', kind: 'security', nodes: [
    { id: 'start', type: 'trigger', trigger: { type: 'manual' } },
    { id: 'check', type: 'recon', scan, target, outKey: 'scan' }
  ], edges: [{ from: 'start', to: 'check' }]
});

describe('security automations', () => {
  it('validates supported scan types and HTTP targets before a workflow can run', () => {
    expect(workflows.validate(reconFlow(), [])).toEqual([]);
    expect(workflows.validate(reconFlow('indexed', 'video_rtsp'), [])).toEqual(expect.arrayContaining([expect.stringMatching(/supported scan/)]));
    expect(workflows.validate(reconFlow('exposure', 'ftp://example.org'), [])).toEqual(expect.arrayContaining([expect.stringMatching(/HTTP\(S\) target/)]));
  });

  it('runs a recon node without starting a browser agent and stores its result', async () => {
    const calls = [];
    const run = await workflows.drive(reconFlow(), {
      runAgent: () => { throw new Error('browser agent should not run'); },
      runRecon: async input => { calls.push(input); return { target: input.target, stages: [] }; },
      persist: () => {}, now: () => '2026-10-23T00:00:00Z'
    });
    expect(run.status).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ scan: 'exposure', target: 'https://example.org' });
    expect(run.steps.find(step => step.type === 'recon').output).toMatchObject({ target: 'https://example.org' });
  });

  it('requires a starter prompt and keeps it on demand', () => {
    const flow = reconFlow('prompt');
    expect(workflows.validate(flow, [])).toEqual(expect.arrayContaining([expect.stringMatching(/starter prompt/)]));
    flow.nodes[1].prompt = 'Check https://target-domain.com';
    expect(workflows.validate(flow, [])).toEqual([]);
    flow.nodes[0].trigger.type = 'schedule';
    expect(workflows.validate(flow, [])).toEqual(expect.arrayContaining([expect.stringMatching(/on-demand only/)]));
    flow.nodes[0].trigger.type = 'manual';
    flow.trigger = { type: 'schedule', everyMin: 60 };
    expect(workflows.validate(flow, [])).toEqual(expect.arrayContaining([expect.stringMatching(/on-demand only/)]));
  });
});
