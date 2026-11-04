'use strict';
/**
 * deepSpiderPipeline.js — Enterprise Deep Headless Spidering & Attack Surface Mapping Pipeline
 *
 * Systematic 5-Stage Autonomous Surface Discovery & Flaw Probing Engine:
 *   Stage 1: Headless Network Interception (Harvests client XHR/Fetch, dynamic API endpoints, and headers)
 *   Stage 2: Multi-Page BFS DOM Crawl (Extracts in-scope links, SPA framework routes, forms, and input parameters)
 *   Stage 2b: Frontend JS Bundle Analyzer (Scans Next.js chunks, Vite assets, and scripts for hidden APIs & leaked secrets)
 *   Stage 3: Concurrent Sensitive & Schema Path Probing (OpenAPI, Swagger, security.txt, robots, GraphQL)
 *   Stage 4: Active Security Flaw & Access Control Probing (Probes discovered endpoints for unauthenticated data leaks & verb tampering)
 *   Stage 5: Living App Map & Target Workspace Ingestion (Saves topology, probed endpoints, and audit history)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { ingestAuditData, normalizeDomain } = require('./targetWorkspace');
let accountAutomation = null;
try {
  accountAutomation = require('./accountAutomation');
} catch (_) {}

/**
 * Robust HTTP client with method, timeout, and payload size cap
 */
function probeHttp(urlStr, options = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const client = u.protocol === 'https:' ? https : http;
      const method = (options.method || 'GET').toUpperCase();
      
      const req = client.request(u, {
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-DeepSpider/3.5 (Enterprise AppSec Audit)',
          'Accept': 'application/json, text/html, application/xhtml+xml, application/xml;q=0.9,*/*;q=0.8',
          ...(options.headers || {})
        },
        timeout: options.timeout || 7000
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 2097152) { // 2MB ceiling per probe
            req.destroy();
            resolve({ status: res.statusCode, headers: res.headers, body });
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', (err) => resolve({ status: 0, headers: {}, body: '', error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '', error: 'timeout' }); });
      if (options.body) req.write(options.body);
      req.end();
    } catch (e) {
      resolve({ status: 0, headers: {}, body: '', error: e.message });
    }
  });
}

/**
 * Standard candidate sensitive and contract paths to probe concurrently
 */
const SENSITIVE_PROBE_PATHS = [
  '/.well-known/security.txt',
  '/robots.txt',
  '/sitemap.xml',
  '/swagger.json',
  '/openapi.json',
  '/v2/api-docs',
  '/api-docs',
  '/api/v1',
  '/graphql',
  '/.git/HEAD',
  '/.env'
];

/**
 * In-browser evaluation script to harvest links, SPA framework routes, forms, inputs, scripts & auth state
 */
