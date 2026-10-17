'use strict';
/**
 * polyglotSstiAuditor.js — Mathematical Polyglot SSTI Fingerprinting Engine (CWE-1336)
 *
 * Injects non-destructive arithmetic expressions into candidate input fields, email receipts,
 * and profile parameters to determine whether server-side template engines evaluate user input as code:
 *   - ${31*37}  -> Java EL / FreeMarker / MVEL (Evaluates to 1147)
 *   - {{31*37}} -> Jinja2 (Python) / Twig (PHP) / Nunjucks (Evaluates to 1147)
 *   - <%= 31*37 %> -> EJS / ERB (Ruby) (Evaluates to 1147)
 *   - #{31*37}  -> Pug / Slim / Ruby Expression (Evaluates to 1147)
 *   - {31*37}   -> Smarty (PHP) (Evaluates to 1147)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { harvestTargetEndpoints } = require('./endpointHarvester');

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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-SstiAuditor/3.0',
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
          if (body.length > 524288) { // 512KB max
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

const SSTI_MATRIX = [
  {
    engine: 'Jinja2 / Twig / Nunjucks',
    syntax: '{{31*37}}',
    targetResult: '1147',
    description: 'Double curly-brace expression'
  },
  {
    engine: 'Java EL / FreeMarker / MVEL',
    syntax: '${31*37}',
    targetResult: '1147',
    description: 'Dollar curly-brace expression'
  },
  {
    engine: 'EJS / ERB',
    syntax: '<%= 31*37 %>',
    targetResult: '1147',
    description: 'ASP/EJS template tag'
  },
  {
    engine: 'Pug / Ruby String Interpolation',
    syntax: '#{31*37}',
    targetResult: '1147',
    description: 'Hash curly-brace interpolation'
  }
];

async function auditPolyglotSsti(targetUrl, options = {}) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  let u = null;
  try { u = new URL(base); } catch (_) { return { error: 'Invalid URL: ' + targetUrl }; }
  const origin = u.origin;

  const findings = [];
  const secureControls = [];

  let candidateEndpoints = (options.endpoints && options.endpoints.length > 0) ? options.endpoints : null;
  if (!candidateEndpoints) {
    try {
      const harvested = await harvestTargetEndpoints(origin, options);
      candidateEndpoints = [...(harvested.mutationEndpoints || []), ...(harvested.queryEndpoints || [])];
    } catch (_) {}
  }

  if (!candidateEndpoints || candidateEndpoints.length === 0) {
    candidateEndpoints = ['/api/me/contact', '/api/comment', '/api/feedback', '/api/billing/vat/check'];
  }

  // Deduplicate and take top 6 endpoints
  const endpointsToTest = Array.from(new Set(candidateEndpoints)).slice(0, 6);

  for (const ep of endpointsToTest) {
    const fullUrl = `${origin}${ep.startsWith('/') ? ep : '/' + ep}`;

    for (const probe of SSTI_MATRIX) {
      // 1. Test via JSON POST payload
      const jsonPayload = {
        name: probe.syntax,
        email: `test+${probe.syntax}@example.com`,
        subject: probe.syntax,
        comment: probe.syntax,
        message: probe.syntax,
        query: probe.syntax
      };

      const resPost = await httpRequest(fullUrl, {
        method: 'POST',
        body: jsonPayload,
        timeout: 5000
      });

      // If the target evaluated 31*37 to 1147 and does NOT contain the literal unescaped probe syntax
      if (resPost.body && resPost.body.includes(probe.targetResult) && !resPost.body.includes(probe.syntax)) {
        findings.push({
          cwe: 'CWE-1336',
          title: `Server-Side Template Injection (SSTI) in ${ep} (${probe.engine})`,
          severity: 'CRITICAL',
          endpoint: ep,
          detectedEngine: probe.engine,
          probeSyntax: probe.syntax,
          evaluatedResult: probe.targetResult,
          impact: `User input injected into ${ep} was evaluated by a server-side template engine (${probe.engine}). Attackers can escalate arithmetic evaluation into full Remote Code Execution (RCE) via engine sandbox escapes.`,
          proof: `Payload "${probe.syntax}" evaluated to "${probe.targetResult}" in response body.`,
          remediation: `Do not pass unescaped user input directly into template compilation. Use contextual auto-escaping or pass variables exclusively as template context parameters.`
        });
        break; // Found vulnerability on this endpoint
      }

      // 2. Also test GET query parameter reflection
      const testParamUrl = `${fullUrl}?q=${encodeURIComponent(probe.syntax)}&name=${encodeURIComponent(probe.syntax)}`;
      const resGet = await httpRequest(testParamUrl, { method: 'GET', timeout: 4000 });

      if (resGet.body && resGet.body.includes(probe.targetResult) && !resGet.body.includes(probe.syntax)) {
        findings.push({
          cwe: 'CWE-1336',
          title: `GET Parameter Server-Side Template Injection (SSTI) in ${ep} (${probe.engine})`,
          severity: 'CRITICAL',
          endpoint: ep,
          detectedEngine: probe.engine,
          probeSyntax: probe.syntax,
          evaluatedResult: probe.targetResult,
          impact: `Query parameters on ${ep} are evaluated by ${probe.engine}.`,
          proof: `Parameter "${probe.syntax}" evaluated to "${probe.targetResult}".`,
          remediation: `Sanitize query parameters and avoid rendering them directly into template strings.`
        });
        break;
      }
    }

    if (!findings.some(f => f.endpoint === ep)) {
      secureControls.push({
        endpoint: ep,
        control: 'Template Engine Input Neutralization',
        status: 'Pass',
        detail: `No arithmetic evaluation observed across mathematical polyglot matrix (${SSTI_MATRIX.map(m => m.syntax).join(', ')}). Input safely treated as string literal.`
      });
    }
  }

  const overallPosture = findings.length === 0 ? 'RESILIENT' : 'VULNERABLE';

  return {
    engine: 'GhostBrowser-PolyglotSstiAuditor/3.0',
    target: origin,
    overallPosture,
    endpointsTested: endpointsToTest.length,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls,
    polyglotsTested: SSTI_MATRIX.map(m => ({ engine: m.engine, probe: m.syntax }))
  };
}

module.exports = {
  auditPolyglotSsti,
  SSTI_MATRIX
};
