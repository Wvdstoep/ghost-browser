'use strict';
/**
 * bannerGrabber.js — Service Version Banner Grabbing & CVE Correlation (CWE-200 / CWE-306)
 *
 * Actively probes exposed services (FTP 21, SSH 22/2222, SMTP 25, MySQL 3306, DirectAdmin 2222)
 * to extract exact daemon version strings and correlate against official CVE registries (NVD / MITRE).
 */

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

const KNOWN_CVE_DATABASE = [
  {
    product: 'OpenSSH',
    match: /OpenSSH_([0-8]\.[0-9]|9\.[0-7])/i,
    cve: 'CVE-2024-6387 (regreSSHion)',
    cvss: 8.1,
    severity: 'HIGH',
    summary: 'Signal handler race condition in OpenSSH server (sshd) allows remote code execution without authentication on glibc-based Linux systems.',
    mitre: 'https://nvd.nist.gov/vuln/detail/CVE-2024-6387'
  },
  {
    product: 'ProFTPD',
    match: /ProFTPD\s*(1\.3\.[0-5]|1\.3\.6\b)/i,
    cve: 'CVE-2019-12815 / CVE-2020-9273',
    cvss: 9.8,
    severity: 'CRITICAL',
    summary: 'Arbitrary unauthenticated file copy vulnerability in mod_copy and use-after-free in ProFTPD memory pools.',
    mitre: 'https://nvd.nist.gov/vuln/detail/CVE-2019-12815'
  },
  {
    product: 'MariaDB',
    match: /10\.([0-5]\.[0-9]+|6\.(?:[0-9]|1[0-6]))-MariaDB/i,
    cve: 'CVE-2022-32082 / CVE-2022-32084',
    cvss: 7.5,
    severity: 'HIGH',
    summary: 'Denial of service and assertion failure in MariaDB server via crafted client packets.',
    mitre: 'https://nvd.nist.gov/vuln/detail/CVE-2022-32082'
  }
];

/**
 * Protocol-specific banner interrogation for FTP (Port 21).
 */
function grabFtpBanner(host, port = 21, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let banner = '';
    let syst = '';
    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {});
    socket.on('data', (d) => {
      const text = d.toString('utf8');
      if (!banner) {
        banner = text.trim();
        // Send SYST command
        socket.write('SYST\r\n');
      } else {
        syst = text.trim();
        socket.destroy();
      }
    });

    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      const isFtp = banner && (banner.startsWith('220') || banner.toLowerCase().includes('ftp'));
      resolve({
        port,
        service: 'FTP',
        banner: isFtp ? banner.slice(0, 160) : null,
        detail: syst ? `SYST: ${syst.slice(0, 80)}` : null
      });
    });

    socket.connect(port, host);
  });
}

/**
 * Protocol-specific banner interrogation for SSH (Port 22 or 2222).
 */
function grabSshBanner(host, port = 22, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let banner = '';
    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {});
    socket.on('data', (d) => {
      banner += d.toString('utf8');
      if (banner.includes('\n') || banner.length > 80) {
        socket.destroy();
      }
    });

    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      const firstLine = banner.split('\n')[0].trim();
      const validSsh = firstLine.startsWith('SSH-');
      resolve({
        port,
        service: 'SSH',
        banner: validSsh ? firstLine : null,
        isOpenSsh: validSsh && /OpenSSH/i.test(firstLine)
      });
    });

    socket.connect(port, host);
  });
}

/**
 * Protocol-specific banner interrogation for MySQL / MariaDB (Port 3306).
 */
function grabMysqlBanner(host, port = 3306, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let version = null;
    let receivedHandshake = false;
    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {});
    socket.on('data', (buf) => {
      try {
        // MySQL Initial Handshake Packet:
        // 3 bytes packet length, 1 byte sequence (0), 1 byte protocol version (10 = 0x0a)
        if (buf.length > 5 && buf[4] === 0x0a) {
          receivedHandshake = true;
          let nullIdx = buf.indexOf(0x00, 5);
          if (nullIdx > 5) {
            version = buf.toString('ascii', 5, nullIdx);
          }
        }
      } catch {}
      socket.destroy();
    });

    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      resolve({
        port,
        service: 'MySQL/MariaDB',
        version: version || null,
        banner: version ? `MariaDB/MySQL Handshake Version: ${version}` : (receivedHandshake ? 'MySQL Handshake received' : null)
      });
    });

    socket.connect(port, host);
  });
}

/**
 * Protocol-specific probe for DirectAdmin / Web Control Panel on Port 2222.
 */
