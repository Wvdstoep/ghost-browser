'use strict';
/**
 * ghost-browser/src/recon/accountAutomation.js
 *
 * Autonomous Account Creation, Login & Email Verification Engine for Security Recon & Auditing
 *
 * Allows the Ghost Browser agent to:
 *   1. Dynamically generate Gmail-aliased auditor credentials (e.g. wesley.biab+audit123@gmail.com).
 *   2. Automatically discover and submit signup forms on target web applications.
 *   3. Coordinate with the logged-in Google browser profile to check Gmail inbox, extract verification links or OTP codes.
 *   4. Automatically complete email verification and establish authenticated sessions.
 *   5. Enable true multi-tenant BOLA / IDOR testing (User A and User B both verified through the same inbox).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Reads the configured owner's Google account email.
 */
function getGoogleEmail() {
  try {
    const settingsPath = path.join(process.env.PROFILE_DIR || '/profiles', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (cfg.googleAccountEmail && cfg.googleAccountEmail.includes('@')) {
        return cfg.googleAccountEmail.trim();
      }
    }
  } catch (_) {}
  return process.env.GOOGLE_ACCOUNT_EMAIL || 'wesley.biab@gmail.com';
}

/**
 * Generates disposable credentials tailored for security audits,
 * using Gmail sub-addressing (plus-tagging) so verification emails
 * arrive in the owner's logged-in Gmail inbox.
 *
 * @param {string} prefix - Credential prefix (e.g. "audit_tenant_a")
 * @param {boolean} useGmail - Whether to use the logged-in Gmail account alias
 */
function generateAuditorCredentials(prefix = 'sec_audit', useGmail = true) {
  const rand = crypto.randomBytes(4).toString('hex');
  let email = `${prefix}.${rand}@recon-auditor.local`;

  if (useGmail) {
    const baseEmail = getGoogleEmail();
    const [user, domain] = baseEmail.split('@');
    // Sanitize tag to alphanumeric
    const safeTag = prefix.replace(/[^a-zA-Z0-9]/g, '_');
    email = `${user}+${safeTag}_${rand}@${domain || 'gmail.com'}`;
  }

  return {
    username: `${prefix}_${rand}`,
    email,
    password: `SecAud!t_${crypto.randomBytes(6).toString('base64url')}#9A`,
    isGmailAlias: !!useGmail
  };
}

/**
 * Searches the logged-in Gmail inbox for the latest verification email from the target.
 * Extracts either the verification link or the OTP numeric code.
 *
 * @param {import('playwright').Page} googlePage - Active page in the 'google' profile
 * @param {object} opts
 * @param {string} [opts.targetDomain] - Target domain or service name
 * @param {string} [opts.tag] - Email tag to filter
 * @param {number} [opts.timeoutMs=35000] - Polling budget
 * @returns {Promise<object>}
 */
