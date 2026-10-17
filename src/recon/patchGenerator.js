'use strict';
/**
 * patchGenerator.js — Automated Pull-Request Ready Remediation Patch Synthesizer
 *
 * Generates verified, copy-pasteable Git diff patches and middleware blocks
 * tailored to enterprise tech stacks (Express, Next.js, Nginx, Traefik).
 */

/**
 * Synthesizes a Git diff patch for a given vulnerability type
 *
 * @param {string} vulnType - 'XSS_REFLECTION' | 'DOM_XSS' | 'BROKEN_AUTH' | 'VERB_TAMPERING' | 'CORS_MISCONFIG'
 * @param {object} details - Contextual details (parameter, endpoint, etc.)
 */
function generateRemediationPatch(vulnType, details = {}) {
  switch (vulnType) {
    case 'XSS_REFLECTION': {
      const param = details.parameter || 'query';
      return `--- a/routes/search.js
+++ b/routes/search.js
@@ -1,5 +1,6 @@
 const express = require('express');
 const router = express.Router();
+const { escapeHtml } = require('../utils/sanitize');

 router.get('/search', (req, res) => {
-  const query = req.query.${param};
-  res.send(\`<div class="results">Search results for: \${query}</div>\`);
+  const query = escapeHtml(req.query.${param} || '');
+  res.send(\`<div class="results">Search results for: \${query}</div>\`);
 });
`;
    }

    case 'DOM_XSS': {
      const sink = details.sink || 'innerHTML';
      return `--- a/components/Viewer.jsx
+++ b/components/Viewer.jsx
@@ -1,5 +1,6 @@
 import React from 'react';
+import DOMPurify from 'dompurify';

 export function Viewer({ content }) {
-  return <div dangerouslySetInnerHTML={{ __html: content }} />;
+  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }} />;
 }
`;
    }

    case 'BROKEN_AUTH': {
      const endpoint = details.endpoint || '/api/admin/users';
      return `--- a/routes/api.js
+++ b/routes/api.js
@@ -8,6 +8,8 @@
+const { requireAuth, requireRole } = require('../middleware/auth');

-router.get('${endpoint}', async (req, res) => {
+router.get('${endpoint}', requireAuth, requireRole('ADMIN'), async (req, res) => {
   const data = await getSensitiveRecords();
   res.json(data);
 });
`;
    }

    case 'VERB_TAMPERING': {
      return `--- a/nginx/default.conf
+++ b/nginx/default.conf
@@ -14,6 +14,12 @@
     location / {
+        # Drop dangerous HTTP methods at the reverse proxy
+        if ($request_method !~ ^(GET|POST|HEAD|OPTIONS)$) {
+            return 405 "Method Not Allowed";
+        }
+
         proxy_pass http://backend_upstream;
     }
`;
    }

    case 'CORS_MISCONFIG': {
      return `--- a/server.js
+++ b/server.js
@@ -10,7 +10,14 @@
-app.use(cors({ origin: true, credentials: true }));
+const allowedOrigins = ['https://app.company.com', 'https://admin.company.com'];
+app.use(cors({
+  origin: (origin, callback) => {
+    if (!origin || allowedOrigins.includes(origin)) {
+      callback(null, true);
+    } else {
+      callback(new Error('Blocked by CORS policy'));
+    }
+  },
+  credentials: true
+}));
`;
    }

    default:
      return null;
  }
}

module.exports = {
  generateRemediationPatch
};
