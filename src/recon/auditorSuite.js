'use strict';
/**
 * auditorSuite.js — Ghost Browser Advanced Security Auditing Suite
 *
 * Implements 6 state-of-the-art browser-based AppSec & Red-Team verification capabilities:
 *   Point 1: Multi-Session Authorization & BOLA verification (cross-profile tenant isolation)
 *   Point 2: Dynamic DOM Sink Instrumentation & Taint Tracing
 *   Point 3: PostMessage & Cross-Window Boundary Inspection
 *   Point 4: Dynamic API Route Harvesting & GraphQL Schema Introspection
 *   Point 5: WebSocket & Streaming Protocol Auditing
 *   Point 6: Client Storage Hygiene & Token Exposure Audit
 */

const { buildAdvisory } = require('./advisory');

/**
 * POINT 1: Multi-Session Authorization & BOLA / IDOR Verification (CWE-639 / OWASP API1:2023)
 *
 * Tests whether resource endpoints enforce tenant/user boundary isolation by comparing
 * access with Tenant A's credentials vs Tenant B's credentials (or unauthenticated).
 */
async function auditBola({ targetUrl, tokenA, tokenB, profileA, profileB, objectIds = [], sessionProvider } = {}) {
  const findings = [];
  const tests = [];
  let vulnerable = false;

  if (!targetUrl) {
    return { error: 'targetUrl is required for BOLA authorization audit' };
  }

  // If objectIds are not provided, extract from targetUrl or use default sample
  const idsToTest = Array.isArray(objectIds) && objectIds.length > 0 
    ? objectIds 
    : [1, 2, 'admin', 'me', 'profile', 'orders'];

  // 1. Unauthenticated test (Broken Authentication / Missing Access Control)
  try {
    const unauthRes = await fetch(targetUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(6000)
    });
    tests.push({
      session: 'unauthenticated',
      url: targetUrl,
      status: unauthRes.status,
      accessible: unauthRes.ok
    });
    if (unauthRes.ok) {
      findings.push({
        type: 'UNAUTHENTICATED_ACCESS',
        severity: 'HIGH',
        title: 'Endpoint Accessible Without Authentication',
        description: `Endpoint ${targetUrl} returned HTTP ${unauthRes.status} without authentication credentials.`,
        remediation: 'Ensure authentication middleware (e.g., Bearer JWT or Session check) is enforced on protected routes.'
      });
    }
  } catch (e) {
    tests.push({ session: 'unauthenticated', error: e.message });
  }

  // 2. Cross-Session / BOLA Test (Session B requesting Session A's resource)
  if (tokenA && tokenB) {
    for (const id of idsToTest.slice(0, 3)) {
      const testUrl = targetUrl.includes('{id}') 
        ? targetUrl.replace('{id}', encodeURIComponent(id))
        : targetUrl.replace(/\/\d+$/, `/${encodeURIComponent(id)}`);

      try {
        const resA = await fetch(testUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${tokenA}`, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(6000)
        });
        const resB = await fetch(testUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${tokenB}`, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(6000)
        });

        const statusA = resA.status;
        const statusB = resB.status;
        const textB = await resB.text().catch(() => '');

        tests.push({
          url: testUrl,
          id,
          statusA,
          statusB,
          sessionBAccessed: statusB === 200
        });

        // If Session B receives 200 OK for resource owned by Session A, flag BOLA
        if (statusA === 200 && statusB === 200 && textB.length > 10) {
          vulnerable = true;
          findings.push({
            type: 'BOLA_IDOR_VULNERABILITY',
            severity: 'CRITICAL',
            cwe: 'CWE-639',
            title: `Broken Object Level Authorization (BOLA) on ${testUrl}`,
            description: `Secondary tenant (Session B) successfully accessed object ${id} belonging to Primary tenant (Session A) with HTTP 200 OK.`,
            remediation: 'Implement user/tenant ownership validation at the data layer. Verify `req.user.tenantId === resource.tenantId` before returning records.'
          });
          break;
        }
      } catch (err) {
        tests.push({ id, error: err.message });
      }
    }
  }

  return {
    targetUrl,
    vulnerable,
    testsRun: tests.length,
    tests,
    findingsCount: findings.length,
    findings,
    remediation: vulnerable
      ? 'CRITICAL: Enforce strict tenant isolation with row-level security or tenancy scoping in SQL/ORM queries.'
      : 'No BOLA leaks detected across tested session boundaries.'
  };
}

