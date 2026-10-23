'use strict';
/**
 * perimeter.js — Universal External Attack Surface & Reconnaissance Engine
 *
 * Performs autonomous reconnaissance against any target (hostname, domain, or URL):
 *   - DNS Records (A, AAAA, MX, TXT, DMARC, DKIM, CAA, CNAME)
 *   - Subdomain Takeover & CNAME Hijacking Risk
 *   - Perimeter TCP Port Exposure
 *   - HTTP Security Headers (CSP, HSTS, X-Frame-Options, etc.)
 *   - Cookie Security Flag Verification (HttpOnly, Secure, SameSite, __Host- prefix)
 *   - WAF & Reverse Proxy Fingerprinting
 *   - Server Header & EOL Runtime Fingerprinting
 *   - 4-Pillar Remediation & Security Grade Generation
 */

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const { buildAdvisory, calculateGrade } = require('./advisory');

const COMMON_PORTS = [
  { port: 80, service: 'HTTP' },
  { port: 443, service: 'HTTPS' },
  { port: 22, service: 'SSH', sensitive: true },
  { port: 25, service: 'SMTP', sensitive: true },
  { port: 21, service: 'FTP', sensitive: true },
  { port: 2222, service: 'GitLab SSH / Alternate SSH', sensitive: true },
  { port: 3000, service: 'Node.js / Internal App', sensitive: true },
  { port: 3306, service: 'MySQL', sensitive: true },
  { port: 5432, service: 'PostgreSQL', sensitive: true },
  { port: 6379, service: 'Redis', sensitive: true },
  { port: 6443, service: 'Kubernetes API Server', sensitive: true },
  { port: 8080, service: 'HTTP-Alt' },
  { port: 8443, service: 'HTTPS-Alt' },
  { port: 8929, service: 'GitLab HTTP Web UI', sensitive: true },
  { port: 9000, service: 'PHP-FPM / Admin Panel', sensitive: true },
  { port: 9100, service: 'Prometheus Node Exporter Metrics', sensitive: true },
  { port: 27017, service: 'MongoDB', sensitive: true }
];

const TAKEOVER_SIGNATURES = [
  { cnamePattern: /\.github\.io$/i, service: 'GitHub Pages' },
  { cnamePattern: /\.s3.*\.amazonaws\.com$/i, service: 'AWS S3 Bucket' },
  { cnamePattern: /\.herokudns\.com$/i, service: 'Heroku App' },
  { cnamePattern: /\.trafficmanager\.net$/i, service: 'Azure Traffic Manager' },
  { cnamePattern: /\.azurewebsites\.net$/i, service: 'Azure App Service' },
  { cnamePattern: /\.cloudfront\.net$/i, service: 'AWS CloudFront' },
  { cnamePattern: /\.myshopify\.com$/i, service: 'Shopify Store' },
  { cnamePattern: /\.zendesk\.com$/i, service: 'Zendesk Portal' }
];

/**
 * Normalizes input URL or host into a clean target object.
 */
function normalizeTarget(rawTarget) {
  let target = (rawTarget || '').trim();
  if (!target) throw new Error('Target domain or URL is required');

  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    target = 'https://' + target;
  }

  const parsed = new URL(target);
  return {
    url: parsed.href,
    origin: parsed.origin,
    hostname: parsed.hostname,
    protocol: parsed.protocol,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80)
  };
}

/**
 * Resolves comprehensive DNS records for a domain.
 */
