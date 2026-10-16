'use strict';
/**
 * sessionProbe.js — Automated Concurrent Session Invalidation Verification (CWE-613)
 *
 * Automates the exact reproduction flow of Multi-Device Session Invalidation (CWE-613) audit:
 *   "Broken Authentication and Session Management > Failure to Invalidate Session > On Password Change"
 *
 * Uses Ghost Browser / Playwright dual isolated browser contexts (or direct HTTP dual-session probes):
 *   1. Context A (User / Attacker Session 1) signs in and obtains Session A.
 *   2. Context B (Victim Session 2) signs in and obtains Session B.
 *   3. Context A initiates a password change / credential update.
 *   4. Context B attempts to access a protected resource.
 *   5. If Context B continues to execute authenticated requests (200 OK instead of 401/redirect),
 *      the system flags a CWE-613 finding with concrete evidence and 4-pillar remediation.
 */

const { buildAdvisory } = require('./advisory');

/**
 * Probes HTTP-based dual session revocation via REST endpoints.
 */
async function testHttpSessionInvalidation({
  loginUrl,
  loginPayload,
  passwordChangeUrl,
  passwordChangePayload,
  protectedUrl,
  tokenExtractor = (data) => data.token || data.accessToken || data.jwt || data.sessionToken
}) {
  const fetch = globalThis.fetch || (await import('node-fetch')).default;

  const result = {
    testedAt: new Date().toISOString(),
    vulnerable: false,
    finding: null,
    steps: []
  };

  try {
    // Step 1: Login Session A
    result.steps.push({ step: 1, action: 'Authenticate Session A' });
    const resA = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginPayload)
    });
    const dataA = await resA.json().catch(() => ({}));
    const tokenA = tokenExtractor(dataA) || resA.headers.get('set-cookie');

    if (!tokenA) {
      throw new Error('Failed to obtain token for Session A from ' + loginUrl);
    }

    // Step 2: Login Session B
    result.steps.push({ step: 2, action: 'Authenticate Session B (Concurrent browser/device)' });
    const resB = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginPayload)
    });
    const dataB = await resB.json().catch(() => ({}));
    const tokenB = tokenExtractor(dataB) || resB.headers.get('set-cookie');

    if (!tokenB) {
      throw new Error('Failed to obtain token for Session B from ' + loginUrl);
    }

    // Step 3: Trigger Password Change using Session A
    result.steps.push({ step: 3, action: 'Change Password via Session A' });
    const authHeaderA = tokenA.startsWith('Bearer ') ? tokenA : (tokenA.includes('=') ? undefined : `Bearer ${tokenA}`);
    const changeHeaders = { 'Content-Type': 'application/json' };
    if (authHeaderA) changeHeaders['Authorization'] = authHeaderA;
    if (tokenA.includes('=')) changeHeaders['Cookie'] = tokenA;

    const changeRes = await fetch(passwordChangeUrl, {
      method: 'POST',
      headers: changeHeaders,
      body: JSON.stringify(passwordChangePayload)
    });

    if (!changeRes.ok) {
      throw new Error(`Password change via Session A returned HTTP ${changeRes.status}`);
    }

    // Step 4: Verify Session B on Protected Resource
    result.steps.push({ step: 4, action: 'Attempt access to protected endpoint using pre-existing Session B' });
    const authHeaderB = tokenB.startsWith('Bearer ') ? tokenB : (tokenB.includes('=') ? undefined : `Bearer ${tokenB}`);
    const protectedHeaders = {};
    if (authHeaderB) protectedHeaders['Authorization'] = authHeaderB;
    if (tokenB.includes('=')) protectedHeaders['Cookie'] = tokenB;

    const testRes = await fetch(protectedUrl, {
      method: 'GET',
      headers: protectedHeaders
    });

    if (testRes.status === 200) {
      // Vulnerable! Session B was NOT revoked
      result.vulnerable = true;
      result.finding = buildAdvisory('session_invalidation', {
        title: 'CWE-613: Active Session Not Invalidated Across Devices After Password Change',
        severity: 'HIGH',
        evidence: `Session B obtained before password change was successfully accepted by ${protectedUrl} with HTTP 200 OK after Session A updated credentials.`,
        threatScenario: 'An attacker holding an existing stolen session or token retains unauthorized access indefinitely after the legitimate user changes their password.'
      });
      result.steps.push({
        step: 5,
        status: 'VULNERABLE',
        detail: `Session B received HTTP 200 from ${protectedUrl}. CWE-613 confirmed.`
      });
    } else if (testRes.status === 401 || testRes.status === 403 || testRes.redirected) {
      result.vulnerable = false;
      result.steps.push({
        step: 5,
        status: 'SECURE',
        detail: `Session B was rejected with HTTP ${testRes.status} as required by session revocation policies.`
      });
    } else {
      result.steps.push({
        step: 5,
        status: 'INCONCLUSIVE',
        detail: `Protected URL returned unexpected status HTTP ${testRes.status}`
      });
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

/**
 * Automates dual-context Playwright session invalidation in Ghost Browser Chromium pool.
 */
async function testBrowserSessionInvalidation(pool, {
  targetOrigin,
  loginUrl,
  usernameSelector,
  username,
  passwordSelector,
  password,
  submitSelector,
  changePasswordUrl,
  newPassword,
  protectedUrl
}) {
  const result = {
    testedAt: new Date().toISOString(),
    vulnerable: false,
    finding: null,
    steps: []
  };

  let ctxA = null;
  let ctxB = null;

  try {
    // Acquire Chromium browser instance from pool or create new contexts
    const browser = pool?.browser;
    if (!browser) {
      throw new Error('BrowserPool is not initialized or running.');
    }

    // Context Alpha (Chrome / Primary)
    ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();

    // Context Beta (Secondary device / Firefox simulation)
    ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();

    // 1. Login on Page A
    result.steps.push({ step: 1, action: 'Context Alpha: Navigate & Login' });
    await pageA.goto(loginUrl, { waitUntil: 'networkidle' });
    await pageA.fill(usernameSelector, username);
    await pageA.fill(passwordSelector, password);
    await pageA.click(submitSelector);
    await pageA.waitForLoadState('networkidle');

    // 2. Login on Page B
    result.steps.push({ step: 2, action: 'Context Beta: Concurrent Login' });
    await pageB.goto(loginUrl, { waitUntil: 'networkidle' });
    await pageB.fill(usernameSelector, username);
    await pageB.fill(passwordSelector, password);
    await pageB.click(submitSelector);
    await pageB.waitForLoadState('networkidle');

    // 3. Change password in Context A
    result.steps.push({ step: 3, action: 'Context Alpha: Execute Password Change' });
    await pageA.goto(changePasswordUrl, { waitUntil: 'networkidle' });
    // Fill new password if inputs exist
    const newPassInput = await pageA.$('input[type="password"]');
    if (newPassInput) {
      await newPassInput.fill(newPassword);
      const submitChange = await pageA.$('button[type="submit"], input[type="submit"]');
      if (submitChange) await submitChange.click();
      await pageA.waitForLoadState('networkidle');
    }

    // 4. Check Context B
    result.steps.push({ step: 4, action: 'Context Beta: Verify Session Invalidation on Protected URL' });
    await pageB.goto(protectedUrl, { waitUntil: 'networkidle' });
    const currentUrlB = pageB.url();

    const isRedirectedToLogin = currentUrlB.includes('/login') || currentUrlB.includes('/auth') || currentUrlB.includes('/signin');

    if (!isRedirectedToLogin) {
      result.vulnerable = true;
      result.finding = buildAdvisory('session_invalidation', {
        title: 'CWE-613: Concurrent Browser Session Remained Authenticated After Password Change',
        severity: 'HIGH',
        evidence: `Context Beta stayed logged in at ${currentUrlB} after Context Alpha completed password update.`,
        threatScenario: 'Penetration test finding confirmed: Stolen session tokens on other devices continue functioning after account password reset.'
      });
      result.steps.push({
        step: 5,
        status: 'VULNERABLE',
        detail: `Context Beta retained full session state at ${currentUrlB}`
      });
    } else {
      result.vulnerable = false;
      result.steps.push({
        step: 5,
        status: 'SECURE',
        detail: `Context Beta was automatically redirected to ${currentUrlB}`
      });
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    if (ctxA) await ctxA.close().catch(() => {});
    if (ctxB) await ctxB.close().catch(() => {});
  }

  return result;
}

module.exports = {
  testHttpSessionInvalidation,
  testBrowserSessionInvalidation
};
