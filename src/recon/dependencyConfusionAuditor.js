'use strict';
/**
 * dependencyConfusionAuditor.js — Dependency Confusion & Internal Namespace Squatting Auditor (CWE-427)
 *
 * Inspects package.json and .npmrc configuration to verify whether internal/private npm packages
 * are susceptible to Dependency Confusion attacks on public registry.npmjs.org.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

function queryPublicNpmRegistry(pkgName) {
  return new Promise((resolve) => {
    try {
      // Encode scoped packages properly: @scope/name -> @scope%2Fname
      const encoded = pkgName.startsWith('@') ? `@${encodeURIComponent(pkgName.slice(1))}` : encodeURIComponent(pkgName);
      const url = `https://registry.npmjs.org/${encoded}`;

      const req = https.get(url, {
        headers: {
          'User-Agent': 'GhostBrowser-DependencyConfusionAuditor/3.0',
          'Accept': 'application/json'
        },
        timeout: 5000
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d.toString(); });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch (_) {}
          resolve({ status: res.statusCode, data: json });
        });
      });

      req.on('error', (err) => resolve({ status: 0, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

function findPackageJsons(dir, results = [], depth = 0) {
  if (depth > 3 || !fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('.') && ent.name !== 'node_modules' && ent.name !== 'dist' && ent.name !== 'build') {
          findPackageJsons(path.join(dir, ent.name), results, depth + 1);
        }
      } else if (ent.isFile() && ent.name === 'package.json') {
        results.push(path.join(dir, ent.name));
      }
    }
  } catch (_) {}
  return results;
}

async function auditDependencyConfusion(projectDir = process.cwd()) {
  const targetDir = path.resolve(projectDir);
  const pkgJsonFiles = findPackageJsons(targetDir);

  const findings = [];
  const secureControls = [];
  const packagesChecked = [];

  // Check .npmrc for scoped registry safeguards
  const npmrcPath = path.join(targetDir, '.npmrc');
  const hasNpmrc = fs.existsSync(npmrcPath);
  let npmrcContent = '';
  if (hasNpmrc) {
    try { npmrcContent = fs.readFileSync(npmrcPath, 'utf8'); } catch (_) {}
  }

  const allDependencies = new Map(); // name -> { version, file }

  for (const pkgFile of pkgJsonFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const deps = { ...(content.dependencies || {}), ...(content.devDependencies || {}) };
      for (const [name, ver] of Object.entries(deps)) {
        if (!allDependencies.has(name)) {
          allDependencies.set(name, { version: ver, file: path.relative(targetDir, pkgFile).replace(/\\/g, '/') });
        }
      }
    } catch (_) {}
  }

  // Filter for candidate private / internal packages:
  // 1. Scoped packages (e.g. @webnpm/*, @myapp/*)
  // 2. Packages with file:, link:, or workspace: protocol
  // 3. Packages matching internal naming patterns
  const candidateInternalPkgs = [];
  for (const [name, meta] of allDependencies.entries()) {
    const isScoped = name.startsWith('@');
    const isLocalProtocol = typeof meta.version === 'string' && (meta.version.startsWith('file:') || meta.version.startsWith('link:') || meta.version.startsWith('workspace:'));
    const isInternalPattern = /internal|service|agent|cluster|priv/i.test(name);

    if (isScoped || isLocalProtocol || isInternalPattern) {
      candidateInternalPkgs.push({ name, ...meta });
    }
  }

  // Probe public npm registry for each candidate
  for (const candidate of candidateInternalPkgs.slice(0, 15)) {
    packagesChecked.push(candidate.name);
    const registryResult = await queryPublicNpmRegistry(candidate.name);

    if (registryResult.status === 404) {
      // Package does not exist publicly. Check if .npmrc protects this scope
      const scopeMatch = candidate.name.startsWith('@') ? candidate.name.split('/')[0] : null;
      const isScopeProtected = scopeMatch && npmrcContent.includes(`${scopeMatch}:registry`);

      if (!isScopeProtected) {
        findings.push({
          cwe: 'CWE-427',
          title: `Unclaimed Internal Package Namespace (${candidate.name})`,
          severity: 'HIGH',
          package: candidate.name,
          versionInRepo: candidate.version,
          definedIn: candidate.file,
          publicNpmStatus: 404,
          impact: `Package "${candidate.name}" is used internally but is completely unclaimed on public registry.npmjs.org. An external attacker can publish a malicious version with semver 99.9.9 on public npm, causing build servers without scoped .npmrc rules to pull the attacker's code.`,
          proof: `Queried https://registry.npmjs.org/${encodeURIComponent(candidate.name)} -> Returned HTTP 404 (Unclaimed on public npm).`,
          remediation: `1. Claim and reserve the namespace or scope "${scopeMatch || candidate.name}" on npmjs.org.\n2. Add a scoped registry mapping in .npmrc: "${scopeMatch || candidate.name}:registry=https://your-private-registry/".`
        });
      } else {
        secureControls.push({
          package: candidate.name,
          control: 'Scoped .npmrc Registry Protection',
          status: 'Protected',
          detail: `Internal package is mapped to private registry in .npmrc.`
        });
      }
    } else if (registryResult.status === 200) {
      secureControls.push({
        package: candidate.name,
        control: 'Public Registry Integrity',
        status: 'Claimed',
        detail: `Package exists publicly and is verified on npmjs.org.`
      });
    }
  }

  if (candidateInternalPkgs.length === 0) {
    secureControls.push({
      control: 'Private Namespace Risk',
      status: 'Clean',
      detail: 'No ambiguous private package dependencies identified in package.json files.'
    });
  }

  const overallPosture = findings.length === 0 ? 'RESILIENT' : 'VULNERABLE';

  return {
    engine: 'GhostBrowser-DependencyConfusionAuditor/3.0',
    projectDir: targetDir,
    packageFilesFound: pkgJsonFiles.length,
    totalDependencies: allDependencies.size,
    internalCandidatesEvaluated: candidateInternalPkgs.length,
    packagesChecked,
    overallPosture,
    findingsCount: findings.length,
    findings,
    secureControlsCount: secureControls.length,
    secureControls
  };
}

module.exports = {
  auditDependencyConfusion,
  queryPublicNpmRegistry
};
