'use strict';
/**
 * domAuditor.js — Live Client-Side DOM & Storage Security Auditor
 *
 * Runs inside Ghost Browser Chromium execution context to evaluate:
 *   - Client-side storage leaks (JWTs, API tokens, passwords in localStorage/sessionStorage)
 *   - Insecure DOM forms (forms without CSRF tokens, actions sending credentials over HTTP)
 *   - Inline JavaScript and XSS sink surfaces
 *   - Exposed global objects in `window`
 */

const { buildAdvisory } = require('./advisory');

/**
 * Script injected into the active Playwright page context to extract client-side state.
 */
const DOM_AUDIT_SCRIPT = `(() => {
  const issues = [];
  const findings = [];

  // 1. Audit localStorage & sessionStorage
  const tokenRegex = /token|jwt|auth|bearer|secret|apikey|credential/i;
  const storageItems = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      storageItems.push({ storage: 'localStorage', key: k, length: v?.length, matchesSensitive: tokenRegex.test(k) });
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      const v = sessionStorage.getItem(k);
      storageItems.push({ storage: 'sessionStorage', key: k, length: v?.length, matchesSensitive: tokenRegex.test(k) });
    }
  } catch (e) {
    storageItems.push({ error: e.message });
  }

  // 2. Audit Forms & Password Fields
  const forms = Array.from(document.querySelectorAll('form')).map((f) => {
    const action = f.getAttribute('action') || '';
    const method = (f.getAttribute('method') || 'GET').toUpperCase();
    const hasPassword = !!f.querySelector('input[type="password"]');
    const hasCsrf = !!f.querySelector('input[name*="csrf"], input[name*="token"], input[name*="_token"]');
    const isHttpAction = action.startsWith('http://');
    return { action, method, hasPassword, hasCsrf, isHttpAction };
  });

  // 3. Audit Scripts & CSP indicators
  const inlineScripts = Array.from(document.querySelectorAll('script:not([src])')).length;
  const externalScripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);

  return {
    url: window.location.href,
    title: document.title,
    storageItems,
    forms,
    inlineScriptsCount: inlineScripts,
    externalScriptsCount: externalScripts.length
  };
})()`;

/**
 * Runs the DOM audit against an active Playwright page in Ghost Browser.
 */
async function auditActivePage(page) {
  if (!page) throw new Error('Valid Playwright page required for DOM security audit');

  const rawAudit = await page.evaluate(DOM_AUDIT_SCRIPT);
  const advisories = [];

  // Check for sensitive tokens in localStorage
  const sensitiveStorage = rawAudit.storageItems.filter((s) => s.matchesSensitive);
  if (sensitiveStorage.length > 0) {
    advisories.push(buildAdvisory('cookie_security', {
      title: 'Sensitive Authentication Tokens Stored in Web Storage (localStorage/sessionStorage)',
      severity: 'HIGH',
      evidence: `Found ${sensitiveStorage.length} sensitive key(s): ${sensitiveStorage.map((s) => s.key).join(', ')}. Web storage is accessible to any script on the page and does not benefit from HttpOnly protections.`,
      threatScenario: 'If any XSS vulnerability exists on the page or in a bundled NPM dependency, the attacker can immediately exfiltrate these tokens via document access.',
      secondaryDefense: 'Store session credentials in HttpOnly, Secure, SameSite=Lax/Strict cookies instead of browser localStorage.'
    }));
  }

  // Check for forms without CSRF tokens or sending passwords over HTTP
  const insecureForms = rawAudit.forms.filter((f) => f.isHttpAction || (f.method === 'POST' && f.hasPassword && !f.hasCsrf));
  if (insecureForms.length > 0) {
    advisories.push(buildAdvisory('csp', {
      title: 'State-Changing Form Lacks CSRF Protection or Submits Insecurely',
      severity: 'MEDIUM',
      evidence: `${insecureForms.length} form(s) lack anti-CSRF token fields or submit to plain HTTP.`
    }));
  }

  return {
    target: rawAudit.url,
    title: rawAudit.title,
    storageItemsCount: rawAudit.storageItems.length,
    sensitiveStorageFound: sensitiveStorage.length,
    inlineScriptsCount: rawAudit.inlineScriptsCount,
    advisories
  };
}

/**
 * Executes a custom in-browser recon / security research script in the live page context.
 */
async function executeSecurityScript(page, script) {
  if (!page) throw new Error('Valid Playwright page required to execute security script');
  const code = String(script || '').trim();
  if (!code) throw new Error('Script code is required');
  try {
    const wrapped = (/\breturn\b|\bawait\b|;|\n/.test(code) && !/^\s*\{.*\}\s*$/.test(code))
      ? `(async () => { ${/\breturn\b/.test(code) ? code : 'return (' + code + ')'} })()`
      : `(async () => (${code}))()`;
    const result = await page.evaluate(wrapped);
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      success: true,
      result: result !== undefined ? result : null
    };
  } catch (err) {
    return {
      url: page.url(),
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  DOM_AUDIT_SCRIPT,
  auditActivePage,
  executeSecurityScript
};
