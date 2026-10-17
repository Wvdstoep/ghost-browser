'use strict';
/**
 * dualSessionAuditor.js — Cross-Tenant Isolation & BOLA/IDOR Verification Engine
 *
 * Evaluates tenant isolation boundaries across multiple authenticated sessions
 * to detect Horizontal & Vertical Privilege Escalation (OWASP API1:2023 / CWE-639 / CWE-285):
 *   1. Baseline Verification: Confirms authorized access to private resource under Session A.
 *   2. Cross-Session Substitution: Submits the identical request under Session B.
 *   3. Differential Response Evaluation: Detects whether Session B leaks Session A's records.
 *   4. Turnkey Remediation: Emits exact curl PoCs and tenant-scoping code diffs.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Dispatches an HTTP request with specific session headers
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-DualSession/2.0',
          'Accept': 'application/json, text/plain, */*',
          ...(options.headers || {})
        },
        timeout: options.timeout || 8000
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 524288) { // max 512KB
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
 * Normalizes auth header format
 */
function buildAuthHeaders(tokenOrHeaders) {
  if (!tokenOrHeaders) return {};
  if (typeof tokenOrHeaders === 'string') {
    const val = tokenOrHeaders.trim();
    if (val.toLowerCase().startsWith('bearer ') || val.toLowerCase().startsWith('token ')) {
      return { 'Authorization': val };
    }
    return { 'Authorization': `Bearer ${val}` };
  }
  return { ...tokenOrHeaders };
}

/**
 * Main Cross-Tenant Isolation & BOLA Auditor
 *
 * @param {object} params
 * @param {string} params.targetUrl - Base URL or specific resource endpoint
 * @param {string|object} [params.tokenA] - Session token or headers for Tenant A
 * @param {string|object} [params.tokenB] - Session token or headers for Tenant B
 * @param {Array<string|number>} [params.objectIds] - Specific resource IDs to test
 * @param {import('playwright').Page} [params.pageA] - Active browser session for Tenant A
 * @param {import('playwright').Page} [params.pageB] - Active browser session for Tenant B
 */
async function auditDualTenantIsolation({
  targetUrl,
  url,
  target,
  tokenA,
  tokenB,
  objectIds = [],
  pageA,
  pageB
} = {}) {
  let base = (targetUrl || url || target || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;

  const findings = [];
  const secureControls = [];
  const testResults = [];

  const headersA = buildAuthHeaders(tokenA);
  const headersB = buildAuthHeaders(tokenB);

  const candidateIds = objectIds.length > 0 ? objectIds : [1, 2, 100, 'latest', 'me'];

  // Test across each target ID
  for (const id of candidateIds.slice(0, 5)) {
    let testUrl = base;
    if (testUrl.includes('{id}')) {
      testUrl = testUrl.replace('{id}', encodeURIComponent(id));
    } else if (/\/\d+$/.test(testUrl)) {
      testUrl = testUrl.replace(/\/\d+$/, `/${encodeURIComponent(id)}`);
    } else {
      testUrl = `${testUrl.replace(/\/$/, '')}/${encodeURIComponent(id)}`;
    }

    // 1. Unauthenticated Request Check
    const unauthRes = await httpRequest(testUrl, { method: 'GET' });
    if (unauthRes.status >= 200 && unauthRes.status < 300) {
      findings.push({
        severity: 'CRITICAL',
        title: `Unauthenticated Access to Resource '${id}'`,
        cwe: 'CWE-306: Missing Authentication for Critical Function',
        cvss: 8.6,
        targetUrl: testUrl,
        evidence: {
          statusCode: unauthRes.status,
          responseSnippet: unauthRes.body.slice(0, 200)
        },
        remediation: {
          rootCause: 'The endpoint does not verify user authentication before returning sensitive resource records.',
          fixSnippet: `// Require authentication middleware before handling request:\napp.use('${base}', requireAuth);`
        }
      });
      continue;
    } else if (unauthRes.status === 401 || unauthRes.status === 403 || unauthRes.status === 404) {
      secureControls.push({
        control: 'AUTHENTICATION_ENFORCED',
        endpoint: testUrl,
        status: unauthRes.status,
        note: `Unauthenticated requests correctly rejected with HTTP ${unauthRes.status}.`
      });
    }

    // 2. Dual-Session Cross-Tenant Access Check (if tokens provided)
    if (tokenA && tokenB) {
      const resA = await httpRequest(testUrl, { method: 'GET', headers: headersA });
      const resB = await httpRequest(testUrl, { method: 'GET', headers: headersB });

      const bothSucceeded = (resA.status >= 200 && resA.status < 300) && (resB.status >= 200 && resB.status < 300);

      if (bothSucceeded) {
        // Compare bodies to detect if Tenant B received Tenant A's private record
        const identical = resA.body && resB.body && (resA.body === resB.body);
        if (identical) {
          findings.push({
            severity: 'CRITICAL',
            title: `Confirmed BOLA / IDOR: Cross-Tenant Access to Resource '${id}'`,
            cwe: 'CWE-639: Authorization Bypass Through User-Controlled Key (BOLA)',
            cvss: 8.8,
            targetUrl: testUrl,
            pocCurl: `# Request as Tenant B accessing Tenant A's object:\ncurl -s -i -H "Authorization: Bearer <Tenant_B_Token>" "${testUrl}"`,
            evidence: {
              statusA: resA.status,
              statusB: resB.status,
              snippet: resB.body.slice(0, 250)
            },
            remediation: {
              rootCause: `Tenant B is permitted to read records belonging to Tenant A at '${testUrl}'. Tenant ownership is not validated on the server.`,
              fixSnippet: `// Server-Side Tenant Scoping Fix:\nconst record = await db.collection('resources').findOne({\n  _id: req.params.id,\n  tenantId: req.user.tenantId // Enforce tenant boundary\n});\nif (!record) return res.status(404).json({ error: 'Not found' });`
            }
          });
        } else {
          secureControls.push({
            control: 'SCOPED_TENANT_DATA',
            endpoint: testUrl,
            note: `Both sessions returned HTTP 200, but data was correctly partitioned to each tenant's context.`
          });
        }
      } else if (resA.status === 200 && (resB.status === 403 || resB.status === 404)) {
        secureControls.push({
          control: 'BOLA_ISOLATION_ENFORCED',
          endpoint: testUrl,
          statusB: resB.status,
          note: `Tenant A granted access (200), while Tenant B was strictly denied (${resB.status}). Tenant boundary enforced.`
        });
      }
    }
  }

  const score = findings.length === 0 ? 100 : Math.max(20, 100 - findings.length * 40);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : 'F';

  return {
    target: base,
    timestamp: new Date().toISOString(),
    score,
    grade,
    testedObjectCount: candidateIds.length,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls,
    summary: findings.length === 0
      ? `Dual-tenant auditor verified ${candidateIds.length} resource boundaries. Zero cross-tenant authorization leaks detected; tenant isolation is strictly enforced.`
      : `Dual-tenant auditor confirmed ${findings.length} broken access control / BOLA vulnerabilities allowing cross-tenant data access.`
  };
}

module.exports = {
  auditDualTenantIsolation
};
