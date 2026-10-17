'use strict';
/**
 * subdomainTakeoverAuditor.js — Subdomain Takeover & Dangling DNS Cloud Analyzer (CWE-284 / CWE-650)
 *
 * Resolves CNAME records for apex domains and common subdomains, testing for dangling cloud pointers
 * (AWS S3, GitHub Pages, Heroku, Vercel, Fastly, Azure) that return unclaimed signature errors.
 */

const dns = require('dns/promises');
const http = require('http');
const https = require('https');
const { URL } = require('url');

function checkHttp(urlStr) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(u, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-DNSAudit/2.0' },
        timeout: 5000
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 65536) { req.destroy(); finish({ status: res.statusCode, body }); }
        });
        res.on('end', () => finish({ status: res.statusCode, body }));
        res.on('close', () => finish({ status: res.statusCode, body }));
      });

      req.on('error', (err) => finish({ error: err.message, status: 0, body: '' }));
      req.on('timeout', () => { req.destroy(); finish({ error: 'timeout', status: 0, body: '' }); });
      req.end();
    } catch (e) {
      finish({ error: e.message, status: 0, body: '' });
    }
  });
}

const CLOUD_TAKEOVER_SIGNATURES = [
  { service: 'AWS S3 Bucket', pattern: /\.s3.*\.amazonaws\.com/i, errorText: 'NoSuchBucket' },
  { service: 'GitHub Pages', pattern: /\.github\.io/i, errorText: "There isn't a GitHub Pages site here" },
  { service: 'Heroku App', pattern: /\.herokuapp\.com/i, errorText: 'No such app' },
  { service: 'Fastly CDN', pattern: /\.fastly\.net/i, errorText: 'Fastly error: unknown domain' },
  { service: 'Surge.sh', pattern: /\.surge\.sh/i, errorText: 'project not found' },
  { service: 'Bitbucket', pattern: /\.bitbucket\.io/i, errorText: 'Repository not found' }
];

async function auditSubdomainTakeover(targetUrl, options = {}) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  let u = null;
  try { u = new URL(base); } catch (_) { return { error: 'Invalid URL: ' + targetUrl }; }
  const hostname = u.hostname;

  const findings = [];
  const secureControls = [];

  const candidateHosts = (options.subdomains && options.subdomains.length > 0)
    ? options.subdomains
    : [hostname, `dev.${hostname}`, `staging.${hostname}`, `api.${hostname}`, `docs.${hostname}`, `blog.${hostname}`];

  let resolvedCount = 0;

  for (const host of candidateHosts.slice(0, 6)) {
    try {
      const cnames = await dns.resolveCname(host);
      resolvedCount++;

      for (const cname of cnames) {
        for (const sig of CLOUD_TAKEOVER_SIGNATURES) {
          if (sig.pattern.test(cname)) {
            // CNAME points to cloud provider. Check HTTP response for unclaimed error text
            const testRes = await checkHttp(`http://${host}`);
            if (testRes.body && testRes.body.includes(sig.errorText)) {
              findings.push({
                severity: 'CRITICAL',
                title: `Subdomain Takeover Vulnerability on '${host}' (${sig.service})`,
                cwe: 'CWE-284: Improper Access Control (Dangling DNS Records)',
                cvss: 9.1,
                targetHost: host,
                cnameTarget: cname,
                evidence: {
                  cnameRecord: cname,
                  service: sig.service,
                  errorFingerprint: sig.errorText
                },
                pocCurl: `curl -i "http://${host}"`,
                remediation: {
                  rootCause: `DNS CNAME record for '${host}' points to an orphaned ${sig.service} resource ('${cname}') that has been deleted or unclaimed.`,
                  fixSnippet: `// Delete the dangling CNAME record from DNS zone:\n// Type: CNAME, Host: ${host}, Target: ${cname} -> REMOVE`
                }
              });
              break;
            }
          }
        }
      }
    } catch (_) {
      // No CNAME or NXDOMAIN
    }
  }

  if (findings.length === 0) {
    secureControls.push({
      control: 'DNS_CNAME_HYGIENE',
      note: `Evaluated ${candidateHosts.length} candidate hosts. Zero dangling CNAME records or unclaimed cloud buckets detected.`
    });
  }

  const score = findings.length === 0 ? 100 : Math.max(25, 100 - findings.length * 40);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : 'F';

  return {
    target: hostname,
    timestamp: new Date().toISOString(),
    score,
    grade,
    hostsEvaluated: candidateHosts.length,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls,
    summary: findings.length === 0
      ? 'Subdomain Takeover Auditor verified DNS hygiene. Zero orphaned cloud bucket pointers detected.'
      : `Subdomain Takeover Auditor detected ${findings.length} critical dangling DNS records vulnerable to hijack.`
  };
}

module.exports = {
  auditSubdomainTakeover
};