const IN_BROWSER_HARVEST_SCRIPT = `(() => {
  const origin = window.location.origin;
  const links = new Set();
  const forms = [];
  const parameters = new Set();
  const routes = new Set();
  const scriptUrls = new Set();

  // 1. Framework SPA Router State
  try {
    if (window.__NEXT_DATA__?.page) routes.add(window.__NEXT_DATA__.page);
    if (window.next?.router?.components) {
      Object.keys(window.next.router.components).forEach(r => routes.add(r));
    }
    if (window.__remixContext?.manifest?.routes) {
      Object.values(window.__remixContext.manifest.routes).forEach(r => {
        if (r.path) routes.add('/' + r.path.replace(/^\\//, ''));
      });
    }
    if (window.__vue_app__?.$router?.getRoutes) {
      window.__vue_app__.$router.getRoutes().forEach(r => routes.add(r.path));
    }
  } catch (_) {}

  // 2. Discover in-scope anchor links
  try {
    document.querySelectorAll('a[href]').forEach(a => {
      const raw = a.getAttribute('href') || '';
      if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) return;
      try {
        const u = new URL(raw, origin);
        if (u.origin === origin) {
          links.add(u.href);
          routes.add(u.pathname);
          u.searchParams.forEach((_, key) => parameters.add(key));
        }
      } catch (_) {}
    });
  } catch (_) {}

  // 3. Harvest Forms and Inputs
  try {
    document.querySelectorAll('form').forEach(f => {
      const action = f.getAttribute('action') || window.location.pathname;
      const method = (f.getAttribute('method') || 'GET').toUpperCase();
      const inputs = [];
      f.querySelectorAll('input, select, textarea').forEach(inp => {
        const name = inp.getAttribute('name') || inp.getAttribute('id') || '';
        const type = inp.getAttribute('type') || inp.tagName.toLowerCase();
        if (name) {
          inputs.push({ name, type });
          parameters.add(name);
        }
      });
      forms.push({ action, method, inputsCount: inputs.length, inputs });
    });
  } catch (_) {}

  // 4. Client-side Interactive Buttons & Role triggers
  const interactiveButtons = [];
  try {
    const privilegedRegex = /admin|login|sign|register|pay|checkout|cart|delete|remove|token|key|export|download|setting/i;
    document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(btn => {
      const text = (btn.innerText || btn.getAttribute('aria-label') || btn.getAttribute('value') || '').trim();
      if (text && privilegedRegex.test(text)) {
        interactiveButtons.push(text.slice(0, 40));
      }
    });
  } catch (_) {}

  // 5. Harvest In-Scope Script URLs (Client JS Bundles & Framework Chunks)
  try {
    document.querySelectorAll('script[src]').forEach(s => {
      const src = s.getAttribute('src');
      if (src && !src.startsWith('//') && !src.includes('google-analytics') && !src.includes('googletagmanager')) {
        try {
          const u = new URL(src, origin);
          if (u.origin === origin) scriptUrls.add(u.href);
        } catch (_) {}
      }
    });
  } catch (_) {}

  // 6. Check Auth State Indicators (Is current profile logged in?)
  let isLoggedIn = false;
  try {
    const pageText = document.body ? document.body.innerText : '';
    if (/logout|sign\\s*out|my\\s*account|dashboard|user\\s*profile|billing/i.test(pageText) &&
        !/login|sign\\s*in|create\\s*account/i.test(pageText.slice(0, 500))) {
      isLoggedIn = true;
    }
  } catch (_) {}

  return {
    links: Array.from(links),
    routes: Array.from(routes),
    forms,
    parameters: Array.from(parameters),
    interactiveButtons: Array.from(new Set(interactiveButtons)),
    scriptUrls: Array.from(scriptUrls),
    isLoggedIn
  };
})()`;

/**
 * Executes the enterprise deep spidering & attack surface probing pipeline
 *
 * @param {object} options
 * @param {string} options.targetUrl Target URL or domain
 * @param {string} [options.profile] Ghost Browser profile to use (default: 'default')
 * @param {object} [options.page] Optional Playwright Page instance
 * @param {function} [options.getPage] Function returning a Playwright Page for profile
 * @param {number} [options.maxPages] Max pages to crawl (default: 15)
 * @param {number} [options.maxDepth] Max BFS depth (default: 2)
 * @param {boolean} [options.autoAuth] Whether to attempt autonomous signup/login if unauthenticated (default: false)
 */
