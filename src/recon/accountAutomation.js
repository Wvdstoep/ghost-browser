'use strict';
/**
 * ghost-browser/src/recon/accountAutomation.js
 *
 * Autonomous Account Creation & Login Automation for Security Recon & Auditing
 *
 * Allows the Ghost Browser agent to dynamically register new test accounts
 * and establish authenticated sessions on any target web application without
 * requiring pre-existing credentials.
 *
 * Enables fully autonomous:
 *   - Authenticated endpoint & API crawling
 *   - BOLA / IDOR tenant isolation testing (registering user A and user B)
 *   - Session lifecycle & token hygiene verification (CWE-613)
 *   - Authenticated DOM sink and storage analysis
 */

const crypto = require('crypto');

/**
 * Generates disposable credentials tailored for security audits.
 */
function generateAuditorCredentials(prefix = 'sec_audit') {
  const rand = crypto.randomBytes(4).toString('hex');
  return {
    username: `${prefix}_${rand}`,
    email: `${prefix}.${rand}@recon-auditor.local`,
    password: `SecAud!t_${crypto.randomBytes(6).toString('base64url')}#9A`
  };
}

/**
 * Autonomously registers a new test account on the target web application.
 *
 * @param {import('playwright').Page} page - Active Playwright page
 * @param {object} opts
 * @param {string} [opts.targetUrl] - Target application URL
 * @param {string} [opts.username] - Custom username
 * @param {string} [opts.email] - Custom email
 * @param {string} [opts.password] - Custom password
 * @param {number} [opts.timeoutMs=25000] - Navigation timeout
 * @returns {Promise<object>}
 */
async function autoRegister(page, { targetUrl, username, email, password, timeoutMs = 25000 } = {}) {
  if (!page) return { error: 'Playwright page instance required for account automation' };

  const creds = generateAuditorCredentials();
  const finalCreds = {
    username: username || creds.username,
    email: email || creds.email,
    password: password || creds.password
  };

  const log = [];
  const startUrl = targetUrl || page.url();

  try {
    // 1. Navigate to target if specified and not already there
    if (targetUrl && (!page.url() || page.url() === 'about:blank' || !page.url().startsWith(targetUrl))) {
      log.push(`Navigating to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch((e) => {
        log.push(`Navigation warning: ${e.message}`);
      });
    }

    await page.waitForTimeout(1000); // Allow dynamic frameworks (React/Vue/Next) to mount

    // 2. Discover Signup Link or Form
    const signupDiscovery = await page.evaluate(() => {
      const path = window.location.pathname.toLowerCase();
      const isAlreadySignup = /sign-?up|register|join|create-account/i.test(path);

      const candidates = [];
      const links = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      for (const el of links) {
        const text = (el.innerText || el.textContent || '').trim();
        const href = el.getAttribute('href') || '';
        const combined = `${text} ${href}`.toLowerCase();

        if (/sign\s*up|register|create\s*an?\s*account|join\s*now|get\s*started/i.test(combined)) {
          candidates.push({
            tagName: el.tagName.toLowerCase(),
            text: text.slice(0, 50),
            href: href ? new URL(href, window.location.origin).href : null,
            selector: el.id ? `#${el.id}` : (el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : null)
          });
        }
      }

      return { isAlreadySignup, candidates };
    });

    log.push(`Discovery: isAlreadySignup=${signupDiscovery.isAlreadySignup}, candidates=${signupDiscovery.candidates.length}`);

    // If not already on signup page, click candidate or navigate to discovered signup URL
    if (!signupDiscovery.isAlreadySignup && signupDiscovery.candidates.length > 0) {
      const best = signupDiscovery.candidates[0];
      if (best.href) {
        log.push(`Navigating to discovered signup URL: ${best.href}`);
        await page.goto(best.href, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      } else if (best.selector) {
        log.push(`Clicking signup trigger: ${best.selector}`);
        await page.click(best.selector, { timeout: 5000 }).catch(() => {});
      }
      await page.waitForTimeout(1000);
    }

    // 3. Inspect Form Fields inside the Signup Page
    const formFields = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
      return inputs.map((inp) => ({
        type: (inp.getAttribute('type') || 'text').toLowerCase(),
        name: inp.getAttribute('name') || '',
        id: inp.id || '',
        placeholder: inp.getAttribute('placeholder') || ''
      }));
    });

    log.push(`Found ${formFields.length} input fields on page`);

    // 4. Fill in the Registration Form
    let filledEmail = false;
    let filledPassword = false;
    let filledUsername = false;

    // Fill Email
    const emailSelector = 'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]';
    const emailEl = await page.$(emailSelector);
    if (emailEl) {
      await emailEl.fill(finalCreds.email);
      filledEmail = true;
    }

    // Fill Username / Name
    const userSelector = 'input[name*="user" i], input[id*="user" i], input[name*="username" i], input[name*="name" i]:not([name*="last" i]), input[placeholder*="username" i]';
    const userEl = await page.$(userSelector);
    if (userEl) {
      await userEl.fill(finalCreds.username);
      filledUsername = true;
    }

    // Fill Passwords (handle password + confirm password)
    const passEls = await page.$$('input[type="password"]');
    if (passEls.length > 0) {
      for (const passEl of passEls) {
        await passEl.fill(finalCreds.password);
      }
      filledPassword = true;
    }

    // Accept Terms / Privacy Checkbox if present
    const termsSelector = 'input[type="checkbox"][name*="term" i], input[type="checkbox"][name*="agree" i], input[type="checkbox"][id*="term" i]';
    const termsEl = await page.$(termsSelector);
    if (termsEl) {
      await termsEl.check().catch(() => {});
    }

    // 5. Submit Registration Form
    const submitBtnSelector = 'button[type="submit"], input[type="submit"], button:has-text("Sign Up"), button:has-text("Register"), button:has-text("Create Account"), button:has-text("Submit"), button:has-text("Continue")';
    const submitBtn = await page.$(submitBtnSelector);

    if (submitBtn) {
      log.push('Submitting registration form');
      await submitBtn.click().catch(() => {});
      await Promise.race([
        page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
        page.waitForTimeout(3000)
      ]);
    } else {
      log.push('No explicit submit button found, attempting keyboard Enter');
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(3000);
    }

    // 6. Verify Session Establishment & Cookies
    const cookies = await page.context().cookies();
    const finalUrl = page.url();
    const tokens = await page.evaluate(() => {
      const keys = [];
      const regex = /token|jwt|auth|bearer|session/i;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (regex.test(k)) keys.push({ storage: 'localStorage', key: k });
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (regex.test(k)) keys.push({ storage: 'sessionStorage', key: k });
        }
      } catch {}
      return keys;
    });

    const isSuccess = cookies.length > 0 || tokens.length > 0 || (finalUrl !== startUrl && !finalUrl.includes('register'));

    return {
      status: isSuccess ? 'registered' : 'attempted',
      registered: isSuccess,
      credentials: {
        username: finalCreds.username,
        email: finalCreds.email,
        password: finalCreds.password
      },
      targetUrl,
      finalUrl,
      cookiesCount: cookies.length,
      storageTokensCount: tokens.length,
      fieldsFilled: { email: filledEmail, password: filledPassword, username: filledUsername },
      log
    };
  } catch (err) {
    return {
      status: 'error',
      registered: false,
      error: err.message,
      targetUrl,
      finalUrl: page.url(),
      log
    };
  }
}

