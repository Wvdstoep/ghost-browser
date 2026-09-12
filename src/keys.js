/**
 * keys.js — who is calling, and what they are allowed to hold open.
 *
 * Deliberately small. Real billing, Stripe and self-service signup are a later phase; what cannot
 * wait is that every request is attributable to somebody and that concurrency is enforced by plan
 * rather than by hope — because concurrency is the thing that decides whether this service survives
 * more than one customer, and retrofitting it after people are using it is much harder.
 *
 * Keys arrive as env, like every other credential on this platform: a JSON object, or the simpler
 * `key:plan,key:plan` form for a handful of them. Nothing is stored in the image and nothing is
 * written to disk.
 */

const PLANS = {
  /*
   * No free tier that opens a browser. That is the whole abuse surface and it is expensive abuse:
   * a browser session costs real memory for its entire life, so an anonymous one is a way to spend
   * someone else's money. A free key may exist later for the cheap search path; it may never open
   * Chromium.
   */
  trial: { maxConcurrent: 1, label: 'Trial' },
  solo:  { maxConcurrent: 1, label: 'Solo' },
  team:  { maxConcurrent: 3, label: 'Team' },
  scale: { maxConcurrent: 8, label: 'Scale' },
};

function parseKeys(raw = process.env.API_KEYS || '') {
  const out = new Map();
  const text = String(raw).trim();
  if (!text) return out;

  if (text.startsWith('{')) {
    try {
      for (const [key, v] of Object.entries(JSON.parse(text))) {
        const plan = typeof v === 'string' ? v : (v && v.plan);
        const owner = (v && v.owner) || key.slice(0, 8);
        if (PLANS[plan]) out.set(key, { key, owner, plan, ...PLANS[plan] });
      }
      return organsAreNotCustomers(out);
    } catch { /* fall through to the simple form rather than starting with no keys at all */ }
  }
  for (const pair of text.split(',')) {
    const [key, plan = 'solo'] = pair.split(':').map((s) => s.trim());
    if (key && PLANS[plan]) out.set(key, { key, owner: key.slice(0, 8), plan, ...PLANS[plan] });
  }
  return organsAreNotCustomers(out);
}

/*
 * A PLATFORM-MINTED ORGAN KEY IS NOT A CUSTOMER.
 *
 * The provisioner mints ONE 'gb_' key per cluster and Herald, LeadFlow and the master all share it,
 * on the ':team' plan — so every organ of the platform together was allowed three sessions. Three
 * room reads on three profiles used them, and the fourth thing the desk needed, a reply on a fourth
 * profile, got 'your plan allows 3 concurrent sessions' and improvised. Plans are the lever for
 * selling this browser to somebody else. The cluster's own organs are held to the pod's real
 * capacity — the session ceiling and the memory guard — which the pool enforces on its own.
 */
const ORGAN_CAP = 64;   // only the pod's own ceiling applies; this number is never the binding one
function organsAreNotCustomers(map) {
  for (const k of map.values()) if (String(k.key || '').startsWith('gb_')) k.maxConcurrent = ORGAN_CAP;
  return map;
}

/**
 * Express middleware. Rejects rather than degrading: an unauthenticated request must never get a
 * browser, and "no keys configured" is a misconfiguration to shout about, not a reason to open up.
 */
function auth(keys) {
  return (req, res, next) => {
    if (!keys.size) {
      return res.status(503).json({ error: 'this service has no API keys configured — it cannot serve anyone yet' });
    }
    const header = req.get('authorization') || '';
    const presented = header.replace(/^Bearer\s+/i, '').trim() || req.get('x-api-key') || '';
    const found = presented && keys.get(presented);
    if (!found) {
      return res.status(401).json({ error: 'no valid API key — send it as `Authorization: Bearer <key>`' });
    }
    req.client = found;
    next();
  };
}

module.exports = { PLANS, parseKeys, auth };
