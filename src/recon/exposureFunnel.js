'use strict';

const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

const PORTS = [21, 22, 25, 80, 443, 2375, 3000, 3306, 5432, 6379, 8080, 8443, 8929, 9000, 27017];
const WEB_PORTS = new Set([80, 443, 3000, 8080, 8443, 8929, 9000, 2375]);
const ROUTES = ['/.env', '/.git/HEAD', '/actuator', '/actuator/env', '/actuator/health', '/config.json', '/wp-admin/', '/administrator/', '/api/v1/', '/swagger-ui.html', '/openapi.json'];

function tcpProbe(host, port, payload) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    let done = false;
    let data = '';
    const finish = () => { if (done) return; done = true; socket.destroy(); resolve({ port, open: socket.readyState === 'open' || connected, banner: data.slice(0, 120) || null }); };
    let connected = false;
    socket.setTimeout(1400);
    socket.on('connect', () => { connected = true; if (payload) socket.write(payload); else setTimeout(finish, 180); });
    socket.on('data', chunk => { data += chunk.toString('utf8', 0, Math.min(chunk.length, 256)); finish(); });
    socket.on('error', finish);
    socket.on('timeout', finish);
    socket.on('close', finish);
  });
}

function request(url, method = 'GET') {
  return new Promise(resolve => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(deadline); resolve(value); };
    const req = lib.request(url, { method, timeout: 2500, headers: { 'User-Agent': 'GhostBrowser-ExposureRecon/1.0', 'Accept': '*/*' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk.toString('utf8', 0, Math.max(0, 32768 - body.length)); if (body.length >= 32768) { finish({ status: res.statusCode, headers: res.headers, body }); req.destroy(); } });
      res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', () => finish(null));
    });
    const deadline = setTimeout(() => { finish(null); req.destroy(); }, 3500);
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(null));
    req.end();
  });
}

function tlsDetails(host, port) {
  return new Promise(resolve => {
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: 2500 });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      resolve({ protocol: socket.getProtocol(), subject: cert.subject?.CN || null, san: cert.subjectaltname || null, authorized: socket.authorized });
      socket.destroy();
    });
    socket.once('error', () => resolve(null));
    socket.once('timeout', () => { socket.destroy(); resolve(null); });
  });
}

function routeEvidence(path, response, baseline) {
  if (!response || response.status === 404 || response.status === 401 || response.status === 403) return null;
  const body = response.body.trim();
  if (baseline && response.status === baseline.status && body === baseline.body.trim()) return null;
  if (path === '/.git/HEAD') return /^ref: refs\/heads\/[\w./-]+\s*$/m.test(body) ? 'Git HEAD reference readable' : null;
  if (path === '/.env') return /(?:^|\n)[A-Z][A-Z0-9_]{2,}\s*=\s*[^\r\n]+/.test(body) && !/<html/i.test(body) ? 'Environment-style key/value content readable; values withheld' : null;
  if (path === '/actuator/env') return /"(?:propertySources|activeProfiles)"/.test(body) ? 'Actuator environment response readable' : null;
  if (path === '/openapi.json' || path === '/config.json') {
    try { const parsed = JSON.parse(body); return path === '/openapi.json' && (parsed.openapi || parsed.swagger) ? 'OpenAPI definition readable' : path === '/config.json' && parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? 'JSON configuration readable; values withheld' : null; } catch { return null; }
  }
  return response.status >= 200 && response.status < 400 ? 'Distinct route response (exposure only)' : null;
}

