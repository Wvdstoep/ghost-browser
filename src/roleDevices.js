/*
 * roleDevices.js — ONE ROLE, ONE METHOD PER DEVICE.
 *
 * A role had a single `require`, and that quietly decided which machine could ever run it:
 * capcut-video-editor asks for `{cdp, click_xy, drag, upload_file}`, so the phone is excluded
 * forever — even though a phone could do the same job by long-pressing and dragging with a finger.
 * One requirement is really two statements squashed together: what the WORK needs, and how THIS
 * KIND OF MACHINE does it. They are not the same, and the differences between devices are large.
 *
 * So a role may carry a `devices` section: per device kind, what that kind needs and how the work is
 * done there. Two things follow, and the second is the point:
 *
 *   1. ROUTING WIDENS. A role is runnable if ANY variant can be satisfied, instead of only the one
 *      requirement someone happened to write first. The phone stops being excluded by omission.
 *   2. THE AGENT IS TOLD ONLY THE VARIANT IT IS ON. A hand-over carries the base playbook plus the
 *      method for the device that took the job, and nothing else — so the agent never has to work
 *      out which of two contradictory instructions applies to it. "Drag the clip onto the timeline"
 *      and "long-press the clip, then drag with your finger" are both correct and only one of them
 *      is correct HERE. Handing over both is how an agent guesses; guessing is what cost seventy
 *      steps on a video editor.
 *
 * Fully back-compatible: a role with only a top-level `require` and no `devices` behaves exactly as
 * before — one variant, no method text, same routing.
 */
'use strict';

/** The device kinds the ring itself knows (normCaps.platform). A variant for anything else is dropped. */
const KINDS = ['desktop', 'android', 'cluster'];

/** What a person calls each kind. */
const KIND_WORDS = { desktop: 'your desktop', android: 'your phone', cluster: 'the cluster browser' };

/**
 * Validate the section. Shape only — whether a device exists is the ring's business at run time.
 *
 * @param {object} devices  { desktop: { require, method, note }, android: {...} }
 * @param {function} normRequire  the role store's own requirement validator, injected so there is
 *                                exactly one definition of a valid requirement
 */
function normDevices(devices, normRequire) {
  if (!devices || typeof devices !== 'object' || Array.isArray(devices)) return null;
  const out = {};
  for (const kind of KINDS) {
    const v = devices[kind];
    if (!v || typeof v !== 'object') continue;
    const rec = {};
    const req = normRequire(v.require) || {};
    const method = typeof v.method === 'string' ? v.method.trim() : '';
    /*
     * AN EMPTY STANZA MUST NOT BECOME A REQUIREMENT.
     *
     * `{ desktop: {} }` used to come out as `require: { platform: 'desktop' }` — a requirement
     * nobody wrote, which NARROWS routing to desktop-only for a role whose author said nothing.
     * A variant has to actually state something before it constrains anything.
     */
    if (!Object.keys(req).length && !method) continue;
    /*
     * The variant's requirement implies its own platform. Writing `platform` again inside a
     * `devices.android` entry is either redundant or a contradiction, and a contradiction here
     * would route phone work to a desktop. So it is set from the key and never read from the body.
     */
    if (kind !== 'cluster') req.platform = kind;
    rec.require = req;
    if (method) rec.method = method.slice(0, 8000);
    if (typeof v.note === 'string' && v.note.trim()) rec.note = v.note.trim().slice(0, 300);
    out[kind] = rec;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Every way this role can run, in the order they should be tried.
 *
 * The base `require` stays a variant of its own (kind `any`) so nothing that works today changes.
 * Device variants are tried BEFORE it: a role that has taken the trouble to say how the desktop
 * does this work means that method, not the generic requirement it was written with.
 *
 * @returns {{kind: string, require: object|null, method: string, note: string}[]}
 */
function variantsOf(role) {
  const r = role || {};
  const out = [];
  const devices = r.devices && typeof r.devices === 'object' ? r.devices : null;
  if (devices) {
    for (const kind of KINDS) {
      const v = devices[kind];
      if (!v) continue;
      out.push({ kind, require: v.require || null, method: String(v.method || ''), note: String(v.note || '') });
    }
  }
  const base = r.require && typeof r.require === 'object' && Object.keys(r.require).length ? r.require : null;
  /* Only when there is no device section at all, OR the base says something the variants do not:
     a base requirement alongside variants is the role's old single answer, and keeping it as a
     last resort means a device that satisfies neither variant can still be found the old way. */
  if (base || !out.length) out.push({ kind: 'any', require: base, method: '', note: '' });
  return out;
}

/**
 * Pick the variant a real device can run, using the ring's own router.
 *
 * @param {function} route   (need) => { deviceId, name, reason, candidates }
 * @returns {{variant: object, route: object}|{variant: null, route: object|null, tried: object[]}}
 */
function chooseVariant(role, route) {
  const tried = [];
  for (const v of variantsOf(role)) {
    /* No requirement at all means the cluster is enough: nothing to route, nothing to refuse. */
    if (!v.require) return { variant: v, route: null, tried };
    let r;
    try { r = route(v.require); } catch (e) { r = { deviceId: null, reason: e.message, candidates: [] }; }
    if (r && r.deviceId) return { variant: v, route: r, tried };
    tried.push({ kind: v.kind, reason: (r && r.reason) || 'no device', require: v.require });
  }
  return { variant: null, route: null, tried };
}

/**
 * THE PLAYBOOK FOR THE DEVICE THAT TOOK THE JOB — base method plus this variant's, nothing else.
 *
 * The whole reason for the device section: the agent on the machine reads one coherent method
 * instead of two that contradict each other, and does not have to decide which applies to it.
 */
function playbookFor(role, variant) {
  const base = String((role && role.prompt) || '').trim();
  const extra = String((variant && variant.method) || '').trim();
  if (!extra) return base;
  const who = KIND_WORDS[variant.kind] || 'this device';
  const head = `ON THIS DEVICE (${who}) — this is the method that applies here, and the only one:`;
  return base ? `${base}\n\n${head}\n${extra}` : `${head}\n${extra}`;
}

/** Why nothing could run it, in one sentence naming each way that was tried. */
function whyNothingFits(tried) {
  if (!tried || !tried.length) return 'this role states no way to run it';
  return tried.map((t) => `${t.kind === 'any' ? 'its general requirement' : KIND_WORDS[t.kind] || t.kind}: ${t.reason}`).join('; ');
}

module.exports = { normDevices, variantsOf, chooseVariant, playbookFor, whyNothingFits, KINDS, KIND_WORDS };