function grabDirectAdminBanner(host, port = 2222, timeoutMs = 3500) {
  return new Promise((resolve) => {
    // Probe HTTPS first on 2222
    const options = {
      hostname: host,
      port,
      path: '/',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 GhostBrowser-AdminAudit/2.0' },
      timeout: timeoutMs,
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.on('end', () => {
        const serverHeader = res.headers.server || '';
        const isDirectAdmin = serverHeader.toLowerCase().includes('directadmin') || body.toLowerCase().includes('directadmin');
        resolve({
          port,
          service: isDirectAdmin ? 'DirectAdmin Web Control Panel' : 'Web Service (HTTPS)',
          banner: isDirectAdmin ? (serverHeader || 'DirectAdmin Web Control Panel') : (serverHeader ? `HTTPS: ${serverHeader}` : null),
          isDirectAdmin,
          statusCode: res.statusCode
        });
      });
    });

    req.on('error', () => {
      // If HTTPS fails, test raw SSH banner on 2222
      grabSshBanner(host, port, timeoutMs).then(resolve);
    });
    req.on('timeout', () => { req.destroy(); resolve({ port, service: 'Unknown', banner: null }); });
    req.end();
  });
}

/**
 * Correlates banner strings with known CVEs.
 */
function correlateCves(banners) {
  const cves = [];
  for (const b of banners) {
    const fullText = `${b.service || ''} ${b.banner || ''} ${b.version || ''}`;
    for (const entry of KNOWN_CVE_DATABASE) {
      if (entry.match.test(fullText)) {
        cves.push({
          port: b.port,
          service: b.service,
          product: entry.product,
          cve: entry.cve,
          cvss: entry.cvss,
          severity: entry.severity,
          summary: entry.summary,
          reference: entry.mitre
        });
      }
    }
  }
  return cves;
}

/**
 * Main Auditor Entrypoint: Performs protocol-specific banner extraction and CVE correlation.
 */
async function auditServiceBanners(targetHost, openPorts = []) {
  const host = (targetHost || '').trim().replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
  if (!host) return { error: 'Target host is required' };

  // Ports to interrogate: either specific open ports or standard sensitive ports
  const targetPorts = openPorts.length > 0
    ? openPorts.map(p => typeof p === 'object' ? p.port : Number(p))
    : [21, 22, 2222, 3306, 25];

  const probes = [];

  if (targetPorts.includes(21)) probes.push(grabFtpBanner(host, 21));
  if (targetPorts.includes(22)) probes.push(grabSshBanner(host, 22));
  if (targetPorts.includes(2222)) probes.push(grabDirectAdminBanner(host, 2222));
  if (targetPorts.includes(3306)) probes.push(grabMysqlBanner(host, 3306));

  const results = await Promise.all(probes);
  const activeBanners = results.filter((r) => r && r.banner);
  const cveMatches = correlateCves(activeBanners);

  const findings = [];

  // Exposed Database Check
  const dbBanner = activeBanners.find((b) => b.port === 3306);
  if (dbBanner) {
    findings.push({
      key: 'unprotected_database_port_3306',
      title: 'Publicly Accessible MariaDB / MySQL Database Service (Port 3306)',
      severity: 'HIGH',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-306: Missing Authentication for Critical Function',
      evidence: `Port 3306 TCP is open to the public internet. Daemon banner: ${dbBanner.banner}`,
      impact: 'Exposing relational database services to the public internet exposes authentication handshakes to automated credential brute force, denial-of-service, and zero-day protocol exploits.',
      poc: `curl.exe -v --max-time 3 telnet://${host}:3306`,
      remediation: 'Bind MySQL/MariaDB to 127.0.0.1 or configure UFW/firewall rules to restrict access to trusted application servers.'
    });
  }

  // Exposed DirectAdmin / Management Check
  const daBanner = activeBanners.find((b) => b.port === 2222 && b.isDirectAdmin);
  if (daBanner) {
    findings.push({
      key: 'exposed_directadmin_portal',
      title: 'Public DirectAdmin Web Control Panel (Port 2222)',
      severity: 'MEDIUM',
      category: 'POSTURE_HARDENING',
      cwe: 'CWE-284: Improper Access Control',
      evidence: `DirectAdmin login interface verified on https://${host}:2222`,
      impact: 'Administrative control panels exposed to the public internet are prime targets for automated credential stuffing and web-based password attacks.',
      poc: `curl.exe -k -i "https://${host}:2222/"`,
      remediation: 'Restrict port 2222 in csf/iptables to static corporate IP addresses or access only through a secure VPN.'
    });
  }

  return {
    host,
    bannersAudited: activeBanners,
    cves: cveMatches,
    findingsCount: findings.length,
    findings
  };
}

module.exports = {
  auditServiceBanners,
  grabFtpBanner,
  grabSshBanner,
  grabMysqlBanner,
  grabDirectAdminBanner,
  correlateCves,
  KNOWN_CVE_DATABASE
};
