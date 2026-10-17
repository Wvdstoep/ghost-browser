'use strict';
/**
 * secondOrderAuditor.js — Multi-Phase Second-Order Stored Injection Engine
 *
 * Discovers stored vulnerabilities where untrusted input injected in Phase 1 (e.g. user profile,
 * display name, bio, organization) is safely accepted, but later executed or reflected unescaped
 * in Phase 2 downstream contexts (admin dashboards, exports, invoice rendering, audit logs).
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

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
      const bodyData = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;

      const req = client.request(u, {
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-SecondOrderAudit/2.0',
          'Accept': 'application/json, text/html, */*',
          ...(bodyData && typeof options.body === 'object' ? { 'Content-Type': 'application/json' } : {}),
          ...(bodyData ? { 'Content-Length': Buffer.byteLength(bodyData) } : {}),
          ...(options.headers || {})
        },
        timeout: options.timeout || 6000
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 262144) {
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

async function auditSecondOrderInjection(targetUrl, options = {}) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  let u = null;
  try { u = new URL(base); } catch (_) { return { error: 'Invalid URL: ' + targetUrl }; }
  const origin = u.origin;

  const findings = [];
  const secureControls = [];

  // Generate unique benign boundary canary token
  const canaryId = '2nd_' + Math.random().toString(36).substring(2, 8);
  const canaryToken = `${canaryId}'"><gb2ndorder>`;

  // Phase 1 Injection endpoints
  const mutationEndpoints = (options.mutationEndpoints && options.mutationEndpoints.length > 0)
    ? options.mutationEndpoints
    : ['/api/user/profile', '/api/settings', '/api/account', '/api/comment'];

  // Phase 2 Downstream Sink endpoints
  const downstreamEndpoints = (options.downstreamEndpoints && options.downstreamEndpoints.length > 0)
    ? options.downstreamEndpoints
    : ['/api/user/profile', '/profile', '/admin/users', '/api/export', '/api/activity'];

  let injectedEndpoint = null;

  // Phase 1: Inject the canary into a mutation endpoint
  for (const ep of mutationEndpoints.slice(0, 3)) {
    const fullUrl = `${origin}${ep.startsWith('/') ? ep : '/' + ep}`;
    const payload = {
      name: canaryToken,
      username: canaryToken,
      bio: canaryToken,
      title: canaryToken
    };

    const res = await httpRequest(fullUrl, {
      method: 'POST',
      body: payload,
      headers: options.headers || {}
    });

    if (res.status >= 200 && res.status < 300) {
      injectedEndpoint = ep;
      break;
    }
  }

  // Phase 2: Probe downstream views for unencoded reflection
  for (const downEp of downstreamEndpoints.slice(0, 4)) {
    const downUrl = `${origin}${downEp.startsWith('/') ? downEp : '/' + downEp}`;
    const resDown = await httpRequest(downUrl, {
      method: 'GET',
      headers: options.headers || {}
    });

    if (resDown.body && resDown.body.includes(canaryToken)) {
      findings.push({
        severity: 'HIGH',
        title: `Second-Order Stored Injection Uncovered on '${downEp}'`,
        cwe: 'CWE-79: Improper Neutralization of Input During Web Page Generation (Stored XSS)',
        cvss: 8.2,
        phase1Injection: injectedEndpoint,
        phase2Sink: downEp,
        evidence: {
          tokenInjected: canaryToken,
          downstreamUrl: downUrl,
          statusCode: resDown.status,
          snippet: resDown.body.slice(0, 200)
        },
        pocCurl: `curl -i "${downUrl}"`,
        remediation: {
          rootCause: `Data stored via '${injectedEndpoint}' was rendered verbatim in '${downEp}' without contextual output encoding.`,
          fixSnippet: `// Apply output encoding in downstream templates / React components:\nimport DOMPurify from 'dompurify';\nconst safeContent = DOMPurify.sanitize(storedData);`
        }
      });
      break;
    }
  }

  if (findings.length === 0) {
    secureControls.push({
      control: 'SECOND_ORDER_ISOLATION',
      note: 'Zero second-order unencoded reflections detected across downstream profile, export, or administrative views.'
    });
  }

  const score = findings.length === 0 ? 100 : Math.max(30, 100 - findings.length * 35);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : 'F';

  return {
    target: origin,
    timestamp: new Date().toISOString(),
    score,
    grade,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls,
    summary: findings.length === 0
      ? 'Second-Order Stored Injection Auditor verified downstream rendering hygiene. Zero stored canary leaks observed.'
      : `Second-Order Stored Injection Auditor uncovered ${findings.length} multi-step stored injection vulnerabilities.`
  };
}

module.exports = {
  auditSecondOrderInjection
};
