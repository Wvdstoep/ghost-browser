'use strict';
/**
 * cswshAuditor.js — Cross-Site WebSocket Hijacking (CSWSH) Origin Handshake Auditor (CWE-1385)
 *
 * Tests whether WebSocket upgrade endpoints validate the HTTP "Origin" header during the
 * 101 Switching Protocols handshake. If the server permits arbitrary origins (e.g. https://evil-attacker.com),
 * third-party malicious websites can hijack authenticated WebSocket sessions using the victim's cookies.
 */

const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const { harvestTargetEndpoints } = require('./endpointHarvester');

function sendHandshake(host, port, isTls, path, originHeader, timeout = 5000) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const options = {
      host,
      port: Number(port) || (isTls ? 443 : 80),
      timeout,
      servername: host,
      rejectUnauthorized: false
    };

    const client = isTls ? tls.connect(options) : net.connect(options);
    let buffer = '';

    const req =
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${host}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Origin: ${originHeader}\r\n` +
      `User-Agent: GhostBrowser-CswshAuditor/3.0\r\n\r\n`;

    client.on('connect', () => {
      client.write(req);
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('\r\n\r\n')) {
        client.destroy();
        finish({ raw: buffer, error: null });
      }
    });

    client.on('end', () => finish({ raw: buffer, error: null }));
    client.on('close', () => finish({ raw: buffer, error: null }));
    client.on('timeout', () => {
      client.destroy();
      finish({ raw: buffer, error: 'Socket timed out' });
    });
    client.on('error', (err) => {
      client.destroy();
      finish({ raw: buffer, error: err.message });
    });
  });
}

function parseStatus(raw) {
  if (!raw) return 0;
  const match = raw.match(/HTTP\/\d\.\d\s+(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

async function auditCrossSiteWebSocketHijacking(targetUrl, options = {}) {
  let base = (targetUrl || '').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  let u = null;
  try { u = new URL(base); } catch (_) { return { error: 'Invalid URL: ' + targetUrl }; }

  const host = u.hostname;
  const isTls = u.protocol === 'https:';
  const port = u.port || (isTls ? 443 : 80);
  const targetOrigin = `${u.protocol}//${u.host}`;

  const findings = [];
  const secureControls = [];

  let candidatePaths = (options.endpoints && options.endpoints.length > 0) ? options.endpoints : null;
  if (!candidatePaths) {
    try {
      const harvested = await harvestTargetEndpoints(targetOrigin, options);
      candidatePaths = (harvested.websocketEndpoints && harvested.websocketEndpoints.length > 0)
        ? harvested.websocketEndpoints
        : ['/ws', '/socket.io/?EIO=4&transport=websocket', '/socket.io/?EIO=3&transport=websocket', '/api/ws', '/stream', '/cable'];
    } catch (_) {
      candidatePaths = ['/ws', '/socket.io/?EIO=4&transport=websocket', '/api/ws', '/stream'];
    }
  }

  let activeWsPath = null;

  for (const p of candidatePaths) {
    // 1. Legitimate Origin Handshake
    const legitimateRes = await sendHandshake(host, port, isTls, p, targetOrigin);
    const legitimateStatus = parseStatus(legitimateRes.raw);

    // If endpoint responds with 101 or 400 (Bad handshake params) vs 404
    if (legitimateStatus === 101 || (legitimateStatus !== 404 && legitimateStatus !== 0 && legitimateRes.raw.includes('Sec-WebSocket'))) {
      activeWsPath = p;

      // 2. Malicious Cross-Origin Handshake (CSWSH Probe)
      const maliciousOrigin = 'https://evil-attacker.com';
      const attackRes = await sendHandshake(host, port, isTls, p, maliciousOrigin);
      const attackStatus = parseStatus(attackRes.raw);

      if (attackStatus === 101) {
        findings.push({
          cwe: 'CWE-1385',
          title: `Cross-Site WebSocket Hijacking (CSWSH) in ${p}`,
          severity: 'HIGH',
          endpoint: p,
          technique: 'Origin Handshake Differential',
          testedOrigin: maliciousOrigin,
          handshakeStatus: 101,
          impact: 'The WebSocket server upgraded the connection with HTTP 101 despite receiving a malicious Origin header (https://evil-attacker.com). Attackers can host a malicious webpage that transparently connects to the victim WebSocket using their ambient cookies and steals live streams, messages, or triggers authenticated actions.',
          proof: `Sent HTTP Upgrade handshake with Origin: ${maliciousOrigin}. Server accepted upgrade and returned HTTP 101 Switching Protocols.`,
          remediation: 'Validate the Origin header in verifyClient (ws) or origins allowlist (socket.io) to reject cross-origin upgrade requests with HTTP 403 Forbidden.'
        });
      } else if (attackStatus === 403 || attackStatus === 401 || attackStatus === 400 || attackStatus === 0) {
        secureControls.push({
          endpoint: p,
          control: 'WebSocket Origin Validation',
          status: 'Enforced',
          httpStatus: attackStatus,
          detail: `Server rejected untrusted Origin header (${maliciousOrigin}) with HTTP ${attackStatus}.`
        });
      }

      break;
    }
  }

  if (!activeWsPath) {
    secureControls.push({
      control: 'WebSocket Attack Surface Exposure',
      status: 'Clean',
      detail: `No active WebSocket upgrade listeners detected on candidate paths (${candidatePaths.join(', ')}).`
    });
  }

  const overallPosture = findings.length === 0 ? 'RESILIENT' : 'VULNERABLE';

  return {
    engine: 'GhostBrowser-CswshAuditor/3.0',
    target: targetOrigin,
    activeWsPath: activeWsPath || 'None Detected',
    overallPosture,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls
  };
}

module.exports = {
  auditCrossSiteWebSocketHijacking
};
