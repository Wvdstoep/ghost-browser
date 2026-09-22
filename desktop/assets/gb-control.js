/*
 * Reverse-channel control loop, run INSIDE a hidden WebView pinned to the GB origin — so register /
 * poll / result all go out as same-origin fetch with the SSO session (the exact path "Fetch profiles"
 * proved works). Commands are handed to the app (GBHost.onCommand), which runs them on the MAIN
 * WebView and posts the result back via window.__gbResult.
 */
(function () {
  if (window.__gbctl) return;
  window.__gbctl = true;
  var DEV = "__DEVICE_ID__", NAME = "__DEVICE_NAME__";

  window.__gbResult = function (id, status, bodyStr) {
    fetch('/v1/device/result', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEV, id: id, status: status, body: bodyStr })
    }).catch(function () {});
  };

  // Mirror the app's activity log to the backend so the operator/master can watch this device
  // (its own on-device agent runs and the commands we drive). Best-effort, same-origin SSO fetch.
  window.__gbLog = function (line) {
    fetch('/v1/device/log', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEV, line: line })
    }).catch(function () {});
  };

  function loop() {
    fetch('/v1/device/poll?deviceId=' + encodeURIComponent(DEV), { credentials: 'include' })
      .then(function (r) {
        if (r.status === 204) { setTimeout(loop, 400); return; }
        // 404 = the backend forgot us (GB pod rolled / restarted) → re-register instead of spinning.
        if (r.status === 404) { setTimeout(reg, 800); return; }
        if (!r.ok) { GBHost.ctl('pollerr', String(r.status)); setTimeout(loop, 3000); return; }
        return r.json().then(function (cmd) {
          GBHost.onCommand(cmd.id || '', cmd.path || '/v1/info', JSON.stringify(cmd.body || {}));
          setTimeout(loop, 150);
        });
      })
      .catch(function (e) { GBHost.ctl('pollerr', String(e)); setTimeout(loop, 3000); });
  }

  /*
   * WHAT THIS NODE CAN DO, SAID OUT LOUD.
   *
   * This registered with only { deviceId, name }, so the hub filled in normCaps({}) — cdp false, no
   * features, no platform. This is the node with real CDP input: click_xy, drag_xy with
   * Input.setInterceptDrags (so an HTML5 drag onto a CapCut timeline actually drops), run_steps to
   * batch a sequence, upload_file straight into a page input. It is the only node that has ever
   * completed a CapCut edit — and to /v1/device/route it looked like a device that can do nothing.
   *
   * Every name below is a tool that exists in renderer.js. Nothing is claimed that is not handled:
   * an advertisement the ring believes is worse than silence, because the ring then sends work here
   * that cannot be done, instead of to a device that can.
   */
  var CAPS = {
    platform: 'desktop',
    cdp: true,            // real Chrome DevTools input: drag-interception, self-saving downloads
    realIp: true,         // the laptop's own home connection
    features: [
      'click_xy', 'drag_xy', 'run_steps', 'upload_file', 'download_url', 'run_flow', 'browser_read',
      'browser_navigate', 'browser_click', 'browser_click_text', 'browser_type',
      'browser_scroll', 'downloads', 'open_tab', 'fetch_url'
    ]
  };

  function reg() {
    fetch('/v1/device/register', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEV, name: NAME, caps: CAPS })
    }).then(function (r) {
      if (r.ok) { GBHost.ctl('registered', DEV); loop(); }
      else { GBHost.ctl('regfail', String(r.status)); setTimeout(reg, 4000); }
    }).catch(function (e) { GBHost.ctl('regfail', String(e)); setTimeout(reg, 4000); });
  }

  reg();
})();
