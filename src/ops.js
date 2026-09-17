/**
 * OPS — Ghost Browser's insides, for an operator on the outside.
 *
 * The GB Operator (a harness job on the agent cluster) runs this browser the way an engineer does: it
 * reads what actually happened before it changes anything. Everything an engineer would open a
 * terminal for is here as a read: the process log (a ring buffer, so a pod that was just rolled still
 * has its last minutes), the recent runs across every flow, a live profile's screenshot, and the
 * operator's own notebook and guide. Nothing here acts on a platform, and nothing here touches code.
 */
const fs = require('fs');
const path = require('path');

const RING_MAX = 3000;
const ring = [];
function remember(level, m) {
  ring.push({ t: Date.now(), level, m: String(m) });
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

/** Wrap the server's logger so every line also lands in the ring. Call once at boot. */
function tapLog(log) {
  for (const level of ['info', 'warn', 'error']) {
    const orig = typeof log[level] === 'function' ? log[level].bind(log) : null;
    log[level] = (m) => { remember(level, m); if (orig) orig(m); };
  }
  return log;
}

const MEM_DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'operator');
const MEM_FILE = path.join(MEM_DIR, 'memory.md');
const MEM_MAX = 60000;   // chars kept; oldest notes fall off the top

function readMemory() { try { return fs.readFileSync(MEM_FILE, 'utf8'); } catch { return ''; } }
function appendMemory(note) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  let cur = readMemory() + `\n- ${stamp} — ${String(note).replace(/\s+/g, ' ').trim()}`;
  if (cur.length > MEM_MAX) cur = cur.slice(cur.length - MEM_MAX);
  fs.mkdirSync(MEM_DIR, { recursive: true }); fs.writeFileSync(MEM_FILE, cur.trim() + '\n');
  return cur.length;
}

/** The guide ships with the code (docs/OPERATOR-GUIDE.md); a section is picked by its heading. */
function readGuide(section) {
  let text = ''; try { text = fs.readFileSync(path.join(__dirname, '..', 'docs', 'OPERATOR-GUIDE.md'), 'utf8'); } catch { return '(no operator guide shipped with this build)'; }
  if (!section) return text;
  const want = String(section).toLowerCase();
  const parts = text.split(/\n(?=## )/);
  const hit = parts.filter((p) => p.toLowerCase().slice(0, 120).includes(want));
  return hit.length ? hit.join('\n') : `(no section matching "${section}"; headings: ${parts.map((p) => (p.match(/^## (.+)/) || [])[1]).filter(Boolean).join(' | ')})`;
}

/** The log, filtered: grep (substring or /regex/), a window in minutes, a line cap — newest last. */
function ringLines({ grep, since, limit } = {}) {
  const from = Date.now() - (Math.max(1, Number(since) || 30) * 60000);
  const cap = Math.min(500, Math.max(10, Number(limit) || 120));
  const g = String(grep || '').trim();
  let re = null; try { re = g ? (g.startsWith('/') && g.lastIndexOf('/') > 0 ? new RegExp(g.slice(1, g.lastIndexOf('/')), g.slice(g.lastIndexOf('/') + 1) || 'i') : new RegExp(g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')) : null; } catch { re = null; }
  return ring.filter((r) => r.t >= from && (!re || re.test(r.m))).slice(-cap).map((r) => `${new Date(r.t).toISOString().slice(11, 19)} ${r.level === 'error' ? 'ERROR ' : r.level === 'warn' ? 'WARN ' : ''}${r.m}`);
}

function install({ app, authed, workflows, pool, profiles, consoleOwner, log }) {
  app.get('/v1/ops/logs', authed, (req, res) => res.json({ lines: ringLines({ grep: req.query.grep, since: req.query.since, limit: req.query.limit }), total: ring.length }));

  // the most recent runs across every flow and watcher, newest first
  app.get('/v1/ops/runs', authed, (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15));
    const all = [];
    for (const wf of workflows.all()) { try { for (const r of workflows.runsFor(wf.id, 5)) all.push(r); } catch (e) { /* none */ } }
    all.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
    res.json({ runs: all.slice(0, limit) });
  });

  // a live profile's page, as a picture (and its url/title for a model that cannot see)
  app.get('/v1/ops/screenshot', authed, async (req, res) => {
    try {
      const owner = consoleOwner() || req.client.owner;
      const want = profiles.safeName(String(req.query.profile || 'facebook'));
      let s = pool.listFor(owner).find((x) => x.profile === want); if (s) s = pool.get(s.sessionId);
      if (!s || !s.page) return res.json({ error: `no open session on profile "${want}"`, url: null, title: null });
      const page = s.page;
      const [url, title] = [page.url(), await page.title().catch(() => '')];
      const png = await page.screenshot({ type: 'png', fullPage: false }).catch(() => null);
      res.json({ url, title, png_base64: png ? png.toString('base64') : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // the operator's notebook and guide
  app.get('/v1/ops/memory', authed, (req, res) => res.json({ text: readMemory() }));
  app.post('/v1/ops/memory', authed, (req, res) => {
    const note = String((req.body || {}).note || '').trim();
    if (!note) return res.status(400).json({ error: 'note required' });
    try { res.json({ ok: true, chars: appendMemory(note) }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/v1/ops/guide', authed, (req, res) => res.json({ text: readGuide(req.query.section) }));

  log.info('[ops] operator endpoints mounted (logs, runs, screenshot, memory, guide)');
}

module.exports = { install, tapLog, remember, ringLines, readMemory, appendMemory, readGuide };
