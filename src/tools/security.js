'use strict';
/**
 * tools/security.js — Red Team Reconnaissance & Security Audit Tools for Ghost Browser
 *
 * Exposes offensive reconnaissance and defensive verification tools to the agent loop:
 *   - recon_scan: Comprehensive perimeter & attack surface audit on any target domain
 *   - dom_security_audit: In-browser live DOM, storage token, and form security audit
 *   - session_invalidation_probe: Concurrent multi-session invalidation verification (CWE-613)
 */

const { auditTarget } = require('../recon/perimeter');
const { auditActivePage } = require('../recon/domAuditor');
const { testHttpSessionInvalidation } = require('../recon/sessionProbe');

module.exports = {
  /**
   * Run full attack surface reconnaissance against any target domain or URL.
   * If target is omitted, defaults to the domain of the active browser page.
   */
  async recon_scan(ctx, a) {
    let target = String(a.target || a.domain || a.host || '').trim();
    if (!target) {
      try {
        const pageUrl = ctx.page()?.url();
        if (pageUrl && pageUrl.startsWith('http')) {
          target = new URL(pageUrl).hostname;
        }
      } catch {}
    }

    if (!target) {
      ctx.observe('recon_scan needs a "target" domain or URL (e.g. "example.com" or "https://target.com").');
      return;
    }

    ctx.step('note', `Starting security reconnaissance on ${target}`);
    try {
      const report = await auditTarget(target);
      ctx.step('note', `Recon complete for ${target}: Score ${report.score}/100 (Grade ${report.grade}), ${report.findingsCount} findings`);

      const summaryLines = [
        `Target: ${report.target} (${report.url})`,
        `Security Score: ${report.score}/100 | Grade: ${report.grade}`,
        `WAF / Edge: ${report.waf?.fingerprints?.map((w) => w.name).join(', ') || 'None detected'}`,
        `Identified Weaknesses (${report.findingsCount}):`
      ];

      for (const f of report.findings) {
        summaryLines.push(`  - [${f.severity}] ${f.title} (${f.cwe || 'CWE'})`);
        if (f.remediation?.traefik && !f.remediation.traefik.includes('# Enforced at DNS')) {
          summaryLines.push(`    Fix: Has copy-paste Traefik & Nginx configuration`);
        }
      }

      ctx.observe(summaryLines.join('\n'));
    } catch (err) {
      ctx.step('note', `Recon scan failed on ${target}: ${err.message}`);
      ctx.observe(`Recon scan encountered an error on ${target}: ${err.message}`);
    }
  },

  /**
   * Evaluates the client-side DOM and browser storage of the currently loaded page.
   */
  async dom_security_audit(ctx) {
    const page = ctx.page();
    if (!page) {
      ctx.observe('No active browser page to audit.');
      return;
    }

    ctx.step('note', `Auditing DOM and storage for ${page.url()}`);
    try {
      const audit = await auditActivePage(page);
      ctx.step('note', `DOM audit complete: ${audit.advisories.length} issues identified`);

      const lines = [
        `DOM Security Audit for ${audit.target}:`,
        `Storage items inspected: ${audit.storageItemsCount} (${audit.sensitiveStorageFound} sensitive tokens found)`,
        `Inline scripts: ${audit.inlineScriptsCount}`
      ];

      for (const adv of audit.advisories) {
        lines.push(`  - [${adv.severity}] ${adv.title}`);
        lines.push(`    Evidence: ${adv.evidence}`);
      }

      ctx.observe(lines.join('\n'));
    } catch (err) {
      ctx.step('note', `DOM audit error: ${err.message}`);
      ctx.observe(`DOM audit failed: ${err.message}`);
    }
  },

  /**
   * Tests concurrent session invalidation upon credential change (Zain Bug Bounty / CWE-613 check).
   */
  async session_invalidation_probe(ctx, a) {
    const loginUrl = a.loginUrl;
    const loginPayload = a.loginPayload || { username: a.username, password: a.password };
    const passwordChangeUrl = a.passwordChangeUrl;
    const passwordChangePayload = a.passwordChangePayload || { oldPassword: a.password, newPassword: a.newPassword };
    const protectedUrl = a.protectedUrl;

    if (!loginUrl || !passwordChangeUrl || !protectedUrl) {
      ctx.observe('session_invalidation_probe requires "loginUrl", "passwordChangeUrl", and "protectedUrl".');
      return;
    }

    ctx.step('note', `Testing concurrent session revocation on ${loginUrl}`);
    try {
      const res = await testHttpSessionInvalidation({
        loginUrl,
        loginPayload,
        passwordChangeUrl,
        passwordChangePayload,
        protectedUrl
      });

      if (res.vulnerable) {
        ctx.step('note', 'VULNERABILITY DETECTED: CWE-613 Failure to Invalidate Session');
        ctx.observe(
          `VULNERABILITY CONFIRMED (CWE-613):\n` +
          `Session B remained valid after password change.\n` +
          `Evidence: ${res.finding?.evidence}\n` +
          `Threat Impact: ${res.finding?.impact}\n` +
          `Remediation: Implement session_version bumping in user DB or purge active tokens on password change.`
        );
      } else {
        ctx.step('note', 'Session revocation check passed — Session B properly terminated.');
        ctx.observe('Concurrent session invalidation test passed: secondary session was rejected after credential update.');
      }
    } catch (err) {
      ctx.step('note', `Session probe failed: ${err.message}`);
      ctx.observe(`Session probe encountered an error: ${err.message}`);
    }
  }
};
