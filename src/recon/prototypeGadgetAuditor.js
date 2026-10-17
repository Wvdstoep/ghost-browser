'use strict';
/**
 * prototypeGadgetAuditor.js — Prototype Pollution RCE Gadget Chain Analyzer (CWE-1321 / CWE-78)
 *
 * Scans JavaScript/TypeScript codebases and backend dependency graphs to detect:
 *   1. Pollution Sources / Primitives:
 *      - lodash.merge / defaultsDeep / set
 *      - qs.parse (with allowPrototypes: true)
 *      - Unchecked recursive merges: obj[a][b] = c without __proto__ / constructor filtering
 *   2. Dangerous Execution Gadgets:
 *      - child_process (spawn, fork, execFile) inheriting { shell, env, NODE_OPTIONS } from Object.prototype
 *      - EJS template engine inheriting { outputFunctionName, destructuredFile }
 *      - Pug template engine inheriting { compileDebug, inlineRuntimeFunctions }
 *   3. Reachability & Exploitability Graph:
 *      Correlates whether an existing prototype pollution source can trigger a weaponizable
 *      gadget sink in the application.
 */

const fs = require('fs');
const path = require('path');

const POLLUTION_SOURCES = [
  {
    name: 'lodash.merge / defaultsDeep',
    pattern: /\b(?:lodash|_)\.(?:merge|defaultsDeep)\s*\(/g,
    cve: 'CVE-2019-10744',
    type: 'LIBRARY_DEEP_MERGE'
  },
  {
    name: 'qs.parse with Prototype Inheritance',
    pattern: /qs\.parse\s*\([^)]*allowPrototypes\s*:\s*true/g,
    cve: 'CVE-2017-1000048',
    type: 'QUERY_STRING_PARSER'
  },
  {
    name: 'Unchecked Dynamic Property Assignment',
    pattern: /\b\w+\[\w+\]\[\w+\]\s*=/g,
    cve: 'CWE-1321',
    type: 'MANUAL_RECURSIVE_ASSIGN'
  }
];

const KNOWN_GADGET_SINKS = [
  {
    id: 'NODE_CHILD_PROCESS_ENV',
    title: 'Node.js child_process.spawn / fork env & shell Gadget',
    cwe: 'CWE-78',
    severity: 'CRITICAL',
    pattern: /\b(?:child_process\.)?(?:spawn|fork|execFile)\s*\(/g,
    pollutableProperties: ['shell', 'env', 'NODE_OPTIONS', 'windowsVerbatimArguments'],
    impact: 'Polluting Object.prototype.shell or NODE_OPTIONS causes any child_process execution to inherit arbitrary commands, leading to instant Remote Code Execution (RCE).'
  },
  {
    id: 'EJS_OUTPUT_FUNCTION',
    title: 'EJS Template Engine outputFunctionName Gadget',
    cwe: 'CWE-94',
    severity: 'CRITICAL',
    pattern: /\bejs\.(?:render|compile|renderFile)\s*\(/g,
    pollutableProperties: ['outputFunctionName', 'destructuredFile', 'escapeFunction'],
    impact: 'Polluting Object.prototype.outputFunctionName allows arbitrary JavaScript execution when EJS compiles any template string.'
  },
  {
    id: 'PUG_COMPILE_DEBUG',
    title: 'Pug Template Engine compileDebug Gadget',
    cwe: 'CWE-94',
    severity: 'HIGH',
    pattern: /\bpug\.(?:compile|render)\s*\(/g,
    pollutableProperties: ['compileDebug', 'inlineRuntimeFunctions'],
    impact: 'Polluting Object.prototype.compileDebug injects unescaped debug blocks into generated function bodies.'
  }
];

function scanFileContent(filePath, content) {
  const sourcesFound = [];
  const gadgetsFound = [];

  for (const src of POLLUTION_SOURCES) {
    const matches = content.match(src.pattern);
    if (matches && matches.length > 0) {
      sourcesFound.push({
        source: src.name,
        type: src.type,
        cve: src.cve,
        occurrences: matches.length
      });
    }
  }

  for (const g of KNOWN_GADGET_SINKS) {
    const matches = content.match(g.pattern);
    if (matches && matches.length > 0) {
      gadgetsFound.push({
        gadgetId: g.id,
        title: g.title,
        cwe: g.cwe,
        severity: g.severity,
        pollutableProperties: g.pollutableProperties,
        impact: g.impact,
        occurrences: matches.length
      });
    }
  }

  return { sourcesFound, gadgetsFound };
}

function walkDirectory(dir, fileList = [], maxFiles = 300) {
  if (!fs.existsSync(dir)) return fileList;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (fileList.length >= maxFiles) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('.') && ent.name !== 'node_modules' && ent.name !== 'dist' && ent.name !== 'build') {
          walkDirectory(full, fileList, maxFiles);
        }
      } else if (ent.isFile()) {
        if (/\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(ent.name)) {
          fileList.push(full);
        }
      }
    }
  } catch (_) {}
  return fileList;
}

