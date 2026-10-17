'use strict';
/**
 * complianceMapper.js — Enterprise Compliance Framework Mapping Engine
 *
 * Automatically maps technical vulnerability findings (CWE / OWASP) directly to:
 *   - SOC 2 Type II: Trust Services Criteria (Common Criteria 6.0)
 *   - ISO 27001:2022: Annex A Controls (Information Security Controls)
 *   - PCI-DSS v4.0: Requirement 6 (Secure Systems & Applications)
 *
 * Provides turnkey compliance evidence for external auditors and enterprise CISOs.
 */

const COMPLIANCE_MAP = {
  // Injection / XSS
  'CWE-79': {
    soc2: ['CC6.6 (Perimeter & Web Application Defense)', 'CC6.8 (Unauthorized Code Prevention)'],
    iso27001: ['A.8.26 (Application Security Requirements)', 'A.8.28 (Secure Coding)'],
    pciDss: ['Requirement 6.4 (Public-Facing Application Protection)', 'Requirement 6.5.7 (Cross-Site Scripting Mitigation)']
  },
  // Broken Authorization / BOLA / IDOR
  'CWE-285': {
    soc2: ['CC6.1 (Logical Access Security)', 'CC6.3 (Role-Based Access Management)'],
    iso27001: ['A.9.4.1 (Information Access Restriction)', 'A.8.3 (Access Control)'],
    pciDss: ['Requirement 7.1 (Restrict Access to Need-to-Know)', 'Requirement 7.2 (Role-Based Access Control)']
  },
  'CWE-639': {
    soc2: ['CC6.1 (Logical Access Security)', 'CC6.3 (Authorization Enforcement)'],
    iso27001: ['A.9.4.1 (Information Access Restriction)', 'A.8.3 (Access Control)'],
    pciDss: ['Requirement 6.5.8 (Access Control & Insecure Direct Object Reference)']
  },
  // Insecure Headers / Verb Tampering
  'CWE-650': {
    soc2: ['CC6.6 (Boundary Protection)', 'CC6.7 (Transmission Protections)'],
    iso27001: ['A.8.20 (Network Security)', 'A.8.22 (Segregation of Networks)'],
    pciDss: ['Requirement 6.4.1 (Web Application Protections)']
  },
  'CWE-1021': {
    soc2: ['CC6.6 (Boundary Protection)'],
    iso27001: ['A.8.26 (Application Security Requirements)'],
    pciDss: ['Requirement 6.4.1 (Application Defense)']
  },
  // Cryptography & Tokens
  'CWE-347': {
    soc2: ['CC6.1 (Authentication Integrity)', 'CC6.7 (Cryptographic Controls)'],
    iso27001: ['A.8.24 (Use of Cryptography)'],
    pciDss: ['Requirement 4.1 (Strong Cryptography)', 'Requirement 8.2 (User Authentication)']
  },
  'CWE-312': {
    soc2: ['CC6.7 (Data Protection & Encryption)', 'CC6.1 (Credential Hygiene)'],
    iso27001: ['A.8.24 (Use of Cryptography)', 'A.8.11 (Data Masking)'],
    pciDss: ['Requirement 3.4 (Cardholder & Sensitive Data Protection)']
  },
  // Throttling & Rate-Limiting
  'CWE-799': {
    soc2: ['CC6.6 (Protection Against Automated Attacks)', 'CC7.1 (System Availability)'],
    iso27001: ['A.8.20 (Network Security)'],
    pciDss: ['Requirement 6.4 (Protection Against Malicious Traffic)']
  },
  // Concurrency & Race Conditions
  'CWE-362': {
    soc2: ['CC6.8 (State Synchronization & Integrity)'],
    iso27001: ['A.8.28 (Secure Coding)'],
    pciDss: ['Requirement 6.5 (Prevent Logic Flaws in Critical Processes)']
  }
};

/**
 * Maps a single finding to compliance controls
 */
function mapFindingToCompliance(finding) {
  if (!finding) return {};

  // Extract CWE number if present (e.g. "CWE-79" or "CWE-285")
  const match = (finding.cwe || finding.title || '').match(/CWE-\d+/i);
  const cweKey = match ? match[0].toUpperCase() : null;

  const defaultMapping = {
    soc2: ['CC6.6 (Logical Access & Boundary Protections)'],
    iso27001: ['A.8.26 (Application Security Requirements)'],
    pciDss: ['Requirement 6.4 (Application Defense)']
  };

  const controls = (cweKey && COMPLIANCE_MAP[cweKey]) ? COMPLIANCE_MAP[cweKey] : defaultMapping;

  return {
    cwe: cweKey || 'N/A',
    soc2: controls.soc2,
    iso27001: controls.iso27001,
    pciDss: controls.pciDss
  };
}

/**
 * Generates an executive compliance scorecard across all audit findings
 */
function generateComplianceScorecard(findings = []) {
  const soc2Impacted = new Set();
  const isoImpacted = new Set();
  const pciImpacted = new Set();

  findings.forEach(f => {
    const map = mapFindingToCompliance(f);
    map.soc2?.forEach(c => soc2Impacted.add(c));
    map.iso27001?.forEach(c => isoImpacted.add(c));
    map.pciDss?.forEach(c => pciImpacted.add(c));
  });

  const compliant = findings.length === 0;

  return {
    complianceStatus: compliant ? 'COMPLIANT (Clean Assessment)' : 'ACTION_REQUIRED',
    findingsEvaluated: findings.length,
    soc2: {
      status: compliant ? 'COMPLIANT' : 'REVIEW_REQUIRED',
      affectedControls: Array.from(soc2Impacted)
    },
    iso27001: {
      status: compliant ? 'COMPLIANT' : 'REVIEW_REQUIRED',
      affectedControls: Array.from(isoImpacted)
    },
    pciDss: {
      status: compliant ? 'COMPLIANT' : 'REVIEW_REQUIRED',
      affectedControls: Array.from(pciImpacted)
    }
  };
}

module.exports = {
  mapFindingToCompliance,
  generateComplianceScorecard
};
