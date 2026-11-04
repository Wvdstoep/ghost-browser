'use strict';
import { describe, it, expect } from 'vitest';
const { runDeepSpider, SENSITIVE_PROBE_PATHS } = require('../src/recon/deepSpiderPipeline');

describe('Ghost Browser Recon Engine — deepSpiderPipeline', () => {
  it('exports SENSITIVE_PROBE_PATHS containing critical schema and config endpoints', () => {
    expect(SENSITIVE_PROBE_PATHS).toBeInstanceOf(Array);
    expect(SENSITIVE_PROBE_PATHS).toContain('/.well-known/security.txt');
    expect(SENSITIVE_PROBE_PATHS).toContain('/robots.txt');
    expect(SENSITIVE_PROBE_PATHS).toContain('/swagger.json');
    expect(SENSITIVE_PROBE_PATHS).toContain('/.git/HEAD');
    expect(SENSITIVE_PROBE_PATHS).toContain('/.env');
  });

  it('handles invalid target URLs gracefully', async () => {
    const res = await runDeepSpider({ targetUrl: ':::invalid-url:::' });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('runs HTTP fallback spider when no Playwright page is passed', async () => {
    // Probe a mock or safe endpoint
    const res = await runDeepSpider({
      targetUrl: 'https://example.com',
      maxPages: 1
    });
    expect(res.ok).toBe(true);
    expect(res.domain).toBe('example.com');
    expect(res.origin).toBe('https://example.com');
    expect(res.routes).toBeInstanceOf(Array);
    expect(res.apiEndpoints).toBeInstanceOf(Array);
    expect(res.probedEndpoints).toBeInstanceOf(Array);
    expect(res.executiveSummary).toContain('Enterprise Deep Spider');
  }, 15000);
});
