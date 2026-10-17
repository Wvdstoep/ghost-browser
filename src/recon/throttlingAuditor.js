'use strict';
/**
 * throttlingAuditor.js — Rate-Limiting & Throttling Verification Engine
 *
 * Verifies whether public endpoints and sensitive APIs implement proper
 * rate-limiting and throttling headers (RFC 6585 / RFC 7231):
 *   1. Rate-Limit Header Inspection: Checks X-RateLimit-Limit, Remaining, Reset, Retry-After.
 *   2. Bounded Probing: Sends a small sequence of benign requests to observe quota decrement.
 *   3. Remediation Diffs: Generates drop-in Nginx limit_req and Express rate-limit configurations.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Dispatches an HTTP request and captures rate-limiting metadata
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-ThrottlingAuditor/2.0',
          'Accept': 'application/json, text/plain, */*',
          ...(options.headers || {})
        },
        timeout: options.timeout || 6000
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 65536) {
            req.destroy();
            finish({ status: res.statusCode, headers: res.headers });
          }
        });
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers }));
        res.on('close', () => finish({ status: res.statusCode, headers: res.headers }));
      });

      req.on('error', (err) => finish({ error: err.message, status: 0, headers: {} }));
      req.on('timeout', () => { req.destroy(); finish({ error: 'timeout', status: 0, headers: {} }); });
      req.end();
    } catch (e) {
      finish({ error: e.message, status: 0, headers: {} });
    }
  });
}

/**
 * Audits an endpoint for rate-limiting headers and throttling controls
 *
 * @param {string} targetUrl - Endpoint to test
 * @param {object} [options]
 */
async function auditThrottling(targetUrl, options = {}) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;

  const findings = [];
  const secureControls = [];

  // 1. Initial probe to observe baseline headers
  const initial = await httpRequest(base, { method: 'GET' });
  if (initial.status === 0) {
    return { error: 'Failed to connect to target endpoint', target: base };
  }

  const headers = initial.headers || {};
  const rateLimitHeader = headers['x-ratelimit-limit'] || headers['ratelimit-limit'];
  const remainingHeader = headers['x-ratelimit-remaining'] || headers['ratelimit-remaining'];
  const retryAfterHeader = headers['retry-after'];

  const hasRateLimitHeaders = !!(rateLimitHeader || remainingHeader || retryAfterHeader);

  // 2. Perform a bounded test sequence of 5 requests to check for decrement
  let decrementObserved = false;
  let received429 = initial.status === 429;
  let lastRemaining = remainingHeader ? parseInt(remainingHeader, 10) : null;

  for (let i = 0; i < 4; i++) {
    const res = await httpRequest(base, { method: 'GET' });
    if (res.status === 429) {
      received429 = true;
      break;
    }
    const rem = res.headers['x-ratelimit-remaining'] || res.headers['ratelimit-remaining'];
    if (rem && lastRemaining !== null && parseInt(rem, 10) < lastRemaining) {
      decrementObserved = true;
      lastRemaining = parseInt(rem, 10);
    }
  }

  if (received429 || decrementObserved || hasRateLimitHeaders) {
    secureControls.push({
      control: 'RATE_LIMITING_ACTIVE',
      status: initial.status,
      headers: {
        limit: rateLimitHeader || 'Enforced',
        remaining: lastRemaining !== null ? lastRemaining : 'Monitored',
        retryAfter: retryAfterHeader || 'N/A'
      },
      note: 'Endpoint enforces rate limiting with active quota decrement or standard throttling headers.'
    });
  } else {
    findings.push({
      severity: 'MEDIUM',
      title: 'Missing Throttling and Rate-Limiting Controls',
      cwe: 'CWE-799: Improper Control of Interaction Frequency',
      cvss: 5.3,
      targetUrl: base,
      evidence: {
        observedStatus: initial.status,
        headersPresent: Object.keys(headers).filter(k => k.includes('rate') || k.includes('retry'))
      },
      remediation: {
        rootCause: 'Endpoint does not return rate-limiting headers or throttle repeated requests, exposing it to automated abuse.',
        fixSnippet: `// Express.js rate-limit middleware:\nconst rateLimit = require('express-rate-limit');\nconst limiter = rateLimit({\n  windowMs: 15 * 60 * 1000, // 15 minutes\n  max: 100, // Limit each IP to 100 requests per window\n  standardHeaders: true,\n  legacyHeaders: false\n});\napp.use('/api/', limiter);`,
        nginxBlock: `# Nginx rate-limiting configuration:\nlimit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;\n\nlocation /api/ {\n    limit_req zone=api_limit burst=20 nodelay;\n}`
      }
    });
  }

  const score = findings.length === 0 ? 100 : 70;
  const grade = score >= 90 ? 'A' : 'B';

  return {
    target: base,
    timestamp: new Date().toISOString(),
    score,
    grade,
    hasRateLimitHeaders,
    decrementObserved,
    received429,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls,
    summary: findings.length === 0
      ? 'Endpoint actively enforces rate-limiting controls and emits standard throttling headers.'
      : 'Endpoint lacks standard rate-limiting headers and throttling controls.'
  };
}

module.exports = {
  auditThrottling
};
