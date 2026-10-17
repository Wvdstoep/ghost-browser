'use strict';
/**
 * semanticRouter.js — In-Browser Semantic SPA Route & Role Surface Discovery
 *
 * Runs inside the Ghost Browser Playwright execution context to extract:
 *   1. Client-Side Framework Routes (Next.js, Remix, Vue Router, Nuxt, React Router)
 *   2. Privileged Actions & Role-Gated UI Elements (Billing, Admin, Delete, Token, Member)
 *   3. Hidden Administrative Forms & Buttons rendered in DOM or SPA bundles
 *   4. Internal API Endpoints & Contract Surface
 */

const { URL } = require('url');

/**
 * In-browser evaluation script that maps SPA routes, privileged DOM actions, and API calls
 */
const IN_BROWSER_SEMANTIC_SCRIPT = `(() => {
  const routes = new Set();
  const privilegedElements = [];
  const apiEndpoints = new Set();

  // 1. Framework-specific router extraction
  try {
    // Next.js
    if (window.__NEXT_DATA__?.page) routes.add(window.__NEXT_DATA__.page);
    if (window.next?.router?.components) {
      Object.keys(window.next.router.components).forEach(r => routes.add(r));
    }
    // Remix
    if (window.__remixContext?.manifest?.routes) {
      Object.values(window.__remixContext.manifest.routes).forEach(r => {
        if (r.path) routes.add('/' + r.path.replace(/^\\//, ''));
      });
    }
    // Vue Router
    if (window.__vue_app__?.$router?.getRoutes) {
      window.__vue_app__.$router.getRoutes().forEach(r => routes.add(r.path));
    }
  } catch (_) {}

  // 2. Discover internal links matching application origin
  try {
    const origin = window.location.origin;
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('/') && !href.startsWith('//')) {
        routes.add(href.split('?')[0].split('#')[0]);
      } else if (href.startsWith(origin)) {
        try {
          const u = new URL(href);
          routes.add(u.pathname);
        } catch (_) {}
      }
    });
  } catch (_) {}

  // 3. Identify Privileged / Role-Gated Actions & Buttons
  const privilegedRegex = /admin|billing|invoice|delete|destroy|remove|role|permission|team|member|transfer|token|apikey|secret|organization|tenant|payout|wallet|refund|subscription/i;

  try {
    document.querySelectorAll('button, [role="button"], a, form, input[type="submit"]').forEach(el => {
      const text = (el.innerText || el.getAttribute('aria-label') || el.title || el.value || '').trim();
      const action = el.getAttribute('href') || el.getAttribute('action') || '';
      const name = el.getAttribute('name') || el.id || '';

      if (privilegedRegex.test(text) || privilegedRegex.test(action) || privilegedRegex.test(name)) {
        const isVisible = el.offsetParent !== null && window.getComputedStyle(el).display !== 'none';
        const isDisabled = el.hasAttribute('disabled') || el.classList.contains('disabled');
        privilegedElements.push({
          tag: el.tagName.toLowerCase(),
          text: text.slice(0, 60),
          action: action || undefined,
          name: name || undefined,
          visible: isVisible,
          disabled: isDisabled
        });
      }
    });
  } catch (_) {}

  // 4. Scan embedded script tags for API route literals
  try {
    const scriptTexts = Array.from(document.querySelectorAll('script:not([src])')).map(s => s.innerText);
    const apiRegex = /["'](\\/api\\/[a-zA-Z0-9_\\-\\/{}:]+)["']/g;
    scriptTexts.forEach(txt => {
      let match;
      while ((match = apiRegex.exec(txt)) !== null) {
        if (match[1]) apiEndpoints.add(match[1]);
      }
    });
  } catch (_) {}

  return {
    routes: Array.from(routes).slice(0, 50),
    privilegedElements: privilegedElements.slice(0, 30),
    apiEndpoints: Array.from(apiEndpoints).slice(0, 30)
  };
})()`;

/**
 * Audits client-side application surface to extract semantic routes and privileged operations
 *
 * @param {import('playwright').Page|null} page
 * @param {string} targetUrl
 */
async function auditSemanticSurface(page, targetUrl) {
  let base = (targetUrl || (page && page.url()) || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;

  let extraction = { routes: [], privilegedElements: [], apiEndpoints: [] };

  if (page) {
    try {
      if (!page.url() || page.url() === 'about:blank') {
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);
      }
      extraction = await page.evaluate(IN_BROWSER_SEMANTIC_SCRIPT);
    } catch (e) {
      extraction.error = e.message;
    }
  }

  // Common sensitive route checklist to test for exposure
  const sensitiveCandidatePaths = [
    '/admin', '/dashboard', '/settings', '/settings/billing', '/settings/team',
    '/api/users', '/api/team', '/api/billing', '/api/keys', '/api/v1/admin'
  ];

  const identifiedPrivilegedPaths = extraction.routes.filter(r => 
    /admin|billing|team|member|key|token|org|secret|wallet/i.test(r)
  );

  return {
    target: base,
    timestamp: new Date().toISOString(),
    discoveredRoutesCount: extraction.routes.length,
    discoveredRoutes: extraction.routes,
    privilegedElementsCount: extraction.privilegedElements.length,
    privilegedElements: extraction.privilegedElements,
    apiEndpointsCount: extraction.apiEndpoints.length,
    apiEndpoints: extraction.apiEndpoints,
    identifiedPrivilegedPaths,
    sensitiveCandidatePaths,
    summary: `Extracted ${extraction.routes.length} SPA routes, ${extraction.privilegedElements.length} privileged UI actions, and ${extraction.apiEndpoints.length} API endpoints from the client runtime.`
  };
}

module.exports = {
  auditSemanticSurface
};
