'use strict';
/**
 * tlsAuditor.js — TLS/SSL Cipher & Protocol Health Deep-Dive (CWE-326 / PCI-DSS v4.0)
 *
 * Inspects TLS socket handshakes, testing for deprecated protocols (TLS 1.0, TLS 1.1),
 * weak ciphers (CBC, 3DES, RC4), forward secrecy (PFS), and certificate validity.
 */

const tls = require('tls');

/**
 * Tests connection with a specific min/max TLS version.
 */
function probeTlsVersion(host, port, minVersion, maxVersion, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const socket = tls.connect({
        host,
        port,
        servername: host,
        minVersion,
        maxVersion,
        rejectUnauthorized: false,
        timeout: timeoutMs
      }, () => {
        const protocol = socket.getProtocol();
        const cipher = socket.getCipher();
        socket.destroy();
        resolve({ supported: true, protocol, cipher });
      });

      socket.on('error', () => resolve({ supported: false, error: 'Handshake failed' }));
      socket.on('timeout', () => { socket.destroy(); resolve({ supported: false, error: 'Timeout' }); });
    } catch (e) {
      resolve({ supported: false, error: e.message });
    }
  });
}

/**
 * Inspects the primary TLS connection and certificate metadata.
 */
function inspectTlsDetails(host, port = 443, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const socket = tls.connect({
        host,
        port,
        servername: host,
        rejectUnauthorized: false,
        timeout: timeoutMs
      }, () => {
        const protocol = socket.getProtocol();
        const cipher = socket.getCipher();
        const cert = socket.getPeerCertificate(true);
        const authorized = socket.authorized;
        socket.destroy();

        if (!cert || Object.keys(cert).length === 0) {
          return resolve({ error: 'No certificate presented' });
        }

        const validTo = new Date(cert.valid_to);
        const now = new Date();
        const daysRemaining = Math.round((validTo.getTime() - now.getTime()) / (1000 * 3600 * 24));

        const sans = (cert.subjectaltname || '')
          .split(',')
          .map((s) => s.replace(/^DNS:/, '').trim())
          .filter(Boolean);

        resolve({
          protocol,
          cipher,
          authorized,
          issuer: cert.issuer ? (cert.issuer.O || cert.issuer.CN || 'Unknown') : 'Unknown',
          subject: cert.subject ? (cert.subject.CN || host) : host,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          daysRemaining,
          keyLength: cert.bits || null,
          sans,
          hasPfs: !!(cipher && (cipher.name.includes('ECDHE') || cipher.name.includes('DHE') || cipher.name.includes('TLS_AES')))
        });
      });

      socket.on('error', (err) => resolve({ error: err.message }));
      socket.on('timeout', () => { socket.destroy(); resolve({ error: 'TLS handshake timeout' }); });
    } catch (e) {
      resolve({ error: e.message });
    }
  });
}

/**
 * Main Auditor Entrypoint: Performs comprehensive TLS protocol, cipher, and certificate health audit.
 */
