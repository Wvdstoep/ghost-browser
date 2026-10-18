'use strict';
/**
 * subdomainDiscovery.js — Passive Subdomain & Certificate Transparency Enumeration (CWE-200 / CWE-284)
 *
 * Discovers subdomains passively via Certificate Transparency logs (crt.sh) and live TLS Subject
 * Alternative Name (SAN) parsing. Actively verifies live DNS resolution and detects wildcard records.
 */

const dns = require('dns').promises;
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

const HIGH_RISK_KEYWORDS = [
  'admin', 'portal', 'directadmin', 'cpanel', 'whm', 'webmail', 'mail', 'autodiscover',
  'dev', 'staging', 'test', 'qa', 'beta', 'corp', 'internal', 'vpn', 'api', 'db',
  'mysql', 'k8s', 'kube', 'grafana', 'prometheus', 'gitlab', 'jenkins'
];

/**
 * Extracts clean apex domain from any input.
 */
function extractApexDomain(raw) {
  let target = (raw || '').trim().toLowerCase();
  if (target.startsWith('http://') || target.startsWith('https://')) {
    try { target = new URL(target).hostname; } catch {}
  }
  // Remove port if present
  target = target.split(':')[0];
  // Strip www. prefix for apex query
  if (target.startsWith('www.')) target = target.slice(4);
  return target;
}

/**
 * Queries Certificate Transparency logs from crt.sh for a domain.
 */
function queryCertificateTransparency(domain, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let finished = false;
    const done = (names) => {
      if (!finished) {
        finished = true;
        resolve(names);
      }
    };

    try {
      const req = https.get(`https://crt.sh/?q=%.${encodeURIComponent(domain)}&output=json`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-CTAudit/2.0',
          'Accept': 'application/json'
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.on('data', (d) => {
          raw += d.toString();
          if (raw.length > 5 * 1024 * 1024) { // 5MB cap
            res.destroy();
            done([]);
          }
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (!Array.isArray(data)) return done([]);
            const names = new Set();
            for (const item of data) {
              if (item.name_value) {
                const parts = String(item.name_value).split('\n');
                for (let p of parts) {
                  p = p.trim().toLowerCase();
                  if (p.startsWith('*.')) p = p.slice(2);
                  if (p.endsWith('.' + domain) || p === domain) {
                    names.add(p);
                  }
                }
              }
              if (item.common_name) {
                let p = String(item.common_name).trim().toLowerCase();
                if (p.startsWith('*.')) p = p.slice(2);
                if (p.endsWith('.' + domain) || p === domain) {
                  names.add(p);
                }
              }
            }
            done([...names]);
          } catch {
            done([]);
          }
        });
      });

      req.on('error', () => done([]));
      req.on('timeout', () => { req.destroy(); done([]); });
    } catch {
      done([]);
    }
  });
}

/**
 * Connects via TLS to port 443 and parses Subject Alternative Names (SANs).
 */
function extractTlsSans(domain, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let finished = false;
    const done = (sans) => {
      if (!finished) {
        finished = true;
        resolve(sans);
      }
    };

    try {
      const socket = tls.connect({
        host: domain,
        port: 443,
        servername: domain,
        rejectUnauthorized: false,
        timeout: timeoutMs
      }, () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();
        if (!cert || !cert.subjectaltname) return done([]);
        const parts = String(cert.subjectaltname).split(',');
        const names = [];
        for (let p of parts) {
          p = p.trim();
          if (p.startsWith('DNS:')) {
            let name = p.slice(4).trim().toLowerCase();
            if (name.startsWith('*.')) name = name.slice(2);
            if (name.endsWith('.' + domain) || name === domain) names.push(name);
          }
        }
        done(names);
      });

      socket.on('error', () => done([]));
      socket.on('timeout', () => { socket.destroy(); done([]); });
    } catch {
      done([]);
    }
  });
}

/**
 * Checks if wildcard DNS is configured on the domain.
 */
async function detectWildcardDns(domain) {
  const randSub = `wb-probe-nonexistent-${Math.random().toString(36).substring(2, 10)}.${domain}`;
  try {
    const addresses = await dns.resolve4(randSub);
    return addresses && addresses.length > 0;
  } catch {
    return false;
  }
}

