'use strict';
/**
 * techFingerprint.js — CMS & Technology Stack Deep Fingerprinting (CWE-200 / CWE-307)
 *
 * Fingerprints CMS platforms (WordPress, Drupal, Joomla, Next.js, Laravel, Shopify),
 * web servers (LiteSpeed, Nginx, Apache, IIS, Cloudflare), and conducts specialized probes
 * against WordPress endpoints (/wp-json/wp/v2/users, /xmlrpc.php, /wp-login.php).
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function requestHttp(targetUrl, opts = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (res) => {
      if (!resolved) {
        resolved = true;
        resolve(res);
      }
    };

    try {
      const u = new URL(targetUrl);
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(u, {
        method: opts.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-TechAudit/2.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
          ...(opts.headers || {})
        },
        timeout: opts.timeout || 6000,
        rejectUnauthorized: false
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > (opts.maxBytes || 524288)) {
            req.destroy();
            finish({ status: res.statusCode, headers: res.headers || {}, body });
          }
        });
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers || {}, body }));
        res.on('close', () => finish({ status: res.statusCode, headers: res.headers || {}, body }));
      });

      req.on('error', (err) => finish({ status: 0, headers: {}, body: '', error: err.message }));
      req.on('timeout', () => { req.destroy(); finish({ status: 0, headers: {}, body: '', error: 'timeout' }); });

      if (opts.body) req.write(opts.body);
      req.end();
    } catch (e) {
      finish({ status: 0, headers: {}, body: '', error: e.message });
    }
  });
}

/**
 * Normalizes root base URL.
 */
function toBaseUrl(target) {
  let t = (target || '').trim();
  if (!t.startsWith('http://') && !t.startsWith('https://')) t = 'https://' + t;
  const u = new URL(t);
  return `${u.protocol}//${u.host}`;
}

/**
 * Inspects homepage HTML and headers for technology signatures.
 */
function analyzeHomeSignatures(headers, html) {
  const techs = [];
  const server = String(headers.server || '').toLowerCase();
  const poweredBy = String(headers['x-powered-by'] || '').toLowerCase();

  // Web Server
  if (server.includes('litespeed')) techs.push({ name: 'LiteSpeed Web Server', category: 'Web Server', confidence: 1.0 });
  else if (server.includes('nginx')) techs.push({ name: 'Nginx', category: 'Web Server', confidence: 0.9 });
  else if (server.includes('apache')) techs.push({ name: 'Apache HTTP Server', category: 'Web Server', confidence: 0.9 });
  else if (server.includes('cloudflare')) techs.push({ name: 'Cloudflare Edge Proxy', category: 'CDN / WAF', confidence: 1.0 });

  // LiteSpeed Cache
  if (headers['x-litespeed-cache'] || headers['x-lsadc-cache'] || html.includes('<!-- Page delivered by LiteSpeed Cache')) {
    techs.push({ name: 'LiteSpeed Cache', category: 'Caching Layer', confidence: 1.0 });
  }

  // Runtime
  if (poweredBy.includes('php')) {
    techs.push({ name: 'PHP Runtime', category: 'Backend Runtime', detail: poweredBy, confidence: 1.0 });
  } else if (poweredBy.includes('express')) {
    techs.push({ name: 'Express.js', category: 'Web Framework', confidence: 1.0 });
  } else if (poweredBy.includes('next.js') || html.includes('__NEXT_DATA__')) {
    techs.push({ name: 'Next.js React Framework', category: 'Frontend Framework', confidence: 1.0 });
  }

  // CMS Checks
  if (html.includes('/wp-content/') || html.includes('/wp-includes/') || /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress/i.test(html)) {
    let version = null;
    const match = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s*([0-9.]+)/i);
    if (match) version = match[1];
    techs.push({ name: 'WordPress', category: 'CMS', version, confidence: 1.0 });
  }

  if (html.includes('drupal.js') || /<meta[^>]+name=["']generator["'][^>]+content=["']Drupal/i.test(html)) {
    techs.push({ name: 'Drupal', category: 'CMS', confidence: 0.9 });
  }

  if (html.includes('/media/system/js/') || /<meta[^>]+name=["']generator["'][^>]+content=["']Joomla/i.test(html)) {
    techs.push({ name: 'Joomla', category: 'CMS', confidence: 0.9 });
  }

  if (html.includes('cdn.shopify.com') || html.includes('Shopify.theme')) {
    techs.push({ name: 'Shopify', category: 'E-commerce Platform', confidence: 1.0 });
  }

  if (html.includes('laravel_session') || html.includes('XSRF-TOKEN')) {
    techs.push({ name: 'Laravel Framework', category: 'Web Framework', confidence: 0.8 });
  }

  return techs;
}

/**
 * Executes specialized deep probes against WordPress endpoints if WP or PHP stack is detected.
 */
