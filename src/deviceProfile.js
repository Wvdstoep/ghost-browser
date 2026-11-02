/*
 * WHICH NAME A DEVICE HOLDS A PROFILE UNDER.
 *
 * The cluster's profile "AliExpress" is the phone's profile "AliExpress" (app 0.92 and later: one name
 * everywhere). Before 0.92 the phone kept its named profiles as "p_<name>", and the server assumed that
 * prefix in six places, so after the app fixed its names every session handed to the phone asked for
 * "p_AliExpress", which the phone no longer has (2026-11-02: the AliExpress order test was refused).
 *
 * One rule instead: a device runs a profile under the name it ADVERTISES (caps.profiles). The exact name
 * first, the pre-0.92 "p_" store second; a device that has neither does not hold the profile.
 * "default" (or no name) is the device's main browser and always held.
 */
const DEFAULT = 'default';

/** The cluster name behind either spelling: "p_linkedin" and "linkedin" are both "linkedin". */
function baseName(name) {
  const n = String(name || '').trim();
  return n.startsWith('p_') ? n.slice(2) : n;
}

/** The name this device holds `name` under, or null when it does not hold it. */
function deviceProfileFor(caps, name) {
  const n = String(name || '').trim();
  if (!n || n === DEFAULT) return DEFAULT;
  const held = (caps && Array.isArray(caps.profiles)) ? caps.profiles.map(String) : [];
  const base = baseName(n);
  for (const candidate of [n, base, `p_${base}`]) if (held.includes(candidate)) return candidate;
  return null;
}

module.exports = { deviceProfileFor, baseName, DEFAULT };
