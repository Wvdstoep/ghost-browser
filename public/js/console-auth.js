/* Authenticate before starting the Compose console, including on older preserved Wasm builds. */
(function (root) {
  'use strict';
  const PLATFORM_SIGN_IN = 'https://my-app.engineer/?next=%2Fapi%2Fcluster-tools%2Fghost-browser%2Fopen';
  function takeHandoff(location, history) {
    const params = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    if (!params.has('leadflow')) return null;
    history.replaceState(null, '', location.pathname + location.search);
    const value = JSON.parse(params.get('leadflow'));
    if (!value || typeof value.auth !== 'string' || !value.auth) throw new Error('This sign-in link is incomplete. Please sign in again.');
    return value;
  }
  async function authenticate({ location, history, fetch }) {
    const handoff = takeHandoff(location, history), token = handoff && handoff.auth;
    if (token) {
      const reply = await fetch('/api/auth/sso', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!reply.ok) throw new Error('This sign-in link expired or could not be verified. Please sign in again.');
    }
    const reply = await fetch('/api/auth/state', { credentials: 'include', cache: 'no-store' });
    if (!reply.ok) throw new Error('We could not reach your browser. Please try again.');
    const state = await reply.json();
    if (token && !state.signedIn) throw new Error('Your session could not be saved. Please allow cookies and sign in again.');
    if (handoff?.device) {
      const d = handoff.device;
      if (!/^[A-Za-z0-9_-]{43}$/.test(d.challenge || '') || !/^[A-Za-z0-9_-]{32,128}$/.test(d.state || '')) throw new Error('This device sign-in is invalid. Please start again in the app.');
      state.device = d;
    }
    return state;
  }
  async function boot(win) {
    const doc = win.document, gate = doc.getElementById('auth-gate');
    if (!gate) return;
    const status = doc.getElementById('auth-status'), actions = doc.getElementById('auth-actions');
    const password = doc.getElementById('password-option'), form = doc.getElementById('local-sign-in');
    const platform = doc.getElementById('platform-sign-in');
    platform.href = PLATFORM_SIGN_IN;
    let started = false;
    function startConsole() {
      if (started) return;
      started = true; gate.hidden = true;
      doc.getElementById('ComposeTarget').hidden = false; doc.getElementById('mcp-link').hidden = false;
      const overlay = doc.createElement('script'); overlay.src = '/console/live-overlay.js'; doc.body.appendChild(overlay);
      const app = doc.createElement('script'); app.src = '/console/gbweb.js';
      app.onerror = () => { gate.hidden = false; status.textContent = 'The browser interface could not load. Please refresh to retry.'; actions.hidden = false; };
      doc.body.appendChild(app);
    }
    try {
      const state = await authenticate({ location: win.location, history: win.history, fetch: win.fetch.bind(win) });
      if (state.signedIn && state.device) {
        const reply = await win.fetch('/api/auth/device-code', { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: state.device.challenge }) });
        if (!reply.ok) throw new Error('We could not connect this phone. Please start sign-in again in the app.');
        const result = await reply.json();
        if (!/^[A-Za-z0-9_-]{43}$/.test(result.code || '')) throw new Error('Device connection could not finish. Please try again.');
        const callback = 'ghostbrowser://connect?' + new URLSearchParams({ cluster: win.location.origin, code: result.code, state: state.device.state });
        status.textContent = 'Signed in. Return to Ghost Browser Mobile to finish connecting.';
        platform.textContent = 'Open Ghost Browser Mobile'; platform.href = callback;
        actions.hidden = false; password.hidden = true;
        win.location.assign(callback);
        return;
      }
      if (state.signedIn) { startConsole(); return; }
      status.textContent = 'Use your existing account. Email and Google sign-in both work here.';
      actions.hidden = false;
      const standalone = !state.sso && !state.ssoOnly;
      password.hidden = !state.hasPassword && !standalone;
      if (standalone) { password.open = true; platform.hidden = true; }
      const signup = standalone && state.needsSignup;
      doc.getElementById('password-submit').textContent = signup ? 'Create owner account' : 'Sign in';
      form.onsubmit = async (event) => {
        event.preventDefault();
        const button = doc.getElementById('password-submit'); button.disabled = true;
        try {
          const reply = await win.fetch('/api/auth/' + (signup ? 'signup' : 'login'), { method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: form.elements.username.value.trim(), password: form.elements.password.value }) });
          if (!reply.ok) { status.textContent = 'Those details did not work. Use your MyApp.Engineer account, or the separate password you set for this browser.'; return; }
          startConsole();
        } catch { status.textContent = 'Sign-in could not finish. Please try again.'; }
        finally { button.disabled = false; }
      };
    } catch (error) {
      status.textContent = error instanceof SyntaxError ? 'This sign-in link is invalid. Please sign in again.' : error.message;
      actions.hidden = false; password.hidden = true;
    }
  }
  function install(win) {
    // Reusing an existing tab can deliver a handoff as a fragment-only navigation.
    win.addEventListener('hashchange', () => {
      if (new URLSearchParams(win.location.hash.slice(1)).has('leadflow')) boot(win);
    });
    return boot(win);
  }
  if (typeof module !== 'undefined') module.exports = { authenticate, takeHandoff, boot, install, PLATFORM_SIGN_IN };
  else install(root);
})(typeof window !== 'undefined' ? window : globalThis);
