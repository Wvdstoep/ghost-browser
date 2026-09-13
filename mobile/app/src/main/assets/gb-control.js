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
        if (!r.ok) { GBHost.ctl('pollerr', String(r.status)); setTimeout(loop, 3000); return; }
        return r.json().then(function (cmd) {
          GBHost.onCommand(cmd.id || '', cmd.path || '/v1/info', JSON.stringify(cmd.body || {}));
          setTimeout(loop, 150);
        });
      })
      .catch(function (e) { GBHost.ctl('pollerr', String(e)); setTimeout(loop, 3000); });
  }

  fetch('/v1/device/register', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: DEV, name: NAME })
  }).then(function (r) {
    if (r.ok) { GBHost.ctl('registered', DEV); loop(); }
    else { GBHost.ctl('regfail', String(r.status)); }
  }).catch(function (e) { GBHost.ctl('regfail', String(e)); });
})();
