'use strict';
/**
 * graphqlAuditor.js — GraphQL Query Complexity, Depth & Contract Resilience Engine
 *
 * Evaluates GraphQL endpoint security controls:
 *   1. Endpoint Discovery: Tests standard paths (/graphql, /api/graphql, /gql, /v1/graphql).
 *   2. Schema Introspection Posture: Checks if production schema introspection is enabled.
 *   3. Query Depth Limits: Verifies whether the gateway rejects deeply nested recursive queries.
 *   4. Batching Resilience: Tests whether array-batched queries bypass request-level limits.
 *   5. Turnkey Hardening Diffs: Provides drop-in depth-limit and Apollo Server security configs.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Dispatches an HTTP POST request with JSON payload
 */
function httpRequest(urlStr, jsonBody) {
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

      const bodyData = JSON.stringify(jsonBody);

      const req = client.request(u, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyData),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-GraphQLAuditor/2.0',
          'Accept': 'application/json'
        },
        timeout: 7000
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
      req.write(bodyData);
      req.end();
    } catch (e) {
      finish({ error: e.message, status: 0, headers: {}, body: '' });
    }
  });
}

/**
 * Audits GraphQL endpoints for depth limits, batching, and schema disclosure
 *
 * @param {string} targetUrl - Target domain or GraphQL URL
 */
async function auditGraphqlResilience(targetUrl) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;

  let u = null;
  try { u = new URL(base); } catch (_) {
    return { error: 'Invalid URL: ' + targetUrl };
  }

  const origin = u.origin;
  const candidatePaths = u.pathname !== '/' && u.pathname.includes('graphql')
    ? [u.pathname]
    : ['/graphql', '/api/graphql', '/gql', '/v1/graphql', '/api/v1/graphql'];

  let activeGraphqlEndpoint = null;
  const findings = [];
  const secureControls = [];

  // 1. Discover active GraphQL endpoint
  for (const path of candidatePaths) {
    const fullUrl = `${origin}${path}`;
    const testRes = await httpRequest(fullUrl, { query: '{ __typename }' });
    if (testRes.status >= 200 && testRes.status < 300 && testRes.body && testRes.body.includes('__typename')) {
      activeGraphqlEndpoint = fullUrl;
      break;
    }
  }

  if (!activeGraphqlEndpoint) {
    return {
      target: origin,
      timestamp: new Date().toISOString(),
      score: 100,
      grade: 'A',
      activeGraphqlDetected: false,
      summary: 'No exposed GraphQL endpoints detected on standard paths.'
    };
  }

  // 2. Test Schema Introspection
  const introspectionRes = await httpRequest(activeGraphqlEndpoint, {
    query: 'query { __schema { queryType { name } mutationType { name } } }'
  });

  if (introspectionRes.body && introspectionRes.body.includes('__schema')) {
    findings.push({
      severity: 'LOW',
      title: 'GraphQL Schema Introspection Enabled in Production',
      cwe: 'CWE-200: Exposure of Sensitive Information to an Unauthorized Actor',
      cvss: 3.7,
      targetUrl: activeGraphqlEndpoint,
      pocCurl: `curl -s -X POST -H "Content-Type: application/json" -d '{"query":"query { __schema { queryType { name } } }"}' "${activeGraphqlEndpoint}"`,
      evidence: { endpoint: activeGraphqlEndpoint, responseSnippet: introspectionRes.body.slice(0, 150) },
      remediation: {
        rootCause: 'Introspection exposes full internal API schema, types, queries, and mutations to unauthenticated visitors.',
        fixSnippet: `// Apollo Server v4 introspection disable:\nconst server = new ApolloServer({\n  typeDefs,\n  resolvers,\n  introspection: process.env.NODE_ENV !== 'production'\n});`
      }
    });
  } else {
    secureControls.push({
      control: 'INTROSPECTION_DISABLED',
      note: 'Schema introspection is securely disabled in production.'
    });
  }

  // 3. Test Query Depth Limits (Recursive nesting)
  const nestedQuery = {
    query: 'query { __schema { queryType { fields { type { ofType { ofType { ofType { ofType { ofType { name } } } } } } } } } }'
  };
  const depthRes = await httpRequest(activeGraphqlEndpoint, nestedQuery);

  if (depthRes.status >= 200 && depthRes.status < 300 && depthRes.body && !depthRes.body.includes('depth') && !depthRes.body.includes('Max query depth')) {
    findings.push({
      severity: 'MEDIUM',
      title: 'Missing GraphQL Maximum Query Depth Limitation',
      cwe: 'CWE-400: Uncontrolled Resource Consumption',
      cvss: 5.3,
      targetUrl: activeGraphqlEndpoint,
      remediation: {
        rootCause: 'GraphQL server accepts arbitrarily deep recursive queries without enforcing depth thresholds.',
        fixSnippet: `// Enforce maximum query depth in Apollo Server:\nimport depthLimit from 'graphql-depth-limit';\nconst server = new ApolloServer({\n  validationRules: [depthLimit(6)]\n});`
      }
    });
  } else {
    secureControls.push({
      control: 'QUERY_DEPTH_ENFORCED',
      note: 'GraphQL server enforces query depth limits.'
    });
  }

  // 4. Test Array-Based Query Batching
  const batchPayload = [
    { query: '{ __typename }' },
    { query: '{ __typename }' },
    { query: '{ __typename }' }
  ];
  const batchRes = await httpRequest(activeGraphqlEndpoint, batchPayload);

  if (Array.isArray(batchRes.body) || (batchRes.body && batchRes.body.startsWith('[') && batchRes.status === 200)) {
    findings.push({
      severity: 'LOW',
      title: 'GraphQL Query Batching Enabled',
      cwe: 'CWE-799: Improper Control of Interaction Frequency',
      cvss: 3.5,
      targetUrl: activeGraphqlEndpoint,
      remediation: {
        rootCause: 'Array-based query batching allows multiple operations per HTTP request, potentially bypassing request rate limits.',
        fixSnippet: `// Disable query batching in Apollo Server / Express:\napp.use('/graphql', (req, res, next) => {\n  if (Array.isArray(req.body)) return res.status(400).json({ error: 'Batching not allowed' });\n  next();\n});`
      }
    });
  } else {
    secureControls.push({
      control: 'QUERY_BATCHING_RESTRICTED',
      note: 'Array-based query batching is restricted.'
    });
  }

  const score = findings.length === 0 ? 100 : Math.max(40, 100 - findings.length * 20);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : 'F';

  return {
    target: activeGraphqlEndpoint,
    timestamp: new Date().toISOString(),
    score,
    grade,
    activeGraphqlDetected: true,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls,
    summary: `Audited GraphQL endpoint ${activeGraphqlEndpoint}. Identified ${findings.length} configuration recommendations.`
  };
}

module.exports = {
  auditGraphqlResilience
};
