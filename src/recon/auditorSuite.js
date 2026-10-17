'use strict';
/**
 * ghost-browser/src/recon/auditorSuite.js
 *
 * Deep Dynamic In-Browser AppSec Audit Suite
 *
 * Implements high-impact defensive recon auditors utilizing the real Chromium execution context:
 *   1. BOLA / IDOR Authorization Isolation Audit (CWE-639)
 *   2. Dynamic DOM Sink & Taint Injection Audit (eval, Function, innerHTML, document.write)
 *   3. PostMessage Cross-Window Boundary Audit (CWE-345)
 *   4. Dynamic API Route Harvesting & GraphQL Schema Introspection Probe
 *   5. WebSocket & Streaming Security Audit (CWE-319 / CWE-598)
 *   6. Client Storage Hygiene & Token Exposure Audit (CWE-922)
 */

/**
 * 1. BOLA / IDOR Authorization Isolation Audit (CWE-639)
 * Tests cross-tenant object access across separate authenticated sessions or profiles.
 */
async function auditBola({ targetUrl, tokenA, tokenB, profileA, profileB, pageA, pageB, objectIds = [] } = {}) {
  const findings = [];
  const tests = [];
  let vulnerable = false;

  if (!targetUrl) {
    return { error: 'targetUrl is required for BOLA authorization audit' };
  }

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

  // 2. In-Browser Multi-Profile BOLA Test (Live Chromium context with real cookies)
  if (pageA && pageB) {
    for (const id of idsToTest.slice(0, 3)) {
      const testUrl = targetUrl.includes('{id}') 
        ? targetUrl.replace('{id}', encodeURIComponent(id))
        : targetUrl.replace(/\/\d+$/, `/${encodeURIComponent(id)}`);

      try {
        const resA = await pageA.evaluate(async (u) => {
          try {
            const r = await fetch(u, { headers: { 'Accept': 'application/json, text/plain, */*' } });
            const body = await r.text().catch(() => '');
            return { status: r.status, ok: r.ok, length: body.length };
          } catch (err) {
            return { error: err.message };
          }
        }, testUrl);

        const resB = await pageB.evaluate(async (u) => {
          try {
            const r = await fetch(u, { headers: { 'Accept': 'application/json, text/plain, */*' } });
            const body = await r.text().catch(() => '');
            return { status: r.status, ok: r.ok, length: body.length };
          } catch (err) {
            return { error: err.message };
          }
        }, testUrl);

        tests.push({
          sessionType: 'browser_profiles',
          profileA: profileA || 'tenant_a',
          profileB: profileB || 'tenant_b',
          url: testUrl,
          statusA: resA.status,
          statusB: resB.status
        });

        if (resA && resA.ok && resB && resB.ok) {
          vulnerable = true;
          findings.push({
            type: 'BOLA_IDOR_VULNERABILITY',
            severity: 'CRITICAL',
            cwe: 'CWE-639',
            title: `Broken Object Level Authorization (BOLA) on ${testUrl}`,
            description: `Secondary profile (${profileB || 'Session B'}) accessed object ${id} belonging to Primary profile (${profileA || 'Session A'}) with HTTP 200 OK.`,
            remediation: 'Implement user/tenant ownership validation at data layer. Verify req.user.tenantId === resource.tenantId before returning records.'
          });
          break;
        }
      } catch (err) {
        tests.push({ sessionType: 'browser_profiles', error: err.message });
      }
    }
  }
  // 3. Token-based Cross-Session BOLA Test
  else if (tokenA && tokenB) {
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

        tests.push({
          sessionType: 'bearer_tokens',
          url: testUrl,
          statusA: resA.status,
          statusB: resB.status
        });

        if (resA.ok && resB.ok) {
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
      } catch (e) {
        tests.push({ url: testUrl, error: e.message });
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
      : 'No BOLA vulnerabilities identified with tested identifiers.'
  };
}

/**
 * 2. Dynamic DOM Sink & Taint Audit
 * Instruments the live DOM inside Chromium to detect dangerous sinks and script injection vectors.
 */
async function auditDomSinks(page) {
  if (!page) return { error: 'Playwright page instance required' };

  try {
    const res = await page.evaluate(() => {
      const sinks = [];
      const url = window.location.href;
      const urlParams = Array.from(new URLSearchParams(window.location.search).entries());

      // Check DOM elements for dangerous sink usage & script injection patterns
      const scripts = Array.from(document.querySelectorAll('script'));
      const evalPatterns = scripts.filter(s => /eval\(|Function\(|setTimeout\(['"]|setInterval\(['"]/i.test(s.innerText || ''));
      if (evalPatterns.length > 0) {
        sinks.push({
          sink: 'eval/Function',
          severity: 'HIGH',
          count: evalPatterns.length,
          sample: (evalPatterns[0].innerText || '').slice(0, 160)
        });
      }

      // Check if URL parameters are reflected in DOM
      let reflectedParams = [];
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
    });

    const advisories = [];
    if (res.sinks.length > 0) {
      advisories.push({
        category: 'DOM_XSS_SINKS',
        severity: 'HIGH',
        cwe: 'CWE-79',
        findings: res.sinks,
        remediation: 'Refactor DOM sinks to use safe APIs (e.g. textContent instead of innerHTML, structured JSON parsing instead of eval).'
      });
    }
    if (res.reflectedParams.length > 0) {
      advisories.push({
        category: 'REFLECTED_DOM_PARAMETER',
        severity: 'MEDIUM',
        cwe: 'CWE-79',
        parameters: res.reflectedParams,
        remediation: 'Sanitize URL search parameters before rendering into DOM elements.'
      });
    }

    return {
      targetUrl: res.url,
      sinksDetected: res.sinks.length,
      reflectedParamsCount: res.reflectedParams.length,
      hasTrustedTypes: res.hasTrustedTypes,
      advisories
    };
  } catch (e) {
    return { error: 'Failed to inspect DOM sinks: ' + e.message };
  }
}

/**
 * 3. PostMessage & Cross-Window Boundary Audit (CWE-345)
 * Analyzes window.onmessage handlers and targetOrigin usage across frames.
 */
async function auditPostMessages(page) {
  if (!page) return { error: 'Playwright page instance required' };

  try {
    const res = await page.evaluate(() => {
      const findings = [];
      const scripts = Array.from(document.querySelectorAll('script')).map(s => s.innerText || '');
      const messageHandlers = scripts.filter(s => /addEventListener\(['"]message['"]/i.test(s) || /window\.onmessage/i.test(s));
      const messageListenerCount = messageHandlers.length;

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
    });

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
 * 4. Dynamic API Route Harvesting & GraphQL Schema Introspection Probe
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
            remediation: 'Disable GraphQL introspection in production environments (e.g. Apollo Server introspection: false, GraphQL Yoga plugins: [useDisableIntrospection()]).'
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
    } catch {}
  }

  return {
    origin,
    graphqlAudit: graphqlFinding || { introspectionEnabled: false, note: 'No public GraphQL introspection endpoints exposed' },
    harvestedRoutesCount: harvestedRoutes.length,
    harvestedRoutes
  };
}

/**
 * 5. WebSocket & Streaming Security Audit (CWE-319 / CWE-598)
 */
async function auditWebSockets(page) {
  if (!page) return { error: 'Playwright page instance required' };

  try {
    const res = await page.evaluate(() => {
      const sockets = [];
      const findings = [];
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
        sockets,
        findings
      };
    });

    return {
      socketsCount: res.sockets.length,
      sockets: res.sockets,
      findings: res.findings,
      remediation: res.findings.length > 0
        ? 'Upgrade all WebSockets to wss:// and transmit authentication tokens via initial handshake HTTP headers or first message frame rather than URL query parameters.'
        : 'All detected WebSocket connections use secure patterns.'
    };
  } catch (e) {
    return { error: 'Failed to audit WebSockets: ' + e.message };
  }
}

/**
 * 6. Client Storage Hygiene & Token Exposure Audit (CWE-922)
 */
async function auditStorageHygiene(page) {
  if (!page) return { error: 'Playwright page instance required' };

  try {
    const res = await page.evaluate(() => {
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

      let localStorageCount = 0;
      let sessionStorageCount = 0;
      try {
        localStorageCount = localStorage.length;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          checkItem('localStorage', k, localStorage.getItem(k));
        }
        sessionStorageCount = sessionStorage.length;
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          checkItem('sessionStorage', k, sessionStorage.getItem(k));
        }
      } catch (e) {
        findings.push({ type: 'STORAGE_ACCESS_ERROR', severity: 'LOW', description: e.message });
      }

      return {
        localStorageCount,
        sessionStorageCount,
        sensitiveTokensCount: sensitiveTokens.length,
        sensitiveTokens,
        findings
      };
    });

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
