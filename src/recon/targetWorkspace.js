'use strict';
/**
 * targetWorkspace.js — Persistent Living App Map & Continuous Target Workspace
 *
 * Maintains a persistent, living dossier and architecture attack surface map for every
 * audited target application. Accumulates discoveries across reconnaissance runs:
 *   - Perimeter & DNS posture
 *   - Verified subdomains (Certificate Transparency & SANs)
 *   - Open ports, daemon banners & CVE status
 *   - Discovered client-side SPA routes & sensitive forms
 *   - Harvested backend API endpoints
 *   - Dual-scorecard security evolution & historical audit timeline
 *   - Scheduled continuous watch settings
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { calculateGrade } = require('./advisory');

const DATA_DIR = process.env.DATA_DIR 
  ? path.join(process.env.DATA_DIR, 'targets') 
  : fs.existsSync('/profiles')
    ? '/profiles/targets'
    : path.join(__dirname, '..', '..', 'data', 'targets');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function normalizeDomain(targetUrl) {
  if (!targetUrl) return '';
  let clean = targetUrl.trim().toLowerCase();
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = 'https://' + clean;
  }
  try {
    const u = new URL(clean);
    return u.hostname;
  } catch (e) {
    return clean.replace(/[^a-z0-9.-]/gi, '');
  }
}

function getFilePath(domain) {
  ensureDir();
  const safeName = domain.replace(/[^a-z0-9.-]/gi, '_');
  return path.join(DATA_DIR, `${safeName}.json`);
}

/**
 * Reads the living app map for a target domain
 */
function getTargetWorkspace(targetUrl) {
  const domain = normalizeDomain(targetUrl);
  if (!domain) return null;

  const fp = getFilePath(domain);
  if (fs.existsSync(fp)) {
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.error(`[targetWorkspace] Failed reading ${fp}:`, e.message);
    }
  }

  // Initial scaffold for a newly tracked application
  return {
    targetUrl: targetUrl.startsWith('http') ? targetUrl : `https://${domain}`,
    domain: domain,
    apexDomain: domain,
    title: domain,
    firstSeen: new Date().toISOString(),
    lastAudited: null,
    watchEnabled: false,
    scheduleInterval: 'daily',
    scores: {
      postureScore: 100,
      postureGrade: 'A+',
      exploitabilityScore: 100,
      exploitabilityGrade: 'A+',
      status: 'Ready for Initial Baseline Scan'
    },
    perimeter: {
      apexIp: null,
      wildcardDns: false,
      dnsHygiene: { spf: null, dmarc: null, caa: null },
      tlsGrade: null,
      waf: null
    },
    subdomains: [],
    services: [],
    spaRoutes: [],
    apiEndpoints: [],
    findings: [],
    history: []
  };
}

/**
 * Saves or updates a target workspace
 */
function saveTargetWorkspace(workspace) {
  if (!workspace || !workspace.apexDomain) return null;
  const domain = normalizeDomain(workspace.apexDomain);
  ensureDir();
  const fp = getFilePath(domain);

  workspace.updatedAt = new Date().toISOString();
  fs.writeFileSync(fp, JSON.stringify(workspace, null, 2), 'utf8');
  return workspace;
}

/**
 * Ingests discoveries from a recon audit run and updates the living app map
 */
