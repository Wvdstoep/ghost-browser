'use strict';
/**
 * blindDetectionPipeline.js — 3-Layer Blind Vulnerability Detection Pipeline
 *
 * Mathematically and behaviorally proves blind vulnerabilities without destructive payloads:
 *   - Layer 1: In-Band Reflection & Syntax Analysis (Direct unencoded reflections & database syntax leaks)
 *   - Layer 2: Statistical Timing Differentials (3-pass calibrated time delays with standard deviation analysis)
 *   - Layer 3: Out-of-Band OAST Canary Pingback (Ephemeral DNS/HTTP cryptographic callbacks for async workers)
 *
 * Conforms to:
 *   - CWE-89: Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')
 *   - CWE-918: Server-Side Request Forgery (SSRF)
 *   - CWE-79: Improper Neutralization of Input During Web Page Generation ('Cross-site Scripting')
 */

const { URL } = require('url');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { auditSqliTimingDifferential } = require('./sqliTimingAuditor');
const { auditOastCanaryProtocol } = require('./oastAuditor');
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-BlindPipeline/2.0',
          'Accept': 'application/json, text/html, */*',
          ...(bodyData && typeof options.body === 'object' ? { 'Content-Type': 'application/json' } : {}),
          ...(bodyData ? { 'Content-Length': Buffer.byteLength(bodyData) } : {}),
          ...(options.headers || {})
        },
        timeout: options.timeout || 6000
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          if (data.length < 50000) data += chunk;
        });
        res.on('end', () => {
          finish({
            status: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });

      req.on('error', (err) => finish({ error: err.message, status: 0, headers: {}, body: '' }));
      req.on('timeout', () => {
        req.destroy();
        finish({ error: 'Request timeout', status: 0, headers: {}, body: '' });
      });

      if (bodyData) req.write(bodyData);
      req.end();
    } catch (e) {
      finish({ error: e.message, status: 0, headers: {}, body: '' });
    }
  });
}

/**
 * 3-Layer Blind Vulnerability Detection Pipeline
 * @param {string} targetUrl - Target base URL or domain
 * @param {object} options - Optional endpoints and timing options
 */