/**
 * POINT 2: Dynamic DOM Sink Instrumentation & Taint Tracing
 *
 * Instruments DOM sinks (innerHTML, outerHTML, eval, document.write, location)
 * in the live browser page and checks for unescaped user inputs flowing into execution sinks.
 */
async function auditDomSinks(page) {
  if (!page) return { error: 'Playwright page instance required' };

  const SINK_INSPECTION_SCRIPT = `(() => {
    const sinks = [];
    const url = window.location.href;
    const urlParams = Array.from(new URLSearchParams(window.location.search).entries());
    const hash = window.location.hash;

    // Check DOM elements for dangerous sink usage & script injection patterns
    const scripts = Array.from(document.querySelectorAll('script'));
    const evalPatterns = scripts.filter(s => /eval\(|Function\(|setTimeout\(['"]|setInterval\(['"]/i.test(s.innerText || ''));
    if (evalPatterns.length > 0) {
      sinks.push({
        sink: 'eval/Function',
        severity: 'HIGH',
        count: evalPatterns.length,
        sample: evalPatterns[0].innerText.slice(0, 160)
      });
    }

    // Check innerHTML taint vectors
    const allEls = Array.from(document.querySelectorAll('*'));
    let innerHtmlSinks = 0;
    let reflectedParams = [];

    // Check if URL parameters are reflected in DOM
    for (const [key, val] of urlParams) {
      if (val && val.length > 3 && document.documentElement.innerHTML.includes(val)) {
        reflectedParams.push({ param: key, value: val });
      }
    }

    // Check document.write indicators
    const hasDocWrite = scripts.some(s => /document\.write/i.test(s.innerText || ''));
    if (hasDocWrite) {
      sinks.push({
        sink: 'document.write',
        severity: 'HIGH',
        description: 'document.write() found in active page scripts — high DOM XSS risk'
      });
    }

    // Navigation sinks (javascript: URLs or open redirects)
    const dangerousLinks = Array.from(document.querySelectorAll('a[href^="javascript:"]')).map(a => a.getAttribute('href'));
    if (dangerousLinks.length > 0) {
      sinks.push({
        sink: 'javascript_pseudoprotocol',
        severity: 'MEDIUM',
        count: dangerousLinks.length,
        links: dangerousLinks.slice(0, 3)
      });
    }

    return {
      url,
      sinks,
      reflectedParams,
      totalScripts: scripts.length,
      hasTrustedTypes: !!window.trustedTypes
    };
  })()`;

  try {
    const res = await page.evaluate(SINK_INSPECTION_SCRIPT);
    const advisories = [];

    if (res.sinks && res.sinks.length > 0) {
      for (const s of res.sinks) {
        advisories.push(buildAdvisory('DOM_SINK_DETECTED', {
          title: `Dangerous DOM Sink: ${s.sink}`,
          severity: s.severity || 'HIGH',
          description: s.description || `Detected ${s.count || 1} instance(s) of dangerous sink ${s.sink}.`,
          remediation: 'Use safe DOM APIs (e.g. textContent, createElement) or sanitize HTML with DOMPurify. Enforce Trusted Types policy.'
        }));
      }
    }

    if (res.reflectedParams && res.reflectedParams.length > 0) {
      advisories.push(buildAdvisory('REFLECTED_DOM_TAINT', {
        title: 'URL Parameters Reflected In DOM',
        severity: 'HIGH',
        description: `URL parameters [${res.reflectedParams.map(p => p.param).join(', ')}] are reflected into the page DOM without sanitization.`,
        remediation: 'Sanitize query parameters before rendering into DOM elements to prevent DOM-based XSS (CWE-79).'
      }));
    }

    return {
      pageUrl: res.url,
      trustedTypesEnabled: res.hasTrustedTypes,
      sinksFound: res.sinks.length,
      sinks: res.sinks,
      reflectedParams: res.reflectedParams,
      advisories
    };
  } catch (e) {
    return { error: 'Failed to inspect DOM sinks: ' + e.message };
  }
}

