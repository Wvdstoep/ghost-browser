'use strict';
/**
 * endpointHarvester.js — Dynamic 3-Layer Target Endpoint Discovery & Classification Engine
 *
 * Layer 1: Static HTML, Manifest & Inline Route Crawler
 * Layer 2: SPA Script & Client Bundle Analyzer (scans Next.js, Vite, Webpack, JS chunks)
 * Layer 3: Cross-Tool Runtime Classification & Context Sharing
 *
 * Categorizes all discovered endpoints into:
 *   - mutationEndpoints: State-changing endpoints (POST/PUT/PATCH/mutation)
 *   - downstreamEndpoints: Views, exports, dashboards, admin tables where injected data reflects
 *   - queryEndpoints: Search, fetch, proxy, parameter-driven query endpoints (SQLi/SSRF)
 *   - authEndpoints: Authenticated user profiles, account, and admin surfaces
 *   - graphqlEndpoints: GraphQL query/mutation gateways
 *   - websocketEndpoints: WebSocket upgrade candidates
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function fetchPage(urlStr, options = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-EndpointHarvester/3.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(options.headers || {})
        },
        timeout: options.timeout || 8000
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 2097152) { // 2MB ceiling per asset
            req.destroy();
            resolve({ status: res.statusCode, headers: res.headers, body });
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', (err) => resolve({ status: 0, headers: {}, body: '', error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '', error: 'timeout' }); });
    } catch (e) {
      resolve({ status: 0, headers: {}, body: '', error: e.message });
    }
  });
}

function classifyEndpoints(routes = []) {
  const mutation = new Set();
  const downstream = new Set();
  const query = new Set();
  const auth = new Set();
  const graphql = new Set();
  const websocket = new Set();

  const mutKeywords = /create|update|edit|save|post|submit|register|login|signup|reset|forgot|mint|settings|profile|account|contact|comment|item|upload|check|delete|setup|confirm|topup|autorecharge|publish|package|action|chat|plan|run|label|upgrade|migrate/i;
  const downKeywords = /profile|account|view|admin|dashboard|export|activity|invoices|history|reports|users|details|workspace|showcase|explore|boardroom|minutes|feed/i;
  const queryKeywords = /search|query|items|apps|machines|channels|tools|find|list|filter|fetch|proxy|preview|vat|check|devices|status|inventory|progress|kubeconfig/i;
  const authKeywords = /me|profile|account|admin|workspace|keys|billing|dashboard|users|byon|wallet|csuite/i;
  const gqlKeywords = /graphql|gql|query|api\/graphql/i;
  const wsKeywords = /ws|websocket|socket\.io|stream|feed|live|chat|events/i;

  for (const r of routes) {
    if (!r || typeof r !== 'string' || !r.startsWith('/')) continue;
    if (r.match(/\.(png|jpg|jpeg|svg|css|ico|woff2?|map)$/i)) continue;

    const clean = r.replace(/\/+$/, '') || '/';
    if (mutKeywords.test(clean)) mutation.add(clean);
    if (downKeywords.test(clean)) downstream.add(clean);
    if (queryKeywords.test(clean)) query.add(clean);
    if (authKeywords.test(clean)) auth.add(clean);
    if (gqlKeywords.test(clean)) graphql.add(clean);
    if (wsKeywords.test(clean)) websocket.add(clean);
  }

  return {
    mutationEndpoints: Array.from(mutation),
    downstreamEndpoints: Array.from(downstream),
    queryEndpoints: Array.from(query),
    authEndpoints: Array.from(auth),
    graphqlEndpoints: Array.from(graphql),
    websocketEndpoints: Array.from(websocket),
    allEndpoints: Array.from(new Set(routes.map(r => r.replace(/\/+$/, '') || '/')))
  };
}

async function harvestTargetEndpoints(targetUrl, options = {}) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  let u = null;
  try { u = new URL(base); } catch (_) { return classifyEndpoints([]); }

  const routes = new Set();
  const scriptUrls = new Set();

  // ── LAYER 1: Root HTML & Document Metadata Crawler ──
  const rootRes = await fetchPage(u.origin + '/', options);
  const html = rootRes.body || '';

  // Extract HTML anchor links
  const linkRegex = /href=["'](\/[^"'>\s#?]+)/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const link = m[1];
    if (link && !link.startsWith('//') && !link.match(/\.(png|jpg|jpeg|svg|css|ico|woff2?)$/i)) {
      routes.add(link);
    }
  }

  // Extract Form actions
  const formRegex = /<form\b[^>]*action=["']([^"']+)["']/gi;
  while ((m = formRegex.exec(html)) !== null) {
    if (m[1].startsWith('/')) routes.add(m[1].split('?')[0]);
  }

  // Extract inline API patterns from HTML
  const apiRegex = /["'](\/(?:api|v[0-9]+)\/[a-zA-Z0-9_\-\/]+)["']/g;
  while ((m = apiRegex.exec(html)) !== null) {
    routes.add(m[1]);
  }

  // Extract script tags (Layer 2 targets)
  const scriptRegex = /<script\b[^>]*src=["']([^"']+)["']/gi;
  while ((m = scriptRegex.exec(html)) !== null) {
    const src = m[1];
    if (src.startsWith('/') && !src.startsWith('//') && !src.match(/jquery|google-analytics|gtag/i)) {
      scriptUrls.add(src);
    }
  }

  // ── LAYER 2: SPA Script & Client Bundle Analysis ──
  // Concurrently fetch up to 8 client bundles/scripts
  const scriptList = Array.from(scriptUrls).slice(0, 8);
  if (scriptList.length > 0) {
    await Promise.all(scriptList.map(async (scriptPath) => {
      try {
        const fullScriptUrl = new URL(scriptPath, u.origin).toString();
        const scriptRes = await fetchPage(fullScriptUrl, { timeout: 6000 });
        const scriptBody = scriptRes.body || '';
        if (scriptBody) {
          let sm;
          const sApiRegex = /["'](\/(?:api|v[0-9]+)\/[a-zA-Z0-9_\-\/]+)["']/g;
          while ((sm = sApiRegex.exec(scriptBody)) !== null) {
            routes.add(sm[1]);
          }
          // Also look for common GraphQL paths
          if (scriptBody.includes('/graphql') || scriptBody.includes('/api/graphql')) {
            routes.add('/api/graphql');
            routes.add('/graphql');
          }
        }
      } catch (_) {
        // Non-blocking asset fetch error
      }
    }));
  }

  // Common fallbacks if target is completely blank SPA
  if (routes.size === 0) {
    routes.add('/api/login');
    routes.add('/api/user/profile');
    routes.add('/api/settings');
    routes.add('/api/comment');
  }

  return classifyEndpoints(Array.from(routes));
}

module.exports = {
  fetchPage,
  classifyEndpoints,
  harvestTargetEndpoints
};
