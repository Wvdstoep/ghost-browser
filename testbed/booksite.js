'use strict';
/**
 * testbed/booksite.js — an OPEN, no-login site shaped like a real one: a search page whose UI is a
 * client of its own JSON API. Typing fires a suggest call and telemetry as well as the real search
 * (so picking the right request is a real decision), and the page waits a beat before painting.
 * TEST-ONLY: nothing in src/ requires it.
 *
 *   mode.field       the JSON field the title lives in; flip to 'name' to simulate a renamed field
 *   mode.apiVersion  'v1' | 'v2': at 'v2' the page calls /api/v2/search and /api/search keeps answering
 *                    200 with the same shape but STALE data (author: 'unknown'), the silent failure
 */
const http = require('http');

const BOOKS = [
  ['The Ghost in the Browser', 'A. Rivera'], ['Ghost Writers of the Web', 'B. Okafor'], ['Headless Ghosts', 'C. Lindqvist'],
  ['Browser Wars, a history', 'D. Mehta'], ['The Browser Who Knew Too Much', 'E. Tanaka'], ['A Browser of One\'s Own', 'F. Haddad'],
  ['Cookies and Other Sessions', 'G. Novak'], ['Ghost Town', 'H. Berg'],
];

function makeBookSite() {
  const mode = { field: 'title', apiVersion: 'v1' };   // flipped by tests: a renamed field, a moved page with a stale v1
  const hits = { search: 0, suggest: 0, telemetry: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (u.pathname === '/') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<!doctype html><html><body>
        <input id="q" placeholder="search books">
        <ul id="results"></ul>
        <script>
          const q = document.getElementById('q'), ul = document.getElementById('results');
          let t;
          q.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(async () => {
              const v = q.value;
              fetch('/api/suggest?q=' + encodeURIComponent(v)).catch(() => {});
              fetch('/api/telemetry', { method: 'POST', body: JSON.stringify({ e: 'typed' }) }).catch(() => {});
              await new Promise((r) => setTimeout(r, 350));            // a real page is never instant
              const r = await fetch('/api/' + API + 'search?query=' + encodeURIComponent(v) + '&hitsPerPage=20&tags=book');
              const j = await r.json();
              ul.innerHTML = j.hits.map((h) => '<li class="hit"><a class="t">' + h[FIELD] + '</a> <span class="by">' + h.author + '</span></li>').join('');
            }, 150);
          });
        </script></body></html>`.replace('FIELD', JSON.stringify(mode.field)).replace('API', JSON.stringify(mode.apiVersion === 'v1' ? '' : 'v2/')));
    }
    if (u.pathname === '/api/search' || u.pathname === '/api/v2/search') {
      hits.search++;
      const stale = u.pathname === '/api/search' && mode.apiVersion === 'v2';       // v1 still answers 200, same shape, STALE data
      const q = (u.searchParams.get('query') || '').toLowerCase();
      return json({ nbHits: 0, hits: BOOKS.filter(([t]) => t.toLowerCase().includes(q)).map(([t, a], i) => ({ objectID: 'b' + i, [mode.field]: t, author: stale ? 'unknown' : a })) });
    }
    if (u.pathname === '/api/suggest') {      // a decoy: also JSON, also contains matching titles — but only the first three
      hits.suggest++;
      const q = (u.searchParams.get('q') || '').toLowerCase();
      return json({ suggestions: BOOKS.filter(([t]) => t.toLowerCase().includes(q)).slice(0, 3).map(([t]) => ({ text: t })) });
    }
    if (u.pathname === '/api/telemetry') { hits.telemetry++; res.statusCode = 204; return res.end(); }
    res.statusCode = 404; res.end('no');
  });
  return {
    mode, hits,
    async listen() { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; },
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { makeBookSite, BOOKS };