async function auditExposureFunnel(rawTarget, options = {}) {
  if (typeof rawTarget !== 'string' || !rawTarget.trim()) throw new Error('Target URL is required');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawTarget.trim()) && !/^https?:\/\//i.test(rawTarget.trim())) throw new Error('Only HTTP(S) targets are supported');
  const value = /^https?:\/\//i.test(rawTarget.trim()) ? rawTarget.trim() : `https://${rawTarget.trim()}`;
  const target = new URL(value);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Only HTTP(S) targets without embedded credentials are supported');
  const host = target.hostname;
  const ports = [...new Set(options.ports || [...PORTS, Number(target.port || (target.protocol === 'https:' ? 443 : 80))])].filter(p => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 20);
  const probe = options.tcpProbe || tcpProbe;
  const get = options.request || request;
  const opened = (await Promise.all(ports.map(port => probe(host, port)))).filter(item => item.open);
  const fingerprints = [];
  const routes = [];
  const proofs = [];
  for (const item of opened) {
    const port = item.port;
    if (port === 6379) {
      const ping = await probe(host, port, '*1\r\n$4\r\nPING\r\n');
      fingerprints.push({ port, protocol: ping.banner?.startsWith('+PONG') ? 'Redis' : 'unknown', evidence: ping.banner?.startsWith('+PONG') ? 'PING returned PONG' : 'TCP open; Redis not confirmed' });
      if (ping.banner?.startsWith('+PONG')) proofs.push({ port, condition: 'Unauthenticated Redis PING', evidence: 'PONG without credentials', level: 'validated exposure', rceProven: false });
      continue;
    }
    if (!WEB_PORTS.has(port) && port !== Number(target.port)) {
      fingerprints.push({ port, protocol: /^SSH-/.test(item.banner || '') ? 'SSH' : 'unconfirmed', evidence: item.banner || 'TCP open; no identifying banner' });
      continue;
    }
    const protocol = port === 443 || port === 8443 || (port === Number(target.port) && target.protocol === 'https:') ? 'https:' : 'http:';
    const origin = new URL(`${protocol}//${host.includes(':') ? `[${host}]` : host}:${port}/`);
    const root = await get(origin);
    if (!root) { fingerprints.push({ port, protocol: 'unconfirmed', evidence: 'TCP open; HTTP handshake failed' }); continue; }
    const fingerprint = { port, protocol: protocol.slice(0, -1), status: root.status, server: root.headers.server || null, poweredBy: root.headers['x-powered-by'] || null };
    if (protocol === 'https:') fingerprint.tls = await (options.tlsDetails || tlsDetails)(host, port);
    fingerprints.push(fingerprint);
    if (port === 2375) {
      const ping = await get(new URL('/_ping', origin));
      const version = await get(new URL('/version', origin));
      if (ping?.body.trim() === 'OK' && version?.status === 200 && /"ApiVersion"/.test(version.body)) proofs.push({ port, condition: 'Unauthenticated Docker API', evidence: 'GET /_ping and /version succeeded without credentials', level: 'validated exposure', rceProven: false });
      continue;
    }
    const baseline = await get(new URL(`/__gb_missing_${crypto.randomUUID()}`, origin));
    for (const path of ROUTES) {
      const response = await get(new URL(path, origin));
      const evidence = routeEvidence(path, response, baseline);
      if (!evidence) continue;
      routes.push({ port, path, status: response.status, evidence });
      if (['/.env', '/.git/HEAD', '/actuator/env'].includes(path)) proofs.push({ port, condition: `${path} readable without credentials`, evidence, level: 'validated exposure', rceProven: false });
    }
  }
  return {
    target: target.origin,
    stages: [
      { stage: 1, name: 'Open port', evidence: opened.map(({ port, banner }) => ({ port, banner })) },
      { stage: 2, name: 'Protocol handshake and fingerprint', evidence: fingerprints },
      { stage: 3, name: 'Route discovery', evidence: routes },
      { stage: 4, name: 'Read-only proof of exposure', evidence: proofs },
      { stage: 5, name: 'Remote code execution', status: 'not tested', evidence: [], reason: 'No exploit payload or code execution is attempted; exposure does not prove RCE.' }
    ],
    limitations: 'Fixed TCP port list and known HTTP routes only. No exploit spraying, mutation, authentication bypass, or proof of RCE.'
  };
}

module.exports = { auditExposureFunnel, routeEvidence, PORTS, ROUTES };
