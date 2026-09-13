/*
 * Local-DNS HTTP CONNECT proxy — the piece that lets Ghost Browser pass Cloudflare Turnstile.
 *
 * The problem: Chromium reaches the tailnet through tailscaled's proxy, which does REMOTE DNS — it
 * resolves hostnames on tailscaled's side, and that resolver cannot resolve Cloudflare's IPv6-ONLY
 * Turnstile verification hosts (e.g. brunhild.challenges.cloudflare.com). So the Turnstile checkbox
 * renders (its widget host has IPv4) but never verifies, and every Cloudflare-gated site is unusable.
 *
 * The fix: Chromium points here instead. For each CONNECT we resolve the hostname LOCALLY (the
 * container resolver is cluster CoreDNS, which carries an IPv4 override for the IPv6-only challenge
 * hosts), then open the tunnel to that IP through tailscaled's OWN http proxy — so egress is still the
 * residential exit node, but resolution happened somewhere that can actually resolve the name.
 */
const http = require('http');
const net = require('net');
const dns = require('dns');

function start({ shimPort, tsHttpPort, log } = {}) {
  const srv = http.createServer((req, res) => { res.writeHead(405); res.end('CONNECT only'); });
  srv.on('connect', (req, client, head) => {
    const [host, portRaw] = String(req.url).split(':');
    const port = portRaw || '443';
    dns.lookup(host, { family: 4 }, (err, ip) => {           // LOCAL resolve via CoreDNS (+override)
      if (err || !ip) { try { client.end('HTTP/1.1 502 shim-dns\r\n\r\n'); } catch (_) {} return; }
      const up = net.connect(tsHttpPort, '127.0.0.1', () => {
        up.write('CONNECT ' + ip + ':' + port + ' HTTP/1.1\r\nHost: ' + ip + ':' + port + '\r\n\r\n');
      });
      let established = false; let buf = '';
      up.on('data', (d) => {
        if (established) return;
        buf += d.toString('binary');
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const statusLine = buf.slice(0, buf.indexOf('\r\n'));
        if (/ 200 /.test(statusLine)) {
          established = true;
          try { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch (_) {}
          if (head && head.length) up.write(head);
          const rest = buf.slice(i + 4);
          if (rest) client.write(Buffer.from(rest, 'binary'));
          up.pipe(client); client.pipe(up);
        } else { try { client.end('HTTP/1.1 502 shim-upstream\r\n\r\n'); } catch (_) {} up.destroy(); }
      });
      up.on('error', () => { try { client.end('HTTP/1.1 502 shim-up\r\n\r\n'); } catch (_) {} });
      client.on('error', () => up.destroy());
    });
  });
  srv.on('error', (e) => { if (log && log.warn) log.warn('[dns-shim] ' + e.message); });
  srv.listen(shimPort, '127.0.0.1', () => { if (log && log.info) log.info('[dns-shim] local-DNS proxy on ' + shimPort + ' -> ts-http ' + tsHttpPort); });
  return srv;
}
module.exports = { start };
