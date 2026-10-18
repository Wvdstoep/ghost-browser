'use strict';
/**
 * sensitiveFiles.js — Sensitive Path, Information Disclosure & RFC 9116 Security.txt Audit (CWE-200 / CWE-538)
 *
 * Probes high-priority well-known and sensitive configuration files with strict false-positive
 * validation against custom SPA 404 handler responses.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const SENSITIVE_PROBES = [
  {
    path: '/.well-known/security.txt',
    title: 'RFC 9116 security.txt Vulnerability Disclosure Policy',
    category: 'COMPLIANCE',
    severity: 'INFO',
    cwe: 'CWE-200: Information Exposure',
    validator: (status, body) => status === 200 && (body.includes('Contact:') || body.includes('Expires:'))
  },
  {
    path: '/robots.txt',
    title: 'Robots.txt Crawler Directives & Sensitive Path Exposure',
    category: 'POSTURE_HARDENING',
    severity: 'INFO',
    cwe: 'CWE-200: Information Exposure',
    validator: (status, body) => status === 200 && (body.includes('User-agent:') || body.includes('Disallow:'))
  },
  {
    path: '/sitemap.xml',
    title: 'XML Sitemap Structure Disclosure',
    category: 'POSTURE_HARDENING',
    severity: 'INFO',
    cwe: 'CWE-200: Information Exposure',
    validator: (status, body) => status === 200 && (body.includes('<urlset') || body.includes('<sitemapindex'))
  },
  {
    path: '/.git/HEAD',
    title: 'Exposed Git Source Code Repository (.git/HEAD)',
    category: 'EXPLOITABLE_VULNERABILITY',
    severity: 'CRITICAL',
    cwe: 'CWE-538: Insertion of Sensitive Information into Externally-Accessible Directory',
    validator: (status, body, headers) => {
      const ct = (headers['content-type'] || '').toLowerCase();
      if (ct.includes('html')) return false; // reject SPA 404s
      return status === 200 && (body.startsWith('ref: refs/') || /^[0-9a-f]{40}/i.test(body.trim()));
    }
  },
  {
    path: '/.env',
    title: 'Exposed Environment Secrets & Database Credentials (.env)',
    category: 'EXPLOITABLE_VULNERABILITY',
    severity: 'CRITICAL',
    cwe: 'CWE-200: Information Exposure',
    validator: (status, body, headers) => {
      const ct = (headers['content-type'] || '').toLowerCase();
      if (ct.includes('html')) return false;
      return status === 200 && /(DB_PASSWORD|APP_KEY|AWS_SECRET|SECRET_KEY|DATABASE_URL)=/i.test(body);
    }
  },
  {
    path: '/phpinfo.php',
    title: 'Exposed PHP System Configuration & Environment (phpinfo.php)',
    category: 'EXPLOITABLE_VULNERABILITY',
    severity: 'HIGH',
    cwe: 'CWE-200: Information Exposure',
    validator: (status, body) => status === 200 && (body.includes('<title>phpinfo()</title>') || body.includes('PHP Version'))
  },
  {
    path: '/wp-config.php.bak',
    title: 'WordPress Configuration Backup Disclosure (wp-config.php.bak)',
    category: 'EXPLOITABLE_VULNERABILITY',
    severity: 'CRITICAL',
    cwe: 'CWE-538: Insertion of Sensitive Information into Externally-Accessible Directory',
    validator: (status, body, headers) => {
      const ct = (headers['content-type'] || '').toLowerCase();
      if (ct.includes('html')) return false;
      return status === 200 && body.includes('DB_PASSWORD') && body.includes('DB_USER');
    }
  }
];

function fetchProbe(targetUrl, pathStr, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    try {
      const u = new URL(pathStr, targetUrl);
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(u, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-PathAudit/2.0',
          'Accept': '*/*'
        },
        timeout: timeoutMs,
        rejectUnauthorized: false
      }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
          if (body.length > 262144) { // 256KB cap
            req.destroy();
            finish({ status: res.statusCode, headers: res.headers || {}, body, url: u.href });
          }
        });
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers || {}, body, url: u.href }));
        res.on('close', () => finish({ status: res.statusCode, headers: res.headers || {}, body, url: u.href }));
      });

      req.on('error', (err) => finish({ status: 0, headers: {}, body: '', error: err.message, url: u.href }));
      req.on('timeout', () => { req.destroy(); finish({ status: 0, headers: {}, body: '', error: 'timeout', url: u.href }); });
      req.end();
    } catch (e) {
      finish({ status: 0, headers: {}, body: '', error: e.message, url: '' });
    }
  });
}

/**
 * Main Auditor Entrypoint: Probes sensitive paths and checks RFC 9116 security.txt compliance.
 */
async function auditSensitivePaths(targetUrl) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;

  const probeResults = await Promise.all(
    SENSITIVE_PROBES.map(async (p) => {
      const res = await fetchProbe(base, p.path);
      const isMatch = p.validator(res.status, res.body, res.headers);
      return {
        ...p,
        status: res.status,
        url: res.url,
        match: isMatch,
        bodySnippet: isMatch ? res.body.slice(0, 300).trim() : null
      };
    })
  );

  const findings = [];
  let securityTxtFound = false;
  let robotsTxtData = null;

  for (const r of probeResults) {
    if (r.path === '/.well-known/security.txt' && r.match) {
      securityTxtFound = true;
    }
    if (r.path === '/robots.txt' && r.match) {
      const disallows = [];
      const lines = r.bodySnippet.split('\n');
      for (const line of lines) {
        if (/^disallow:\s*(.+)$/i.test(line.trim())) {
          disallows.push(line.trim());
        }
      }
      robotsTxtData = { url: r.url, disallowRules: disallows.slice(0, 10) };
    }

    if (r.match && r.severity !== 'INFO') {
      findings.push({
        key: `sensitive_path_${r.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
        title: r.title,
        severity: r.severity,
        category: r.category,
        cwe: r.cwe,
        evidence: `HTTP ${r.status} on ${r.url}\nVerification Snippet:\n${r.bodySnippet}`,
        impact: r.category === 'EXPLOITABLE_VULNERABILITY'
          ? 'Allows unauthorized attackers to access confidential source code, server configuration, or cryptographic credentials.'
          : 'Discloses internal paths or infrastructure details to external auditors and adversaries.',
        poc: `curl.exe -i -s "${r.url}"`,
        remediation: `Block direct web server access to ${r.path} in your reverse proxy / web server configuration.`
      });
    }
  }

  // RFC 9116 Security.txt Posture Check
  if (!securityTxtFound) {
    findings.push({
      key: 'missing_security_txt',
      title: 'Missing RFC 9116 security.txt Vulnerability Disclosure Policy',
      severity: 'LOW',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-200: Information Exposure',
      evidence: `GET ${base}/.well-known/security.txt returned no active policy file.`,
      impact: 'Security researchers discovering critical zero-day vulnerabilities in your applications lack a designated contact channel or PGP key for responsible disclosure.',
      poc: `curl.exe -i "${base}/.well-known/security.txt"`,
      remediation: 'Publish an RFC 9116 compliant security.txt file at /.well-known/security.txt defining Contact, Expires, and Preferred-Languages.'
    });
  }

  return {
    target: base,
    probesAudited: SENSITIVE_PROBES.length,
    securityTxtPresent: securityTxtFound,
    robotsTxt: robotsTxtData,
    findingsCount: findings.length,
    findings
  };
}

module.exports = {
  auditSensitivePaths,
  fetchProbe,
  SENSITIVE_PROBES
};