/**
 * Actively resolves candidate subdomains to find live assets and their IPs.
 */
async function resolveSubdomains(candidates, limit = 25) {
  const selected = candidates.slice(0, limit);
  const live = [];
  const dormant = [];

  await Promise.all(selected.map(async (sub) => {
    try {
      const ips = await dns.resolve4(sub);
      if (ips && ips.length > 0) {
        const isSensitive = HIGH_RISK_KEYWORDS.some((kw) => sub.startsWith(kw + '.') || sub.includes('.' + kw + '.'));
        live.push({
          subdomain: sub,
          ips,
          sensitive: isSensitive,
          tag: isSensitive ? 'Exposed Management / Infra Subdomain' : 'Standard Web Asset'
        });
      } else {
        dormant.push(sub);
      }
    } catch {
      dormant.push(sub);
    }
  }));

  return { live, dormant };
}

/**
 * Main Auditor Entrypoint: Discovers passive subdomains, tests live resolution, and reports risk.
 */
async function auditPassiveSubdomains(domainOrUrl) {
  const apex = extractApexDomain(domainOrUrl);
  if (!apex) return { error: 'Invalid domain or URL specified for subdomain discovery' };

  // 1. Gather candidates from Certificate Transparency and live TLS SAN
  const [ctNames, tlsSans, hasWildcard] = await Promise.all([
    queryCertificateTransparency(apex),
    extractTlsSans(apex),
    detectWildcardDns(apex)
  ]);

  // Combine and deduplicate
  // If wildcard DNS is active, arbitrary dictionary names (like directadmin, cpanel, etc.)
  // will all resolve to the wildcard IP and generate false positive assets!
  // In that case, we MUST only trust names verified in CT logs or TLS Subject Alternative Names.
  const verifiedCertNames = new Set([...ctNames, ...tlsSans]);
  verifiedCertNames.add(apex);
  verifiedCertNames.add(`www.${apex}`);

  let allCandidates = [];
  if (hasWildcard) {
    allCandidates = Array.from(verifiedCertNames).sort();
  } else {
    allCandidates = Array.from(new Set([
      apex,
      `www.${apex}`,
      `api.${apex}`,
      `app.${apex}`,
      ...verifiedCertNames
    ])).sort();
  }

  // 2. Actively resolve live vs dormant
  const { live, dormant } = await resolveSubdomains(allCandidates);

  // 3. Build findings
  const findings = [];
  const sensitiveLive = live.filter((s) => s.sensitive);

  if (sensitiveLive.length > 0) {
    findings.push({
      key: 'exposed_sensitive_subdomains',
      title: 'Exposed Administrative & Infrastructure Subdomains',
      severity: 'MEDIUM',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-200: Information Exposure',
      evidence: `Discovered ${sensitiveLive.length} sensitive subdomain(s): ${sensitiveLive.map(s => s.subdomain + ' (' + s.ips.join(',') + ')').join(', ')}`,
      impact: 'Publicly exposed management or development subdomains (DirectAdmin, CPanel, Mail, Admin) increase the organization attack surface and expose internal service endpoints.',
      remediation: 'Restrict access to administrative subdomains via firewall/VPN or internal DNS records.'
    });
  }

  if (hasWildcard) {
    findings.push({
      key: 'wildcard_dns_enabled',
      title: 'Wildcard DNS Record Enabled',
      severity: 'LOW',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-284: Improper Access Control',
      evidence: `*.${apex} resolves to a valid IP address.`,
      impact: 'Wildcard DNS records can mask dangling CNAME takeovers and make unauthorized subdomain spoofing easier to execute.',
      remediation: 'Replace wildcard DNS records with explicit A/AAAA host records where possible.'
    });
  }

  return {
    domain: apex,
    totalDiscovered: allCandidates.length,
    wildcardDns: hasWildcard,
    liveCount: live.length,
    dormantCount: dormant.length,
    liveSubdomains: live,
    historicalSubdomains: dormant.slice(0, 30),
    sensitiveSubdomains: sensitiveLive,
    findings
  };
}

module.exports = {
  auditPassiveSubdomains,
  extractApexDomain,
  detectWildcardDns
};
