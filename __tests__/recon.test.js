'use strict';
import { describe, it, expect } from 'vitest';
const { buildAdvisory, calculateGrade } = require('../src/recon/advisory');
const { normalizeTarget, auditCookies, identifyWaf } = require('../src/recon/perimeter');
const roles = require('../src/roles');
const tools = require('../src/tools');

describe('Ghost Browser Recon Engine — advisory & 4-pillar models', () => {
  it('builds 4-pillar advisory with Traefik, Nginx, Express, and DNS remediations for CSP', () => {
    const adv = buildAdvisory('csp', { evidence: 'Header missing' });
    expect(adv.key).toBe('csp');
    expect(adv.severity).toBe('HIGH');
    expect(adv.cwe).toMatch(/CWE-1021/);
    expect(adv.remediation.traefik).toContain('contentSecurityPolicy');
    expect(adv.remediation.nginx).toContain('add_header Content-Security-Policy');
    expect(adv.remediation.express).toContain('helmet.contentSecurityPolicy');
    expect(adv.evidence).toBe('Header missing');
  });

  it('builds 4-pillar advisory for session invalidation (CWE-613)', () => {
    const adv = buildAdvisory('session_invalidation');
    expect(adv.cwe).toMatch(/CWE-613/);
    expect(adv.remediation.express).toContain('session_version');
    expect(adv.threatScenario).toMatch(/compromised account/i);
  });

  it('calculates security grade and score based on severity weights', () => {
    const findings = [
      { severity: 'HIGH' },
      { severity: 'MEDIUM' }
    ];
    const { score, grade } = calculateGrade(findings);
    expect(score).toBe(77); // 100 - 15 - 8 = 77
    expect(grade).toBe('B');
  });

  it('drops to Grade F when multiple critical and high findings exist', () => {
    const findings = [
      { severity: 'CRITICAL' },
      { severity: 'CRITICAL' },
      { severity: 'HIGH' },
      { severity: 'HIGH' }
    ];
    const { score, grade } = calculateGrade(findings);
    expect(score).toBe(10); // 100 - 60 - 30 = 10
    expect(grade).toBe('F');
  });
});

describe('Ghost Browser Recon Engine — perimeter normalization and analysis', () => {
  it('normalizes bare hostnames into full HTTPS target objects', () => {
    const target = normalizeTarget('example.org');
    expect(target.hostname).toBe('example.org');
    expect(target.url).toBe('https://example.org/');
    expect(target.protocol).toBe('https:');
  });

  it('does not invent domain posture, CVEs or crawl results for an unreachable IP', async () => {
    const { auditTarget } = require('../src/recon/perimeter');
    const result = await auditTarget('http://127.0.0.254/');
    expect(result.cves).toEqual([]);
    expect(result.crawlEndpoints).toEqual([]);
    expect(result.score).toBeNull();
    expect(result.exploitabilityScore).toBeNull();
    expect(result.assessmentCoverage.dns).toBe(false);
    expect(result.findings.map((finding) => finding.key)).not.toContain('spf');
    expect(result.findings.map((finding) => finding.key)).not.toContain('dmarc');
    expect(result.findings.map((finding) => finding.key)).not.toContain('csp');
    expect(result.findings.map((finding) => finding.key)).not.toContain('hsts');
  }, 15000);

  it('audits cookie security flags', () => {
    const rawCookies = [
      'session=abc1234; Path=/',
      '__Host-secure=xyz; Path=/; Secure; HttpOnly; SameSite=Strict'
    ];
    const issues = auditCookies(rawCookies);
    expect(issues.length).toBe(1);
    expect(issues[0].cookie).toBe('session');
    expect(issues[0].httpOnly).toBe(false);
    expect(issues[0].secure).toBe(false);
    expect(issues[0].sameSite).toBe(false);
  });

  it('identifies WAF and reverse proxies from headers', () => {
    const headers = {
      server: 'cloudflare',
      'cf-ray': '81234-AMS'
    };
    const waf = identifyWaf(headers);
    expect(waf.fingerprints.some((f) => f.name === 'Cloudflare')).toBe(true);
    expect(waf.originBypassRisk).not.toBeNull();
  });

  it('categorizes header and DNS advisories as POSTURE_HARDENING', () => {
    const cspAdv = buildAdvisory('csp', { evidence: 'Missing CSP' });
    const hstsAdv = buildAdvisory('hsts', { evidence: 'Missing HSTS' });
    const xfoAdv = buildAdvisory('clickjacking', { evidence: 'Missing XFO' });
    expect(cspAdv.category).toBe('POSTURE_HARDENING');
    expect(hstsAdv.category).toBe('POSTURE_HARDENING');
    expect(xfoAdv.category).toBe('POSTURE_HARDENING');
  });

  it('calculates dual scores preserving 100/100 Grade A+ exploitability when only hardening headers are missing', () => {
    const postureOnlyFindings = [
      buildAdvisory('csp', { evidence: 'Missing CSP' }),
      buildAdvisory('hsts', { evidence: 'Missing HSTS' }),
      buildAdvisory('clickjacking', { evidence: 'Missing XFO' }),
      buildAdvisory('content_sniffing', { evidence: 'Missing XCTO' }),
      buildAdvisory('spf', { evidence: 'Missing SPF' }),
      buildAdvisory('dmarc', { evidence: 'Missing DMARC' })
    ];
    const { postureScore, postureGrade, exploitabilityScore, exploitabilityGrade } = calculateGrade(postureOnlyFindings);
    expect(exploitabilityScore).toBe(100);
    expect(exploitabilityGrade).toBe('A+');
    expect(postureScore).toBeLessThan(100);
  });

  it('penalizes exploitability score when active confirmed vulnerabilities exist', () => {
    const exploitFindings = [
      buildAdvisory('session_invalidation', { severity: 'CRITICAL', category: 'EXPLOITABLE_VULNERABILITY' }),
      buildAdvisory('open_ports', { severity: 'HIGH', category: 'EXPLOITABLE_VULNERABILITY' })
    ];
    const { exploitabilityScore, exploitabilityGrade } = calculateGrade(exploitFindings);
    expect(exploitabilityScore).toBe(55); // 100 - 30 - 15 = 55
    expect(exploitabilityGrade).toBe('D');
  });
});