async function inspectDns(domain) {
  const records = {
    a: [],
    aaaa: [],
    mx: [],
    txt: [],
    dmarc: [],
    dkim: [],
    caa: [],
    cname: null
  };

  try { records.a = await dns.resolve4(domain); } catch {}
  try { records.aaaa = await dns.resolve6(domain); } catch {}
  try { records.mx = await dns.resolveMx(domain); } catch {}
  try {
    const rawTxt = await dns.resolveTxt(domain);
    records.txt = rawTxt.map((parts) => parts.join(''));
  } catch {}

  // DMARC Check
  try {
    const dmarcTxt = await dns.resolveTxt(`_dmarc.${domain}`);
    records.dmarc = dmarcTxt.map((parts) => parts.join(''));
  } catch {}

  // DKIM Selectors Check
  const selectors = ['default', 'google', 'k1', 'mail', 's1', 'smtp'];
  for (const s of selectors) {
    try {
      const dkimTxt = await dns.resolveTxt(`${s}._domainkey.${domain}`);
      records.dkim.push({ selector: s, record: dkimTxt.map((p) => p.join('')) });
    } catch {}
  }

  // CAA Check
  try { records.caa = await dns.resolveCaa(domain); } catch {}

  // CNAME Check
  try { records.cname = await dns.resolveCname(domain); } catch {}

  return records;
}

/**
 * Checks a single TCP port with a fast timeout.
 */
function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let status = 'closed';
    let banner = '';

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      status = 'open';
      // Wait briefly for text-based banners (SSH, FTP, SMTP, HTTP)
      setTimeout(() => socket.destroy(), 600);
    });
    socket.on('data', (d) => {
      banner += d.toString('utf8', 0, Math.min(d.length, 256)).trim();
      socket.destroy();
    });
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      resolve({ port, status, banner: banner.slice(0, 120) || null });
    });

    socket.connect(port, host);
  });
}

/**
 * Probes open ports concurrently.
 */
async function probePorts(host) {
  const probes = COMMON_PORTS.map((p) =>
    probePort(host, p.port).then((res) => ({
      port: p.port,
      service: res.banner && /^SSH-/.test(res.banner) ? 'SSH' : 'Unidentified TCP service',
      expectedService: p.service,
      sensitive: !!p.sensitive,
      status: res.status,
      banner: res.banner || null
    }))
  );
  const results = await Promise.all(probes);
  return results.filter((r) => r.status === 'open');
}

/**
 * Performs an HTTP/HTTPS HEAD/GET request to collect response headers and cookies.
 */
function probeHttp(targetUrl, timeoutMs = 7000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(targetUrl);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;

      const req = lib.request(u, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-Recon/2.0'
        },
        timeout: timeoutMs,
        rejectUnauthorized: false
      }, (res) => {
        const headers = res.headers || {};
        const cookies = headers['set-cookie'] || [];
        resolve({
          statusCode: res.statusCode,
          headers,
          cookies: Array.isArray(cookies) ? cookies : [cookies],
          tls: isHttps,
          error: null
        });
        res.destroy();
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ error: 'Connection timed out' });
      });

      req.on('error', (err) => {
        resolve({ error: err.message });
      });

      req.end();
    } catch (e) {
      resolve({ error: e.message });
    }
  });
}

/**
 * Identifies WAF and Reverse Proxy fingerprints from response headers.
 */
function identifyWaf(headers = {}) {
  const lowerHeaders = Object.keys(headers).reduce((acc, k) => {
    acc[k.toLowerCase()] = headers[k];
    return acc;
  }, {});

  const detected = [];
  const server = String(lowerHeaders['server'] || '');

  if (server.toLowerCase().includes('cloudflare') || lowerHeaders['cf-ray']) {
    detected.push({ name: 'Cloudflare', type: 'Edge CDN / WAF' });
  }
  if (server.toLowerCase().includes('traefik')) {
    detected.push({ name: 'Traefik', type: 'Cloud-Native Ingress Proxy' });
  }
  if (server.toLowerCase().includes('nginx') || lowerHeaders['x-nginx-cache']) {
    detected.push({ name: 'Nginx', type: 'Reverse Proxy / Web Server' });
  }
  if (lowerHeaders['x-amz-cf-id'] || server.toLowerCase().includes('cloudfront')) {
    detected.push({ name: 'AWS CloudFront', type: 'CDN / Edge Proxy' });
  }
  if (lowerHeaders['x-envoy-upstream-service-time'] || server.toLowerCase().includes('envoy')) {
    detected.push({ name: 'Envoy', type: 'Service Proxy / Mesh' });
  }
  if (server.toLowerCase().includes('caddy')) {
    detected.push({ name: 'Caddy', type: 'Web Server with Auto-HTTPS' });
  }

  return {
    fingerprints: detected,
    serverHeader: server || null,
    originBypassRisk: detected.length > 0 && detected.some((w) => w.type.includes('CDN'))
      ? 'If public DNS records point directly to origin IP rather than CDN proxy, attackers can bypass WAF protection.'
      : null
  };
}

