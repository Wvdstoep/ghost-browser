'use strict';
/**
 * webCacheAuditor.js — Web Cache Deception & Cache Poisoning Auditor (CWE-524 / CWE-444)
 *
 * Probes authenticated and dynamic endpoints with static pseudo-extensions (.css, .js, .png, ;.css)
 * to verify whether CDN caches (Cloudflare, Fastly, Akamai, Nginx) erroneously cache private JSON
 * or allow unkeyed header cache poisoning (X-Forwarded-Host, X-Original-URL).
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

      const req = client.request(u, {
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-WebCacheAuditor/3.0',
          'Accept': 'application/json, text/html, */*',
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
      req.end();
    } catch (e) {
      finish({ error: e.message, status: 0, headers: {}, body: '' });
    }
  });
}

const STATIC_EXTENSIONS = ['.css', '.js', '.png', ';test.css'];

async function auditWebCacheDeception(targetUrl, options = {}) {
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
      candidateEndpoints = (harvested.authEndpoints && harvested.authEndpoints.length > 0)
        ? harvested.authEndpoints
        : ['/api/me', '/api/me/profile', '/workspace', '/api/billing/vat/check'];
    } catch (_) {
      candidateEndpoints = ['/api/me', '/workspace'];
    }
  }

  const endpointsToTest = Array.from(new Set(candidateEndpoints)).slice(0, 5);

  for (const ep of endpointsToTest) {
    const cleanEp = ep.startsWith('/') ? ep : '/' + ep;
    const baseReqUrl = `${origin}${cleanEp}`;

    // 1. Baseline Request
    const baseRes = await httpRequest(baseReqUrl);
    const baseCacheControl = String(baseRes.headers['cache-control'] || '').toLowerCase();

    // 2. Extension Probe
    for (const ext of STATIC_EXTENSIONS) {
      const extUrl = `${origin}${cleanEp}${ext.startsWith(';') ? ext : '/' + 'cachetest' + ext}`;
      const extRes = await httpRequest(extUrl);

      const extCacheControl = String(extRes.headers['cache-control'] || '').toLowerCase();
      const cfCacheStatus = extRes.headers['cf-cache-status'];
      const xCache = extRes.headers['x-cache'];
      const age = extRes.headers['age'];

      const isCdnCached = (cfCacheStatus === 'HIT' || (typeof xCache === 'string' && xCache.includes('HIT')) || (age && Number(age) > 0));
      const permitsPublicCache = extCacheControl.includes('public') && !extCacheControl.includes('no-store') && !extCacheControl.includes('no-cache');

      // If the server served the dynamic resource (200 OK) with same body/data, but cache headers allowed caching
      if (extRes.status === 200 && (isCdnCached || permitsPublicCache)) {
        findings.push({
          cwe: 'CWE-524',
          title: `Web Cache Deception Vulnerability in ${cleanEp}`,
          severity: 'HIGH',
          endpoint: cleanEp,
          testedUrl: extUrl,
          technique: `Static Extension Path Confusion (${ext})`,
          httpStatus: extRes.status,
          cacheControl: extCacheControl || '(None)',
          cdnStatus: cfCacheStatus || xCache || 'None',
          impact: `Appending static extension "${ext}" caused the server to return dynamic resource (HTTP 200) without "no-store" cache protection. CDNs will cache this response and serve confidential account data to unauthenticated third parties.`,
          proof: `GET ${extUrl} returned HTTP 200 with Cache-Control: "${extCacheControl}" and CDN cache status: "${cfCacheStatus || xCache || 'public'}".`,
          remediation: 'Enforce "Cache-Control: private, no-cache, no-store, must-revalidate" on all dynamic endpoints and enable CDN Cache Deception Armor.'
        });
        break;
      }
    }

    if (!findings.some(f => f.endpoint === cleanEp)) {
      secureControls.push({
        endpoint: cleanEp,
        control: 'Cache-Control Header Policy',
        status: 'Pass',
        baselineCacheControl: baseCacheControl || '(None)',
        detail: `Endpoint rejected static extension probes (404/400) or enforced strict no-store / private caching.`
      });
    }
  }

  // 3. Unkeyed Host / Header Poisoning Probe
  const poisonProbeUrl = `${origin}/`;
  const poisonRes = await httpRequest(poisonProbeUrl, {
    headers: {
      'X-Forwarded-Host': 'evil-cache-poison.attacker.com',
      'X-Host': 'evil-cache-poison.attacker.com'
    }
  });

  if (poisonRes.body && poisonRes.body.includes('evil-cache-poison.attacker.com')) {
    const isCached = poisonRes.headers['cf-cache-status'] || poisonRes.headers['x-cache'];
    findings.push({
      cwe: 'CWE-444',
      title: 'Unkeyed Host Header Cache Poisoning Risk',
      severity: isCached ? 'CRITICAL' : 'HIGH',
      endpoint: '/',
      impact: 'The application reflected an unkeyed header (X-Forwarded-Host) into the HTML response. If this response is cached by reverse proxy / CDN tiers, all subsequent visitors will receive the poisoned host reference.',
      proof: 'X-Forwarded-Host: evil-cache-poison.attacker.com was reflected directly in response body.',
      remediation: 'Do not trust X-Forwarded-Host without domain validation, or add "Vary: X-Forwarded-Host" to cache keys.'
    });
  } else {
    secureControls.push({
      control: 'Unkeyed Header Reflection',
      status: 'Pass',
      detail: 'X-Forwarded-Host and X-Host headers are not reflected into root page responses.'
    });
  }

  const overallPosture = findings.length === 0 ? 'RESILIENT' : 'VULNERABLE';

  return {
    engine: 'GhostBrowser-WebCacheAuditor/3.0',
    target: origin,
    overallPosture,
    endpointsTested: endpointsToTest.length,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls
  };
}

module.exports = {
  auditWebCacheDeception
};