async function fetchVerificationFromGmail(googlePage, { targetDomain = '', tag = '', timeoutMs = 35000 } = {}) {
  if (!googlePage) {
    return { error: 'Playwright page instance for Google profile required to check Gmail' };
  }

  const log = [];
  const t0 = Date.now();
  let query = 'newer_than:10m';
  if (targetDomain) {
    try {
      const host = new URL(targetDomain.startsWith('http') ? targetDomain : `https://${targetDomain}`).hostname;
      const cleanHost = host.replace(/^www\./, '');
      query += ` ${cleanHost}`;
    } catch (_) {
      query += ` ${targetDomain}`;
    }
  }

  const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
  log.push(`Checking Gmail with query: ${query}`);

  try {
    await googlePage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
      log.push(`Gmail navigation warning: ${e.message}`);
    });

    // Poll for matching email thread rows in Gmail UI
    let foundEmail = false;
    let attempts = 0;

    while (Date.now() - t0 < timeoutMs) {
      attempts++;
      const rowCount = await googlePage.evaluate(() => {
        const rows = document.querySelectorAll('div[role="row"], tr.zA');
        return rows.length;
      }).catch(() => 0);

      if (rowCount > 0) {
        log.push(`Found ${rowCount} matching threads in Gmail (attempt ${attempts})`);
        foundEmail = true;
        break;
      }

      await googlePage.waitForTimeout(4000);
      // Click Gmail refresh button if available or re-trigger search
      await googlePage.click('div[aria-label*="Refresh" i], div[act="20"]').catch(() => {});
    }

    if (!foundEmail) {
      return {
        found: false,
        error: `No verification email arrived within ${Math.round(timeoutMs / 1000)}s for query: ${query}`,
        log
      };
    }

    // Click the top matching email thread
    log.push('Opening most recent verification email');
    const clicked = await googlePage.evaluate(() => {
      const row = document.querySelector('div[role="row"], tr.zA');
      if (row) {
        row.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      await googlePage.click('div[role="row"], tr.zA').catch(() => {});
    }

    await googlePage.waitForTimeout(2500);

    // Extract verification links and OTP codes from the email body
    const emailData = await googlePage.evaluate(() => {
      const bodyEl = document.querySelector('.a3s, [role="listitem"] div[dir="ltr"]');
      const subjectEl = document.querySelector('h2.hP, [data-thread-perm-id]');
      const fullText = (bodyEl ? bodyEl.innerText : document.body.innerText) || '';
      const subject = subjectEl ? subjectEl.innerText : '';

      // 1. Extract links
      const links = [];
      const linkElements = bodyEl ? bodyEl.querySelectorAll('a') : document.querySelectorAll('.a3s a, [role="listitem"] a');
      for (const a of linkElements) {
        const href = a.getAttribute('href');
        const text = (a.innerText || '').trim();
        if (href && href.startsWith('http')) {
          links.push({ href, text });
        }
      }

      // Best candidate link for email verification
      let verificationUrl = null;
      for (const l of links) {
        const combo = `${l.text} ${l.href}`.toLowerCase();
        if (/verify|confirm|activate|validation|token=|signup\/verify/i.test(combo) && !/unsubscribe|privacy|terms|help|google\.com/i.test(combo)) {
          verificationUrl = l.href;
          break;
        }
      }

      // If no keyword match, grab the primary CTA button or first non-standard link
      if (!verificationUrl && links.length > 0) {
        const filtered = links.filter(l => !/google\.com|support|privacy|terms/i.test(l.href));
        if (filtered.length > 0) verificationUrl = filtered[0].href;
      }

      // 2. Extract OTP numeric codes (e.g. 123456 or "code is: 987654")
      let otp = null;
      const codeMatch = fullText.match(/(?:verification|confirm(?:ation)?|security|login)?\s*code\s*(?:is|:)?\s*([0-9]{4,8})/i)
        || fullText.match(/\b([0-9]{6})\b/)
        || fullText.match(/\b([0-9]{4})\b/);

      if (codeMatch) {
        otp = codeMatch[1];
      }

      return {
        subject,
        verificationUrl,
        otp,
        snippet: fullText.slice(0, 300),
        totalLinks: links.length
      };
    });

    log.push(`Extraction result: verificationUrl=${!!emailData.verificationUrl}, otp=${emailData.otp || 'none'}`);

    return {
      found: !!(emailData.verificationUrl || emailData.otp),
      verificationUrl: emailData.verificationUrl,
      otp: emailData.otp,
      subject: emailData.subject,
      snippet: emailData.snippet,
      log
    };
  } catch (err) {
    return {
      found: false,
      error: `Failed to inspect Gmail: ${err.message}`,
      log
    };
  }
}

/**
 * Completes email verification on the target application:
 * navigates to the verification link or fills the OTP code input.
 *
 * @param {import('playwright').Page} targetPage - Active page in the target profile
 * @param {object} opts
 * @param {string} [opts.verificationUrl] - Verification URL to open
 * @param {string} [opts.otp] - Verification code to fill
 * @returns {Promise<object>}
 */