/**
 * Audits cookies for security best practices.
 */
function auditCookies(cookies = []) {
  const issues = [];
  for (const c of cookies) {
    const raw = String(c);
    const nameMatch = raw.match(/^([^=]+)=/);
    const name = nameMatch ? nameMatch[1].trim() : 'cookie';

    const isHttpOnly = /httponly/i.test(raw);
    const isSecure = /secure/i.test(raw);
    const hasSameSite = /samesite=(lax|strict|none)/i.test(raw);
    const hasPrefix = name.startsWith('__Host-') || name.startsWith('__Secure-');

    if (!isHttpOnly || !isSecure || !hasSameSite) {
      issues.push({
        cookie: name,
        httpOnly: isHttpOnly,
        secure: isSecure,
        sameSite: hasSameSite,
        prefixed: hasPrefix
      });
    }
  }
  return issues;
}

/**
 * Executes full reconnaissance on a target and builds structured 4-pillar findings.
 */

async function auditTarget(rawTarget) {
  const target = normalizeTarget(rawTarget);
  const findings = [];

  // 1. DNS Reconnaissance
  const ipTarget = net.isIP(target.hostname) !== 0;
  const dnsRecords = ipTarget ? { a: [], aaaa: [], mx: [], txt: [], dmarc: [], dkim: [], caa: [], cname: null }
    : await inspectDns(target.hostname);
  const dnsAssessed = !ipTarget && Boolean(dnsRecords.a.length || dnsRecords.aaaa.length ||
    dnsRecords.mx.length || dnsRecords.txt.length || dnsRecords.caa.length || dnsRecords.cname);

  if (dnsAssessed) {
  // Check SPF
  const spf = dnsRecords.txt.find((t) => t.startsWith('v=spf1'));
  if (!spf) {
    findings.push(buildAdvisory('spf', {
      evidence: 'No TXT record starting with v=spf1 found on apex domain.'
    }));
  } else if (spf.includes('+all') || spf.includes('?all')) {
    findings.push(buildAdvisory('spf', {
      title: 'Overly Permissive SPF Record (' + (spf.includes('+all') ? '+all' : '?all') + ')',
      severity: 'HIGH',
      evidence: spf
    }));
  }

  // Check DMARC
  const dmarc = dnsRecords.dmarc.find((t) => t.startsWith('v=DMARC1'));
  if (!dmarc) {
    findings.push(buildAdvisory('dmarc', {
      evidence: `No TXT record found at _dmarc.${target.hostname}`
    }));
  } else if (dmarc.includes('p=none')) {
    findings.push(buildAdvisory('dmarc', {
      title: 'DMARC Policy Set to Monitor Only (p=none)',
      severity: 'MEDIUM',
      evidence: dmarc,
      threatScenario: 'The domain publishes a DMARC policy, but with p=none mail receivers will not reject forged sender envelopes, allowing spoofed emails through.'
    }));
  }

  // Check CNAME Subdomain Takeover
  if (dnsRecords.cname && dnsRecords.cname.length > 0) {
    for (const cname of dnsRecords.cname) {
      for (const sig of TAKEOVER_SIGNATURES) {
        if (sig.cnamePattern.test(cname)) {
          findings.push(buildAdvisory('cname_takeover', {
            title: `Potential Subdomain Takeover: ${sig.service}`,
            evidence: `CNAME points to ${cname} matching signature ${sig.service}`
          }));
        }
      }
    }
  }
  }

  // 2. HTTP Perimeter & Headers
  const httpProbe = await probeHttp(target.url);
  const headers = httpProbe.headers || {};
  const wafInfo = identifyWaf(headers);

  if (!httpProbe.error && httpProbe.statusCode) {
  // Check CSP
  if (!headers['content-security-policy']) {
    findings.push(buildAdvisory('csp', {
      evidence: 'No Content-Security-Policy header returned in HTTP response.'
    }));
  }

  // Check HSTS
  if (target.protocol === 'https:' && !headers['strict-transport-security']) {
    findings.push(buildAdvisory('hsts', {
      evidence: 'No Strict-Transport-Security header returned.'
    }));
  } else if (target.protocol === 'https:') {
    const hstsVal = String(headers['strict-transport-security']);
    const maxAgeMatch = hstsVal.match(/max-age=(\d+)/i);
    const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 0;
    if (maxAge < 31536000 || !hstsVal.includes('includeSubDomains')) {
      findings.push(buildAdvisory('hsts', {
        title: 'HSTS Header Missing includeSubDomains or Max-Age < 1 Year',
        severity: 'LOW',
        evidence: hstsVal
      }));
    }
  }

  // Check Frame Options (Clickjacking Posture Gap)
  if (!headers['x-frame-options'] && (!headers['content-security-policy'] || !headers['content-security-policy'].includes('frame-ancestors'))) {
    findings.push(buildAdvisory('clickjacking', {
      title: 'Missing Clickjacking Defense (X-Frame-Options / frame-ancestors)',
      severity: 'LOW',
      category: 'POSTURE_HARDENING',
      evidence: 'Neither X-Frame-Options nor CSP frame-ancestors is present.',
      impact: 'The target lacks explicit framing restrictions. However, modern browsers enforce Lax SameSite cookies by default, mitigating cross-site state-changing actions in framed contexts.',
      threatScenario: 'If target hosts authenticated sensitive actions and does not set SameSite cookies or frame-ancestors, an attacker may attempt to overlay an invisible iframe to induce unintentional clicks.'
    }));
  }

  // Check MIME Sniffing
  if (!headers['x-content-type-options']) {
    findings.push(buildAdvisory('content_sniffing', {
      evidence: 'Missing X-Content-Type-Options: nosniff header.'
    }));
  }

  // Cookie Security
  const cookieIssues = auditCookies(httpProbe.cookies);
  if (cookieIssues.length > 0) {
    findings.push(buildAdvisory('cookie_security', {
      evidence: `${cookieIssues.length} cookie(s) lack HttpOnly, Secure, or SameSite controls: ${cookieIssues.map((c) => c.cookie).join(', ')}`
    }));
  }
  }

  // 3. Port Scan
  const openPorts = await probePorts(target.hostname);
  const sensitivePorts = openPorts.filter((p) => p.sensitive);
  if (sensitivePorts.length > 0) {
    const portDetails = sensitivePorts.map((p) => `Port ${p.port}/TCP (${p.service})${p.banner ? ` [Banner: ${p.banner}]` : ''} - PoC: nc -zv -w 3 ${target.hostname} ${p.port}`).join('; ');
    findings.push(buildAdvisory('open_ports', {
      title: 'Sensitive TCP Ports Reachable (Attack Surface)',
      severity: 'LOW',
      category: 'POSTURE_HARDENING',
      cwe: null,
      evidence: `Reachable TCP ports on ${target.hostname}: ${portDetails}. Port number alone does not verify the service, authentication, or exploitability.`,
      impact: 'Reachable administration or database ports may increase attack surface. Verify service identity, access controls, and whether exposure is intended.',
      ports: sensitivePorts
    }));
  }

  // Calculate Consolidated Grade and Dual Scores
  const calculated = calculateGrade(findings);
  const postureAssessed = !ipTarget && dnsAssessed && Boolean(httpProbe.statusCode);
  const score = postureAssessed ? calculated.score : null;
  const grade = postureAssessed ? calculated.grade : 'Unassessed';
  const postureScore = postureAssessed ? calculated.postureScore : null;
  const postureGrade = postureAssessed ? calculated.postureGrade : 'Unassessed';
  // This perimeter check does not run exploit verification engines.
  const exploitabilityScore = null;
  const exploitabilityGrade = 'Unassessed';

  // Normalized Open Ports with state
  const normalizedOpenPorts = openPorts.map((p) => ({
    port: p.port,
    service: p.service,
    expectedService: p.expectedService,
    banner: p.banner || null,
    sensitive: !!p.sensitive,
    state: 'OPEN',
    poc: `nc -zv -w 3 ${target.hostname} ${p.port}`
  }));

  // Normalized DNS records for mobile presentation
  const dnsRecordsList = [];
  if (dnsRecords.a && dnsRecords.a.length) dnsRecordsList.push({ type: 'A', host: target.hostname, value: dnsRecords.a.join(', '), status: 'OK', note: 'Authoritative IPv4 routing' });
  if (dnsRecords.aaaa && dnsRecords.aaaa.length) dnsRecordsList.push({ type: 'AAAA', host: target.hostname, value: dnsRecords.aaaa.join(', '), status: 'OK', note: 'Authoritative IPv6 routing' });
  if (dnsRecords.mx && dnsRecords.mx.length) dnsRecordsList.push({ type: 'MX', host: target.hostname, value: dnsRecords.mx.map((m) => m.exchange || m).join(', '), status: 'OK', note: 'Mail exchanger records' });
  if (dnsRecords.dmarc && dnsRecords.dmarc.length) dnsRecordsList.push({ type: 'DMARC', host: `_dmarc.${target.hostname}`, value: dnsRecords.dmarc.join('; '), status: 'OK', note: 'Domain-based Message Authentication' });
  if (dnsRecords.caa && dnsRecords.caa.length) dnsRecordsList.push({ type: 'CAA', host: target.hostname, value: dnsRecords.caa.map((c) => `${c.flags} ${c.tag} ${c.value}`).join('; '), status: 'OK', note: 'Certificate Authority Authorization' });
  if (dnsRecords.cname) dnsRecordsList.push({ type: 'CNAME', host: target.hostname, value: dnsRecords.cname, status: 'OK', note: 'Canonical name alias' });

  // Banner and HTTP observations alone do not confirm a CVE.
  const cves = [];

  return {
    target: target.hostname,
    url: target.url,
    timestamp: new Date().toISOString(),
    score,
    grade,
    postureScore,
    postureGrade,
    exploitabilityScore,
    exploitabilityGrade,
    assessmentCoverage: { dns: dnsAssessed, http: Boolean(httpProbe.statusCode), ports: true, exploitability: false },
    openPorts: normalizedOpenPorts,
    network: {
      openPorts: normalizedOpenPorts
    },
    cves,
    waf: wafInfo,
    dns: {
      a: dnsRecords.a,
      aaaa: dnsRecords.aaaa,
      mx: dnsRecords.mx,
      txtCount: dnsRecords.txt.length,
      dmarc: dnsRecords.dmarc,
      dkimCount: dnsRecords.dkim.length,
      cname: dnsRecords.cname
    },
    dnsRecords: dnsRecordsList,
    findingsCount: findings.length,
    findings,
    crawlEndpoints: []
  };
}

module.exports = {
  normalizeTarget,
  inspectDns,
  probePorts,
  probeHttp,
  identifyWaf,
  auditCookies,
  auditTarget
};
