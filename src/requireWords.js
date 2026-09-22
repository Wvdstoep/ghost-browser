/*
 * requireWords.js — A ROLE'S DEVICE REQUIREMENT, IN WORDS A PERSON CHOOSES BY.
 *
 * A role says where it can run as machine facts: `{ cdp: true, features: ['click_xy','drag',
 * 'upload_file'] }`. That is exactly right for the router and useless for the person deciding
 * whether this is the correct specialist for their profile — and deciding that is the whole point
 * of being able to read a role before selecting it.
 *
 * The translation lives on the SERVER, deliberately, next to the matcher it describes. A phone, a
 * desktop and a web console each translating the same flags is three copies of one rule, and the
 * third one is always the one that goes stale. The clients render the sentence they are given.
 *
 * AN UNKNOWN NAME IS PRINTED, NEVER INVENTED. A capability this file has not been taught comes back
 * as its own name rather than a plausible phrase, because a confident wrong description of what a
 * role needs is how work gets sent to a machine that cannot do it. See missesFor in device-hub.js:
 * the names here are the names it matches on, and nothing else may be added to either list alone.
 */
'use strict';

/** The four flags missesFor checks by name. */
const FLAGS = {
  cdp: 'a desktop browser it can drive directly',
  mobileApp: 'the phone app, for real touch',
  model: 'a model running on the device itself',
  realIp: 'a home internet connection rather than a datacentre',
};

/**
 * Named primitives. Keys are the feature names devices advertise (see normCaps) — `drag` and
 * `drag_xy` are both present because the desktop node advertises the first and older roles ask for
 * the second, and a reader should not have to know which.
 */
const FEATURES = {
  navigate: 'open a page',
  info: 'read where it is',
  analyze: 'look at the page',
  content: 'read the text of a page',
  click: 'click something it has looked at',
  click_text: 'click a piece of text',
  click_xy: 'click an exact point',
  type: 'type',
  scroll: 'scroll',
  screenshot: 'take a picture of the page',
  eval: 'run a snippet on the page',
  drag: 'drag something across the page',
  drag_xy: 'drag something across the page',
  native_tap: 'tap with a real finger',
  upload_file: 'choose a file to upload',
  download_url: 'save a file to disk',
  run_goal: 'work a whole goal on its own',
  info_device: 'say what device it is',
};

/** Join with "and", the way a person writes a list. */
function andList(items) {
  const a = items.filter(Boolean);
  if (a.length === 0) return '';
  if (a.length === 1) return a[0];
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

/**
 * @param {object|null} require  a role's `require` record
 * @returns {{ any: boolean, sentence: string, needs: {key: string, words: string, known: boolean}[] }}
 */
function requireWords(require) {
  const r = require && typeof require === 'object' ? require : {};
  const needs = [];

  for (const k of Object.keys(FLAGS)) if (r[k]) needs.push({ key: k, words: FLAGS[k], known: true });
  if (r.platform) {
    const words = r.platform === 'android' ? 'a phone' : r.platform === 'desktop' ? 'a desktop computer' : `a ${r.platform}`;
    needs.push({ key: `platform:${r.platform}`, words, known: r.platform === 'android' || r.platform === 'desktop' });
  }
  for (const f of (Array.isArray(r.features) ? r.features : [])) {
    const known = Object.prototype.hasOwnProperty.call(FEATURES, f);
    needs.push({ key: `feature:${f}`, words: known ? FEATURES[f] : `"${f}"`, known });
  }

  if (!needs.length) {
    return { any: false, needs: [], sentence: 'Runs anywhere — the cluster browser is enough for this one.' };
  }
  /* The flags describe a MACHINE; the features describe what it must be able to DO. Two clauses,
     because "needs a desktop browser it can drive directly and click an exact point" reads as one
     confused requirement rather than two separate ones. */
  const machine = needs.filter((n) => !n.key.startsWith('feature:')).map((n) => n.words);
  const actions = needs.filter((n) => n.key.startsWith('feature:')).map((n) => n.words);
  const parts = [];
  if (machine.length) parts.push(`needs ${andList(machine)}`);
  if (actions.length) parts.push(`must be able to ${andList(actions)}`);
  return { any: true, needs, sentence: `This role ${parts.join(', and ')}.` };
}

/**
 * Who can actually run it right now, from the router's own answer — so the picker says "your
 * desktop can, your phone cannot drag" rather than leaving a person to guess from flag names.
 *
 * @param {object} route  what deviceHub.routeDevice(owner, need) returned
 */
function runsOnWords(route) {
  const r = route || {};
  const candidates = (r.candidates || []).map((c) => ({
    name: c.name,
    canRun: (c.misses || []).length === 0,
    lacks: (c.misses || []).map((m) => {
      const f = String(m).startsWith('feature:') ? String(m).slice(8) : null;
      if (f) return Object.prototype.hasOwnProperty.call(FEATURES, f) ? FEATURES[f] : `"${f}"`;
      return Object.prototype.hasOwnProperty.call(FLAGS, m) ? FLAGS[m] : String(m);
    }),
  }));
  const ready = candidates.filter((c) => c.canRun).map((c) => c.name);
  /* Only a device that actually lacks something can be reported as lacking it. Listing every
     candidate produced "WojMagEmi cannot ." for a device with nothing missing. */
  const short = candidates.filter((c) => c.lacks.length);
  return {
    device: r.deviceId ? r.name : null,
    ready,
    candidates,
    /* The cluster is never a candidate for a role with a requirement: it has no pointer and no
       file picker, and pretending otherwise is what produced seventy steps of guessing. */
    summary: r.deviceId
      ? `Ready to run on ${r.name}.`
      : ready.length
        ? `Ready to run on ${andList(ready)}.`
        : short.length
          ? `No connected device can run this yet — ${short.map((c) => `${c.name} cannot ${andList(c.lacks)}`).join('; ')}.`
          : 'No devices are connected, and the cluster browser cannot do this on its own.',
  };
}

module.exports = { requireWords, runsOnWords, FLAGS, FEATURES, andList };
