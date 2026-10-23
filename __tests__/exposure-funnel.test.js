'use strict';

import { describe, it, expect } from 'vitest';
const http = require('http');
const { auditExposureFunnel, routeEvidence } = require('../src/recon/exposureFunnel');
const { registerOperatorTools } = require('../src/operator/tools');

describe('staged exposure recon', () => {
  it('rejects non-HTTP targets and embedded credentials', async () => {
    await expect(auditExposureFunnel('ftp://example.org')).rejects.toThrow();
    await expect(auditExposureFunnel('http://user:password@example.org')).rejects.toThrow();
  });

  it('separates TCP, HTTP fingerprint, route evidence, and read-only proof without leaking secrets', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('Server', 'test-web');
      if (req.url === '/.git/HEAD') return res.end('ref: refs/heads/main\n');
      if (req.url === '/.env') return res.end('PRIVATE_KEY=do-not-report\n');
      if (req.url === '/openapi.json') { res.setHeader('Content-Type', 'application/json'); return res.end('{"openapi":"3.0.0"}'); }
      res.end('<html>SPA fallback</html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const report = await auditExposureFunnel(`http://127.0.0.1:${port}`, { ports: [port] });
      expect(report.stages.map(s => s.stage)).toEqual([1, 2, 3, 4, 5]);
      expect(report.stages[0].evidence[0].port).toBe(port);
      expect(report.stages[1].evidence[0].server).toBe('test-web');
      expect(report.stages[2].evidence.map(r => r.path)).toEqual(['/.env', '/.git/HEAD', '/openapi.json']);
      expect(report.stages[3].evidence.map(p => p.condition)).toEqual(['/.env readable without credentials', '/.git/HEAD readable without credentials']);
      expect(report.stages[4].status).toBe('not tested');
      expect(JSON.stringify(report)).not.toContain('do-not-report');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('rejects SPA fallbacks and non-matching sensitive content', () => {
    const fallback = { status: 200, body: '<html>SPA fallback</html>' };
    expect(routeEvidence('/.env', fallback, fallback)).toBeNull();
    expect(routeEvidence('/.git/HEAD', { status: 200, body: '<html>not a repo</html>' }, null)).toBeNull();
    expect(routeEvidence('/openapi.json', { status: 200, body: 'not json' }, null)).toBeNull();
  });

  it('requires read-only service responses before reporting Redis or Docker exposure', async () => {
    const tcpProbe = async (host, port, payload) => ({ port, open: true, banner: port === 6379 && payload ? '+PONG\r\n' : null });
    const request = async url => {
      if (url.pathname === '/_ping') return { status: 200, headers: {}, body: 'OK' };
      if (url.pathname === '/version') return { status: 200, headers: {}, body: '{"ApiVersion":"1.47"}' };
      return { status: 404, headers: {}, body: '' };
    };
    const report = await auditExposureFunnel('http://127.0.0.1', { ports: [6379, 2375], tcpProbe, request });
    expect(report.stages[3].evidence.map(p => p.condition)).toEqual(['Unauthenticated Redis PING', 'Unauthenticated Docker API']);
    expect(report.stages[3].evidence.every(p => p.rceProven === false)).toBe(true);
  });

  it('registers a dedicated recon tool that calls its own pipeline', async () => {
    const tools = new Map();
    registerOperatorTools({ register: (name, description, schema, run) => tools.set(name, run), has: name => tools.has(name), names: () => [...tools.keys()] }, {
      recon: { auditExposureFunnel: async target => ({ target, stages: [] }) }
    }, { mode: 'recon' });
    const result = JSON.parse(await tools.get('gb_pipeline_exposure_funnel')({ targetUrl: 'https://example.org' }));
    expect(result.target).toBe('https://example.org');
  });
});
