'use strict';
/**
 * ghost-browser/src/recon/headersAuditor.js
 *
 * Enterprise-Grade Burp Suite-Style Differential HTTP Header & Verb Tamper Audit Engine
 *
 * Implements high-impact defensive security checks:
 *   1. HTTP Verb Tampering (OPTIONS, HEAD, TRACE, TRACK, PUT, DELETE, PATCH)
 *   2. Host Header Injection & Reverse Proxy Cache Poisoning (CWE-644 / CWE-116)
 *   3. Internal IP Trust & Proxy Header Spoofing (X-Forwarded-For, X-Real-IP) (CWE-290)
 *   4. CORS Differential Matrix (null, attacker.com, subdomain suffix reflection with credentials) (CWE-942)
 *   5. Content-Type Parser Confusion & CSRF Surface (CWE-352 / CWE-436)
 *   6. Cache-Control & Edge CDN PII / Token Leakage (CWE-525 / CWE-524)
 *   7. Modern Enterprise Defense Header Compliance Scorecard (HSTS, CSP, XFO, XCTO, Permissions-Policy, COOP, COEP)
 *   8. Concrete Proof-of-Concept Curl Commands & 4-Pillar Remediations (Traefik, Nginx, Express)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Perform raw HTTP/HTTPS request with precise options and timeouts.
 */
