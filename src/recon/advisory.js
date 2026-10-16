'use strict';
/**
 * advisory.js — 4-Pillar Vulnerability Detail Model & Remediation Engine
 *
 * For every finding identified during reconnaissance or runtime inspection,
 * this engine builds actionable, copy-pasteable advisories conforming to:
 *   1. Root Cause & Technical Breakdown
 *   2. Threat Modeling & Real-world Attack Scenarios
 *   3. Copy-Paste Remediation for Target Stacks (Traefik, Nginx, Express, DNS)
 *   4. Secondary Defenses & WAF Mitigation Rules
 */

const REMEDIATION_TEMPLATES = {
  csp: {
    title: 'Missing or Incomplete Content Security Policy (CSP)',
    cwe: 'CWE-1021 / CWE-79',
    owasp: 'A05:2021-Security Misconfiguration',
    severity: 'HIGH',
    impact: 'High risk of Cross-Site Scripting (XSS), data exfiltration, clickjacking, and unauthorized inline script injection.',
    rootCause: 'The server did not send a Content-Security-Policy header. Modern browsers rely on CSP to restrict resource origins (scripts, styles, frames, connections) and block reflected/stored XSS execution.',
    threatScenario: 'An attacker injects a malicious <script> tag or loads a compromised third-party script. Without CSP, the browser executes the payload in the context of the user session, exfiltrating session tokens, cookies, and sensitive DOM state.',
    traefik: `# Traefik Dynamic Configuration (File or Middleware CRD)
http:
  middlewares:
    sec-headers:
      headers:
        contentSecurityPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https: data:; connect-src 'self' https: wss:; frame-ancestors 'none'; object-src 'none'; base-uri 'self';"
`,
    nginx: `# Nginx Server or Location Block
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https: data:; connect-src 'self' https: wss:; frame-ancestors 'none'; object-src 'none'; base-uri 'self';" always;
`,
    express: `// Express.js with Helmet
const helmet = require('helmet');
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https:"],
    styleSrc: ["'self'", "'unsafe-inline'", "https:"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'", "https:", "wss:"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"]
  }
}));
`,
    dns: `# CSP is an HTTP response header; no direct DNS record required.
# Ensure all canonical subdomains and CDNs are explicitly whitelisted in script-src.
`,
    secondaryDefense: 'Deploy a Web Application Firewall (WAF) such as Cloudflare WAF or Coraza/ModSecurity to filter common script injection patterns in query parameters, headers, and request bodies.'
  },

  hsts: {
    title: 'Missing or Insufficient HTTP Strict Transport Security (HSTS)',
    cwe: 'CWE-319',
    owasp: 'A02:2021-Cryptographic Failures',
    severity: 'HIGH',
    impact: 'Susceptible to SSL-stripping and Man-in-the-Middle (MitM) attacks on unencrypted initial HTTP connections.',
    rootCause: 'The server does not enforce Strict-Transport-Security, or max-age is set below 1 year (31536000 seconds), omitting includeSubDomains and preload.',
    threatScenario: 'A user on a public or compromised Wi-Fi network navigates to the plain http:// version. An active MitM interceptor intercepts the plain HTTP request before TLS upgrade, stripping HTTPS and intercepting credentials or session tokens in cleartext.',
    traefik: `# Traefik Dynamic Configuration
http:
  middlewares:
    sec-headers:
      headers:
        stsSeconds: 63072000
        stsIncludeSubdomains: true
        stsPreload: true
        forceSTSHeader: true
`,
    nginx: `# Nginx Configuration
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
`,
    express: `// Express.js with Helmet
const helmet = require('helmet');
app.use(helmet.hsts({
  maxAge: 63072000,
  includeSubDomains: true,
  preload: true
}));
`,
    dns: `# DNS / HSTS Preload
# Once deployed, submit your apex domain to https://hstspreload.org
# This bakes HTTPS-only enforcement directly into Google Chrome, Firefox, and Safari.
`,
    secondaryDefense: 'Configure immediate HTTP to HTTPS 301 Permanent Redirects at the edge router/ingress.'
  },

  dmarc: {
    title: 'Insecure DMARC Policy (Missing or Quarantine/Reject Disabled)',
    cwe: 'CWE-290 / CWE-358',
    owasp: 'A05:2021-Security Misconfiguration',
    severity: 'MEDIUM',
    impact: 'High vulnerability to direct email spoofing, executive impersonation, and phishing campaigns launched under your domain identity.',
    rootCause: 'The TXT record for _dmarc.<domain> is missing or specifies "p=none", which acts in monitor-only mode and instructs receiving mail servers to deliver forged emails to inboxes.',
    threatScenario: 'An attacker uses an open SMTP relay or custom mail server to dispatch fraudulent emails with your domain in the "From:" header (e.g., support@<domain> or ceo@<domain>). Without p=reject, Gmail and Outlook deliver the message directly to customer inboxes.',
    traefik: `# DMARC is enforced via DNS TXT records rather than HTTP proxy middlewares.
`,
    nginx: `# DMARC is enforced via DNS TXT records rather than HTTP web server headers.
`,
    express: `# DMARC is enforced via DNS TXT records rather than application code.
`,
    dns: `# DNS TXT Record for _dmarc.<domain>
# Host / Name:  _dmarc
# Type:         TXT
# Value:
v=DMARC1; p=reject; sp=reject; rua=mailto:dmarc-reports@<domain>; ruf=mailto:dmarc-forensics@<domain>; fo=1; pct=100;
`,
    secondaryDefense: 'Monitor incoming RUA aggregate reports to identify any legitimate third-party sending services (SendGrid, Mailgun, Postmark) before transitioning from p=quarantine to p=reject.'
  },

  spf: {
    title: 'Missing or Overly Permissive SPF Record',
    cwe: 'CWE-290',
    owasp: 'A05:2021-Security Misconfiguration',
    severity: 'MEDIUM',
    impact: 'Unauthorized servers can forge mail on behalf of this domain.',
    rootCause: 'Domain lacks an SPF TXT record or ends with "+all" or "?all" (neutral), granting sending rights to any host on the internet.',
    threatScenario: 'Attackers target employees or customers with phishing emails originating from random VPS hosts; anti-spam filters see no SPF constraint and deliver the malicious payload.',
    traefik: `# Enforced at DNS layer.
`,
    nginx: `# Enforced at DNS layer.
`,
    express: `# Enforced at DNS layer.
`,
    dns: `# DNS TXT Record for apex domain (@)
# Type:  TXT
# Value:
v=spf1 mx a include:_spf.google.com ~all
# Note: Substitute your verified mail server IP (ip4:x.x.x.x) or provider include.
`,
    secondaryDefense: 'Deploy strict DKIM key signing and DMARC p=reject alignment.'
  },

  session_invalidation: {
    title: 'Failure to Invalidate Concurrent Sessions on Credential Change',
    cwe: 'CWE-613: Insufficient Session Expiration',
    owasp: 'A07:2021-Identification and Authentication Failures',
    severity: 'HIGH',
    impact: 'Compromised or stolen sessions remain fully active even after an account owner changes their password.',
    rootCause: 'User authentication relies on stateless JWTs without revocation tracking, or the backend session store fails to bump a session_version / invalidate active bearer tokens across all devices when credentials are changed.',
    threatScenario: 'An attacker gains access to an employee session via session hijacking, cookie theft, or an unattended terminal. The employee notices anomalous behavior and immediately resets their password. Because the session store does not purge existing session tokens or verify session_version on protected requests, the attacker retains full unauthenticated-equivalent access to the compromised account.',
    traefik: `# Ingress rate limiting & session gate middleware can restrict anomalous access:
http:
  middlewares:
    auth-ratelimit:
      rateLimit:
        average: 10
        burst: 20
`,
    nginx: `# Nginx cannot track application session versions directly; ensure proxy passes authorization headers cleanly:
proxy_set_header Authorization $http_authorization;
`,
    express: `// Express.js Session Versioning Implementation
// In user DB schema: store \`session_version\` (INTEGER, defaults to 1)

// On Password Change:
async function updatePassword(userId, newHashedPassword) {
  await db.query(
    'UPDATE users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2',
    [newHashedPassword, userId]
  );
  // Also delete active Redis sessions for this user if using session store:
  // await redis.del(\`sessions:\${userId}:*\`);
}

// In Authentication Middleware:
async function verifySession(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const decoded = jwt.verify(token, JWT_SECRET);
  const user = await db.getUserById(decoded.userId);
  
  if (!user || user.session_version !== decoded.sessionVersion) {
    return res.status(401).json({ error: 'Session revoked due to password change or logout.' });
  }
  req.user = user;
  next();
}
`,
    dns: `# Application-level authentication finding; no DNS changes required.
`,
    secondaryDefense: 'Implement refresh token rotation and maintain a Redis token denylist or atomic DB session_version counter.'
  },

  cookie_security: {
    title: 'Insecure Cookie Attributes (Missing Secure, HttpOnly, or SameSite)',
    cwe: 'CWE-614 / CWE-1004 / CWE-1275',
    owasp: 'A05:2021-Security Misconfiguration',
    severity: 'MEDIUM',
    impact: 'Session cookies exposed to Cross-Site Scripting (XSS) extraction or Cross-Site Request Forgery (CSRF).',
    rootCause: 'Set-Cookie headers lack the Secure attribute (allowing transmission over plain HTTP), HttpOnly (accessible via document.cookie in JS), or SameSite=Lax/Strict (allowing cross-site request embedding).',
    threatScenario: 'If XSS occurs on the application, an attacker executes document.cookie and transmits session tokens to an external server. Alternatively, absent SameSite controls permit third-party malicious sites to trigger authenticated state-changing actions.',
    traefik: `# Traefik can enforce cookie attributes via response headers if upstream misses them:
http:
  middlewares:
    cookie-sec:
      headers:
        customResponseHeaders:
          Set-Cookie: "; Secure; HttpOnly; SameSite=Lax"
`,
    nginx: `# Nginx proxy cookie flag modifier
proxy_cookie_path / "/; Secure; HttpOnly; SameSite=Lax";
`,
    express: `// Express Session Cookie Settings
app.use(session({
  name: '__Host-session',
  secret: process.env.SESSION_SECRET,
  cookie: {
    httpOnly: true,
    secure: true, // Requires HTTPS
    sameSite: 'lax', // or 'strict' for high-security panels
    domain: undefined, // __Host- requires no domain attribute
    path: '/',
    maxAge: 3600000 // 1 hour
  }
}));
`,
    dns: `# No direct DNS records for cookies.
`,
    secondaryDefense: 'Prefix critical session cookies with __Host- or __Secure- to enforce origin-bound HTTPS isolation in modern browsers.'
  },

  cname_takeover: {
    title: 'Dangling CNAME / Subdomain Takeover Risk',
    cwe: 'CWE-350 / CWE-284',
    owasp: 'A05:2021-Security Misconfiguration',
    severity: 'CRITICAL',
    impact: 'Complete hijacking of the subdomain, enabling attackers to host malicious phishing sites, harvest cookies, and bypass CORS.',
    rootCause: 'A DNS CNAME record points to an external cloud service provider (GitHub Pages, AWS S3, Heroku, Azure, CloudFront) that has been deprovisioned or never claimed in the target account.',
    threatScenario: 'An attacker notices the CNAME points to an unclaimed resource (e.g., target.github.io or target.s3.amazonaws.com). The attacker signs into that provider, claims the matching bucket/service, and serves whatever malicious HTML they choose directly under your brand with valid SSL.',
    traefik: `# Ensure wildcard router rules do not route unassigned domains to default backends.
`,
    nginx: `# Ensure server_name blocks strictly reject unmatched hostnames:
server {
    listen 80 default_server;
    listen 443 ssl default_server;
    return 444;
}
`,
    express: `# Application level proxy guard: reject Host headers not belonging to known tenants.
`,
    dns: `# REMOVE or UPDATE the dangling DNS record:
# Delete CNAME record pointing to deprovisioned bucket or third-party service immediately.
# Run periodic DNS audits against registered external assets.
`,
    secondaryDefense: 'Implement continuous DNS asset monitoring and automated alerts on deprovisioned SaaS records.'
  },

  clickjacking: {
    title: 'Clickjacking Protection Missing (X-Frame-Options / frame-ancestors)',
    cwe: 'CWE-1021',
    owasp: 'A05:2021-Security Misconfiguration',
    severity: 'MEDIUM',
    impact: 'Application can be embedded within an invisible iframe on a hostile website to trick users into performing unintended actions.',
    rootCause: 'Neither X-Frame-Options (DENY/SAMEORIGIN) nor CSP frame-ancestors is present in server responses.',
    threatScenario: 'An attacker loads your dashboard or settings page inside a transparent <iframe> over an enticing decoy button or game. The victim clicks the button, unknowingly submitting an authenticated money transfer, credential change, or account deletion.',
    traefik: `# Traefik Dynamic Configuration
http:
  middlewares:
    frame-deny:
      headers:
        customFrameOptionsValue: "DENY"
`,
    nginx: `# Nginx Server Block
add_header X-Frame-Options "DENY" always;
`,
    express: `// Express.js with Helmet
const helmet = require('helmet');
app.use(helmet.frameguard({ action: 'deny' }));
`,
    dns: `# Enforced at HTTP layer.
`,
    secondaryDefense: 'Implement modern CSP frame-ancestors \x27none\x27 which supersedes legacy X-Frame-Options in all modern user agents.'
  },

  content_sniffing: {
    title: 'MIME Sniffing Vulnerability (Missing X-Content-Type-Options)',
    cwe: 'CWE-16',
    owasp: 'A05:2021-Security Misconfiguration',
    severity: 'LOW',
    impact: 'Browsers may interpret non-executable MIME types (e.g., text/plain, image/png) as executable HTML or JavaScript.',
    rootCause: 'Missing X-Content-Type-Options: nosniff header.',
    threatScenario: 'A user uploads an image containing embedded JavaScript onto your storage service. If requested without nosniff, certain browsers attempt to sniff the content and execute the malicious script within your domain origin.',
    traefik: `# Traefik Dynamic Configuration
http:
  middlewares:
    nosniff:
      headers:
        contentTypeNosniff: true
`,
    nginx: `# Nginx Configuration
add_header X-Content-Type-Options "nosniff" always;
`,
    express: `// Express.js with Helmet
const helmet = require('helmet');
app.use(helmet.noSniff());
`,
    dns: `# Enforced at HTTP layer.
`,
    secondaryDefense: 'Strictly validate and sanitize uploaded file headers and serve user-supplied uploads from an isolated, sandboxed domain (e.g. your-user-content.com).'
  },

  open_ports: {
    title: 'Unnecessary or Sensitive TCP Ports Exposed to Public Internet',
    cwe: 'CWE-284',
    owasp: 'A05:2021-Security Misconfiguration',
    severity: 'HIGH',
    impact: 'Exposes database, administrative, or debug interfaces to automated brute-force attacks and zero-day exploitation.',
    rootCause: 'Firewall rules (iptables/ufw/security groups) permit ingress traffic to internal service ports (e.g., 22 SSH, 3306 MySQL, 5432 Postgres, 6379 Redis, 9000 Portainer/PHP-FPM, 27017 Mongo).',
    threatScenario: 'Automated internet scanning bots (Shodan, Censys, botnets) discover open database or cache ports. Even with strong passwords, network services may suffer from authentication bypasses, denial of service, or protocol-level vulnerabilities.',
    traefik: `# Bind public entrypoints strictly to 80 and 443. Keep internal entrypoints bound to 127.0.0.1 or wireguard/tailscale interface.
`,
    nginx: `# Bind listen directives only to internal interfaces or proxy strictly over TLS.
`,
    express: `# Application servers should listen on 127.0.0.1 or internal docker network, never 0.0.0.0 directly on host.
`,
    dns: `# DNS does not control port access. Configure firewall security groups.
`,
    secondaryDefense: 'Implement host-level UFW / iptables rules: ufw default deny incoming; ufw allow 80/tcp; ufw allow 443/tcp; restrict SSH to VPN/Tailscale.'
  }
};