function ingestAuditData(targetUrl, auditResult = {}) {
  const ws = getTargetWorkspace(targetUrl) || {
    targetUrl: targetUrl.startsWith('http') ? targetUrl : `https://${normalizeDomain(targetUrl)}`,
    apexDomain: normalizeDomain(targetUrl)
  };

  const now = new Date().toISOString();
  ws.lastAudited = now;

  // 1. Merge Perimeter & DNS
  if (auditResult.perimeter) {
    ws.perimeter = {
      ...ws.perimeter,
      ...auditResult.perimeter
    };
  }
  if (auditResult.wildcardDns !== undefined) {
    ws.perimeter.wildcardDns = auditResult.wildcardDns;
  }

  // 2. Merge Subdomains
  if (Array.isArray(auditResult.subdomains) || Array.isArray(auditResult.liveSubdomains)) {
    const subs = auditResult.subdomains || auditResult.liveSubdomains;
    const existing = new Set(ws.subdomains.map(s => typeof s === 'string' ? s : s.subdomain));
    for (const sub of subs) {
      const subName = typeof sub === 'string' ? sub : sub.subdomain;
      if (subName && !existing.has(subName)) {
        existing.add(subName);
        ws.subdomains.push(typeof sub === 'string' ? { subdomain: subName, firstSeen: now } : sub);
      }
    }
  }

  // 1b. Merge DNS Hygiene & Apex IP
  if (auditResult.dns || auditResult.dnsRecords) {
    const dnsObj = auditResult.dns || {};
    ws.perimeter = {
      ...ws.perimeter,
      apexIp: dnsObj.a || dnsObj.ip || (Array.isArray(auditResult.dnsRecords) && auditResult.dnsRecords.find(r => r.type === 'A')?.value) || ws.perimeter.apexIp,
      mx: dnsObj.mx || ws.perimeter.mx,
      dnsHygiene: {
        ...(ws.perimeter.dnsHygiene || {}),
        spf: dnsObj.spf || ws.perimeter.dnsHygiene?.spf,
        dmarc: dnsObj.dmarc || ws.perimeter.dnsHygiene?.dmarc,
        caa: dnsObj.caa || ws.perimeter.dnsHygiene?.caa
      }
    };
  }

  // 3. Merge Services, Banners & Open Ports
  const portList = auditResult.banners || auditResult.services || auditResult.ports || auditResult.openPorts || (auditResult.network && auditResult.network.openPorts);
  if (Array.isArray(portList)) {
    const existingPorts = new Set(ws.services.map(s => s.port));
    for (const svc of portList) {
      const portNum = typeof svc === 'number' ? svc : (svc && svc.port);
      if (portNum && !existingPorts.has(portNum)) {
        existingPorts.add(portNum);
        const defaultSvc = portNum === 443 ? 'https' : portNum === 80 ? 'http' : portNum === 25 ? 'smtp' : portNum === 22 ? 'ssh' : portNum === 3306 ? 'mysql' : 'tcp';
        ws.services.push(typeof svc === 'number' ? { port: portNum, service: defaultSvc, banner: null } : svc);
      }
    }
  }

  // 4. Merge Client Routes (SPA)
  if (Array.isArray(auditResult.routes) || Array.isArray(auditResult.spaRoutes)) {
    const routes = auditResult.routes || auditResult.spaRoutes;
    const existingRoutes = new Set(ws.spaRoutes);
    for (const r of routes) {
      if (r && !existingRoutes.has(r)) {
        existingRoutes.add(r);
        ws.spaRoutes.push(r);
      }
    }
  }

  // 5. Merge API Endpoints
  if (Array.isArray(auditResult.endpoints) || Array.isArray(auditResult.apiEndpoints)) {
    const eps = auditResult.endpoints || auditResult.apiEndpoints;
    const existingEps = new Set(ws.apiEndpoints);
    for (const ep of eps) {
      if (ep && !existingEps.has(ep)) {
        existingEps.add(ep);
        ws.apiEndpoints.push(ep);
      }
    }
  }

  // 6. Update Scorecards & Findings
  if (Array.isArray(auditResult.findings)) {
    ws.findings = auditResult.findings;
  }

  if (auditResult.scores) {
    ws.scores = auditResult.scores;
  } else if (auditResult.postureScore !== undefined) {
    ws.scores = {
      postureScore: auditResult.postureScore,
      postureGrade: auditResult.postureGrade,
      exploitabilityScore: auditResult.exploitabilityScore || 100,
      exploitabilityGrade: auditResult.exploitabilityGrade || 'A+',
      status: auditResult.status || 'Audited'
    };
  } else if (ws.findings && ws.findings.length > 0) {
    const computed = calculateGrade(ws.findings);
    ws.scores = {
      postureScore: computed.postureScore || 100,
      postureGrade: computed.postureGrade || 'A+',
      exploitabilityScore: computed.exploitabilityScore,
      exploitabilityGrade: computed.exploitabilityGrade,
      status: `Audited (${ws.findings.length} findings)`
    };
  }

  // 7. Append to History Timeline
  ws.history = ws.history || [];
  ws.history.unshift({
    timestamp: now,
    scores: ws.scores,
    findingsCount: ws.findings.length,
    subdomainCount: ws.subdomains.length,
    serviceCount: ws.services.length
  });

  // Keep last 30 runs in history
  if (ws.history.length > 30) {
    ws.history = ws.history.slice(0, 30);
  }

  return saveTargetWorkspace(ws);
}