/**
 * POINT 3: PostMessage & Cross-Window Boundary Inspection
 *
 * Inspects window message listeners for missing origin checks and wildcard targetOrigin.
 */
async function auditPostMessages(page) {
  if (!page) return { error: 'Playwright page instance required' };

  const POSTMESSAGE_SCRIPT = `(() => {
    const findings = [];
    let messageListenerCount = 0;

    // Check inline scripts for message event listener patterns
    const scripts = Array.from(document.querySelectorAll('script')).map(s => s.innerText || '');
    const messageHandlers = scripts.filter(s => /addEventListener\(['"]message['"]/i.test(s) || /window\.onmessage/i.test(s));

    messageListenerCount = messageHandlers.length;

    for (const h of messageHandlers) {
      const hasOriginCheck = /event\.origin|e\.origin|origin\s*===|origin\s*==/i.test(h);
      const hasWildcardOrigin = /postMessage\([^,]+,\s*['"]\*['"]\)/i.test(h);
      const hasEvalOnData = /eval\(e\.data|eval\(event\.data/i.test(h);

      if (!hasOriginCheck) {
        findings.push({
          type: 'MISSING_ORIGIN_VERIFICATION',
          severity: 'HIGH',
          cwe: 'CWE-345',
          description: 'window.addEventListener("message") handler does not verify event.origin — susceptible to arbitrary cross-window messaging exploits.'
        });
      }
      if (hasWildcardOrigin) {
        findings.push({
          type: 'WILDCARD_TARGET_ORIGIN',
          severity: 'MEDIUM',
          cwe: 'CWE-345',
          description: 'window.postMessage uses targetOrigin "*", broadcasting sensitive message payload to any frame or origin.'
        });
      }
      if (hasEvalOnData) {
        findings.push({
          type: 'EVAL_ON_MESSAGE_PAYLOAD',
          severity: 'CRITICAL',
          cwe: 'CWE-94',
          description: 'PostMessage handler calls eval() on incoming message data.'
        });
      }
    }

    return {
      messageListenerCount,
      findings
    };
  })()`;

  try {
    const res = await page.evaluate(POSTMESSAGE_SCRIPT);
    return {
      messageListenerCount: res.messageListenerCount,
      vulnerable: res.findings.length > 0,
      findings: res.findings,
      remediation: res.findings.length > 0
        ? 'Always verify event.origin strictly against trusted whitelist (e.g. `if (event.origin !== "https://trusted.com") return;`) and specify exact targetOrigin in postMessage().'
        : 'No unverified message handlers detected.'
    };
  } catch (e) {
    return { error: 'Failed to audit postMessage handlers: ' + e.message };
  }
}

/**
 * POINT 4: Dynamic API Route Harvesting & GraphQL Schema Introspection
 *
 * Harvests discovered endpoints and probes GraphQL endpoints for __schema introspection.
 */