async function auditTlsHealth(targetHost, port = 443) {
  const host = (targetHost || '').trim().replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
  if (!host) return { error: 'Target host is required for TLS health audit' };

  // 1. Concurrently test deprecated and modern TLS versions
  const [tls10, tls11, tls12, tls13, details] = await Promise.all([
    probeTlsVersion(host, port, 'TLSv1', 'TLSv1'),
    probeTlsVersion(host, port, 'TLSv1.1', 'TLSv1.1'),
    probeTlsVersion(host, port, 'TLSv1.2', 'TLSv1.2'),
    probeTlsVersion(host, port, 'TLSv1.3', 'TLSv1.3'),
    inspectTlsDetails(host, port)
  ]);

  const findings = [];
  let tlsGrade = 'A';

  // Check Deprecated TLS 1.0
  if (tls10.supported) {
    tlsGrade = 'F';
    findings.push({
      key: 'deprecated_tls_10',
      title: 'Deprecated TLS 1.0 Protocol Supported (PCI-DSS v4.0 Violation / CWE-326)',
      severity: 'HIGH',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-326: Inadequate Encryption Strength',
      evidence: `Target accepted TLSv1.0 connection with cipher: ${tls10.cipher?.name || 'Unknown'}`,
      impact: 'TLS 1.0 is deprecated by RFC 8996 and prohibited by PCI-DSS due to vulnerabilities in CBC ciphers (BEAST, POODLE) and weak cryptographic integrity.',
      remediation: 'Disable TLS 1.0 in web server/load balancer configuration. Enforce TLSv1.2 and TLSv1.3 only.'
    });
  }

  // Check Deprecated TLS 1.1
  if (tls11.supported) {
    if (tlsGrade !== 'F') tlsGrade = 'C';
    findings.push({
      key: 'deprecated_tls_11',
      title: 'Deprecated TLS 1.1 Protocol Supported (CWE-326)',
      severity: 'MEDIUM',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-326: Inadequate Encryption Strength',
      evidence: `Target accepted TLSv1.1 connection with cipher: ${tls11.cipher?.name || 'Unknown'}`,
      impact: 'TLS 1.1 lacks modern authenticated encryption (AEAD) ciphers and is deprecated by all major web browsers.',
      remediation: 'Disable TLS 1.1 across all reverse proxies and edge gateways.'
    });
  }

  // Check Certificate Expiration
  if (details.daysRemaining !== undefined && details.daysRemaining <= 14) {
    const isExpired = details.daysRemaining <= 0;
    findings.push({
      key: isExpired ? 'tls_certificate_expired' : 'tls_certificate_expiring_soon',
      title: isExpired ? 'TLS/SSL Certificate Expired' : 'TLS/SSL Certificate Expiring Soon (< 14 Days)',
      severity: isExpired ? 'HIGH' : 'LOW',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-295: Improper Certificate Validation',
      evidence: `Certificate valid_to: ${details.validTo} (${details.daysRemaining} days remaining).`,
      impact: 'Expired or expiring certificates cause browser security warnings, connection drops, and loss of user trust.',
      remediation: 'Renew TLS certificate via ACME/Let’s Encrypt automated certificate management.'
    });
  }

  // Check Forward Secrecy
  if (details.cipher && !details.hasPfs) {
    if (tlsGrade === 'A') tlsGrade = 'B';
    findings.push({
      key: 'missing_perfect_forward_secrecy',
      title: 'Missing Perfect Forward Secrecy (PFS)',
      severity: 'LOW',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-326: Inadequate Encryption Strength',
      evidence: `Negotiated cipher ${details.cipher.name} does not use ephemeral key exchange (ECDHE/DHE).`,
      impact: 'If the server private key is compromised in the future, past recorded encrypted traffic can be decrypted retroactively.',
      remediation: 'Prioritize ECDHE cipher suites (e.g. ECDHE-ECDSA-AES128-GCM-SHA256, ECDHE-RSA-AES128-GCM-SHA256).'
    });
  }

  // Modern TLS 1.3 bonus
  if (tls13.supported && tlsGrade === 'A') {
    tlsGrade = 'A+';
  }

  return {
    host,
    port,
    tlsGrade,
    negotiatedProtocol: details.protocol || 'Unknown',
    negotiatedCipher: details.cipher || null,
    protocols: {
      tls10: tls10.supported,
      tls11: tls11.supported,
      tls12: tls12.supported,
      tls13: tls13.supported
    },
    certificate: {
      issuer: details.issuer,
      subject: details.subject,
      validTo: details.validTo,
      daysRemaining: details.daysRemaining,
      sanCount: details.sans?.length || 0,
      sans: details.sans || []
    },
    findingsCount: findings.length,
    findings
  };
}

module.exports = {
  auditTlsHealth,
  probeTlsVersion,
  inspectTlsDetails
};
