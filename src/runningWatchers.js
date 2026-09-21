/*
 * THE ONE-PASS-AT-A-TIME FLAG, WHICH COULD NEVER LET GO.
 *
 * `runningWatchers` was a plain Set: add on start, delete in .finally(). Every path has a .finally(),
 * so a pass that THROWS cleans up after itself. A pass whose promise never settles does not, and
 * then nothing ever removes the entry, because the only thing that would have is the callback that
 * never ran.
 *
 * Found in production: `facebook-post-polish-it-group-offer` sat in the set for 114 minutes on a
 * watcher that was not even active, holding no browser session, its own recorded lastPass showing a
 * SEVEN SECOND run that had long since ended.
 *
 * The blast radius is the whole machine, because the gates ask `runningWatchers.size` rather than
 * anything per-profile: one stuck entry blocks every watcher pass, every flow run (the dev agent sat
 * in a sleep-and-retry loop burning 40 of its 150 iterations against it), and the deployer's idle
 * gate, which is how a built image waited two hours to roll.
 *
 * It was invisible too. The health endpoint computes stale as `active && !running && ...`, so while
 * an entry is stuck `running` is true and the watcher can NEVER be reported stale — the check is
 * blinded by exactly the state it exists to find.
 *
 * So the flag now carries the time it was set, and a read reaps whatever has outlived the cap. This
 * only clears the FLAG, never the work: if a genuinely long pass is still going, a reap lets a
 * second pass start alongside it, which is the thing the gate exists to prevent. That is why the cap
 * is generous rather than tight, why it is one env var away from being changed, and why every reap
 * says so loudly instead of tidying up in silence.
 */
'use strict';

/** Generous on purpose: normal passes take seconds to a couple of minutes. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function ttl() {
  const n = Number(process.env.WATCHER_RUN_TTL_MS);
  return Number.isFinite(n) && n >= 60000 ? n : DEFAULT_TTL_MS;
}

/*
 * A Set, deliberately, and not a nicer shape: ~25 call sites already use .add/.delete/.has/.size and
 * spread it into a message. Keeping the interface means the fix is the storage, not a refactor of
 * every gate, and a gate that was correct before stays correct.
 */
class RunningWatchers extends Set {
  constructor(log) {
    super();                                  // never with an iterable: that would call add() before _at exists
    this._at = new Map();
    this._log = log || null;
  }

  /** Whoever is holding the flag, and since when — the two facts needed to diagnose a stuck pass. */
  startedAt(key) { return this._at.get(key) || 0; }

  add(key) { this._at.set(key, Date.now()); return super.add(key); }
  delete(key) { this._at.delete(key); return super.delete(key); }
  clear() { this._at.clear(); return super.clear(); }

  /** Drop flags that outlived the cap. Returns what it cleared, so a caller can report it. */
  reap(now = Date.now()) {
    const cap = ttl();
    const gone = [];
    for (const key of [...super.values()]) {          // copy: we delete while looking
      const at = this._at.get(key) || 0;
      if (!at || now - at <= cap) continue;
      super.delete(key);
      this._at.delete(key);
      gone.push({ key, heldMinutes: Math.round((now - at) / 60000) });
    }
    for (const g of gone) {
      const m = `[watchers] cleared a stuck run flag "${g.key}" after ${g.heldMinutes} min — its pass`
        + ' never settled, so nothing was ever going to release it. One stuck flag blocks every'
        + ' watcher pass, every flow run and the deploy gate.';
      if (this._log && this._log.warn) this._log.warn(m); else console.warn(m);
    }
    return gone;
  }

  /* Every read reaps first, so a stuck flag cannot outlive the cap no matter who asks. */
  get size() { this.reap(); return super.size; }
  has(key) { this.reap(); return super.has(key); }
  values() { this.reap(); return super.values(); }
  keys() { this.reap(); return super.keys(); }
  entries() { this.reap(); return super.entries(); }
  forEach(fn, thisArg) { this.reap(); return super.forEach(fn, thisArg); }
  [Symbol.iterator]() { this.reap(); return super[Symbol.iterator](); }
}

module.exports = { RunningWatchers, DEFAULT_TTL_MS, ttl };