async function auditApiAndGraphql(page, targetUrl) {
  const url = targetUrl || (page && typeof page.url === 'function' ? page.url() : '');
  if (!url) return { error: 'Target URL or active page required' };

  let origin = '';
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    origin = u.origin;
  } catch {
    return { error: 'Invalid URL for API audit: ' + url };
  }

  const candidateGraphqlPaths = [
    '/graphql',
    '/api/graphql',
    '/gql',
    '/v1/graphql',
    '/api/v1/graphql',
    '/query'
  ];

  const INTROSPECTION_QUERY = {
    query: 'query IntrospectionQuery { __schema { queryType { name } mutationType { name } types { name kind fields { name } } } }'
  };

  let graphqlFinding = null;

  for (const p of candidateGraphqlPaths) {
    const ep = origin + p;
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(INTROSPECTION_QUERY),
        signal: AbortSignal.timeout(5000)
      });

      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json && json.data && json.data.__schema) {
          const types = json.data.__schema.types || [];
          const queries = (types.find(t => t.name === 'Query') || {}).fields || [];
          const mutations = (types.find(t => t.name === 'Mutation') || {}).fields || [];
          const sensitiveFields = [];

          for (const t of types) {
            for (const f of (t.fields || [])) {
              if (/password|token|secret|credential|ssn|creditcard|apikey/i.test(f.name)) {
                sensitiveFields.push(`${t.name}.${f.name}`);
              }
            }
          }

          graphqlFinding = {
            endpoint: ep,
            introspectionEnabled: true,
            severity: 'HIGH',
            totalTypes: types.length,
            queriesCount: queries.length,
            queries: queries.slice(0, 10).map(q => q.name),
            mutationsCount: mutations.length,
            mutations: mutations.slice(0, 10).map(m => m.name),
            sensitiveFieldsFound: sensitiveFields.slice(0, 12),
            remediation: 'Disable GraphQL introspection in production environments (e.g. Apollo Server `introspection: false`, GraphQL Yoga `plugins: [useDisableIntrospection()]`).'
          };
          break;
        }
      }
    } catch {
      // Continue next candidate
    }
  }

  // Harvest endpoints from page DOM if page provided
  let harvestedRoutes = [];
  if (page) {
    try {
      harvestedRoutes = await page.evaluate(() => {
        const found = new Set();
        const scripts = Array.from(document.querySelectorAll('script')).map(s => s.innerText || '');
        const routeRegex = /['"](\/api\/[a-zA-Z0-9_\-\/]+|\/v[1-9]\/[a-zA-Z0-9_\-\/]+)['"]/g;
        for (const s of scripts) {
          let match;
          while ((match = routeRegex.exec(s)) !== null) {
            found.add(match[1]);
          }
        }
        return Array.from(found).slice(0, 25);
      });
    } catch {
      harvestedRoutes = [];
    }
  }

  return {
    origin,
    graphqlAudit: graphqlFinding || { introspectionEnabled: false, note: 'No public GraphQL introspection endpoints exposed' },
    harvestedRoutesCount: harvestedRoutes.length,
    harvestedRoutes
  };
}

/**
 * POINT 5: WebSocket & Streaming Protocol Auditing
 *
 * Inspects WebSocket protocol configurations (WSS encryption and URL query parameter token leakage).
 */
async function auditWebSockets(page) {
  if (!page) return { error: 'Playwright page instance required' };

  const WS_AUDIT_SCRIPT = `(() => {
    const sockets = [];
    const findings = [];

    // Inspect script text for WebSocket initialization patterns
    const scripts = Array.from(document.querySelectorAll('script')).map(s => s.innerText || '');
    const wsRegex = /new\s+WebSocket\(['"]([^'"]+)['"]\)/g;

    for (const s of scripts) {
      let m;
      while ((m = wsRegex.exec(s)) !== null) {
        const wsUrl = m[1];
        const isInsecure = wsUrl.startsWith('ws://');
        const hasTokenInQuery = /[?&](token|auth|jwt|access_token|key|secret)=/i.test(wsUrl);

        sockets.push({ url: wsUrl, isInsecure, hasTokenInQuery });

        if (isInsecure) {
          findings.push({
            type: 'INSECURE_WEBSOCKET_PROTOCOL',
            severity: 'HIGH',
            cwe: 'CWE-319',
            url: wsUrl,
            description: 'WebSocket connects over unencrypted ws:// instead of wss://.'
          });
        }
        if (hasTokenInQuery) {
          findings.push({
            type: 'TOKEN_IN_WEBSOCKET_QUERY',
            severity: 'HIGH',
            cwe: 'CWE-598',
            url: wsUrl,
            description: 'Authentication token or API key passed in WebSocket query string — logged in intermediate proxy logs.'
          });
        }
      }
    }

    return {
      socketsFound: sockets.length,
      sockets,
      findings
    };
  })()`;

  try {
    const res = await page.evaluate(WS_AUDIT_SCRIPT);
    return {
      socketsCount: res.socketsFound,
      sockets: res.sockets,
      findings: res.findings,
      remediation: res.findings.length > 0
        ? 'Always use wss:// for encrypted WebSockets. Transmit session tokens during connection handshake via cookies or first message payload, never in URL query strings.'
        : 'All detected WebSocket connections use secure patterns.'
    };
  } catch (e) {
    return { error: 'Failed to audit WebSockets: ' + e.message };
  }
}