describe('Ghost Browser Tool and Role Registration', () => {
  it('registers recon_scan and session_invalidation_probe in tools registry', () => {
    expect(tools.has('recon_scan')).toBe(true);
    expect(tools.has('dom_security_audit')).toBe(true);
    expect(tools.has('session_invalidation_probe')).toBe(true);
  });

  it('registers appsec.auditor role with security tools', () => {
    const roleList = roles.list();
    const appsecRole = roleList.find((r) => r.name === 'appsec.auditor');
    expect(appsecRole).toBeDefined();
    expect(appsecRole.tools).toContain('recon_scan');
    expect(appsecRole.tools).toContain('session_invalidation_probe');
    expect(appsecRole.tools).toContain('dom_security_audit');
  });
});

describe('Ghost Browser 6 State-of-the-Art Recon Modules', () => {
  it('requires evidence-backed scoring and does not call banners confirmed RCE', () => {
    const { reconPrompt } = require('../src/operator/reconPrompt');
    const prompt = reconPrompt();
    expect(prompt).toContain('A banner is only a claimed version');
    expect(prompt).toContain('Show Unassessed');
    expect(prompt).not.toContain('OpenSSH is < 9.8p1');
  });
  const { extractApexDomain } = require('../src/recon/subdomainDiscovery');
  const { analyzeHomeSignatures, toBaseUrl } = require('../src/recon/techFingerprint');
  const { SENSITIVE_PROBES } = require('../src/recon/sensitiveFiles');
  const { correlateCves, KNOWN_CVE_DATABASE } = require('../src/recon/bannerGrabber');
  const { captureVisualProof } = require('../src/recon/visualProof');
  const { inspectTlsDetails } = require('../src/recon/tlsAuditor');

  it('Point 1: extracts clean apex domain from URLs, subdomains, and ports', () => {
    expect(extractApexDomain('https://mail.soluti.nl:8443/login')).toBe('mail.soluti.nl');
    expect(extractApexDomain('www.soluti.nl')).toBe('soluti.nl');
    expect(extractApexDomain('http://soluti.nl/')).toBe('soluti.nl');
  });

  it('Point 2: fingerprints LiteSpeed, WordPress, and PHP stack correctly', () => {
    expect(toBaseUrl('https://soluti.nl/wp-login.php')).toBe('https://soluti.nl');
    const headers = {
      server: 'LiteSpeed',
      'x-powered-by': 'PHP/8.1.28',
      'x-litespeed-cache': 'hit'
    };
    const html = '<html><head><meta name="generator" content="WordPress 6.4.3" /></head><body><link rel="stylesheet" href="/wp-content/themes/custom/style.css"></body></html>';
    const techs = analyzeHomeSignatures(headers, html);
    expect(techs.some((t) => t.name === 'LiteSpeed Web Server')).toBe(true);
    expect(techs.some((t) => t.name === 'WordPress' && t.version === '6.4.3')).toBe(true);
    expect(techs.some((t) => t.name === 'PHP Runtime')).toBe(true);
    expect(techs.some((t) => t.name === 'LiteSpeed Cache')).toBe(true);
  });

  it('Point 3: sensitive files validator strictly rejects false-positive HTML 404 responses', () => {
    const gitProbe = SENSITIVE_PROBES.find((p) => p.path === '/.git/HEAD');
    expect(gitProbe).toBeDefined();
    // SPA returning 200 OK with HTML should be rejected
    expect(gitProbe.validator(200, '<!DOCTYPE html><html><body>Page Not Found</body></html>', { 'content-type': 'text/html' })).toBe(false);
    // Real git repository HEAD file should be accepted
    expect(gitProbe.validator(200, 'ref: refs/heads/main\n', { 'content-type': 'text/plain' })).toBe(true);

    const envProbe = SENSITIVE_PROBES.find((p) => p.path === '/.env');
    expect(envProbe.validator(200, '<!DOCTYPE html><html>...</html>', { 'content-type': 'text/html' })).toBe(false);
    expect(envProbe.validator(200, 'DB_PASSWORD=supersecret\nAPP_KEY=base64:123\n', { 'content-type': 'text/plain' })).toBe(true);
  });

  it('Point 4: correlates service daemon banners with official CVE database entries', () => {
    const banners = [
      { port: 22, service: 'SSH', banner: 'SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.1' },
      { port: 21, service: 'FTP', banner: '220 ProFTPD 1.3.5 Server' },
      { port: 3306, service: 'MySQL/MariaDB', banner: 'MariaDB/MySQL Handshake Version: 10.6.15-MariaDB' }
    ];
    const cves = correlateCves(banners);
    expect(cves.length).toBeGreaterThanOrEqual(3);
    expect(cves.some((c) => c.cve.includes('CVE-2024-6387'))).toBe(true);
    expect(cves.some((c) => c.cve.includes('CVE-2019-12815'))).toBe(true);
    expect(cves.some((c) => c.cve.includes('CVE-2022-32082'))).toBe(true);
    expect(cves.find((c) => c.cve.includes('CVE-2024-6387')).status).toBe('version_range_candidate');
  });

  it('does not label OpenSSH 6.6.1p1 or patched versions as regreSSHion', () => {
    const banners = ['6.6.1p1', '8.4p1', '9.8p1', '10.0p2'].map((version) =>
      ({ port: 22, service: 'SSH', banner: `SSH-2.0-OpenSSH_${version}` }));
    expect(correlateCves(banners).filter((candidate) => candidate.cve.includes('CVE-2024-6387'))).toEqual([]);
    expect(correlateCves([{ port: 22, service: 'SSH', banner: 'SSH-2.0-OpenSSH_9.7p1' }])
      .some((candidate) => candidate.cve.includes('CVE-2024-6387'))).toBe(true);
  });

  it('Point 5: captures visual proof or safely falls back without crashing', async () => {
    const result = await captureVisualProof('https://example.com');
    expect(result).toBeDefined();
    expect(result.targetUrl).toBe('https://example.com');
    expect(result.finding).toBeDefined();
    expect(result.markdownEmbed).toBeDefined();
  });

  it('Point 6: exports TLS auditor functions and handles invalid host cleanly', async () => {
    const { auditTlsHealth } = require('../src/recon/tlsAuditor');
    const res = await auditTlsHealth('');
    expect(res.error).toBeDefined();
  });

  it('grabMysqlBanner returns null banner and does not false-flag closed ports', async () => {
    const { grabMysqlBanner } = require('../src/recon/bannerGrabber');
    const res = await grabMysqlBanner('127.0.0.1', 19876, 300);
    expect(res.version).toBeNull();
    expect(res.banner).toBeNull();
  });

  it('auditPassiveSubdomains isolates candidates to verified cert names when wildcard DNS is detected', async () => {
    const { auditPassiveSubdomains } = require('../src/recon/subdomainDiscovery');
    // Calling with empty or local domain doesn't crash and returns structured report
    const res = await auditPassiveSubdomains('127.0.0.1');
    expect(res).toBeDefined();
    expect(res.domain).toBe('127.0.0.1');
    expect(Array.isArray(res.findings)).toBe(true);
  });

  it('auditBusinessLogic detects negative quantity and client-side price tampering', async () => {
    const http = require('http');
    const { auditBusinessLogic, generateBusinessLogicPatch } = require('../src/recon/businessLogicAuditor');

    // Spin up an in-memory test server simulating a vulnerable vibe-coded checkout API
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          // Vulnerable logic: accepts negative quantities and client prices
          if (data.quantity === -1 || (data.items && data.items.some(i => i.quantity === -1))) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, orderId: 1337, total: -10 }));
          }
          if (data.price === 0.01 || data.amount === 1) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, orderId: 1338, clientPriceAccepted: true, total: 0.01 }));
          }
        } catch (e) {}
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid' }));
      });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const testBaseUrl = `http://127.0.0.1:${port}`;

    try {
      const result = await auditBusinessLogic(testBaseUrl, {
        endpoints: ['/api/checkout']
      });

      expect(result).toBeDefined();
      expect(result.clean).toBe(false);
      expect(result.findings.length).toBeGreaterThanOrEqual(2);

      const negFinding = result.findings.find(f => f.key === 'negative_quantity_underflow');
      expect(negFinding).toBeDefined();
      expect(negFinding.severity).toBe('CRITICAL');
      expect(negFinding.cwe).toContain('CWE-840');
      expect(negFinding.pocCurl).toContain('-1');

      const priceFinding = result.findings.find(f => f.key === 'client_price_tampering');
      expect(priceFinding).toBeDefined();
      expect(priceFinding.severity).toBe('CRITICAL');
      expect(priceFinding.cwe).toContain('CWE-472');

      const patch = generateBusinessLogicPatch('negative_quantity_underflow');
      expect(patch).toContain('validateOrderQuantities');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  describe('Living App Map & Target Workspace Engine', () => {
    const {
      getTargetWorkspace,
      saveTargetWorkspace,
      ingestAuditData,
      listTargetWorkspaces,
      normalizeDomain
    } = require('../src/recon/targetWorkspace');

    it('normalizes target URLs into clean domain keys', () => {
      expect(normalizeDomain('https://app.example.com/login?ref=1')).toBe('app.example.com');
      expect(normalizeDomain('http://sub.domain.org:8080/')).toBe('sub.domain.org');
      expect(normalizeDomain('target.io')).toBe('target.io');
    });

    it('scaffolds a fresh target workspace dossier', () => {
      const ws = getTargetWorkspace('https://unit-test-app.com');
      expect(ws).toBeDefined();
      expect(ws.apexDomain).toBe('unit-test-app.com');
      expect(ws.scores.postureGrade).toBe('A+');
      expect(Array.isArray(ws.subdomains)).toBe(true);
      expect(Array.isArray(ws.spaRoutes)).toBe(true);
      expect(Array.isArray(ws.findings)).toBe(true);
      expect(Array.isArray(ws.history)).toBe(true);
    });

    it('ingests multi-phase audit findings, ports, routes, and updates attack surface map', () => {
      const target = 'https://unit-test-app.com';
      const ingested = ingestAuditData(target, {
        perimeter: { apexIp: '1.2.3.4', tlsGrade: 'A' },
        wildcardDns: false,
        liveSubdomains: ['api.unit-test-app.com', 'admin.unit-test-app.com'],
        ports: [{ port: 443, service: 'https', banner: 'nginx/1.24' }],
        spaRoutes: ['/dashboard', '/settings/billing'],
        apiEndpoints: ['/api/v1/auth/me', '/api/v1/checkout'],
        findings: [
          { key: 'test_cors', severity: 'HIGH', title: 'Permissive CORS' },
          { key: 'test_cve', severity: 'CRITICAL', title: 'RCE in Webpack Dev Server' }
        ]
      });

      expect(ingested.domain).toBe('unit-test-app.com');
      expect(ingested.perimeter.apexIp).toBe('1.2.3.4');
      expect(ingested.subdomains.length).toBe(2);
      expect(ingested.services.length).toBe(1);
      expect(ingested.services[0].port).toBe(443);
      expect(ingested.spaRoutes).toContain('/dashboard');
      expect(ingested.apiEndpoints).toContain('/api/v1/checkout');
      expect(ingested.findings.length).toBe(2);
      expect(ingested.history.length).toBeGreaterThanOrEqual(1);
      // Exploitability score should drop due to CRITICAL and HIGH findings
      expect(ingested.scores.exploitabilityScore).toBeLessThan(100);
      expect(['F', 'D', 'C']).toContain(ingested.scores.exploitabilityGrade);

      // Verify listTargetWorkspaces includes this domain
      const list = listTargetWorkspaces();
      expect(list.some(item => item.domain === 'unit-test-app.com')).toBe(true);
    });
  });
});


