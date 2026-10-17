'use strict';
/**
 * graphqlBatchAuditor.js — GraphQL Batching & Alias Amplification Auditor (CWE-400)
 *
 * Tests whether GraphQL gateways enforce query alias limits and batching controls
 * using non-destructive safe probes (a: __typename, b: __typename) without modifying data
 * or triggering Denial of Service.
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
        method: options.method || 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-GraphQLBatchAuditor/3.0',
          'Accept': 'application/json, */*',
          ...(bodyData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) } : {}),
          ...(options.headers || {})
        },
        timeout: options.timeout || 6000
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 524288) {
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

async function auditGraphQLBatchAmplification(targetUrl, options = {}) {
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
      candidateEndpoints = (harvested.graphqlEndpoints && harvested.graphqlEndpoints.length > 0)
        ? harvested.graphqlEndpoints
        : ['/api/graphql', '/graphql', '/gql'];
    } catch (_) {
      candidateEndpoints = ['/api/graphql', '/graphql', '/gql'];
    }
  }

  let activeGraphqlEndpoint = null;

  for (const ep of candidateEndpoints) {
    const fullUrl = `${origin}${ep.startsWith('/') ? ep : '/' + ep}`;

    // 1. Basic Introspection / Endpoint Existence Probe
    const probeRes = await httpRequest(fullUrl, {
      method: 'POST',
      body: { query: '{ __typename }' }
    });

    let json = null;
    try { json = JSON.parse(probeRes.body); } catch (_) {}

    if (json && (json.data || json.errors)) {
      activeGraphqlEndpoint = ep;

      // ── Probe 1: Safe Aliased Multi-Call Amplification Probe ──
      // query { a: __typename, b: __typename, c: __typename, d: __typename, e: __typename }
      const aliasQuery = {
        query: 'query SafeBatchCheck { a: __typename b: __typename c: __typename d: __typename e: __typename }'
      };

      const aliasRes = await httpRequest(fullUrl, { method: 'POST', body: aliasQuery });
      let aliasJson = null;
      try { aliasJson = JSON.parse(aliasRes.body); } catch (_) {}

      if (aliasJson && aliasJson.data && aliasJson.data.a && aliasJson.data.e) {
        findings.push({
          cwe: 'CWE-400',
          title: `Unrestricted GraphQL Alias Amplification in ${ep}`,
          severity: 'HIGH',
          endpoint: ep,
          technique: 'Aliased Multi-Call Probe (5 aliases)',
          impact: 'The GraphQL gateway evaluates multiple aliased operations in a single HTTP request without alias limits. Attackers can bundle 500+ mutations (e.g. login, credit transfer, OTP guess) in a single request to bypass rate limiters.',
          proof: `Executed query with 5 aliases (a-e: __typename). Server returned data for all 5 aliases in a single response.`,
          remediation: 'Implement alias count limits (e.g. @escape.tech/graphql-armor with maxAliases: 3 or graphql-input-number-of-aliases plugin).'
        });
      } else {
        secureControls.push({
          endpoint: ep,
          control: 'GraphQL Alias Limiting',
          status: 'Pass',
          detail: 'Server restricted or rejected aliased multi-call query.'
        });
      }

      // ── Probe 2: Array-Based Query Batching Probe ──
      const batchQuery = [
        { query: '{ __typename }' },
        { query: '{ __typename }' },
        { query: '{ __typename }' }
      ];

      const batchRes = await httpRequest(fullUrl, { method: 'POST', body: batchQuery });
      let batchJson = null;
      try { batchJson = JSON.parse(batchRes.body); } catch (_) {}

      if (Array.isArray(batchJson) && batchJson.length === 3) {
        findings.push({
          cwe: 'CWE-400',
          title: `Array-Based HTTP Request Batching Enabled in ${ep}`,
          severity: 'MEDIUM',
          endpoint: ep,
          technique: 'Array Batch Probe (3 batched queries)',
          impact: 'Server allows clients to send an array of GraphQL queries in a single HTTP POST request. This enables rate-limiting bypass and amplified resource consumption.',
          proof: `Sent JSON array of 3 GraphQL operations. Server processed all 3 and returned an array of 3 execution results.`,
          remediation: 'Disable batched HTTP requests in Apollo Server: { allowBatchedHttpRequests: false } or enforce maximum batch size of 1 in GraphQL Yoga/Helix.'
        });
      } else {
        secureControls.push({
          endpoint: ep,
          control: 'GraphQL Array Batching Restriction',
          status: 'Pass',
          detail: 'Server rejected or ignored array-batched query payload.'
        });
      }

      break; // Found and audited GraphQL endpoint
    }
  }

  if (!activeGraphqlEndpoint) {
    secureControls.push({
      control: 'GraphQL Surface Exposure',
      status: 'Clean',
      detail: `No publicly exposed GraphQL endpoints detected on candidate paths (${candidateEndpoints.join(', ')}).`
    });
  }

  const overallPosture = findings.length === 0 ? 'RESILIENT' : 'VULNERABLE';

  return {
    engine: 'GhostBrowser-GraphQLBatchAuditor/3.0',
    target: origin,
    activeGraphqlEndpoint: activeGraphqlEndpoint || 'None Detected',
    overallPosture,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls
  };
}

module.exports = {
  auditGraphQLBatchAmplification
};
