'use strict';
/**
 * redteam.js — Active Red Team Endpoint, CORS & Client-Side Penetration Testing Probes
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const SENSITIVE_PATHS = [
  { path: '/.git/HEAD', name: 'Git Repository Exposure', risk: 'CRITICAL', match: (body) => body.includes('ref: refs/') },
  { path: '/.env', name: 'Environment Variables / Secrets File', risk: 'CRITICAL', match: (body) => /(DB_PASSWORD|SECRET|API_KEY|AWS_)/i.test(body) },
  { path: '/actuator/health', name: 'Spring Boot Actuator Health', risk: 'MEDIUM', match: (body) => body.includes('"status"') },
  { path: '/metrics', name: 'Prometheus / Internal Metrics', risk: 'MEDIUM', match: (body) => body.includes('process_cpu') || body.includes('http_requests') },
  { path: '/swagger.json', name: 'Swagger / OpenAPI Specification', risk: 'LOW', match: (body) => body.includes('"swagger"') || body.includes('"openapi"') },
  { path: '/api-docs', name: 'API Documentation Portal', risk: 'LOW', match: (body) => body.includes('swagger') || body.includes('api') },
  { path: '/robots.txt', name: 'Robots Policy File', risk: 'INFO', match: (body) => body.includes('Disallow') }
];

function httpRequest(urlStr, options = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(u, {
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-RedTeam/2.0',
          ...(options.headers || {})
        },
        timeout: options.timeout || 6000
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 32768) {
            req.destroy();
            finish({ status: res.statusCode, headers: res.headers, body });
          }
        });
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body }));
        res.on('close', () => finish({ status: res.statusCode, headers: res.headers, body }));
      });

      req.on('error', (err) => finish({ error: err.message, status: 0, headers: {}, body: '' }));
      req.on('timeout', () => { req.destroy(); finish({ error: 'timeout', status: 0, headers: {}, body: '' }); });
      if (options.body) req.write(options.body);
      req.end();
    } catch (e) {
      finish({ error: e.message, status: 0, headers: {}, body: '' });
    }
  });
}

/**
 * Actively probe for sensitive exposed files & endpoints.
 */
async function probeSensitiveEndpoints(rawTarget) {
  let base = rawTarget.trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  const targetUrl = new URL(base);

  const findings = [];
  for (const item of SENSITIVE_PATHS) {
    const checkUrl = `${targetUrl.origin}${item.path}`;
    const res = await httpRequest(checkUrl);
    if (res.status === 200 && res.body && item.match(res.body)) {
      findings.push({
        path: item.path,
        url: checkUrl,
        name: item.name,
        risk: item.risk,
        status: res.status,
        evidence: `Discovered accessible resource at ${item.path} (HTTP 200 OK)`
      });
    }
  }

  return {
    target: targetUrl.origin,
    scannedPathsCount: SENSITIVE_PATHS.length,
    exposedFindingsCount: findings.length,
    findings
  };
}

/**
 * Actively probe CORS misconfiguration with arbitrary rogue origins.
 */
async function probeCors(rawTarget) {
  let base = rawTarget.trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  const targetUrl = new URL(base);

  const testOrigin = 'https://rogue-security-audit.com';
  const res = await httpRequest(targetUrl.origin, {
    method: 'GET',
    headers: {
      'Origin': testOrigin
    }
  });

  const acao = res.headers['access-control-allow-origin'];
  const acac = res.headers['access-control-allow-credentials'];

  const vulnerable = (acao === testOrigin || acao === '*') && acac === 'true';
  const permissive = acao === '*';

  return {
    target: targetUrl.origin,
    testedOrigin: testOrigin,
    accessControlAllowOrigin: acao || 'None',
    accessControlAllowCredentials: acac || 'None',
    vulnerableToCredentialTheft: vulnerable,
    wildcardPermissive: permissive,
    assessment: vulnerable
      ? 'CRITICAL CORS MISCONFIGURATION: Arbitrary rogue origins reflect with credentials allowed.'
      : permissive
      ? 'PERMISSIVE CORS: Wildcard * returned; acceptable for public APIs without credentials.'
      : 'SECURE: Origin is not reflected or credentials are appropriately restricted.'
  };
}

/**
 * Checks framing capability for Clickjacking attacks.
 */
async function probeFraming(rawTarget) {
  let base = rawTarget.trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  const targetUrl = new URL(base);

  const res = await httpRequest(targetUrl.origin);
  const xfo = res.headers['x-frame-options'];
  const csp = res.headers['content-security-policy'] || '';

  const hasAncestors = csp.includes('frame-ancestors');
  const frameable = !xfo && !hasAncestors;

  return {
    target: targetUrl.origin,
    xFrameOptions: xfo || 'None',
    cspFrameAncestors: hasAncestors ? 'Present' : 'None',
    canBeFramed: frameable,
    assessment: frameable
      ? 'VULNERABLE TO CLICKJACKING: Neither X-Frame-Options nor frame-ancestors is present.'
      : 'SECURE: Anti-framing controls enforce frame isolation.'
  };
}

/**
 * Consolidated active red-team probe.
 */
async function runRedteamAudit(rawTarget) {
  const [endpoints, cors, framing] = await Promise.all([
    probeSensitiveEndpoints(rawTarget),
    probeCors(rawTarget),
    probeFraming(rawTarget)
  ]);

  return {
    target: rawTarget,
    timestamp: new Date().toISOString(),
    endpoints,
    cors,
    framing
  };
}

module.exports = {
  probeSensitiveEndpoints,
  probeCors,
  probeFraming,
  runRedteamAudit
};