/**
 * Retrieves discovered deployed applications from the user's cluster workspace
 */
function getDeployedClusterApps() {
  const p = path.join(process.env.PROFILE_DIR || '/profiles', 'cluster-apps.json');
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      console.error('[targetWorkspace] Failed reading cluster-apps.json:', e.message);
    }
  }
  return [];
}

/**
 * Deletes a registered target application workspace
 */
function deleteTargetWorkspace(targetUrl) {
  const domain = normalizeDomain(targetUrl);
  if (!domain) return false;
  const fp = getFilePath(domain);
  if (fs.existsSync(fp)) {
    try {
      fs.unlinkSync(fp);
      return true;
    } catch (e) {
      console.error(`[targetWorkspace] Failed unlinking ${fp}:`, e.message);
    }
  }
  return false;
}

/**
 * Lists all registered target applications (including deployed cluster applications)
 */
function listTargetWorkspaces() {
  ensureDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const targets = [];
  const seenDomains = new Set();

  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      const dom = data.domain || data.apexDomain;
      seenDomains.add(dom);
      targets.push({
        apexDomain: data.apexDomain,
        domain: dom,
        targetUrl: data.targetUrl,
        title: data.title || data.apexDomain,
        type: data.type || (data.targetUrl && data.targetUrl.includes('my-app.engineer') ? 'cluster' : 'custom'),
        lastAudited: data.lastAudited,
        watchEnabled: data.watchEnabled || false,
        scores: data.scores || null,
        findingsCount: (data.findings || []).length,
        subdomainCount: (data.subdomains || []).length,
        serviceCount: (data.services || []).length,
        isCluster: data.isCluster !== undefined ? data.isCluster : (data.targetUrl && data.targetUrl.includes('my-app.engineer')),
        subdomains: data.subdomains || [],
        services: data.services || [],
        spaRoutes: data.spaRoutes || [],
        perimeter: data.perimeter || {},
        findings: data.findings || []
      });
    } catch (e) {}
  }

  // Also include deployed cluster apps so the user sees all platform applications
  const clusterApps = getDeployedClusterApps();
  for (const ca of clusterApps) {
    const dom = normalizeDomain(ca.host || ca.targetUrl);
    if (dom && !seenDomains.has(dom)) {
      seenDomains.add(dom);
      targets.push({
        apexDomain: dom,
        domain: dom,
        targetUrl: ca.targetUrl,
        title: ca.name || dom,
        type: 'cluster',
        lastAudited: null,
        watchEnabled: false,
        scores: { postureScore: 100, postureGrade: 'A+', exploitabilityScore: 100, exploitabilityGrade: 'A+', status: 'Cluster Deployed (Ready for Audit)' },
        findingsCount: 0,
        subdomainCount: 1,
        serviceCount: 0,
        isCluster: true,
        subdomains: [dom],
        services: [],
        spaRoutes: [],
        perimeter: {},
        findings: []
      });
    }
  }

  return targets;
}

module.exports = {
  getTargetWorkspace,
  saveTargetWorkspace,
  deleteTargetWorkspace,
  getDeployedClusterApps,
  ingestAuditData,
  listTargetWorkspaces,
  normalizeDomain
};