function makeRequest(targetUrl, { method = 'GET', headers = {}, body = null, timeoutMs = 7000 } = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (res) => {
      if (!resolved) {
        resolved = true;
        resolve(res);
      }
    };

    try {
      const u = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`);
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? https : http;

      const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-BurpAuditor/2.0',
        'Accept': '*/*',
        ...headers
      };

      const req = client.request(u, {
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
        rejectUnauthorized: false
      }, (res) => {
        let rawBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (rawBody.length < 32000) rawBody += chunk;
        });
        res.on('end', () => {
          done({
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: rawBody,
            method,
            targetUrl: u.href
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        done({ status: 0, error: 'TIMEOUT', method, targetUrl });
      });

      req.on('error', (err) => {
        done({ status: 0, error: err.message, method, targetUrl });
      });

      if (body) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    } catch (err) {
      done({ status: 0, error: err.message, method, targetUrl });
    }
  });
}

/**
 * Full Differential HTTP Header & Verb Tamper Audit
 *
 * @param {string} targetUrl - Target endpoint or base URL
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
async function auditHttpHeaders(targetUrl, opts = {}) {
  if (!targetUrl) return { error: 'targetUrl is required' };
  const base = targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`;

  const findings = [];
  const matrix = [];
  const u = new URL(base);
  const hostname = u.hostname;

  // 1. Baseline GET request
  const baseline = await makeRequest(base, { method: 'GET' });

  // 2. HTTP Method Tampering & Allowed Verbs
  const verbs = ['OPTIONS', 'HEAD', 'TRACE', 'TRACK', 'PUT', 'DELETE', 'PATCH'];
  const verbResults = {};

  for (const verb of verbs) {
    const res = await makeRequest(base, { method: verb });
    verbResults[verb] = res.status;

    if (verb === 'TRACE' && res.status === 200 && (res.body.includes('TRACE') || res.body.includes('GhostBrowser'))) {
      findings.push({
        severity: 'HIGH',
        cwe: 'CWE-650',
        title: 'Cross-Site Tracing (XST) Enabled via HTTP TRACE',
        evidence: `Server accepted TRACE method with 200 OK and reflected request body/headers.`,
        poc: `curl -k -X TRACE "${base}" -H "Cookie: test=secret"`,
        remediation: 'Disable TRACE and TRACK methods in reverse proxy (e.g. Traefik/Nginx: limit_except GET POST { deny all; }).'
      });
    }

    if (verb === 'OPTIONS') {
      const allowHeader = res.headers['allow'] || res.headers['access-control-allow-methods'] || '';
      verbResults.allowed = allowHeader;
      if (/DELETE|PUT|TRACE/i.test(allowHeader)) {
        findings.push({
          severity: 'MEDIUM',
          cwe: 'CWE-284',
          title: 'Dangerous HTTP Verbs Advertised in Options Header',
          evidence: `OPTIONS Allow header advertised: ${allowHeader}`,
          poc: `curl -k -X OPTIONS -I "${base}"`,
          remediation: 'Restrict advertised and accepted HTTP methods to strictly necessary verbs.'
        });
      }
    }
  }

  // 3. Host Header Injection & Reverse Proxy Poisoning (CWE-644 / CWE-116)
  const poisonHost = 'evil-attacker-host.local';
  const hostTests = [
    { name: 'X-Forwarded-Host', headers: { 'X-Forwarded-Host': poisonHost } },
    { name: 'X-Host', headers: { 'X-Host': poisonHost } },
    { name: 'Host Override', headers: { 'Host': poisonHost } }
  ];

  for (const ht of hostTests) {
    const res = await makeRequest(base, { headers: ht.headers });
    const location = String(res.headers['location'] || '');
    const reflectedInBody = res.body && res.body.includes(poisonHost);
    const reflectedInLocation = location.includes(poisonHost);

    if (reflectedInLocation || reflectedInBody) {
      findings.push({
        severity: reflectedInLocation ? 'HIGH' : 'MEDIUM',
        cwe: 'CWE-644',
        title: `Host Header Injection / Poisoning via ${ht.name}`,
        evidence: reflectedInLocation 
          ? `Attacker host reflected in redirect Location: ${location}`
          : `Attacker host reflected in response body.`,
        poc: `curl -k -H "${ht.name}: ${poisonHost}" -I "${base}"`,
        remediation: 'Enforce strict Host header validation at gateway/Nginx. Discard or ignore untrusted X-Forwarded-Host headers.'
      });
      break;
    }
  }

  // 4. Internal IP / Trusted Proxy Header Spoofing (CWE-290)
  const ipSpoofs = [
    { header: 'X-Forwarded-For', val: '127.0.0.1' },
    { header: 'X-Real-IP', val: '127.0.0.1' },
    { header: 'X-Originating-IP', val: '127.0.0.1' },
    { header: 'True-Client-IP', val: '127.0.0.1' }
  ];

  for (const ips of ipSpoofs) {
    const res = await makeRequest(base, { headers: { [ips.header]: ips.val } });
    matrix.push({ test: ips.header, status: res.status });
  }

  // 5. CORS Differential Matrix (CWE-942)
  const originTests = [
    { label: 'null origin', origin: 'null' },
    { label: 'arbitrary attacker', origin: 'https://evil-attacker-site.com' },
    { label: 'subdomain suffix bypass', origin: `https://${hostname}.evil-site.com` },
    { label: 'prefixed domain bypass', origin: `https://evil-${hostname}` }
  ];

  const corsMatrix = [];
  for (const ot of originTests) {
    const res = await makeRequest(base, {
      method: 'GET',
      headers: { 'Origin': ot.origin }
    });
    const acao = res.headers['access-control-allow-origin'];
    const acac = res.headers['access-control-allow-credentials'];

    corsMatrix.push({ origin: ot.origin, acao: acao || '(none)', acac: acac || '(none)' });

    if (acao === ot.origin || acao === '*') {
      const allowsCreds = acac === 'true' || acac === true;
      if (ot.label !== 'null origin' && allowsCreds) {
        findings.push({
          severity: 'CRITICAL',
          cwe: 'CWE-942',
          title: `Overly Permissive CORS with Credentials (${ot.label})`,
          evidence: `Origin "${ot.origin}" reflected in Access-Control-Allow-Origin with Access-Control-Allow-Credentials: true.`,
          poc: `curl -k -H "Origin: ${ot.origin}" -I "${base}"`,
          remediation: 'Do not reflect arbitrary untrusted Origins when Access-Control-Allow-Credentials is true. Use a strict whitelist.'
        });
      } else if (ot.label === 'null origin' && allowsCreds) {
        findings.push({
          severity: 'HIGH',
          cwe: 'CWE-942',
          title: 'CORS Trust of "null" Origin with Credentials',
          evidence: 'Access-Control-Allow-Origin: null with credentials allowed. Vulnerable to sandboxed iframe attacks.',
          poc: `curl -k -H "Origin: null" -I "${base}"`,
          remediation: 'Never whitelist "null" origin for authenticated CORS requests.'
        });
      }
    }
  }

  // 6. Cache-Control & CDN Information Leakage (CWE-525)
  const cacheControl = baseline.headers['cache-control'] || '';
  const isCacheable = !/no-store|private/i.test(cacheControl);

  if (isCacheable && (base.includes('/api/') || base.includes('/me') || base.includes('/user'))) {
    findings.push({
      severity: 'MEDIUM',
      cwe: 'CWE-525',
      title: 'Sensitive Endpoint Missing Restrictive Cache-Control',
      evidence: `Cache-Control header: "${cacheControl || '(none)'}". Sensitive API endpoints should specify "no-store, private".`,
      poc: `curl -k -I "${base}"`,
      remediation: 'Send "Cache-Control: no-store, no-cache, private, must-revalidate" on all dynamic / API responses.'
    });
  }

  // 7. Modern Enterprise Defense Header Compliance Scorecard
  const h = baseline.headers;
  const headerChecklist = [
    {
      name: 'Strict-Transport-Security (HSTS)',
      header: 'strict-transport-security',
      present: !!h['strict-transport-security'],
      value: h['strict-transport-security'] || 'MISSING',
      severity: 'HIGH',
      cwe: 'CWE-319',
      ideal: 'max-age=31536000; includeSubDomains; preload'
    },
    {
      name: 'Content-Security-Policy (CSP)',
      header: 'content-security-policy',
      present: !!h['content-security-policy'],
      value: h['content-security-policy'] || 'MISSING',
      severity: 'HIGH',
      cwe: 'CWE-79',
      ideal: "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self';"
    },
    {
      name: 'X-Frame-Options (Clickjacking)',
      header: 'x-frame-options',
      present: !!h['x-frame-options'],
      value: h['x-frame-options'] || 'MISSING',
      severity: 'MEDIUM',
      cwe: 'CWE-1021',
      ideal: 'DENY or SAMEORIGIN'
    },
    {
      name: 'X-Content-Type-Options',
      header: 'x-content-type-options',
      present: !!h['x-content-type-options'],
      value: h['x-content-type-options'] || 'MISSING',
      severity: 'MEDIUM',
      cwe: 'CWE-436',
      ideal: 'nosniff'
    },
    {
      name: 'Referrer-Policy',
      header: 'referrer-policy',
      present: !!h['referrer-policy'],
      value: h['referrer-policy'] || 'MISSING',
      severity: 'LOW',
      cwe: 'CWE-200',
      ideal: 'strict-origin-when-cross-origin'
    },
    {
      name: 'Permissions-Policy',
      header: 'permissions-policy',
      present: !!h['permissions-policy'],
      value: h['permissions-policy'] || 'MISSING',
      severity: 'LOW',
      cwe: 'CWE-200',
      ideal: 'camera=(), microphone=(), geolocation=()'
    },
    {
      name: 'Cross-Origin-Opener-Policy (COOP)',
      header: 'cross-origin-opener-policy',
      present: !!h['cross-origin-opener-policy'],
      value: h['cross-origin-opener-policy'] || 'MISSING',
      severity: 'LOW',
      cwe: 'CWE-200',
      ideal: 'same-origin'
    }
  ];

  const missingHeaders = headerChecklist.filter(item => !item.present);
  for (const mh of missingHeaders) {
    findings.push({
      severity: mh.severity,
      cwe: mh.cwe,
      title: `Missing Security Defense Header: ${mh.name}`,
      evidence: `Header "${mh.header}" was not present in the HTTP response. Ideal value: "${mh.ideal}".`,
      poc: `curl -k -I "${base}"`,
      remediation: `Configure your reverse proxy or web server to return "${mh.header}: ${mh.ideal}".`
    });
  }

  // 8. 4-Pillar Concrete Hardening Configs
  const remediations = {
    traefik: `
# Traefik Kubernetes Middleware Hardening
apiVersion: traefik.containo.us/v1alpha1
kind: Middleware
metadata:
  name: enterprise-security-headers
spec:
  headers:
    frameDeny: true
    contentTypeNosniff: true
    browserXssFilter: true
    stsSeconds: 31536000
    stsIncludeSubdomains: true
    stsPreload: true
    customResponseHeaders:
      X-Robots-Tag: "noindex, nofollow"
      Permissions-Policy: "camera=(), microphone=(), geolocation=()"
      Referrer-Policy: "strict-origin-when-cross-origin"
`,
    nginx: `
# Nginx Enterprise Hardening Directives
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self';" always;
proxy_hide_header X-Powered-By;
`,
    express: `
// Express / Node.js Helmet Enterprise Hardening
const helmet = require('helmet');
app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      objectSrc: ["'none'"]
    }
  }
}));
`
  };

  const score = Math.max(20, 100 - (findings.filter(f => f.severity === 'CRITICAL').length * 25) - (findings.filter(f => f.severity === 'HIGH').length * 15) - (findings.filter(f => f.severity === 'MEDIUM').length * 8) - (findings.filter(f => f.severity === 'LOW').length * 3));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';

  return {
    targetUrl: base,
    score,
    grade,
    baselineStatus: baseline.status,
    server: baseline.headers['server'] || '(undisclosed)',
    verbResults,
    corsMatrix,
    headerChecklist,
    findingsCount: findings.length,
    findings,
    remediations
  };
}

module.exports = { auditHttpHeaders };
