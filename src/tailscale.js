/**
 * tailscale.js — the browser's own exit, owned by whoever runs it.
 *
 * WHY THIS IS IN THE IMAGE AND NOT THE PLATFORM.
 *
 * The pods exit from 65.108.13.228: Finland, Hetzner, already flagged `proxy: true` by public IP
 * databases. Facebook refuses a login from it and returns you to the login page after a solved
 * captcha, while the same account on the same day logs in immediately from a home connection. That
 * is not a fingerprint problem and no amount of stealth patching touches it — the browser was
 * telling the truth and the truth was the problem.
 *
 * A tailnet fixes it properly: the browser exits through a device the OWNER controls — their phone,
 * their laptop, their home line — so the traffic comes from where they actually are. It belongs in
 * this image rather than in the platform because the whole point of the exit is that it is not the
 * platform's.
 *
 * USERSPACE NETWORKING is what makes it possible at all here. `tailscaled --tun=userspace-networking`
 * needs no TUN device, no NET_ADMIN, no privileged pod — it opens a SOCKS5 proxy on localhost and
 * routes what goes through it over the tailnet. Chromium takes a SOCKS5 proxy per browser context,
 * so a profile can exit through the tailnet while everything else on the pod does not.
 *
 * STATE LIVES ON THE VOLUME, beside the browser profiles, so you authenticate once rather than on
 * every pod restart — the same reason the profiles are there.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const STATE_DIR = path.join(process.env.PROFILE_DIR || '/profiles', '.tailscale');
const SOCK = path.join(STATE_DIR, 'tailscaled.sock');
const SOCKS_PORT = Number(process.env.TAILSCALE_SOCKS_PORT) || 1055;
const SOCKS_URL = `socks5://127.0.0.1:${SOCKS_PORT}`;
const SHIM_PORT = SOCKS_PORT + 2;
const PROXY_URL = `http://127.0.0.1:${SHIM_PORT}`;
const dnsShim = require('./dns-shim');
let shimServer = null;
function startShimOnce() { if (shimServer) return; try { shimServer = dnsShim.start({ shimPort: SHIM_PORT, tsHttpPort: SOCKS_PORT + 1, log }); } catch (e) { if (log && log.warn) log.warn('[dns-shim] start failed: ' + e.message); } }
const HOSTNAME = process.env.TAILSCALE_HOSTNAME || 'ghost-browser';

let daemon = null;
let lastLoginUrl = null;

const cli = (args, timeout = 30000) =>
  execFileAsync('tailscale', ['--socket', SOCK, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 });

/** Is the binary even in this image? Answered honestly so the UI can say so rather than hang. */
async function installed() {
  try { await execFileAsync('tailscale', ['version'], { timeout: 5000 }); return true; }
  catch { return false; }
}

/*
 * The daemon, started once and left running. Deliberately NOT started at boot: an image that dials
 * a VPN on startup is a surprise, and most sessions never need one.
 */
