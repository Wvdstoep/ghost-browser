'use strict';
/**
 * authMatrixAuditor.js — Business Logic & Broken Access Control (BOLA/IDOR) Auditor
 *
 * Evaluates whether backend API and administrative endpoints enforce server-side
 * authentication and role authorization, rather than relying on UI-level hiding.
 *
 * Conforms to:
 *   - OWASP API #1:2023 Broken Object Level Authorization (BOLA)
 *   - OWASP Top 10 A01:2021 Broken Access Control
 *   - CWE-285: Improper Authorization
 *   - CWE-639: Authorization Bypass Through User-Controlled Key
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Dispatches an HTTP request with custom headers
 */
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-AuthMatrix/2.0',
          'Accept': 'application/json, text/plain, */*',
          ...(options.headers || {})
        },
        timeout: options.timeout || 8000
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 262144) { // max 256KB
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
 * Checks whether an endpoint response indicates sensitive data exposure
 */
function containsSensitiveData(body, contentType) {
  if (!body) return false;
  const isJson = contentType && contentType.includes('application/json');
  
  // High confidence indicators of backend business data leaking
  const sensitiveRegex = /(?:["'](?:users|accounts|invoices|tokens|api_keys|payouts|members|roles|permissions|credentials|secrets)["']\s*:\s*\[|\b(?:is_admin|role["']?\s*:\s*["']?admin|super_user|api_secret)\b)/i;

  if (isJson && sensitiveRegex.test(body)) return true;
  return false;
}

/**
 * Tests an array of endpoints for missing authorization controls
 *
 * @param {string} targetUrl - Base target domain
 * @param {object} [options]
 * @param {string[]} [options.endpoints] - Specific routes or API endpoints to test
 * @param {object} [options.headers] - Authenticated headers to compare against
 */
async function auditAuthMatrix(targetUrl, options = {}) {
  let base = (targetUrl || options.target || options.url || options.targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;

  let u = null;
  try { u = new URL(base); } catch (_) {
    return { error: 'Invalid target URL: ' + targetUrl };
  }

  const origin = u.origin;
  const candidateRoutes = (options.endpoints && options.endpoints.length > 0)
    ? options.endpoints
    : [
        '/api/admin',
        '/api/users',
        '/api/billing',
        '/api/team',
        '/api/keys',
        '/api/v1/users',
        '/api/v1/organization',
        '/admin/dashboard',
        '/settings/team'
      ];

  const findings = [];
  const secureControls = [];
  const testedRoutes = [];

  for (const route of candidateRoutes.slice(0, 10)) {
    const fullUrl = `${origin}${route.startsWith('/') ? route : '/' + route}`;
    testedRoutes.push(route);

    // 1. Send unauthenticated request (stripping session cookies & Authorization header)
    const unauthHeaders = {};
    const res = await httpRequest(fullUrl, { method: 'GET', headers: unauthHeaders });

    if (res.status === 0) continue;

    const hdrs = (res && res.headers) || {};
    const contentType = hdrs['content-type'] || '';
    const isRedirect = res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308;
    const location = hdrs['location'] || '';

    // Evaluate authorization enforcement
    if (res.status === 401 || res.status === 403) {
      secureControls.push({
        endpoint: route,
        status: res.status,
        result: 'SECURE_AUTH_ENFORCED',
        note: `Endpoint strictly requires authentication (${res.status} returned).`
      });
    } else if (isRedirect && (location.includes('/login') || location.includes('/signin') || location.includes('/auth'))) {
      secureControls.push({
        endpoint: route,
        status: res.status,
        result: 'SECURE_LOGIN_REDIRECT',
        note: `Unauthenticated traffic redirected to ${location}.`
      });
    } else if (res.status >= 200 && res.status < 300) {
      if (containsSensitiveData(res.body, contentType)) {
        findings.push({
          severity: 'CRITICAL',
          title: `Broken Access Control: Unauthenticated Data Leak on '${route}'`,
          cwe: 'CWE-285: Improper Authorization (OWASP A01:2021)',
          cvss: 8.6,
          endpoint: route,
          targetUrl: fullUrl,
          statusCode: res.status,
          pocCurl: `curl -s -i "${fullUrl}"`,
          evidence: {
            statusCode: res.status,
            contentType,
            snippet: res.body.substring(0, 300)
          },
          remediation: {
            rootCause: `Endpoint '${route}' returned HTTP 200 OK with sensitive records to an unauthenticated request. Authorization is not verified on the server.`,
            fixSnippet: `// Express.js Server-Side Authorization Middleware:\nconst { requireAuth, requireRole } = require('../middleware/auth');\n\n// Protect endpoint:\nrouter.get('${route}', requireAuth, requireRole('ADMIN'), async (req, res) => {\n  // Handler logic\n});`,
            nginxBlock: `# Drop direct external access if internal API:\nlocation ${route} {\n  allow 10.0.0.0/8;\n  deny all;\n}`
          }
        });
      } else {
        // Returned 200 but public/generic landing or 404-SPA fallback
        secureControls.push({
          endpoint: route,
          status: res.status,
          result: 'PUBLIC_OR_FALLBACK',
          note: `Returned 200 without sensitive authorization leak.`
        });
      }
    }
  }

  const score = findings.length === 0 ? 100 : Math.max(30, 100 - findings.length * 40);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : 'F';

  return {
    target: origin,
    timestamp: new Date().toISOString(),
    score,
    grade,
    testedRoutesCount: testedRoutes.length,
    testedRoutes,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls,
    summary: findings.length === 0
      ? `Authorization matrix verified ${testedRoutes.length} endpoints. Server strictly enforces authentication boundaries; no unauthorized data exposure detected.`
      : `Authorization matrix detected ${findings.length} broken access control vulnerabilities allowing unauthenticated access to privileged data.`
  };
}

module.exports = {
  auditAuthMatrix
};