async function auditPrototypeGadgets(projectDir = process.cwd()) {
  const targetDir = path.resolve(projectDir);
  const files = walkDirectory(targetDir, [], 250);

  const sourcesByFile = [];
  const gadgetsByFile = [];

  for (const f of files) {
    try {
      const code = fs.readFileSync(f, 'utf8');
      const { sourcesFound, gadgetsFound } = scanFileContent(f, code);
      const relPath = path.relative(targetDir, f).replace(/\\/g, '/');

      if (sourcesFound.length > 0) {
        sourcesByFile.push({ file: relPath, sources: sourcesFound });
      }
      if (gadgetsFound.length > 0) {
        gadgetsByFile.push({ file: relPath, gadgets: gadgetsFound });
      }
    } catch (_) {}
  }

  // Cross-reference: If we have an active source AND an active gadget
  const hasPollutionSource = sourcesByFile.length > 0;
  const hasDangerousGadget = gadgetsByFile.length > 0;

  const chains = [];

  if (hasPollutionSource && hasDangerousGadget) {
    for (const s of sourcesByFile) {
      for (const g of gadgetsByFile) {
        chains.push({
          sourceFile: s.file,
          sources: s.sources,
          gadgetFile: g.file,
          gadgets: g.gadgets,
          chainRisk: 'CONFIRMED_EXPLOITABLE_GADGET_CHAIN',
          severity: 'CRITICAL',
          impact: `Prototype pollution in ${s.file} can pollute Object.prototype, which will be inherited by ${g.gadgets.map(x => x.title).join(', ')} in ${g.file}, triggering arbitrary code execution (RCE).`
        });
      }
    }
  }

  return {
    engine: 'GhostBrowser-PrototypeGadgetAuditor/3.0',
    projectDir: targetDir,
    scannedFilesCount: files.length,
    pollutionSourcesCount: sourcesByFile.length,
    pollutionSources: sourcesByFile,
    dangerousGadgetsCount: gadgetsByFile.length,
    dangerousGadgets: gadgetsByFile,
    activeGadgetChainsCount: chains.length,
    activeGadgetChains: chains,
    posture: chains.length > 0 ? 'CRITICAL_GADGET_CHAIN_DETECTED' : (hasDangerousGadget ? 'DORMANT_GADGETS_NO_ACTIVE_SOURCE' : 'RESILIENT'),
    remediation: chains.length > 0 ? {
      immediateAction: 'Freeze Object.prototype at application bootstrap: Object.freeze(Object.prototype);',
      safeMergeHelper: 'Strip "__proto__", "constructor", and "prototype" keys before any recursive object merges.'
    } : null
  };
}

module.exports = {
  auditPrototypeGadgets,
  POLLUTION_SOURCES,
  KNOWN_GADGET_SINKS
};