async function probeWordPressSecurity(baseUrl) {
  const wpResults = {
    isWordPress: false,
    version: null,
    userEnumeration: { exposed: false, users: [] },
    xmlrpc: { exposed: false, methods: [] },
    loginUrl: `${baseUrl}/wp-login.php`,
    loginAccessible: false,
    plugins: []
  };

  // 1. Check REST API users endpoint
  const usersRes = await requestHttp(`${baseUrl}/wp-json/wp/v2/users`, { timeout: 4000 });
  if (usersRes.status === 200 && usersRes.body.startsWith('[')) {
    try {
      const usersData = JSON.parse(usersRes.body);
      if (Array.isArray(usersData) && usersData.length > 0) {
        wpResults.isWordPress = true;
        wpResults.userEnumeration.exposed = true;
        wpResults.userEnumeration.users = usersData.slice(0, 10).map((u) => ({
          id: u.id,
          slug: u.slug,
          name: u.name
        }));
      }
    } catch {}
  }

  // 2. Check XML-RPC
  const xmlrpcProbe = '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>';
  const xmlrpcRes = await requestHttp(`${baseUrl}/xmlrpc.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xmlrpcProbe,
    timeout: 4000
  });

  if (xmlrpcRes.status === 200 && xmlrpcRes.body.includes('<methodResponse>')) {
    wpResults.isWordPress = true;
    wpResults.xmlrpc.exposed = true;
    // Extract methods if present
    const methods = [];
    const methodMatches = xmlrpcRes.body.matchAll(/<value><string>([^<]+)<\/string><\/value>/g);
    for (const m of methodMatches) {
      if (methods.length < 15) methods.push(m[1]);
    }
    wpResults.xmlrpc.methods = methods;
  }

  // 3. Check /wp-login.php
  const loginRes = await requestHttp(`${baseUrl}/wp-login.php`, { timeout: 4000 });
  if (loginRes.status === 200 && loginRes.body.includes('user_login')) {
    wpResults.isWordPress = true;
    wpResults.loginAccessible = true;
  }

  return wpResults;
}

/**
 * Main Auditor Entrypoint: Fingerprints complete technology stack and flags high-risk configuration disclosures.
 */
async function auditTechStack(targetUrl) {
  const baseUrl = toBaseUrl(targetUrl);
  const homeRes = await requestHttp(baseUrl, { timeout: 7000 });

  const technologies = analyzeHomeSignatures(homeRes.headers || {}, homeRes.body || '');
  const hasWpIndicator = technologies.some((t) => t.name === 'WordPress') || homeRes.body.includes('wp-content');

  let wpDetails = null;
  if (hasWpIndicator || homeRes.headers.server?.toLowerCase().includes('litespeed')) {
    wpDetails = await probeWordPressSecurity(baseUrl);
    if (wpDetails.isWordPress && !technologies.some((t) => t.name === 'WordPress')) {
      technologies.push({ name: 'WordPress', category: 'CMS', confidence: 1.0 });
    }
  }

  // Build findings
  const findings = [];

  if (wpDetails && wpDetails.userEnumeration.exposed) {
    const userList = wpDetails.userEnumeration.users.map(u => u.slug).join(', ');
    findings.push({
      key: 'wordpress_user_enumeration',
      title: 'WordPress REST API Public User Enumeration (CWE-200)',
      severity: 'MEDIUM',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-200: Information Exposure',
      evidence: `GET ${baseUrl}/wp-json/wp/v2/users returned 200 OK disclosing author usernames: [${userList}]`,
      impact: 'Enables malicious actors to harvest legitimate usernames, fueling targeted dictionary attacks and automated brute force against /wp-login.php or XML-RPC.',
      remediation: 'Disable unauthenticated REST API user endpoints in functions.php or security plugins (e.g. Wordfence, Disable REST API).'
    });
  }

  if (wpDetails && wpDetails.xmlrpc.exposed) {
    findings.push({
      key: 'wordpress_xmlrpc_exposed',
      title: 'WordPress XML-RPC Interface Publicly Accessible (CWE-307 / CWE-400)',
      severity: 'MEDIUM',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-307: Improper Restriction of Excessive Authentication Attempts',
      evidence: `POST ${baseUrl}/xmlrpc.php accepted system.listMethods with 200 OK response.`,
      impact: 'XML-RPC supports pingback amplification (used for DDoS reflection) and multicall authentication (allowing hundreds of credential guesses per single HTTP request).',
      remediation: 'Disable xmlrpc.php in web server configuration (.htaccess or Nginx `location = /xmlrpc.php { deny all; }`).'
    });
  }

  if (wpDetails && wpDetails.loginAccessible) {
    findings.push({
      key: 'exposed_admin_login_portal',
      title: 'Exposed WordPress Administrative Login Interface',
      severity: 'LOW',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-284: Improper Access Control',
      evidence: `GET ${baseUrl}/wp-login.php returns active login form.`,
      impact: 'Exposes administrative login to public credential stuffing and brute force attempts.',
      remediation: 'Enforce two-factor authentication (2FA), rate limiting, and restrict wp-login.php to authorized administrative IP ranges.'
    });
  }

  return {
    target: baseUrl,
    server: homeRes.headers.server || 'Undisclosed',
    technologies,
    wordpressAudit: wpDetails,
    findingsCount: findings.length,
    findings
  };
}

module.exports = {
  auditTechStack,
  analyzeHomeSignatures,
  probeWordPressSecurity,
  toBaseUrl
};
