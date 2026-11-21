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

/** "www.m.facebook.com" and "https://facebook.com/x" are both "facebook.com". */
function siteOf(urlOrHost) {
  let h = String(urlOrHost || '').trim().toLowerCase();
  try { if (/^[a-z]+:\/\//.test(h)) h = new URL(h).hostname; } catch (e) { return ''; }
  h = h.replace(/^\.+/, '').split('/')[0];
  const parts = h.split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : '';
}

/*
 * WHERE THE LOGIN FOR A SITE LIVES (2026-11-21). The owner's Facebook is signed in in the phone's "default"
 * profile, not in one called "facebook": a rule by profile name never found it. The phone (app 1.01) says per
 * profile which sites it holds a real login for (caps.logins, from the login cookie itself, refreshed after every
 * page), so the cluster routes by the site: { device, profile } that holds it, waiting/busy as loginHome, or {}.
 */
function siteHome({ devices = [], sessions = [], owner, url, now = Date.now(), busyCheck = true } = {}) {
  const site = siteOf(url);
  if (!site) return {};
  const holds = (d) => {
    const logins = d && d.caps && d.caps.logins;
    if (!logins || typeof logins !== 'object') return null;
    for (const [profile, sites] of Object.entries(logins)) if (Array.isArray(sites) && sites.map(String).includes(site)) return profile;
    return null;
  };
  const holders = devices.filter((d) => d && d.owner === owner && d.caps && d.caps.realIp && holds(d));
  const online = holders.filter((d) => d.online);
  const dev = online.find((d) => d.caps.platform !== 'desktop') || online[0];
  if (!dev) {
    return holders.length ? { waiting: true, name: holders[0].name, site,
      reason: `the ${site} login lives on ${holders.map((d) => d.name).join(', ')}, which is offline: waiting for it (never the cluster)` } : {};
  }
  const profile = holds(dev);
  if (busyCheck) {
    for (const live of sessions) {
      if (live && live.ring && live.ring.deviceId === dev.deviceId && (live.ring.profile || 'default') === profile && now - (live.lastUsed || 0) < BUSY_MS) {
        return { busy: true, name: dev.name, site, reason: `${dev.name} is in use in "${profile}" by a session right now: the next pass reads it` };
      }
    }
  }
  return { device: { deviceId: dev.deviceId, name: dev.name, caps: dev.caps }, name: dev.name, profile, site };
}

module.exports = { loginHome, siteHome, siteOf, STARTUP_MS, BUSY_MS };
