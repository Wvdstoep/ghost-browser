/**
 * sink.js — sending each lead somewhere that already knows what to do with it.
 *
 * This browser is good at one thing no API is: reading what people actually wrote, on sites its
 * owner is signed in to. It is deliberately bad at everything after that — scoring, finding an
 * email address, drafting an approach, remembering who was contacted last Tuesday. LeadFlow does
 * all of it already.
 *
 * So a lead goes out the moment it is found, rather than accumulating in a job file that somebody
 * has to export. By the time a run finishes, the leads have already been de-duped against the whole
 * library and are sitting in a pipeline.
 *
 * ONE LEAD AT A TIME AND NEVER FATAL. A run can be forty minutes of real work behind a login that
 * took an afternoon to get; the far end being briefly unreachable must cost that run nothing. Every
 * failure here is reported into the transcript and the lead stays in the job file, which is exactly
 * what that file is for.
 */

const TIMEOUT_MS = 15000;

/**
 * Where a lead may be sent.
 *
 * https only, and never a private address. This is a URL that arrives from a page fragment, and the
 * server would otherwise POST whatever a lead contains to any address someone could name — the same
 * reason navigation is guarded, and a stronger one, because this carries a token.
 */
function checkTarget(api) {
  let u;
  try { u = new URL(String(api)); } catch { throw Object.assign(new Error('that is not a URL'), { status: 400 }); }
  if (u.protocol !== 'https:') {
    throw Object.assign(new Error('leads are only sent over https'), { status: 400 });
  }
  const host = u.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') ||
    host.endsWith('.svc') || host.endsWith('.cluster.local') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|::1$|\[?::1\]?$)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) {
    throw Object.assign(new Error('that address is inside a private network'), { status: 400 });
  }
  return u.toString().replace(/\/+$/, '');
}

/**
 * Only the fields that mean something on the other side, and nothing that identifies this browser.
 *
 * The social half is the part no places API can produce: a PERSON, what they WROTE, and WHERE. All
 * three are needed to approach them well — a reply that does not refer to their actual words is
 * exactly the one that reads as a bot.
 */
const shape = (lead) => ({
  name: lead.name, url: lead.url || null, why: lead.why || null, quote: lead.quote || null,
  contact: lead.contact || null, city: lead.city || null, phone: lead.phone || null,
  email: lead.email || null, website: lead.website || null, at: lead.at || null,
  platform: lead.platform || null, profileUrl: lead.profileUrl || null,
  groupName: lead.groupName || null, groupUrl: lead.groupUrl || null,
  postUrl: lead.postUrl || lead.url || null, postText: lead.postText || lead.quote || null,
  postedAt: lead.postedAt || null,
});

async function post(url, token, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {}),
      signal: ctl.signal,
    });
    const text = await r.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { /* an error page, not JSON */ }
    if (!r.ok) {
      // 401 here means the token expired mid-run, which is a specific and fixable thing — worth
      // saying rather than folding into a generic failure.
      throw Object.assign(new Error(parsed.error || `${r.status} ${text.slice(0, 120)}`), { status: r.status });
    }
    return parsed;
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('timed out'), { status: 504 });
    throw e;
  } finally { clearTimeout(timer); }
}

/** A destination, validated once when a job starts rather than on every lead. */
function makeSink({ api, searchId, token, label = 'LeadFlow' } = {}) {
  if (!api || !searchId || !token) return null;
  const base = checkTarget(api);
  return {
    label, searchId,
    send: (lead) => post(`${base}/${encodeURIComponent(searchId)}/lead`, token, shape(lead)),
    /* Told either way. A search left saying "processing" forever is worse than one that says it
       failed, because nobody knows whether to wait. */
    close: (failed = false) => post(`${base}/${encodeURIComponent(searchId)}/done`, token, { failed }),
  };
}

/**
 * The conversation half.
 *
 * A SEPARATE TOKEN from the lead sink, and deliberately so: checking for replies happens days after
 * the search that found them, and a credential scoped to that search would stop working exactly
 * when it starts being useful.
 */
function makeConversation({ api, token, label = 'LeadFlow' } = {}) {
  if (!api || !token) return null;
  const base = checkTarget(api);
  return {
    label,
    /* Who has been written to and has not answered — with what was said to them, so a reply can be
       recognised without opening anything. */
    awaiting: () => get(`${base}/awaiting`, token),
    /* Whose post is this? Asked when a notification names someone, so the agent can match against
       what it already knows instead of following every link. */
    match: (q) => post(`${base}/match`, token, q),
    /* One exchange, in either direction. The far end derives the stage — a browser should not get
       a vote on what a reply MEANS, or the two halves of the pipeline would disagree about the
       same words. */
    touch: (t) => post(`${base}/touch`, token, t),
    conversation: (leadId) => get(`${base}/conversation/${encodeURIComponent(leadId)}`, token),
    /* Who the owner sells for, read from LeadFlow rather than kept a second time here. It already
       holds this, on the user, feeding its templates and campaigns — and two copies of the same
       facts is a guarantee that one is stale with no way to tell which. */
    business: () => get(`${base}/business`, token),
    /* Open a search for a conversation that did not start from one. Leads only reached LeadFlow
       when the run began on the Search page — which is the rarer path; the common one is opening
       the browser and talking to it, and twenty-nine leads were stranded in a job file proving it. */
    openSearch: (query) => post(`${base}/search`, token, { query }),
  };
}

async function get(url, token) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    const text = await r.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { /* an error page, not JSON */ }
    if (!r.ok) throw Object.assign(new Error(parsed.error || `${r.status}`), { status: r.status });
    return parsed;
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('timed out'), { status: 504 });
    throw e;
  } finally { clearTimeout(timer); }
}

module.exports = { makeSink, makeConversation, checkTarget, shape };