async function completeEmailVerification(targetPage, { verificationUrl, otp } = {}) {
  if (!targetPage) return { error: 'Target Playwright page required' };

  const log = [];
  try {
    if (verificationUrl) {
      log.push(`Navigating target profile to verification URL: ${verificationUrl}`);
      await targetPage.goto(verificationUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await targetPage.waitForTimeout(2000);

      const finalUrl = targetPage.url();
      const cookies = await targetPage.context().cookies();
      return {
        verified: true,
        method: 'link',
        finalUrl,
        cookiesCount: cookies.length,
        log
      };
    }

    if (otp) {
      log.push(`Filling OTP verification code: ${otp}`);
      // Find code inputs (either single code input or 4-6 digit discrete inputs)
      const codeSelector = 'input[name*="code" i], input[name*="otp" i], input[id*="code" i], input[placeholder*="code" i], input[autocomplete="one-time-code"]';
      const codeInp = await targetPage.$(codeSelector);

      if (codeInp) {
        await codeInp.fill(otp);
      } else {
        // Discrete digit inputs (e.g. 6 boxes of maxlength=1)
        const digitInputs = await targetPage.$$('input[maxlength="1"]');
        if (digitInputs.length >= otp.length) {
          for (let i = 0; i < otp.length; i++) {
            await digitInputs[i].fill(otp[i]);
          }
        }
      }

      // Click verify / submit
      const verifyBtn = await targetPage.$('button[type="submit"], input[type="submit"], button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit")');
      if (verifyBtn) {
        await verifyBtn.click().catch(() => {});
      } else {
        await targetPage.keyboard.press('Enter').catch(() => {});
      }

      await targetPage.waitForTimeout(3000);
      const cookies = await targetPage.context().cookies();

      return {
        verified: true,
        method: 'otp',
        finalUrl: targetPage.url(),
        cookiesCount: cookies.length,
        log
      };
    }

    return { verified: false, error: 'Neither verificationUrl nor otp provided' };
  } catch (err) {
    return { verified: false, error: `Failed to complete verification: ${err.message}`, log };
  }
}

/**
 * Autonomously registers a new test account on the target web application.
 *
 * Automatically:
 *   - Generates a Gmail alias (e.g. wesley.biab+auditA_123@gmail.com).
 *   - Fills and submits the registration form.
 *   - Detects if email verification is requested.
 *   - If googlePage is provided, autonomously opens Gmail, extracts the verification link/OTP, and completes verification!
 *
 * @param {import('playwright').Page} page - Target profile page
 * @param {object} opts
 * @param {string} [opts.targetUrl] - Target application URL
 * @param {string} [opts.username] - Custom username
 * @param {string} [opts.email] - Custom email
 * @param {string} [opts.password] - Custom password
 * @param {boolean} [opts.useGmail=true] - Use logged-in Gmail alias
 * @param {import('playwright').Page} [opts.googlePage] - Playwright page in 'google' profile for automated email verification
 * @param {number} [opts.timeoutMs=25000] - Navigation timeout
 * @returns {Promise<object>}
 */
async function autoRegister(page, { targetUrl, username, email, password, useGmail = true, googlePage = null, timeoutMs = 25000 } = {}) {
  if (!page) return { error: 'Playwright page instance required for account automation' };

  const creds = generateAuditorCredentials('sec_audit', useGmail);
  const finalCreds = {
    username: username || creds.username,
    email: email || creds.email,
    password: password || creds.password
  };

  const log = [];
  const startUrl = targetUrl || page.url();

  try {
    // 1. Navigate to target
    if (targetUrl && (!page.url() || page.url() === 'about:blank' || !page.url().startsWith(targetUrl))) {
      log.push(`Navigating to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch((e) => {
        log.push(`Navigation warning: ${e.message}`);
      });
    }

    await page.waitForTimeout(1000);

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

    // 3. Fill Form
    let filledEmail = false;
    let filledPassword = false;
    let filledUsername = false;

    // Email
    const emailSelector = 'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]';
    const emailEl = await page.$(emailSelector);
    if (emailEl) {
      log.push(`Filling email: ${finalCreds.email}`);
      await emailEl.fill(finalCreds.email);
      filledEmail = true;
    }

    // Username / Full Name
    const userSelector = 'input[name*="user" i], input[id*="user" i], input[name*="username" i], input[name*="name" i]:not([name*="last" i]), input[placeholder*="username" i]';
    const userEl = await page.$(userSelector);
    if (userEl) {
      await userEl.fill(finalCreds.username);
      filledUsername = true;
    }

    // Password
    const passEls = await page.$$('input[type="password"]');
    if (passEls.length > 0) {
      for (const passEl of passEls) {
        await passEl.fill(finalCreds.password);
      }
      filledPassword = true;
    }

    // Terms
    const termsSelector = 'input[type="checkbox"][name*="term" i], input[type="checkbox"][name*="agree" i], input[type="checkbox"][id*="term" i]';
    const termsEl = await page.$(termsSelector);
    if (termsEl) {
      await termsEl.check().catch(() => {});
    }

    // 4. Submit
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
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(3000);
    }

    // 5. Detect if Email Verification is Demanded
    const pageVerificationState = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const needsEmailVerification = /verify your email|confirmation email|check your inbox|verification code|sent a (link|code) to|activate your account/i.test(text);
      const hasOtpInput = !!document.querySelector('input[name*="code" i], input[name*="otp" i], input[autocomplete="one-time-code"], input[maxlength="1"]');
      return { needsEmailVerification, hasOtpInput, snippet: text.slice(0, 200) };
    });

    let emailVerificationResult = null;

    // 6. Autonomous Verification via Logged-In Gmail Profile
    if ((pageVerificationState.needsEmailVerification || pageVerificationState.hasOtpInput) && googlePage) {
      log.push('Target requires email verification — polling logged-in Gmail profile');
      const gmailResult = await fetchVerificationFromGmail(googlePage, {
        targetDomain: targetUrl || page.url(),
        timeoutMs: 35000
      });

      if (gmailResult.found) {
        log.push('Verification email found in Gmail — completing verification');
        emailVerificationResult = await completeEmailVerification(page, {
          verificationUrl: gmailResult.verificationUrl,
          otp: gmailResult.otp
        });
      } else {
        emailVerificationResult = { verified: false, error: gmailResult.error };
      }
    }

    // 7. Verify Final Session
    const cookies = await page.context().cookies();
    const finalUrl = page.url();
    const isSuccess = cookies.length > 0 || (emailVerificationResult && emailVerificationResult.verified) || (finalUrl !== startUrl && !finalUrl.includes('register'));

    return {
      status: isSuccess ? 'registered' : 'attempted',
      registered: isSuccess,
      emailVerified: emailVerificationResult ? emailVerificationResult.verified : (pageVerificationState.needsEmailVerification ? false : true),
      emailVerification: emailVerificationResult,
      credentials: {
        username: finalCreds.username,
        email: finalCreds.email,
        password: finalCreds.password,
        gmailAlias: finalCreds.email.includes('+')
      },
      targetUrl,
      finalUrl,
      cookiesCount: cookies.length,
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

    const isLogin = /log-?in|sign-?in/i.test(page.url());
    if (!isLogin) {
      const loginLink = await page.$('a:has-text("Log in"), a:has-text("Sign in"), a[href*="login"], a[href*="signin"]');
      if (loginLink) {
        await loginLink.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    const userInp = await page.$('input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[type="email"], input[type="text"]');
    if (userInp && username) {
      await userInp.fill(username);
    }

    const passInp = await page.$('input[type="password"]');
    if (passInp) {
      await passInp.fill(password);
    }

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
  getGoogleEmail,
  generateAuditorCredentials,
  fetchVerificationFromGmail,
  completeEmailVerification
};
