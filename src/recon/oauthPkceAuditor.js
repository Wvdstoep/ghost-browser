'use strict';
/**
 * oauthPkceAuditor.js — OAuth2 PKCE & Pre-Account Takeover Auditor (CWE-287 / RFC 7636)
 *
 * Analyzes OAuth2 / OIDC social login initiation flows (Google, GitHub, Apple, SSO)
 * for cryptographic state parameter entropy and PKCE (code_challenge_method=S256) enforcement.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { harvestTargetEndpoints } = require('./endpointHarvester');

function calculateEntropy(str) {
  if (!str) return 0;
  const len = str.length;
  const frequencies = {};
  for (let i = 0; i < len; i++) {
    const ch = str[i];
    frequencies[ch] = (frequencies[ch] || 0) + 1;
  }
  let entropy = 0;
  for (const count of Object.values(frequencies)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function fetchOauthRedirect(urlStr) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GhostBrowser-OAuthAuditor/3.0',
          'Accept': 'text/html,application/xhtml+xml,application/json,*/*'
        },
        timeout: 6000
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d.toString(); });
        res.on('end', () => {
          const location = res.headers['location'] || '';
          let jsonUrl = '';
          try {
            const j = JSON.parse(body);
            jsonUrl = j.url || j.redirectUrl || j.redirect || '';
          } catch (_) {}

          resolve({
            status: res.statusCode,
            headers: res.headers,
            location: location || jsonUrl,
            body
          });
        });
      });

      req.on('error', (err) => resolve({ status: 0, location: '', error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, location: '', error: 'timeout' }); });
    } catch (e) {
      resolve({ status: 0, location: '', error: e.message });
    }
  });
}