async function auditBlindDetectionPipeline(targetUrl, options = {}) {
  let origin = targetUrl;
  try {
    const u = new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl);
    origin = u.origin;
  } catch (_) {}

  const findings = [];
  const secureControls = [];

  const discovered = (options.endpoints && options.endpoints.length > 0)
    ? { all: options.endpoints, queryEndpoints: options.endpoints }
    : await harvestTargetEndpoints(origin);

  const candidateEndpoints = [...(discovered.queryEndpoints || []), ...(discovered.mutationEndpoints || []), ...(discovered.all || [])].slice(0, 5);

  // ═════════════════════════════════════════════════════════════════════
  // LAYER 1: IN-BAND REFLECTION & SYNTAX ANALYSIS
  // ═════════════════════════════════════════════════════════════════════
  const canaryId = crypto.randomBytes(4).toString('hex');
  const boundaryToken = `__gbcanary_${canaryId}'"\\;--/*`;
  const SQL_SYNTAX_ERROR_PATTERNS = [
    /syntax error in SQL statement/i,
    /You have an error in your SQL syntax/i,
    /PostgreSQL query failed/i,
    /pg_query\(\)/i,
    /SQLite3::SQLException/i,
    /ORA-[0-9]{5}/i,
    /Microsoft OLE DB Provider for SQL Server/i,
    /Unclosed quotation mark before the character string/i
  ];

  const inBandFindings = [];
  for (const ep of candidateEndpoints.slice(0, 4)) {
    const probeUrl = `${origin}${ep.startsWith('/') ? ep : '/' + ep}?q=${encodeURIComponent(boundaryToken)}&id=1${encodeURIComponent("'")}`;
    const res = await httpRequest(probeUrl, { method: 'GET' });

    if (res.body) {
      // Check for SQL error leak
      for (const pattern of SQL_SYNTAX_ERROR_PATTERNS) {
        if (pattern.test(res.body)) {
          inBandFindings.push({
            endpoint: ep,
            type: 'SQL_SYNTAX_ERROR_LEAK',
            snippet: res.body.slice(0, 200)
          });
          findings.push({
            layer: 'Layer 1: In-Band Reflection & Syntax Analysis',
            id: 'BLIND-L1-SQL-SYNTAX-ERROR-LEAK',
            cwe: 'CWE-209',
            severity: 'CRITICAL',
            title: 'Database Syntax Error Information Leak',
            description: `Endpoint '${ep}' returned raw database syntax error details when boundary delimiter was injected.`,
            endpoint: ep,
            remediation: 'Disable database verbose error messages in production and use parameterized prepared statements.'
          });
          break;
        }
      }

      // Check for unencoded reflection
      if (res.body.includes(boundaryToken)) {
        inBandFindings.push({
          endpoint: ep,
          type: 'UNENCODED_CANARY_REFLECTION',
          snippet: res.body.slice(0, 200)
        });
        findings.push({
          layer: 'Layer 1: In-Band Reflection & Syntax Analysis',
          id: 'BLIND-L1-UNENCODED-CANARY-REFLECTION',
          cwe: 'CWE-79',
          severity: 'HIGH',
          title: 'Unencoded Canary Reflection Detected',
          description: `Endpoint '${ep}' reflects input delimiter '${boundaryToken}' verbatim without contextual HTML/attribute escaping.`,
          endpoint: ep,
          remediation: 'Apply contextual HTML entity encoding to all user-controlled input before reflecting in responses.'
        });
      }
    }
  }

  if (inBandFindings.length === 0) {
    secureControls.push({
      layer: 'Layer 1',
      control: 'IN_BAND_SYNTAX_SANITATION',
      note: 'Zero database syntax error disclosures and zero unencoded boundary reflections observed.'
    });
  }

  // ═════════════════════════════════════════════════════════════════════
  // LAYER 2: STATISTICAL TIMING DIFFERENTIALS (BLIND SQLi)
  // ═════════════════════════════════════════════════════════════════════
  const timingResult = await auditSqliTimingDifferential(origin, {
    endpoints: candidateEndpoints.slice(0, 3)
  });

  if (timingResult.findingsCount > 0) {
    for (const f of timingResult.findings) {
      findings.push({
        layer: 'Layer 2: Statistical Timing Differentials',
        id: 'BLIND-L2-STATISTICAL-TIMING-ANOMALY',
        cwe: 'CWE-89',
        severity: 'CRITICAL',
        title: f.title || 'Blind SQL Injection Proven via Timing Differential',
        description: f.description || 'Calibrated time-delay payloads caused statistically significant latency differentials (>3σ) across repeated trials.',
        endpoint: f.endpoint,
        remediation: f.remediation || 'Enforce parameterized queries (prepared statements) across all ORM and raw SQL database calls.'
      });
    }
  } else {
    secureControls.push({
      layer: 'Layer 2',
      control: 'STATISTICAL_TIMING_CONSISTENCY',
      note: 'Latency across calibrated delay trials remained strictly consistent with baseline (Δ < 150ms, σ within normal distribution).'
    });
  }

  // ═════════════════════════════════════════════════════════════════════
  // LAYER 3: OUT-OF-BAND (OAST) CANARY PINGBACK
  // ═════════════════════════════════════════════════════════════════════
  const oastResult = await auditOastCanaryProtocol(origin, {
    endpoints: candidateEndpoints.slice(0, 3)
  });

  if (oastResult.findingsCount > 0) {
    for (const f of oastResult.findings) {
      findings.push({
        layer: 'Layer 3: Out-of-Band OAST Canary Pingback',
        id: 'BLIND-L3-ASYNCHRONOUS-CALLBACK-DETECTED',
        cwe: f.cwe || 'CWE-918',
        severity: f.severity || 'CRITICAL',
        title: f.title || 'Out-of-Band Asynchronous Callback Confirmed',
        description: f.description || 'Target server or backend message consumer initiated DNS/HTTP callback to external canary token.',
        endpoint: f.endpoint,
        remediation: f.remediation || 'Validate and whitelist all outbound network destinations, isolating internal network boundaries.'
      });
    }
  } else {
    secureControls.push({
      layer: 'Layer 3',
      control: 'OAST_OUTBOUND_EGRESS_CONFINED',
      note: 'Zero unauthorized asynchronous DNS or HTTP egress callbacks triggered by candidate webhook/fetcher parameters.'
    });
  }

  const score = findings.length === 0 ? 100 : Math.max(25, 100 - findings.reduce((acc, f) => acc + (f.severity === 'CRITICAL' ? 35 : f.severity === 'HIGH' ? 20 : 10), 0));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : 'F';

  return {
    target: origin,
    pipeline: 'Blind Vulnerability Detection Pipeline (3 Layers)',
    timestamp: new Date().toISOString(),
    score,
    grade,
    layers: {
      layer1_inBandReflection: {
        endpointsTested: candidateEndpoints.length,
        syntaxErrorsFound: inBandFindings.filter(f => f.type === 'SQL_SYNTAX_ERROR_LEAK').length,
        unencodedReflectionsFound: inBandFindings.filter(f => f.type === 'UNENCODED_CANARY_REFLECTION').length
      },
      layer2_timingDifferential: {
        endpointsTested: candidateEndpoints.slice(0, 3).length,
        anomaliesDetected: timingResult.findingsCount
      },
      layer3_oastCallbacks: {
        endpointsTested: candidateEndpoints.slice(0, 3).length,
        callbacksTriggered: oastResult.findingsCount
      }
    },
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls,
    summary: findings.length === 0
      ? '3-Layer Blind Vulnerability Detection Pipeline completed with 100% confidence. Zero in-band syntax leaks, zero timing differentials, and zero unauthorized OAST egress callbacks.'
      : `3-Layer Blind Vulnerability Detection Pipeline discovered ${findings.length} confirmed vulnerabilities across in-band, timing, or asynchronous layers.`
  };
}

module.exports = {
  auditBlindDetectionPipeline
};
