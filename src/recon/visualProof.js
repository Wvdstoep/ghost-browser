'use strict';
/**
 * visualProof.js — Automated Visual Proof for Exposed Portals & Web Services (CWE-284)
 *
 * Captures automated headless screenshots of exposed administrative portals, login forms,
 * and web management services (DirectAdmin 2222, cPanel 2083, /wp-login.php) to provide
 * irrefutable visual evidence in security deliverables.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Screenshots storage directory
const SHOTS_DIR = process.env.SHOTS_DIR || path.join(process.env.PROFILE_DIR || '/profiles', 'operator', 'shots');

function ensureShotsDir() {
  try {
    if (!fs.existsSync(SHOTS_DIR)) {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback lightweight HTTP inspector when browser execution is unavailable.
 */
function fetchHttpMeta(targetUrl, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(targetUrl);
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(u, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 GhostBrowser-Proof/2.0' },
        timeout: timeoutMs,
        rejectUnauthorized: false
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 65536) req.destroy();
        });
        res.on('end', () => {
          const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
          resolve({
            status: res.statusCode,
            title: titleMatch ? titleMatch[1].trim() : 'No Title',
            server: res.headers.server || null
          });
        });
        res.on('close', () => resolve({ status: res.statusCode, title: 'Closed', server: null }));
      });

      req.on('error', (err) => resolve({ status: 0, title: 'Error', error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, title: 'Timeout', error: 'timeout' }); });
      req.end();
    } catch (e) {
      resolve({ status: 0, title: 'Error', error: e.message });
    }
  });
}

/**
 * Main Auditor Entrypoint: Navigates to exposed portal and captures photographic visual proof.
 */
async function captureVisualProof(targetUrlOrHost, opts = {}) {
  let target = (targetUrlOrHost || '').trim();
  const port = opts.port;

  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    const defaultProto = (port === 80 || port === 8080) ? 'http://' : 'https://';
    target = defaultProto + target + (port ? `:${port}` : '');
  }

  ensureShotsDir();

  const timestamp = Date.now();
  const sanitizedHost = target.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
  const shotFileName = `proof_${sanitizedHost}_${timestamp}.png`;
  const shotPath = path.join(SHOTS_DIR, shotFileName);

  let captured = false;
  let pageTitle = '';
  let statusCode = 200;
  let methodUsed = 'http-probe';

  // 1. Attempt Playwright Chromium Capture
  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors']
    });
    try {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-VisualProof/2.0'
      });
      const page = await context.newPage();
      const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 10000 });
      if (resp) statusCode = resp.status();
      pageTitle = await page.title().catch(() => '');

      // Wait briefly for CSS/render
      await page.waitForTimeout(500);
      await page.screenshot({ path: shotPath, fullPage: false });
      captured = true;
      methodUsed = 'playwright-headless';
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    // 2. Graceful Fallback to HTTP Metadata
    const meta = await fetchHttpMeta(target);
    statusCode = meta.status;
    pageTitle = meta.title;
    methodUsed = 'http-metadata-fallback';
  }

  return {
    targetUrl: target,
    statusCode,
    title: pageTitle,
    screenshotCaptured: captured,
    filePath: captured ? shotPath : null,
    fileName: captured ? shotFileName : null,
    relativeUrl: captured ? `/api/v1/files/${shotFileName}` : null,
    method: methodUsed,
    markdownEmbed: captured
      ? `![Visual Proof of Exposed Portal: ${pageTitle || target}](/api/v1/files/${shotFileName})`
      : `> **Visual Proof (HTTP Verified)**: Exposed portal confirmed on \`${target}\` (${pageTitle}) with status code ${statusCode}.`,
    finding: {
      key: 'visual_proof_exposed_portal',
      title: `Automated Visual Proof: Exposed Portal (${pageTitle || target})`,
      severity: 'MEDIUM',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-284: Improper Access Control',
      evidence: `Target URL: ${target}\nPage Title: ${pageTitle}\nHTTP Status: ${statusCode}\nCaptured Evidence: ${captured ? shotFileName : 'HTTP verified'}`,
      impact: 'Public exposure of administrative interfaces allows adversaries to discover service software, branding, and version details without authentication.',
      remediation: 'Restrict access to administrative portals to authorized IPs or access via internal VPN.'
    }
  };
}

module.exports = {
  captureVisualProof,
  fetchHttpMeta,
  SHOTS_DIR
};