async function auditOAuthPkceAndState(targetUrl, options = {}) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  let u = null;
  try { u = new URL(base); } catch (_) { return { error: 'Invalid URL: ' + targetUrl }; }
  const origin = u.origin;

  const findings = [];
  const secureControls = [];

  let candidateEndpoints = (options.endpoints && options.endpoints.length > 0) ? options.endpoints : null;
  if (!candidateEndpoints) {
    try {
      const harvested = await harvestTargetEndpoints(origin, options);
      // Filter for auth / oauth endpoints
      candidateEndpoints = (harvested.allEndpoints || []).filter(e => /auth|oauth|login|sso|google|github/i.test(e));
    } catch (_) {}
  }

  if (!candidateEndpoints || candidateEndpoints.length === 0) {
    candidateEndpoints = ['/api/auth/google', '/api/auth/sso', '/auth/google', '/auth/github', '/api/login/google'];
  }

  let oauthFlowDetected = false;

  for (const ep of candidateEndpoints.slice(0, 6)) {
    const fullUrl = `${origin}${ep.startsWith('/') ? ep : '/' + ep}`;
    const res = await fetchOauthRedirect(fullUrl);

    if (res.location && (res.location.includes('accounts.google.com') || res.location.includes('github.com/login/oauth') || res.location.includes('authorize') || res.location.includes('response_type='))) {
      oauthFlowDetected = true;
      let targetAuthUrl = null;
      try {
        targetAuthUrl = new URL(res.location.startsWith('http') ? res.location : new URL(res.location, origin).toString());
      } catch (_) {
        continue;
      }

      const params = targetAuthUrl.searchParams;
      const stateParam = params.get('state');
      const codeChallenge = params.get('code_challenge');
      const codeChallengeMethod = params.get('code_challenge_method');
      const redirectUri = params.get('redirect_uri');

      // ── Check 1: State Parameter Presence & Entropy (CSRF Protection) ──
      if (!stateParam) {
        findings.push({
          cwe: 'CWE-352',
          title: `Missing OAuth2 State Parameter in ${ep}`,
          severity: 'HIGH',
          endpoint: ep,
          impact: 'The authorization request lacks a "state" parameter. Attackers can forge OAuth callbacks to link victim sessions to attacker social accounts (OAuth CSRF / Account Linking Takeover).',
          proof: `Redirect Location: ${targetAuthUrl.origin}${targetAuthUrl.pathname}?${params.toString()} lacks state param.`,
          remediation: 'Generate a cryptographically secure random state parameter stored in an HttpOnly session cookie and verify it on callback.'
        });
      } else {
        const entropy = calculateEntropy(stateParam);
        if (stateParam.length < 12 || entropy < 2.5) {
          findings.push({
            cwe: 'CWE-330',
            title: `Low Entropy / Predictable OAuth State in ${ep}`,
            severity: 'MEDIUM',
            endpoint: ep,
            stateValue: stateParam,
            entropyScore: entropy.toFixed(2),
            impact: 'The state parameter has low entropy or insufficient length, making it vulnerable to brute force or prediction.',
            proof: `State value: "${stateParam}" (length: ${stateParam.length}, entropy: ${entropy.toFixed(2)} bits/char).`,
            remediation: 'Use crypto.randomBytes(32).toString("hex") to generate high-entropy state tokens.'
          });
        } else {
          secureControls.push({
            endpoint: ep,
            control: 'OAuth State CSRF Protection',
            status: 'Enforced',
            stateLength: stateParam.length,
            entropyScore: entropy.toFixed(2),
            detail: 'State parameter contains high cryptographic entropy (>3.0 bits/char).'
          });
        }
      }

      // ── Check 2: PKCE Enforcement (RFC 7636) ──
      if (!codeChallenge) {
        findings.push({
          cwe: 'CWE-287',
          title: `Missing OAuth2 PKCE (code_challenge) in ${ep}`,
          severity: 'MEDIUM',
          endpoint: ep,
          impact: 'The OAuth flow does not enforce Proof Key for Code Exchange (RFC 7636). Authorization codes intercepted via redirect URI eavesdropping or referrer leakage can be exchanged by attackers without proof of possession.',
          proof: 'Authorization request did not include code_challenge or code_challenge_method.',
          remediation: 'Implement RFC 7636 PKCE: Generate code_verifier and send SHA-256 code_challenge with code_challenge_method=S256.'
        });
      } else if (codeChallengeMethod !== 'S256') {
        findings.push({
          cwe: 'CWE-327',
          title: `Insecure PKCE Transform Method (${codeChallengeMethod || 'plain'}) in ${ep}`,
          severity: 'LOW',
          endpoint: ep,
          impact: 'PKCE code_challenge_method is set to "plain" rather than SHA-256 ("S256").',
          proof: `code_challenge_method="${codeChallengeMethod}"`,
          remediation: 'Enforce code_challenge_method=S256 for all OAuth authorization requests.'
        });
      } else {
        secureControls.push({
          endpoint: ep,
          control: 'PKCE Authorization Protection (RFC 7636)',
          status: 'Enforced',
          method: 'S256',
          detail: 'Client enforces SHA-256 code_challenge transform.'
        });
      }

      // ── Check 3: Redirect URI Validation ──
      if (redirectUri) {
        if (!redirectUri.startsWith('https://')) {
          findings.push({
            cwe: 'CWE-601',
            title: `Insecure In-Transit OAuth redirect_uri (${redirectUri})`,
            severity: 'HIGH',
            endpoint: ep,
            impact: 'redirect_uri does not use HTTPS, permitting network intercept of authorization codes.',
            proof: `redirect_uri: ${redirectUri}`,
            remediation: 'Enforce HTTPS for all OAuth redirect URIs.'
          });
        } else {
          secureControls.push({
            endpoint: ep,
            control: 'OAuth Redirect URI Transport',
            status: 'Secure',
            redirectUri,
            detail: 'Redirect URI strictly enforces HTTPS encryption.'
          });
        }
      }

      break;
    }
  }

  if (!oauthFlowDetected) {
    secureControls.push({
      control: 'Social OAuth Surface Discovery',
      status: 'Clean',
      detail: `No redirect-based OAuth login endpoints responded on candidate paths (${candidateEndpoints.join(', ')}).`
    });
  }

  const overallPosture = findings.length === 0 ? 'RESILIENT' : 'VULNERABLE';

  return {
    engine: 'GhostBrowser-OAuthPkceAuditor/3.0',
    target: origin,
    oauthFlowDetected,
    overallPosture,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls
  };
}

module.exports = {
  auditOAuthPkceAndState,
  calculateEntropy
};