/**
 * Builds a 4-pillar structured advisory object for any finding ID.
 */
function buildAdvisory(findingKey, customDetails = {}) {
  const template = REMEDIATION_TEMPLATES[findingKey] || {
    title: customDetails.title || 'Security Weakness Identified',
    cwe: customDetails.cwe || 'CWE-693',
    owasp: customDetails.owasp || 'A05:2021-Security Misconfiguration',
    severity: customDetails.severity || 'MEDIUM',
    impact: customDetails.impact || 'Presents security risks to domain and platform posture.',
    rootCause: customDetails.rootCause || 'Configuration does not meet security best practices.',
    threatScenario: customDetails.threatScenario || 'Adversaries may chain this weakness to escalate attack scope.',
    traefik: '# Apply relevant Traefik security middleware.',
    nginx: '# Apply relevant Nginx header or proxy configuration.',
    express: '// Apply appropriate Express middleware or header controls.',
    dns: '# Verify DNS records.',
    secondaryDefense: 'Ensure edge WAF and intrusion detection systems monitor anomalous activity.'
  };

  return {
    key: findingKey,
    title: customDetails.title || template.title,
    severity: customDetails.severity || template.severity,
    cwe: template.cwe,
    owasp: template.owasp,
    impact: customDetails.impact || template.impact,
    rootCause: customDetails.rootCause || template.rootCause,
    threatScenario: customDetails.threatScenario || template.threatScenario,
    remediation: {
      traefik: template.traefik,
      nginx: template.nginx,
      express: template.express,
      dns: template.dns,
      secondaryDefense: template.secondaryDefense
    },
    evidence: customDetails.evidence || null,
    status: customDetails.status || 'OPEN'
  };
}

/**
 * Calculates a consolidated security score (0-100) and letter grade from findings.
 */
function calculateGrade(findings = []) {
  let score = 100;
  for (const f of findings) {
    const sev = (f.severity || '').toUpperCase();
    if (sev === 'CRITICAL') score -= 30;
    else if (sev === 'HIGH') score -= 15;
    else if (sev === 'MEDIUM') score -= 8;
    else if (sev === 'LOW') score -= 3;
  }
  score = Math.max(0, Math.min(100, score));

  let grade = 'A+';
  if (score < 50) grade = 'F';
  else if (score < 60) grade = 'D';
  else if (score < 70) grade = 'C';
  else if (score < 80) grade = 'B';
  else if (score < 90) grade = 'A';
  else grade = 'A+';

  return { score, grade };
}

module.exports = {
  REMEDIATION_TEMPLATES,
  buildAdvisory,
  calculateGrade
};
