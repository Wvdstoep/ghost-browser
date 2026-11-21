'use strict';
/*
 * WHERE A LOGIN LIVES (2026-11-21).
 *
 * Owner: "for now I didn't experience a verify you are human at all on mobile, only on the cloud IP, while mobile
 * works just fine". A profile that one of the owner's phones (or desktops) holds is that device's: work in it runs
 * there, with the device's own login and home connection, never on the cluster with a copy of the login. Trying
 * the cluster first, and the posts watcher reading Facebook from the cluster every hour, meant one login seen from
 * the datacenter and from the phone within seconds, which is what draws a site's check.
 *
 * Pure, so the rule is tested without a server: the devices and the open sessions are handed in.
 *
 *   { device }            an online device that holds it: run there (a phone before a desktop)
 *   { waiting, reason }   a device holds it but none is online (or the server just started and the devices are
 *                         still registering): wait, never fall back to the cluster
 *   { busy, reason }      that device is working in this profile for a session right now: the next pass
 *   {}                    no device holds it: the cluster, as before
 */
const { deviceProfileFor } = require('./deviceProfile');

const STARTUP_MS = 3 * 60 * 1000;
const BUSY_MS = 3 * 60 * 1000;

function loginHome({ devices = [], sessions = [], owner, profile, now = Date.now(), startedAt = 0, starting = true, busyCheck = true } = {}) {
  const name = String(profile || '').trim();
  if (!name || name === 'default') return {};   // "default" is a different browser on each side
  const holders = devices.filter((d) => d && d.owner === owner && d.caps && d.caps.realIp && deviceProfileFor(d.caps, name));
  const online = holders.filter((d) => d.online);
  const dev = online.find((d) => d.caps.platform !== 'desktop') || online[0];
  if (!dev) {
    if (holders.length) {
      return { waiting: true, name: holders[0].name,
        reason: `the "${name}" login lives on ${holders.map((d) => d.name).join(', ')}, which is offline: waiting for it (never the cluster)` };
    }
    if (starting && now - startedAt < STARTUP_MS) return { waiting: true, reason: `just started: waiting for the devices to connect before deciding where "${name}" runs` };
    return {};
  }
  const held = deviceProfileFor(dev.caps, name);
  if (busyCheck) {
    for (const live of sessions) {
      if (live && live.ring && live.ring.deviceId === dev.deviceId && (live.ring.profile || 'default') === held && now - (live.lastUsed || 0) < BUSY_MS) {
        return { busy: true, name: dev.name, reason: `${dev.name} is in use in "${name}" by a session right now: the next pass reads it` };
      }
    }
  }
  return { device: { deviceId: dev.deviceId, name: dev.name, caps: dev.caps }, name: dev.name };
}

module.exports = { loginHome, STARTUP_MS, BUSY_MS };