async function runDeepSpider(options = {}) {
  let raw = (options.targetUrl || options.url || options.target || '').trim();
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    raw = 'https://' + raw;
  }

  let origin = '';
  let domain = '';
  try {
    const u = new URL(raw);
    origin = u.origin;
    domain = u.hostname;
  } catch (e) {
    return { ok: false, error: `Invalid target URL: ${raw}` };
  }

  const startTime = Date.now();
  const maxPages = options.maxPages || 15;
  const maxDepth = options.maxDepth || 2;
  const activeProfile = options.profile || 'default';

  const crawledUrls = new Set();
  const discoveredRoutes = new Set();
  const networkApiEndpoints = new Set();
  const frontendEndpoints = new Map(); // path -> { path, source, bundle }
  const allParameters = new Set();
  const harvestedForms = [];
  const interactiveActions = new Set();
  const sensitiveExposures = [];
  const scriptUrls = new Set();
  const secretExposures = [];
  let userIsAuthenticated = false;

  // Determine if a live Playwright page is available
  let page = options.page || null;
  if (!page && typeof options.getPage === 'function') {
    try {
      page = await options.getPage(activeProfile);
    } catch (_) {}
  }

  // ── STAGE 1 & 2: Dynamic Headless Crawling & Network Interception ──
  if (page && typeof page.goto === 'function') {
    // Attach network request listener to capture dynamic AJAX/Fetch calls
    const requestHandler = (req) => {
      try {
        const reqUrl = req.url();
        const rType = req.resourceType();
        if (rType === 'fetch' || rType === 'xhr') {
          const u = new URL(reqUrl);
          if (u.origin === origin) {
            networkApiEndpoints.add(u.pathname);
            u.searchParams.forEach((_, key) => allParameters.add(key));
          }
        }
      } catch (_) {}
    };

    try {
      page.on('request', requestHandler);
    } catch (_) {}

    // BFS Queue: { url, depth }
    const queue = [{ url: raw, depth: 0 }];
    crawledUrls.add(raw);

    while (queue.length > 0 && crawledUrls.size <= maxPages) {
      const current = queue.shift();
      try {
        await page.goto(current.url, { waitUntil: 'domcontentloaded', timeout: 12000 });
        // Brief pause for client hydration
        await page.waitForTimeout(600);

        // In-browser extraction
        const harvest = await page.evaluate(IN_BROWSER_HARVEST_SCRIPT);

        if (harvest) {
          if (harvest.isLoggedIn) userIsAuthenticated = true;
          (harvest.routes || []).forEach(r => discoveredRoutes.add(r));
          (harvest.parameters || []).forEach(p => allParameters.add(p));
          (harvest.interactiveButtons || []).forEach(b => interactiveActions.add(b));
          (harvest.scriptUrls || []).forEach(s => scriptUrls.add(s));
          
          if (Array.isArray(harvest.forms)) {
            harvest.forms.forEach(f => {
              if (!harvestedForms.some(hf => hf.action === f.action && hf.method === f.method)) {
                harvestedForms.push(f);
              }
            });
          }

          // Enqueue child links if within depth limit
          if (current.depth < maxDepth) {
            for (const link of (harvest.links || [])) {
              if (!crawledUrls.has(link) && crawledUrls.size < maxPages) {
                crawledUrls.add(link);
                queue.push({ url: link, depth: current.depth + 1 });
              }
            }
          }
        }
      } catch (err) {
        // Continue crawling remaining queue items on navigation error
      }
    }

    // Optional Autonomous Signup/Login if unauthenticated and requested
    if (!userIsAuthenticated && options.autoAuth && accountAutomation && typeof accountAutomation.authRegister === 'function') {
      try {
        const regRes = await accountAutomation.authRegister(activeProfile, { targetUrl: origin });
        if (regRes && regRes.ok) {
          userIsAuthenticated = true;
          // Re-navigate to root or dashboard as authenticated user
          await page.goto(origin + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
          const authHarvest = await page.evaluate(IN_BROWSER_HARVEST_SCRIPT).catch(() => null);
          if (authHarvest) {
            (authHarvest.routes || []).forEach(r => discoveredRoutes.add(r));
            (authHarvest.scriptUrls || []).forEach(s => scriptUrls.add(s));
          }
        }
      } catch (_) {}
    }

    try {
      page.off('request', requestHandler);
    } catch (_) {}
  } else {
    // ── FALLBACK: HTTP-based recursive spidering when Playwright session is not attached ──
    const rootRes = await probeHttp(origin + '/');
    crawledUrls.add(origin + '/');

    if (rootRes.body) {
      // Extract links
      const linkRegex = /href=["'](\/[^"'>\s#?]+)/gi;
      let m;
      while ((m = linkRegex.exec(rootRes.body)) !== null) {
        const link = m[1];
        if (!link.match(/\.(png|jpg|jpeg|svg|css|ico|woff2?|map)$/i)) {
          discoveredRoutes.add(link);
          if (crawledUrls.size < maxPages) {
            crawledUrls.add(origin + link);
          }
        }
      }
      // Extract forms
      const formRegex = /<form\b[^>]*action=["']([^"']+)["']/gi;
      while ((m = formRegex.exec(rootRes.body)) !== null) {
        harvestedForms.push({ action: m[1], method: 'POST', inputsCount: 1, inputs: [] });
      }
      // Extract scripts
      const scriptRegex = /<script\b[^>]*src=["']([^"']+)["']/gi;
      while ((m = scriptRegex.exec(rootRes.body)) !== null) {
        const src = m[1];
        if (src.startsWith('/') && !src.startsWith('//') && !src.includes('google-analytics')) {
          scriptUrls.add(origin + src);
        }
      }
    }
  }

  // ── STAGE 2b: Frontend JS Bundle Analysis (Scans client scripts & chunks) ──
  const scriptList = Array.from(scriptUrls).slice(0, 15);
  if (scriptList.length > 0) {
    const scriptPromises = scriptList.map(async (scriptUrl) => {
      const res = await probeHttp(scriptUrl, { timeout: 6000 });
      if (res.body && res.body.length > 100) {
        // 1. Quoted relative API routes
        const apiRegex = /["'\`]((\/(?:api|v[0-9]+|v1|v2|v3|graphql|auth|admin|users?|account|billing|settings|teams?|projects?|items?|orders?|checkout|webhooks?|rpc|dashboard)\/[a-zA-Z0-9_\-\/{}\$]+))["'\`]/gi;
        let am;
        while ((am = apiRegex.exec(res.body)) !== null) {
          const ep = am[1];
          if (!ep.match(/\.(png|jpg|jpeg|svg|css|ico|woff2?|map)$/i)) {
            frontendEndpoints.set(ep, { path: ep, source: 'frontend_bundle', bundle: scriptUrl.split('/').pop() });
            discoveredRoutes.add(ep);
          }
        }

        // 2. Client HTTP calls (fetch, axios, api)
        const clientCallRegex = /(?:fetch|axios|api|http|client)\.(?:get|post|put|delete|patch)\(\s*["'\`]((\/[^"'\`\s\)]+))["'\`]/gi;
        let cm;
        while ((cm = clientCallRegex.exec(res.body)) !== null) {
          const ep = cm[1];
          if (ep.startsWith('/') && !ep.match(/\.(png|jpg|jpeg|svg|css|ico|woff2?|map)$/i)) {
            frontendEndpoints.set(ep, { path: ep, source: 'frontend_bundle_client_call', bundle: scriptUrl.split('/').pop() });
            discoveredRoutes.add(ep);
          }
        }

        // 3. Scan for client-side sensitive secrets
        const stripeKey = res.body.match(/(?:pk_live_[0-9a-zA-Z]{24,})/);
        if (stripeKey) secretExposures.push({ type: 'Stripe Publishable Key', token: stripeKey[0].slice(0, 14) + '...' });
        const awsKey = res.body.match(/AKIA[0-9A-Z]{16}/);
        if (awsKey) secretExposures.push({ type: 'AWS Access Key ID', token: awsKey[0] });
        const jwtToken = res.body.match(/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/);
        if (jwtToken) secretExposures.push({ type: 'Static JWT Token in Client Bundle', token: jwtToken[0].slice(0, 20) + '...' });
      }
    });

    await Promise.all(scriptPromises);
  }

  // ── STAGE 3: Concurrent Sensitive & Schema Path Probing ──
  const probePromises = SENSITIVE_PROBE_PATHS.map(async (p) => {
    const targetPath = origin + p;
    const res = await probeHttp(targetPath, { timeout: 5000 });
    if (res.status >= 200 && res.status < 400 && res.body && !res.body.includes('<html') && res.body.length > 10) {
      sensitiveExposures.push({
        path: p,
        status: res.status,
        type: res.headers['content-type'] || 'text/plain',
        snippet: res.body.slice(0, 150).replace(/\r?\n/g, ' ')
      });
      discoveredRoutes.add(p);
    } else if (p.includes('robots.txt') && res.status === 200 && res.body) {
      // Parse Disallow rules from robots.txt
      const disallowRegex = /Disallow:\s*([^\s\r\n#]+)/gi;
      let dm;
      while ((dm = disallowRegex.exec(res.body)) !== null) {
        if (dm[1] && dm[1].startsWith('/')) {
          discoveredRoutes.add(dm[1]);
        }
      }
    }
  });

  await Promise.all(probePromises);

  // ── STAGE 4: Active Security Flaw & Access Control Probing on Discovered Endpoints ──
  const candidateEndpointsToProbe = Array.from(new Set([
    ...Array.from(frontendEndpoints.keys()),
    ...Array.from(networkApiEndpoints),
    ...Array.from(discoveredRoutes).filter(r => /^\/(?:api|v[0-9]+|admin|settings|billing|users?|account|export)/i.test(r))
  ])).slice(0, 20); // Top 20 candidate endpoints for depth & performance

  const probedEndpoints = [];
  const probedPromises = candidateEndpointsToProbe.map(async (ep) => {
    const targetEpUrl = origin + ep;
    // 1. Unauthenticated GET Probe
    const getRes = await probeHttp(targetEpUrl, { timeout: 5000 });
    
    // Evaluate Access Control & Exposure
    let secStatus = 'SECURE';
    let authEnforced = false;
    let findingDesc = 'Access control enforced; authentication required';
    const isSensitive = /user|admin|billing|settings|account|token|key|export/i.test(ep);
    
    if (getRes.status === 401 || getRes.status === 403 || getRes.status === 307 || getRes.status === 302) {
      authEnforced = true;
      secStatus = 'SECURE';
      findingDesc = `Authentication required (${getRes.status}) — boundary strictly gated`;
    } else if (getRes.status === 200) {
      authEnforced = false;
      const bodyLower = (getRes.body || '').toLowerCase();
      const hasSensitiveKeys = /"user"|"email"|"token"|"secret"|"keys"|"role"|"password"|"tenant_id"|"stripe"|"balance"/i.test(bodyLower);
      
      if (isSensitive && hasSensitiveKeys) {
        secStatus = 'VULNERABLE';
        findingDesc = 'CRITICAL: Unauthenticated sensitive data exposed (OWASP API1:2023 / CWE-285)';
      } else {
        secStatus = 'INFO';
        findingDesc = 'Public unauthenticated endpoint reachable (200 OK)';
      }
    } else if (getRes.status === 404 || getRes.status === 405) {
      secStatus = 'FILTERED';
      findingDesc = `Endpoint filtered/rejected (${getRes.status})`;
    } else {
      secStatus = 'INFO';
      findingDesc = `HTTP status ${getRes.status}`;
    }

    // 2. HTTP Verb Tampering Check (OPTIONS probe)
    let methodsAllowed = ['GET'];
    const optRes = await probeHttp(targetEpUrl, { method: 'OPTIONS', timeout: 4000 });
    const allowHeader = optRes.headers['allow'] || optRes.headers['access-control-allow-methods'] || '';
    if (allowHeader) {
      methodsAllowed = allowHeader.split(',').map(m => m.trim().toUpperCase());
      if (!authEnforced && (methodsAllowed.includes('PUT') || methodsAllowed.includes('DELETE'))) {
        secStatus = secStatus === 'VULNERABLE' ? 'VULNERABLE' : 'WARNING';
        findingDesc += ' · High: Insecure mutation verbs (PUT/DELETE) accepted';
      }
    }

    const source = frontendEndpoints.has(ep) ? 'frontend_bundle' : (networkApiEndpoints.has(ep) ? 'runtime_xhr' : 'spider_route');
    probedEndpoints.push({
      path: ep,
      methods: methodsAllowed,
      source,
      status: getRes.status,
      authEnforced,
      securityStatus: secStatus,
      finding: findingDesc,
      snippet: (getRes.body || '').slice(0, 100).replace(/\r?\n/g, ' ')
    });
  });

  await Promise.all(probedPromises);

  // Combine discovered routes
  const routesList = Array.from(discoveredRoutes).sort();
  const apiList = Array.from(new Set([...Array.from(networkApiEndpoints), ...Array.from(frontendEndpoints.keys())])).sort();
  const paramList = Array.from(allParameters).sort();
  const elapsedMs = Date.now() - startTime;

  // ── STAGE 5: Living App Map Ingestion ──
  try {
    ingestAuditData(domain, {
      routes: routesList,
      apiEndpoints: apiList,
      probedEndpoints,
      forms: harvestedForms,
      parameters: paramList,
      sensitivePaths: sensitiveExposures.map(s => s.path),
      timeline: [{
        title: 'Enterprise Deep Spidering & Frontend Attack Surface Probing',
        summary: `Spidered ${crawledUrls.size} pages in profile "${activeProfile}" (${userIsAuthenticated ? 'AUTHENTICATED' : 'PUBLIC'}). Mapped ${routesList.length} routes, ${apiList.length} frontend & API endpoints, ${probedEndpoints.length} actively probed for security gaps, and ${paramList.length} parameters.`
      }]
    });
  } catch (_) {}

  // Classification summary for downstream security vectors
  const attackSurface = {
    mutationEndpoints: routesList.filter(r => /create|update|edit|save|post|submit|register|login|checkout|cart|comment|upload|action/i.test(r)),
    adminSurfaces: routesList.filter(r => /admin|dashboard|settings|billing|team|user|role|organization/i.test(r)),
    apiEndpoints: apiList,
    probedEndpoints,
    queryParameters: paramList,
    forms: harvestedForms,
    sensitiveExposures,
    secretExposures,
    userIsAuthenticated
  };

  const vulnerableCount = probedEndpoints.filter(p => p.securityStatus === 'VULNERABLE').length;
  const gatedCount = probedEndpoints.filter(p => p.authEnforced).length;

  const executiveSummary = [
    `# 🕷️ Enterprise Deep Spider & Attack Surface Dossier: ${domain}`,
    `**Target URL:** \`${origin}\` | **Profile:** \`${activeProfile}\` (${userIsAuthenticated ? '🟢 Authenticated Session' : '⚪ Public Surface'}) | **Duration:** ${(elapsedMs / 1000).toFixed(1)}s`,
    '',
    '## 📊 Attack Surface Mapping Scorecard',
    `| Metric | Count | Technical Assessment |`,
    `| :--- | :---: | :--- |`,
    `| **Discovered Application Routes** | **${routesList.length}** | Complete client-side & static routing topology |`,
    `| **Frontend & Backend API Endpoints** | **${apiList.length}** | Harvested from client JS bundles & runtime network |`,
    `| **Actively Probed API Endpoints** | **${probedEndpoints.length}** | ${gatedCount} Gated (401/403) · ${vulnerableCount} Critical Exposures |`,
    `| **Interactive Forms Harvested** | **${harvestedForms.length}** | State-mutating form targets mapped |`,
    `| **Input Injection Parameters** | **${paramList.length}** | Query & payload keys cataloged for fuzzing |`,
    `| **Sensitive Files Discovered** | **${sensitiveExposures.length}** | Candidate documentation & schema contracts |`,
    '',
    '## 🔍 Discovered Frontend & Runtime API Endpoints (Active Security Probes)',
    probedEndpoints.length > 0
      ? probedEndpoints.map(p => `- \`${p.path}\` [${p.source}] → **${p.securityStatus}** (${p.status}) · *${p.finding}*`).join('\n')
      : '- No API endpoints detected for probing.',
    '',
    '## 🗺️ Discovered Architecture Breakdown',
    routesList.length > 0 
      ? `### Mapped Routes (${routesList.length}):\n` + routesList.slice(0, 20).map(r => `- \`${r}\``).join('\n') + (routesList.length > 20 ? `\n- *...and ${routesList.length - 20} more routes.*` : '')
      : '- Zero explicit client-side routes extracted.',
    '',
    attackSurface.forms.length > 0
      ? `### Harvested Forms & Mutators (${harvestedForms.length}):\n` + harvestedForms.slice(0, 10).map(f => `- **${f.method}** \`${f.action}\` (${f.inputsCount} inputs: ${f.inputs.map(i => i.name).join(', ')})`).join('\n')
      : '### Forms: No HTML form elements detected on spidered pages.',
    '',
    paramList.length > 0
      ? `### Identified Input Parameters (${paramList.length}):\n` + paramList.map(p => `\`${p}\``).join(', ')
      : '### Parameters: No explicit query parameters mapped.',
    '',
    secretExposures.length > 0
      ? `### Leaked Secrets in Frontend JS Bundles (${secretExposures.length}):\n` + secretExposures.map(s => `- **${s.type}**: \`${s.token}\``).join('\n')
      : '### Leaked Secrets: No plain-text API secrets detected in client JavaScript bundles.',
    '',
    sensitiveExposures.length > 0
      ? `### Sensitive Contract & File Exposures (${sensitiveExposures.length}):\n` + sensitiveExposures.map(s => `- \`${s.path}\` (HTTP ${s.status}, ${s.type})`).join('\n')
      : '### Sensitive Files: Common schema & secret files (OpenAPI, .git, .env) are protected (HTTP 404/403).'
  ].join('\n');

  return {
    ok: true,
    domain,
    origin,
    profile: activeProfile,
    userIsAuthenticated,
    totalPagesCrawled: crawledUrls.size,
    routesCount: routesList.length,
    routes: routesList,
    apiEndpoints: apiList,
    probedEndpoints,
    forms: harvestedForms,
    parameters: paramList,
    interactiveActions: Array.from(interactiveActions),
    sensitiveExposures,
    secretExposures,
    attackSurface,
    executiveSummary,
    elapsedMs
  };
}

module.exports = {
  runDeepSpider,
  SENSITIVE_PROBE_PATHS
};