async function startDaemon(log = console) {
  if (daemon && !daemon.killed) return true;
  if (!(await installed())) return false;
  fs.mkdirSync(STATE_DIR, { recursive: true });

  /*
   * A SOCKET OUTLIVES THE POD THAT MADE IT — the same shape as Chromium's SingletonLock, and it
   * bites for the same reason: the file is on the volume, the process that owned it is gone, and
   * everything that checks "is it running?" by looking for the socket believes a dead pod. The UI
   * sat on "checking…" forever because the status call was talking to a socket with nothing behind
   * it. tailscaled refuses to bind over it, so it has to go before we start.
   */
  try { fs.unlinkSync(SOCK); log.warn?.('[tailscale] removed a stale socket left by a previous pod'); }
  catch { /* not there, which is the normal case */ }

  daemon = spawn('tailscaled', [
    '--tun=userspace-networking',                 // no TUN device, no NET_ADMIN, no privileged pod
    `--socks5-server=127.0.0.1:${SOCKS_PORT}`,    // how Chromium reaches the tailnet
    `--outbound-http-proxy-listen=127.0.0.1:${SOCKS_PORT + 1}`,
    `--statedir=${STATE_DIR}`,
    `--socket=${SOCK}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  daemon.stdout.on('data', (d) => log.info?.(`[tailscaled] ${String(d).trim().slice(0, 300)}`));
  daemon.stderr.on('data', (d) => {
    const line = String(d).trim();
    // The login URL appears in the daemon's own output as well as the CLI's; catching it here means
    // a login started by any route can still be surfaced to whoever is looking at the UI.
    const m = line.match(/https:\/\/login\.tailscale\.com\/[^\s]+/);
    if (m) lastLoginUrl = m[0];
    log.info?.(`[tailscaled] ${line.slice(0, 300)}`);
  });
  daemon.on('exit', (code) => { log.warn?.(`[tailscaled] exited (${code})`); daemon = null; });

  // Wait for the socket rather than sleeping: the CLI fails confusingly if it is not there yet.
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(SOCK)) { startShimOnce(); return true; }
    if (!daemon || daemon.killed) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * What the tailnet looks like right now. Shaped for a UI: whether it is usable, who could be an
 * exit node, and which one is in use — not the whole status blob, which is enormous.
 */
async function status() {
  if (!(await installed())) {
    return { installed: false, running: false, loggedIn: false, reason: 'tailscale is not in this image' };
  }
  if (!fs.existsSync(SOCK)) {
    return { installed: true, running: false, loggedIn: false, loginUrl: lastLoginUrl };
  }
  try {
    // Short, because the question "is it alive" must not take fifteen seconds to answer no.
    const { stdout } = await cli(['status', '--json'], 6000);
    const s = JSON.parse(stdout);
    const peers = Object.values(s.Peer || {});
    return {
      installed: true,
      running: true,
      loggedIn: s.BackendState === 'Running',
      backendState: s.BackendState,
      loginUrl: s.AuthURL || lastLoginUrl || null,
      self: s.Self ? { name: s.Self.HostName, ip: (s.Self.TailscaleIPs || [])[0] } : null,
      /*
       * Only peers that ADVERTISE themselves as exit nodes can be used as one. Listing every device
       * and letting someone pick one that cannot route would produce a failure with no explanation
       * — on a phone that setting is off by default and has to be turned on deliberately.
       */
      exitNodes: peers.filter((p) => p.ExitNodeOption).map((p) => ({
        name: p.HostName,
        ip: (p.TailscaleIPs || [])[0],
        online: !!p.Online,
        os: p.OS || null,
        inUse: !!p.ExitNode,
      })),
      exitNode: (peers.find((p) => p.ExitNode) || {}).HostName || null,
      // Every device, so the UI can explain WHY a phone is missing from the list above.
      devices: peers.map((p) => ({ name: p.HostName, os: p.OS || null, online: !!p.Online, canExit: !!p.ExitNodeOption })),
      socks: SOCKS_URL,
    };
  } catch (e) {
    // The socket is there and nothing answered: a dead pod's leftovers, not a running daemon.
    return {
      installed: true, running: false, loggedIn: false, stale: true,
      reason: 'a socket is present but no daemon is answering — press Connect to start it',
      error: String(e.message).slice(0, 160),
    };
  }
}

/*
 * COME BACK BY ITSELF AFTER A RESTART.
 *
 * The authentication survives on the volume, so a restarted pod is still a member of the tailnet —
 * but nothing was starting the daemon, so the tunnel was down and the exit node silently stopped
 * applying. A browser profile set to exit through the tailnet would then be pointing at a dead
 * port. Anything that has been authenticated once should reconnect on its own; only a profile that
 * has never been logged in should wait to be asked.
 */
async function resumeIfConfigured(log = console) {
  try {
    if (!fs.existsSync(path.join(STATE_DIR, 'tailscaled.state'))) return false;
    if (!(await startDaemon(log))) return false;
    const s = await status();
    log.info?.(`[tailscale] resumed after restart — ${s.loggedIn ? 'connected' : s.backendState || 'starting'}`
      + (s.exitNode ? `, exiting via ${s.exitNode}` : ''));
    return true;
  } catch (e) {
    log.warn?.(`[tailscale] could not resume: ${e.message}`);
    return false;
  }
}

/**
 * Bring it up. An auth key is deterministic and instant; without one, Tailscale prints a URL to
 * open, which is returned rather than waited on — the caller polls status until the backend reports
 * Running, so the UI can show a link instead of hanging on a request.
 */
async function up({ authKey = null, log = console } = {}) {
  if (!(await startDaemon(log))) throw Object.assign(new Error('tailscaled could not start'), { status: 500 });

  const args = ['up', `--hostname=${HOSTNAME}`,
    // The pod keeps cluster DNS. Taking the tailnet's would break how it resolves its own services.
    '--accept-dns=false',
    '--reset'];
  if (authKey) args.push(`--authkey=${authKey}`);

  if (authKey) {
    await cli(args, 60000);
    lastLoginUrl = null;
    return { ...(await status()), usedAuthKey: true };
  }

  /*
   * Without a key `tailscale up` blocks until someone completes the login in a browser, so it is
   * started detached and only its URL is taken. Killing the request would abort the login.
   */
  return await new Promise((resolve) => {
    const p = spawn('tailscale', ['--socket', SOCK, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const grab = (buf) => {
      const m = String(buf).match(/https:\/\/login\.tailscale\.com\/[^\s]+/);
      if (m && !settled) { settled = true; lastLoginUrl = m[0]; resolve({ loginUrl: m[0], pending: true }); }
    };
    p.stdout.on('data', grab);
    p.stderr.on('data', grab);
    // Already authenticated? Then `up` just returns and there is no URL to wait for.
    p.on('exit', async () => { if (!settled) { settled = true; resolve({ ...(await status()), pending: false }); } });
    setTimeout(async () => { if (!settled) { settled = true; resolve({ ...(await status()), pending: true, loginUrl: lastLoginUrl }); } }, 20000);
  });
}

/** Route through one of the tailnet's exit nodes — or stop routing through any. */
async function setExitNode(node) {
  if (!fs.existsSync(SOCK)) throw Object.assign(new Error('tailscale is not running'), { status: 409 });
  const target = node ? String(node).trim() : '';
  if (target) {
    const s = await status();
    const match = (s.exitNodes || []).find((n) => n.name === target || n.ip === target);
    // Refuse a node that cannot route, with the reason — otherwise traffic silently keeps its old path.
    if (!match) throw Object.assign(new Error(`"${target}" is not offering itself as an exit node — turn that on in its Tailscale settings first`), { status: 400 });
    if (!match.online) throw Object.assign(new Error(`"${target}" is offline`), { status: 409 });
  }
  await cli(['set', `--exit-node=${target}`, '--exit-node-allow-lan-access=false'], 30000);
  return status();
}

async function down() {
  if (!fs.existsSync(SOCK)) return { running: false };
  try { await cli(['down'], 20000); } catch { /* already down */ }
  return status();
}

/** Where a profile should point its proxy to use the tailnet. */
const socksUrl = () => SOCKS_URL;
const proxyUrl = () => PROXY_URL;

module.exports = { installed, startDaemon, status, up, setExitNode, down, socksUrl, proxyUrl, resumeIfConfigured, STATE_DIR, SOCKS_URL };
