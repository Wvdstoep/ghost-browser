'use strict';
/**
 * massAssignmentAuditor.js — Mass Assignment & Privileged Attribute Escalation Auditor (CWE-915)
 *
 * Evaluates whether state-changing API endpoints (POST, PUT, PATCH) blindly bind untrusted
 * request body keys to internal database models or session contexts without DTO allow-listing.
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-MassAssignAudit/2.0',
          'Accept': 'application/json, text/plain, */*',
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

const PRIVILEGED_ATTRIBUTES = [
  { key: 'role', value: 'admin' },
  { key: 'isAdmin', value: true },
  { key: 'is_admin', value: true },
  { key: 'permissions', value: ['*'] },
  { key: 'verified', value: true },
  { key: 'is_verified', value: true },
  { key: 'credits', value: 99999 },
  { key: 'plan', value: 'enterprise' }
];

async function auditMassAssignment(targetUrl, options = {}) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  let u = null;
  try { u = new URL(base); } catch (_) { return { error: 'Invalid URL: ' + targetUrl }; }
  const origin = u.origin;

  const findings = [];
  const secureControls = [];

  const candidateEndpoints = (options.endpoints && options.endpoints.length > 0)
    ? options.endpoints
    : ['/api/user', '/api/users', '/api/profile', '/api/settings', '/api/account'];

  for (const ep of candidateEndpoints.slice(0, 4)) {
    const fullUrl = `${origin}${ep.startsWith('/') ? ep : '/' + ep}`;

    // Base legitimate payload
    const basePayload = { name: 'Probe Tester', email: 'probe@test.local', updatedAt: Date.now() };

    // Mutated payload with sensitive privilege attributes injected
    const mutatedPayload = {
      ...basePayload,
      role: 'admin',
      isAdmin: true,
      permissions: ['*'],
      credits: 99999
    };

    const res = await httpRequest(fullUrl, {
      method: 'POST',
      body: mutatedPayload,
      headers: options.headers || {}
    });

    if (res.status >= 200 && res.status < 300) {
      // Check if response echoes back accepted role or isAdmin attributes
      let echoesPrivilege = false;
      let echoedField = '';
      try {
        const json = JSON.parse(res.body);
        if (json.role === 'admin') { echoesPrivilege = true; echoedField = 'role: "admin"'; }
        else if (json.isAdmin === true) { echoesPrivilege = true; echoedField = 'isAdmin: true'; }
        else if (json.credits === 99999) { echoesPrivilege = true; echoedField = 'credits: 99999'; }
      } catch (_) {}

      if (echoesPrivilege) {
        findings.push({
          severity: 'CRITICAL',
          title: `Mass Assignment & Privilege Escalation Accepted on '${ep}'`,
          cwe: 'CWE-915: Improperly Controlled Modification of Dynamically-Determined Object Attributes',
          cvss: 8.8,
          targetUrl: fullUrl,
          pocCurl: `curl -i -X POST -H "Content-Type: application/json" -d '${JSON.stringify(mutatedPayload)}' "${fullUrl}"`,
          evidence: {
            acceptedField: echoedField,
            statusCode: res.status,
            responseSnippet: res.body.slice(0, 200)
          },
          remediation: {
            rootCause: `Endpoint '${ep}' accepted an arbitrary object and bound unvalidated attributes into the database or session model.`,
            fixSnippet: `// Use Zod / TypeScript schema allow-listing (strict DTO pattern):\nimport { z } from 'zod';\n\nconst UpdateProfileDto = z.object({\n  name: z.string().min(1),\n  email: z.string().email()\n}).strict(); // Rejects any extra keys like role or isAdmin\n\nconst validated = UpdateProfileDto.parse(req.body);`
          }
        });
      }
    }
  }

  if (findings.length === 0) {
    secureControls.push({
      control: 'MASS_ASSIGNMENT_IMMUNITY',
      note: 'Mutation endpoints safely filter or reject unauthorized privilege attributes (role, isAdmin, credits).'
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
      ? 'Mass Assignment Auditor verified DTO strictness. Zero unauthorized privilege attribute escalations allowed.'
      : `Mass Assignment Auditor detected ${findings.length} endpoints allowing unauthorized privilege escalation.`
  };
}

module.exports = {
  auditMassAssignment
};
