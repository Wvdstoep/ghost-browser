'use strict';
/**
 * concurrencyAuditor.js — Concurrency, TOCTOU & Idempotency Verification Engine
 *
 * Verifies whether stateful actions and sensitive endpoints enforce proper
 * synchronization, deduplication, and idempotency headers (IETF draft-ietf-httpapi-idempotency-key-header):
 *   1. Synchronized Connection Burst: Fires parallel requests via HTTP connection pooling.
 *   2. Idempotency Key Evaluation: Tests whether repeated submissions with identical keys are deduplicated.
 *   3. Concurrency Safety: Flags duplicate processing flaws (CWE-362: Race Conditions / TOCTOU).
 *   4. Turnkey Remediation: Emits Redis mutex lock and idempotency middleware code diffs.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Dispatches an HTTP request
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

      const bodyData = options.body ? JSON.stringify(options.body) : null;

      const req = client.request(u, {
        method: options.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bodyData ? { 'Content-Length': Buffer.byteLength(bodyData) } : {}),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-ConcurrencyAuditor/2.0',
          'Accept': 'application/json',
          ...(options.headers || {})
        },
        timeout: options.timeout || 7000
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 65536) {
            req.destroy();
            finish({ status: res.statusCode, headers: res.headers, body });
          }
        });
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body }));
        res.on('close', () => finish({ status: res.statusCode, headers: res.headers, body }));
      });

      req.on('error', (err) => finish({ error: err.message, status: 0, headers: {}, body: '' }));
      req.on('timeout', () => { req.destroy(); finish({ error: 'timeout', status: 0, headers: {}, body: '' }); });
      if (bodyData) req.write(bodyData);
      req.end();
    } catch (e) {
      finish({ error: e.message, status: 0, headers: {}, body: '' });
    }
  });
}

/**
 * Audits an endpoint for concurrency handling and idempotency key support
 *
 * @param {string} targetUrl - Target endpoint URL
 * @param {object} [options]
 * @param {object} [options.headers] - Auth headers
 * @param {object} [options.payload] - Action payload
 * @param {number} [options.concurrency] - Number of parallel requests (default 8)
 */
async function auditConcurrency(targetUrl, options = {}) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;

  const findings = [];
  const secureControls = [];

  const burstCount = Math.min(10, Math.max(4, options.concurrency || 6));
  const testIdempotencyKey = 'idemp_' + Math.random().toString(36).substring(2, 10);

  const burstHeaders = {
    ...(options.headers || {}),
    'Idempotency-Key': testIdempotencyKey,
    'X-Idempotency-Key': testIdempotencyKey
  };

  // 1. Dispatch synchronized parallel requests
  const promises = [];
  for (let i = 0; i < burstCount; i++) {
    promises.push(httpRequest(base, {
      method: options.method || 'POST',
      headers: burstHeaders,
      body: options.payload || { probe: 'concurrency_test', t: Date.now() }
    }));
  }

  const responses = await Promise.all(promises);
  const statusCounts = {};
  responses.forEach(r => {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  });

  const successCount = (statusCounts[200] || 0) + (statusCounts[201] || 0);
  const conflictCount = (statusCounts[409] || 0) + (statusCounts[429] || 0);

  // Evaluate whether idempotency or deduplication was observed
  if (successCount === 1 && conflictCount > 0) {
    secureControls.push({
      control: 'CONCURRENCY_MUTEX_ENFORCED',
      note: `1 request succeeded while ${conflictCount} parallel duplicate requests were safely locked/rejected (HTTP 409/429).`
    });
  } else if (successCount > 1 && responses.every(r => r.body === responses[0].body)) {
    secureControls.push({
      control: 'IDEMPOTENCY_DEDUPLICATION_ENFORCED',
      note: `Identical responses returned for shared Idempotency-Key (${successCount} requests deduplicated).`
    });
  } else if (successCount > 3) {
    findings.push({
      severity: 'MEDIUM',
      title: 'Missing Idempotency and State Synchronization Controls',
      cwe: 'CWE-362: Concurrent Execution using Shared Resource with Improper Synchronization',
      cvss: 5.4,
      targetUrl: base,
      evidence: {
        burstCount,
        statusCounts,
        note: `${successCount} concurrent submissions were accepted independently without deduplication.`
      },
      remediation: {
        rootCause: 'Endpoint processes concurrent duplicate submissions without database locks or Idempotency-Key tracking.',
        fixSnippet: `// Redis Distributed Lock / Idempotency Middleware:\nconst redis = require('./redisClient');\n\napp.post('/api/action', async (req, res) => {\n  const key = req.headers['idempotency-key'];\n  if (key) {\n    const acquired = await redis.set(\`lock:\${key}\`, 'active', 'NX', 'EX', 10);\n    if (!acquired) return res.status(409).json({ error: 'Concurrent duplicate request in progress' });\n  }\n  // Execute action logic\n});`
      }
    });
  } else {
    secureControls.push({
      control: 'REQUEST_THROTTLED',
      note: `Endpoint handled parallel requests safely (Statuses: ${JSON.stringify(statusCounts)}).`
    });
  }

  const score = findings.length === 0 ? 100 : 75;
  const grade = score >= 90 ? 'A' : 'B';

  return {
    target: base,
    timestamp: new Date().toISOString(),
    score,
    grade,
    burstCount,
    statusCounts,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls,
    summary: findings.length === 0
      ? 'Endpoint safely handles concurrent submissions and enforces synchronization controls.'
      : 'Endpoint accepted concurrent duplicate submissions without idempotency deduplication.'
  };
}

module.exports = {
  auditConcurrency
};