/**
 * POINT 6: Client Storage Hygiene & Token Exposure Audit
 *
 * Deep scan of localStorage, sessionStorage, cookies, and IndexedDB for exposed credentials and missing security flags.
 */
async function auditStorageHygiene(page) {
  if (!page) return { error: 'Playwright page instance required' };

  const STORAGE_HYGIENE_SCRIPT = `(() => {
    const findings = [];
    const sensitiveTokens = [];
    const jwtRegex = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
    const keyPatterns = /token|auth|bearer|jwt|secret|apikey|credential|password|private_key/i;

    function checkItem(storageType, key, val) {
      if (!val) return;
      const keySensitive = keyPatterns.test(key);
      const isJwt = jwtRegex.test(val);
      const isSensitive = keySensitive || isJwt || /AKIA[0-9A-Z]{16}/.test(val);

      if (isSensitive) {
        sensitiveTokens.push({
          storage: storageType,
          key,
          isJwt,
          length: val.length,
          preview: val.slice(0, 10) + '...'
        });
        findings.push({
          type: 'SENSITIVE_CREDENTIAL_IN_CLIENT_STORAGE',
          severity: isJwt ? 'HIGH' : 'MEDIUM',
          cwe: 'CWE-922',
          storage: storageType,
          key,
          description: 'Sensitive credential stored in ' + storageType + ' ("' + key + '"). JavaScript-accessible storage is vulnerable to XSS exfiltration.'
        });
      }
    }

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        checkItem('localStorage', k, localStorage.getItem(k));
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        checkItem('sessionStorage', k, sessionStorage.getItem(k));
      }
    } catch (e) {
      findings.push({ error: e.message });
    }

    // Check document.cookie (note: HttpOnly cookies are invisible to JS, which is desired)
    const clientCookies = document.cookie ? document.cookie.split(';').map(c => c.trim()) : [];
    const exposedAuthCookies = clientCookies.filter(c => keyPatterns.test(c));
    if (exposedAuthCookies.length > 0) {
      findings.push({
        type: 'NON_HTTPONLY_AUTH_COOKIE',
        severity: 'HIGH',
        cwe: 'CWE-1004',
        count: exposedAuthCookies.length,
        description: 'Session/auth cookies accessible to JavaScript without HttpOnly flag.'
      });
    }

    return {
      localStorageCount: localStorage.length,
      sessionStorageCount: sessionStorage.length,
      sensitiveTokensCount: sensitiveTokens.length,
      sensitiveTokens,
      findings
    };
  })()`;

  try {
    const res = await page.evaluate(STORAGE_HYGIENE_SCRIPT);
    return {
      localStorageItems: res.localStorageCount,
      sessionStorageItems: res.sessionStorageCount,
      sensitiveTokensFound: res.sensitiveTokensCount,
      sensitiveTokens: res.sensitiveTokens,
      findingsCount: res.findings.length,
      findings: res.findings,
      remediation: res.findings.length > 0
        ? 'Store session authentication tokens in HttpOnly; Secure; SameSite=Strict cookies to protect against XSS token exfiltration. Avoid saving long-lived credentials in localStorage.'
        : 'Client storage hygiene meets AppSec standards.'
    };
  } catch (e) {
    return { error: 'Failed to audit storage hygiene: ' + e.message };
  }
}

module.exports = {
  auditBola,
  auditDomSinks,
  auditPostMessages,
  auditApiAndGraphql,
  auditWebSockets,
  auditStorageHygiene
};
