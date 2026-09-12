'use strict';
/**
 * keyring.js — more than one key, and the sense to move to the next one.
 *
 * THE WEEK THIS EXISTS FOR. The whole factory runs on one model account, and on the day its weekly
 * allowance ran out EVERYTHING stopped at once: the builder mid-fix, the master's research verdicts,
 * the browser's QA runs. Three services, three separate places a key is configured, one provider
 * account behind all of them — so a single number reaching 100% took the entire business offline for
 * a day. A second account fixes that only if something actually reaches for it.
 *
 * SPENT IS NOT THE SAME AS BROKEN, and that distinction is the whole module. A rejected key is a
 * configuration error and the next key will fail identically, so rotating is pointless noise. An
 * EXHAUSTED key is a fact about a billing period: this key is finished until the period rolls over,
 * another key on another account is not, and the work should carry on within seconds.
 *
 * Deliberately tiny and dependency-free so the same file can live in each service. The three do not
 * share an npm package, and inventing one to hold forty lines would cost more than the duplication.
 */

/* An allowance that resets. The provider says so in words — status alone cannot tell this apart from
   a per-minute limit, which clears by waiting and must NOT burn a second key. */
const SPENT_RE = /(weekly|monthly|daily) usage limit|usage limit|quota (exceeded|exhausted)|out of credits|insufficient (credits|quota)|exceeded your current quota/i;

/** Is this failure the kind another key could survive? */
function isSpent(err) {
  const status = err && (err.status || err.statusCode || (err.response && err.response.status));
  const text = String((err && (err.body || err.message)) || err || '');
  return status === 429 && SPENT_RE.test(text);
}

/*
 * How long a spent key is left alone. Not a guess at the provider's reset — it is deliberately
 * shorter, because being wrong toward RETRYING costs one failed call while being wrong toward
 * skipping costs a key that came back hours ago and nobody used.
 */
const REST_MS = 30 * 60 * 1000;

function makeKeyring(keys = [], { now = () => Date.now(), restMs = REST_MS, log = console } = {}) {
  // Order is meaningful: the first key is the one to prefer, the rest are there for when it is spent.
  const ring = (Array.isArray(keys) ? keys : String(keys || '').split(','))
    .map((k) => String(k || '').trim()).filter(Boolean)
    .filter((k, i, a) => a.indexOf(k) === i)          // the same key twice is one key
    /* NEVER spent is -Infinity, not 0: a falsy timestamp is indistinguishable from "spent at time
     * zero", which reads a just-spent key as fresh. Only an injected clock exposes that, and a test
     * did — with a real clock it would have sat here unnoticed until someone virtualised time. */
    .map((key) => ({ key, spentAt: -Infinity }));

  const live = () => ring.filter((e) => now() - e.spentAt > restMs);

  return {
    size: ring.length,
    /** The key to use now: the first that is not resting. Null only when there are none at all. */
    current() {
      const l = live();
      if (l.length) return l[0].key;
      /*
       * EVERY key is resting. Hand back the least-recently-spent rather than nothing: the caller
       * still has work to do, the provider may have reset early, and a real 429 is a better answer
       * than a synthetic "no key" the caller has never seen before.
       */
      return ring.length ? ring.slice().sort((a, b) => a.spentAt - b.spentAt)[0].key : null;
    },
    /** Mark a key spent. Returns the next key to try, or null when there is nothing left today. */
    spend(key, why = '') {
      const e = ring.find((x) => x.key === key);
      if (e) {
        e.spentAt = now();
        log.warn?.(`[keyring] key …${String(key).slice(-6)} is out of allowance${why ? ` (${why})` : ''} — ${live().length} of ${ring.length} still usable`);
      }
      const l = live();
      return l.length ? l[0].key : null;
    },
    /** For a status line: how many keys exist and how many are usable right now. */
    state() { return { total: ring.length, usable: live().length }; },
  };
}

module.exports = { makeKeyring, isSpent, SPENT_RE, REST_MS };