/**
 * Autonomously logs into an existing account on the target web application.
 *
 * @param {import('playwright').Page} page - Active Playwright page
 * @param {object} opts
 * @param {string} [opts.targetUrl] - Target application URL
 * @param {string} opts.username - Username or email
 * @param {string} opts.password - Account password
 * @param {number} [opts.timeoutMs=25000] - Navigation timeout
 * @returns {Promise<object>}
 */
async function autoLogin(page, { targetUrl, username, password, timeoutMs = 25000 } = {}) {
  if (!page) return { error: 'Playwright page instance required for login automation' };
  if (!password) return { error: 'Password is required for autoLogin' };

  const log = [];
  try {
    if (targetUrl && (!page.url() || page.url() === 'about:blank' || !page.url().startsWith(targetUrl))) {
      log.push(`Navigating to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    }

    await page.waitForTimeout(1000);

    // Discover Login Link if not already on login page
    const isLogin = /log-?in|sign-?in/i.test(page.url());
    if (!isLogin) {
      const loginLink = await page.$('a:has-text("Log in"), a:has-text("Sign in"), a[href*="login"], a[href*="signin"]');
      if (loginLink) {
        await loginLink.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    // Fill Username or Email
    const userInp = await page.$('input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[type="email"], input[type="text"]');
    if (userInp && username) {
      await userInp.fill(username);
    }

    // Fill Password
    const passInp = await page.$('input[type="password"]');
    if (passInp) {
      await passInp.fill(password);
    }

    // Click Login
    const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Sign In")');
    if (submitBtn) {
      await submitBtn.click().catch(() => {});
      await Promise.race([
        page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
        page.waitForTimeout(3000)
      ]);
    } else {
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(3000);
    }

    const cookies = await page.context().cookies();
    return {
      status: 'authenticated',
      loggedIn: cookies.length > 0,
      finalUrl: page.url(),
      cookiesCount: cookies.length,
      log
    };
  } catch (err) {
    return {
      status: 'error',
      loggedIn: false,
      error: err.message,
      finalUrl: page.url(),
      log
    };
  }
}

module.exports = {
  autoRegister,
  autoLogin,
  generateAuditorCredentials
};
