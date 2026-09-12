const $ = (id) => document.getElementById(id);

/*
 * Where this page is mounted, derived rather than configured. "/browser/" gives "/browser";
 * "/" gives "". Everything below routes through here, so the console works identically on its
 * own host and as a page inside LeadFlow.
 */
const BASE = location.pathname.replace(/\/[^/]*$/, '').replace(/\/+$/, '');
const mounted = (path) => BASE + path;

/*
 * THE HANDOFF FROM LEADFLOW, read before anything else happens.
 *
 * It carries two separate things: WHO you are (so the console does not ask you to sign in a second
 * time inside an app you are already inside), and optionally WHICH search to fill.
 *
 * Parsed at the very top because the login gate is drawn early, and a sign-on that arrives after
 * the form has been shown has failed at the only job it has. This was exactly that bug: the
 * handoff was read near the bottom of the file and the gate at line 593 had already run.
 *
 * A FRAGMENT rather than a query string: it never reaches a server log or a Referer header. It is
 * wiped from the address bar immediately, so a reload or a shared screenshot carries no credential.
 */
let leadflow = null;
let ssoToken = null;
let social = null;

/* LeadFlow toggles a class on its own root; an iframe cannot see that, so the theme is handed over
   and then pushed on every change. Opened on its own, the media query decides. */
function applyTheme(t) {
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}
addEventListener('message', (e) => {
  // Same origin only. This is a page inside another app, not a public embed.
  if (e.origin !== location.origin) return;
  if (e.data && e.data.type === 'theme') applyTheme(e.data.theme);
});

(function readHandoff() {
  const m = (location.hash || '').match(/[#&]leadflow=([^&]+)/);
  if (!m) return;
  let payload;
  try { payload = JSON.parse(decodeURIComponent(m[1])); } catch { return; }
  history.replaceState(null, '', location.pathname + location.search);

  // The identity half stands alone: opening the Browser tab hands one over without starting a
  // search at all, which is the ordinary case.
  if (payload.auth) ssoToken = payload.auth;
  if (payload.theme) applyTheme(payload.theme);
  /* Embedded: this is a page of LeadFlow, not a product of its own. Its brand would be a second
     name for something already titled "Browser" one line above, and its Sign out means something
     different from the one in the app's header — which is exactly the kind of small wrongness that
     makes an integration feel bolted on. */
  if (payload.auth) document.documentElement.setAttribute('data-embedded', 'true');
  leadflow = (payload.api && payload.searchId && payload.token) ? payload : null;
  // The conversation endpoint arrives on its own: opening the Browser tab to check for answers
  // hands one over with no search attached at all, which is the ordinary case after the first day.
  social = (payload.socialApi && payload.socialToken)
    ? { api: payload.socialApi, token: payload.socialToken } : null;
})();

let session = null, ws = null, activeProfile = '';

const log = (m, cls='') => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = new Date().toLocaleTimeString() + '  ' + m;
  $('log').prepend(d);
  return d;
};

/* A warning you can act on. Closing a browser tab does not close the session behind it, so
   "already open in another session" points at something the user cannot see and cannot reach —
   which is a dead end unless the way out is right there on the message. */
const logAction = (m, label, fn) => {
  const d = log(m, 'err');
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'margin-left:8px;padding:2px 8px;font-size:11px;border-radius:5px;'
    + 'border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer';
  b.onclick = async () => { b.disabled = true; b.textContent = 'working…'; await fn(); b.remove(); };
  d.appendChild(b);
};

async function api(path, opts = {}) {
  // mounted(), NOT at(). There is a pointer-event helper further down also called at(), and it is a
  // hoisted function declaration — so it won, silently, and every single API call went through it
  // and produced a nonsense URL. The console rendered, the first call 404ed, gateState threw before
  // it could try single sign-on, and the login form was left on screen looking like SSO had failed.
  // One missed rename, two symptoms that looked unrelated.
  const r = await fetch(mounted(path), { ...opts, headers:{ 'Content-Type':'application/json', ...(opts.headers||{}) } });
  const b = await r.json().catch(() => ({}));
  // The body of a refusal often carries the way out; throwing only the message discards it.
  if (!r.ok) throw Object.assign(new Error(b.error || ('HTTP ' + r.status)), { body: b, status: r.status });
  return b;
}

// ── Gate ──────────────────────────────────────────────────────────────
let mode = 'login', minPw = 10;

/* Live, so the button cannot be pressed against a rule that will reject it. */
function checkPw() {
  if (mode !== 'signup') { $('gateGo').disabled = false; $('gateMsg').textContent = ''; return; }
  const n = $('p').value.length;
  const ok = n >= minPw && $('u').value.trim().length >= 3;
  $('gateGo').disabled = !ok;
  $('gateMsg').className = 'msg';
  $('gateMsg').textContent = n === 0 ? '' : (n < minPw ? (minPw - n) + ' more character' + (minPw - n === 1 ? '' : 's') : 'looks good');
  if (n >= minPw) $('gateMsg').className = 'msg ok';
}

async function gateState() {
  const s = await api('/api/auth/state');
  /* Who you are, answered once, where the console already asks it — see the dashboard's Admin nav. */
  window.__ghostSuper = !!s.superadmin;
  if (s.signedIn) return enter();

  /*
   * Signed into LeadFlow is signed in here. Tried BEFORE the gate is drawn, so nobody ever sees a
   * second login inside an app they are already inside — which is the whole reason this exists.
   *
   * A failure here is not fatal and is not silent: the password gate is still there, and the reason
   * is shown, because "expired LeadFlow session" and "SSO is not configured" have different fixes.
   */
  if (ssoToken && s.sso) {
    try {
      await api('/api/auth/sso', { method:'POST', body: JSON.stringify({ token: ssoToken }) });
      ssoToken = null;
      return enter();
    } catch (e) {
      $('gateMsg').textContent = e.message;
      $('gateMsg').className = 'msg bad';
    }
  }
  /*
   * SSO-ONLY (platform-managed install): there is NO local password account — the only way in is the
   * handoff from the platform. Hide the username/password gate entirely so nobody can create an owner
   * here; tell them where to sign in instead. (Any failed-SSO reason set above stays in gateMsg.)
   */
  if (s.ssoOnly) {
    $('gateSub').textContent = 'Single sign-on only — open Ghost Browser from your platform (the Tools tab) to sign in. There is no separate password here.';
    ['u', 'p', 'gateGo', 'forgot', 'resetBox'].forEach((id) => { const el = $(id); if (el) el.style.display = 'none'; });
    return;
  }
  mode = s.needsSignup ? 'signup' : 'login';
  minPw = s.minPassword || 10;
  $('gateSub').textContent = mode === 'signup'
    ? 'No account yet. The first one you create is the owner — after this there is only a login.'
    : 'Sign in to drive the browser.';
  $('gateGo').textContent = mode === 'signup' ? 'Create the owner account' : 'Sign in';
  // Say the rule BEFORE it is broken. Twice the signup was rejected for a short password and the
  // account was never created, which then reads as "my login does not work".
  $('p').placeholder = mode === 'signup' ? ('Password — at least ' + minPw + ' characters') : 'Password';
  checkPw();
}
$('gateGo').onclick = async () => {
  $('gateMsg').className = 'msg'; $('gateMsg').textContent = '';
  try {
    await api('/api/auth/' + mode, { method:'POST', body: JSON.stringify({ username:$('u').value, password:$('p').value }) });
    enter();
  } catch (e) { $('gateMsg').className = 'msg bad'; $('gateMsg').textContent = e.message; }
};
$('p').onkeydown = (e) => { if (e.key === 'Enter') $('gateGo').click(); };
$('p').oninput = checkPw;
$('u').oninput = checkPw;

$('forgot').onclick = (e) => { e.preventDefault(); $('resetBox').classList.toggle('hide'); };
$('resetGo').onclick = async () => {
  $('gateMsg').className = 'msg';
  try {
    await api('/api/auth/reset', { method:'POST', headers:{ Authorization: 'Bearer ' + $('resetKey').value.trim() } });
    $('gateMsg').className = 'msg ok';
    $('gateMsg').textContent = 'Account cleared — create a new one above.';
    $('resetBox').classList.add('hide');
    // ── Where this browser exits ──────────────────────────────────────────────
$('exitBtn').onclick = () => {
  const p = $('exitPanel');
  p.classList.toggle('hide');
  if (!p.classList.contains('hide')) { tsRefresh(); p.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
};
// The header is the shortest route to the thing it is warning about.
/*
 * THE HEADER IS THE SHORTEST ROUTE TO THE THING IT IS WARNING ABOUT.
 *
 * It reported "exit: this server" in amber, was styled as clickable, and clicking it did nothing —
 * twice over. It went through $('exitBtn').click() rather than opening the panel itself, and the
 * panel opens between the header and the toolbar, which on a scrolled tablet is above the visible
 * area. So on the occasions the indirection did fire, the result was still off-screen: identical
 * to broken, from the only seat that matters.
 */
$('exitState').onclick = () => {
  const p = $('exitPanel');
  p.classList.remove('hide');
  tsRefresh();
  // Opening something the reader cannot see is the same as not opening it.
  p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

async function tsRefresh() {
  try {
    const t = await api('/v1/tailscale/status');
    try { $('tsAll').checked = (await api('/v1/agent/settings')).routeThroughTailnet !== false; } catch {}
    if (!t.installed) { $('tsState').textContent = 'not available in this image'; return; }
    $('tsState').textContent = !t.running ? 'not running'
      : t.loggedIn ? ('connected as ' + (t.self?.name || '?') + (t.exitNode ? ' → exiting via ' + t.exitNode : ' · no exit node chosen'))
      : (t.backendState || 'starting…');

    if (t.loginUrl && !t.loggedIn) {
      $('tsLogin').classList.remove('hide');
      $('tsLogin').innerHTML = 'Open this to authorise, then press Connect again: '
        + '<a href="' + t.loginUrl + '" target="_blank" rel="noreferrer" style="color:var(--accent)">' + t.loginUrl + '</a>';
    } else { $('tsLogin').classList.add('hide'); }

    const nodes = t.exitNodes || [];
    if (!t.loggedIn) { $('tsNodes').innerHTML = ''; return; }
    if (!nodes.length) {
      /* Say WHY the list is empty rather than showing nothing: the setting they are missing is on
         the phone, not here, and it is off by default. */
      const others = (t.devices || []).filter(d => !d.canExit).map(d => d.name + (d.online ? '' : ' (offline)')).join(', ');
      $('tsNodes').innerHTML = '<span style="font-size:12px;color:var(--warn)">No device is offering itself as an exit node'
        + (others ? '. Seen on your tailnet: ' + others : '') + '</span>';
      return;
    }
    $('tsNodes').innerHTML = '';
    for (const n of nodes) {
      const b = document.createElement('button');
      b.textContent = (n.inUse ? '● ' : '') + n.name + (n.os ? ' (' + n.os + ')' : '') + (n.online ? '' : ' — offline');
      b.disabled = !n.online;
      b.style.cssText = 'margin:0 6px 6px 0;font-size:12px;' + (n.inUse ? 'border-color:var(--ok);color:var(--ok)' : '');
      b.onclick = async () => {
        try { await api('/v1/tailscale/exit-node', { method:'POST', body: JSON.stringify({ node: n.name }) });
              log('exiting through ' + n.name, 'ok'); tsRefresh(); }
        catch (e) { log(e.message, 'err'); }
      };
      $('tsNodes').appendChild(b);
    }
    const off = document.createElement('button');
    off.textContent = 'no exit node';
    off.style.cssText = 'margin:0 6px 6px 0;font-size:12px';
    off.onclick = async () => { await api('/v1/tailscale/exit-node', { method:'POST', body: JSON.stringify({ node: '' }) }); tsRefresh(); };
    $('tsNodes').appendChild(off);
  } catch (e) { $('tsState').textContent = e.message; }
}

$('tsUp').onclick = async () => {
  $('tsState').textContent = 'connecting…';
  try {
    const r = await api('/v1/tailscale/up', { method:'POST', body: JSON.stringify({ authKey: $('tsKey').value.trim() || undefined }) });
    $('tsKey').value = '';        // used once, never stored
    if (r.loginUrl && !r.loggedIn) log('open the Tailscale link to authorise this browser');
    tsRefresh();
    exitState();
  } catch (e) { log(e.message, 'err'); $('tsState').textContent = 'failed'; }
};
$('tsAll').onchange = async () => {
  const on = $('tsAll').checked;
  try {
    await api('/v1/agent/settings', { method:'PUT', body: JSON.stringify({ routeThroughTailnet: on }) });
    // Fixed when a browser process starts, so it lands on the next session and not this one.
    log(on ? 'every login now leaves through the exit node — reopen a session for it to apply'
           : 'logins now leave from this server unless one says otherwise', 'ok');
    exitState();
  } catch (e) { $('tsAll').checked = !on; log(e.message, 'err'); }
};

$('tsDown').onclick = async () => { try { await api('/v1/tailscale/down', { method:'POST' }); tsRefresh(); } catch (e) { log(e.message,'err'); } };

gateState();
  } catch (err) { $('gateMsg').className = 'msg bad'; $('gateMsg').textContent = err.message; }
};

function enter() {
  $('gate').classList.add('hide'); $('dash').classList.remove('hide');
  capacity(); loadProfiles(); setInterval(capacity, 5000);
  // The agent panel needs a session, and this is the first moment there is one.
  loadPanel();
  // Open it unprompted the first time there is no exit configured — a setting nobody finds is a
  // setting nobody uses, and this one decides whether logins work at all.
  api('/v1/tailscale/status').then((t) => {
    if (!t.loggedIn || !t.exitNode) { $('exitPanel').classList.remove('hide'); tsRefresh(); }
  }).catch(() => {});
}
$('logout').onclick = async () => { await api('/api/auth/logout', { method:'POST' }); location.reload(); };
$('showKey').onclick = async () => {
  try {
    const r = await api('/api/auth/key');
    /*
     * GO TO WHERE THE ANSWER IS. #keyBox lives inside the Log section, which is `hidden` unless the
     * Log tab is open — so this un-hid a box nobody could see and the button did nothing at all
     * from the Agent tab, which is the one everybody is on. A control that reveals something must
     * take you to it.
     */
    showTab('log');
    $('keyBox').classList.remove('hide');
    $('keyBox').textContent = r.keys.map(k => k.key + '  (' + k.plan + ')').join('\n') || 'no keys configured';
  } catch (e) { log(e.message, 'err'); }
};

async function capacity() {
  try {
    const c = await (await fetch(mounted('/v1/capacity'))).json();
    $('cap').textContent = c.sessions + '/' + c.maxSessions + ' sessions · ' + c.memoryPct + '% memory' + (c.draining ? ' · draining' : '');
  } catch { $('cap').textContent = 'unreachable'; }
  exitState();
}

let PRESETS = [], SINGLE = false, BROWSER_PROFILE = '';
async function loadProfiles() {
  try {
    /*
     * ONE BROWSER. There is nothing to pick and nothing to switch — a single browser signed into
     * every site. The picker collapses to a static "Browser", and the setting-up, throwaway and
     * close-all controls that only made sense with many logins are gone.
     */
    try {
      const sb = await api('/v1/agent/settings');
      if (sb.singleBrowser) {
        SINGLE = true;
        BROWSER_PROFILE = sb.browserProfile || 'facebook';
        $('profile').innerHTML = '<option value="' + esc(BROWSER_PROFILE) + '">Browser</option>';
        $('profile').value = BROWSER_PROFILE;
        document.documentElement.setAttribute('data-single', 'true');
        return;
      }
    } catch { /* fall through to the many-logins UI */ }

    const r = await (await fetch(mounted('/v1/profiles'))).json();
    const saved = r.profiles || [];
    try { PRESETS = (await api('/v1/profiles/presets')).presets || []; } catch { PRESETS = []; }

    /*
     * The logins you have, then the ones this browser knows how to set up. Choosing one of those
     * creates it already labelled with its site — which is what the agent matches on, and what was
     * previously typed by hand and therefore silently wrong.
     */
    const missing = PRESETS.filter(x => !x.exists);
    /* A login that already serves a site says so beside its name — "facebook.com" on a profile
       called carla-test-facebook is the answer to "is my Facebook set up", and it was previously
       only visible by opening Setup. */
    const serves = {};
    for (const x of PRESETS) if (x.servedBy) serves[x.servedBy] = x.site;
    $('profile').innerHTML = saved.map(p =>
        '<option value="' + p + '">' + p + (serves[p] ? ' — ' + serves[p] : '') + '</option>')
      .concat(missing.length
        ? ['<optgroup label="Set up a login">'
           + missing.map(x => '<option value="preset:' + x.key + '">＋ ' + esc(x.label) + '</option>').join('')
           + '</optgroup>']
        : [])
      .concat(['<option value="">throwaway (no saved cookies)</option>',
               '<option value="__new__">＋ new named profile…</option>']).join('');

    /*
     * A SAVED LOGIN IS THE DEFAULT, not a throwaway.
     *
     * Asking it to "open my stored Facebook session" and watching it open an empty browser is
     * exactly backwards: the throwaway is the rare case, and the logins took real work to get. The
     * one used last is remembered, because whoever has two profiles is usually going back to the
     * same one.
     */
    const last = localStorage.getItem('gb_profile');
    if (last && saved.includes(last)) $('profile').value = last;
    else if (saved.length) $('profile').value = saved[0];
    pointUrlAtProfile();     // land the bar on the remembered login, not the hard-coded default
  } catch {}
}
$('profile').onchange = () => {
  if ($('profile').value !== '__new__') return;
  const n = prompt('Name this profile (e.g. facebook-carla). Whatever you log into stays logged in.');
  if (!n) { $('profile').value = ''; return; }
  const c = n.replace(/[^a-z0-9_-]/gi,'');
  $('profile').insertAdjacentHTML('afterbegin', '<option value="' + c + '" selected>' + c + '</option>');
};

// ── The live view ─────────────────────────────────────────────────────
/* Frames arrive over a WebSocket whenever the page actually changes, and are drawn to a canvas.
   Input goes back the same way as real mouse and key events, so the page behaves the way it would
   in any tab — no side panel, no "click a field first", no polling. */
const view = $('view');
const ctx = view.getContext('2d', { alpha:false });

function connectLive() {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + mounted('/v1/live') + '?session=' + encodeURIComponent(session));
  ws.onopen = () => { $('wsdot').classList.add('on'); log('live view connected', 'ok'); };
  ws.onclose = () => { $('wsdot').classList.remove('on'); };
  ws.onerror = () => log('live view dropped', 'err');
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'frame') {
      /* Decoded off the main thread, then drawn in one go. Assigning a data URL to an <img> blanks
         it while it decodes, which is what made the old polled version strobe. */
      const blob = await (await fetch('data:image/jpeg;base64,' + m.data)).blob();
      const bmp = await createImageBitmap(blob);
      if (view.width !== bmp.width || view.height !== bmp.height) { view.width = bmp.width; view.height = bmp.height; }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      view.hidden = false; $('empty').classList.add('hide'); $('hint').hidden = false;
    } else if (m.t === 'url') { $('url').value = m.url; }
    else if (m.t === 'focus') {
      /* The tap landed on a real field → raise the keyboard (still inside the tap's activation).
         It landed on anything else → put the keyboard away rather than leave it covering the page. */
      if (m.editable) { try { kbd.focus({ preventScroll: true }); } catch {} setKbdBtn(true); }
      else if (document.activeElement === kbd) { kbd.blur(); setKbdBtn(false); }
    }
    else if (m.t === 'error') { log(m.error, 'err'); }
  };
}

/* The canvas is displayed scaled; every coordinate is mapped back to page pixels or every click
   lands somewhere else, which looks exactly like the automation being broken. */
function at(ev) {
  const r = view.getBoundingClientRect();
  return {
    x: Math.round((ev.clientX - r.left) * (view.width / r.width)),
    y: Math.round((ev.clientY - r.top) * (view.height / r.height)),
  };
}
const mods = (e) => ({ alt:e.altKey, ctrl:e.ctrlKey, meta:e.metaKey, shift:e.shiftKey });
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

view.addEventListener('mousedown', (e) => {
  e.preventDefault(); view.focus();
  // The keyboard is raised by the server's 'focus' reply now, not blindly on every press.
  const p = at(e);
  send({ t:'mouse', type:'mousePressed', x:p.x, y:p.y, button: e.button === 2 ? 'right' : 'left', clickCount: e.detail || 1, mod: mods(e) });
});
view.addEventListener('mouseup', (e) => {
  e.preventDefault();
  const p = at(e);
  send({ t:'mouse', type:'mouseReleased', x:p.x, y:p.y, button: e.button === 2 ? 'right' : 'left', clickCount: e.detail || 1, mod: mods(e) });
});
let lastMove = 0;
view.addEventListener('mousemove', (e) => {
  // Hover matters (menus, tooltips) but every pixel does not. ~30/s is smooth and cheap.
  const now = performance.now();
  if (now - lastMove < 33) return;
  lastMove = now;
  const p = at(e);
  send({ t:'mouse', type:'mouseMoved', x:p.x, y:p.y, mod: mods(e) });
});
view.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = at(e);
  send({ t:'wheel', x:p.x, y:p.y, dx:e.deltaX, dy:e.deltaY, mod: mods(e) });
}, { passive:false });
view.addEventListener('contextmenu', (e) => e.preventDefault());

/* Keys only while the canvas has focus, so the address bar still behaves normally. Tab is
   swallowed deliberately: inside a page it should move between the page's fields. */
view.addEventListener('keydown', (e) => {
  if (!['F5','F12'].includes(e.key)) e.preventDefault();
  send({ t:'key', type:'keyDown', key:e.key, code:e.code, mod:mods(e) });
});
view.addEventListener('keyup', (e) => {
  e.preventDefault();
  send({ t:'key', type:'keyUp', key:e.key, code:e.code, mod:mods(e) });
});
view.addEventListener('paste', (e) => {
  e.preventDefault();
  send({ t:'paste', text: (e.clipboardData || window.clipboardData).getData('text') });
});

/* ── MOBILE ────────────────────────────────────────────────────────────────────────────
   Two things a phone needs that a desktop does not.

   THE KEYBOARD. Focusing the hidden input has to happen inside the touch handler itself: browsers
   only raise the keyboard in response to a user gesture, and a focus() called from a promise
   callback a moment later is silently ignored.

   TOUCH. There is no mousedown on a phone. A tap becomes press+release at that point; a drag
   becomes a wheel, because dragging a page is how scrolling works and nobody expects it to select
   text. */
const kbd = $('kbd');
const ZWSP = '\u200b';
/* The punctuation an address or a password actually contains. Anything not listed sends no code
   at all, which is fine — the character itself is what inserts it. */
const PUNCT_CODE = {
  '.':'Period', ',':'Comma', '-':'Minus', '_':'Minus', '@':'Digit2', '/':'Slash', ':':'Semicolon',
  ';':'Semicolon', "'":'Quote', '"':'Quote', '?':'Slash', '!':'Digit1', ' ':'Space',
  '+':'Equal', '=':'Equal', '(':'Digit9', ')':'Digit0', '#':'Digit3', '$':'Digit4', '%':'Digit5',
  '&':'Digit7', '*':'Digit8', '[':'BracketLeft', ']':'BracketRight',
};
const resetKbd = () => { kbd.value = ZWSP; };

kbd.addEventListener('input', () => {
  const v = kbd.value;
  if (v.length > ZWSP.length) {
    // Whatever was added since the last reset is what they typed.
    const typed = v.replace(ZWSP, '');
    for (const ch of typed) {
      /* 'Key' + the character is only a real code for letters. For '.' it invents "Key." — the
         server no longer trusts it, but sending nonsense is still worse than sending nothing. */
      const code = /[a-zA-Z]/.test(ch) ? 'Key' + ch.toUpperCase()
                 : /[0-9]/.test(ch) ? 'Digit' + ch
                 : (PUNCT_CODE[ch] || '');
      send({ t:'key', type:'keyDown', key:ch, code });
      send({ t:'key', type:'keyUp', key:ch, code });
    }
  } else if (v.length < ZWSP.length) {
    // The sentinel is gone, so they pressed Backspace — the one key Android will not report.
    send({ t:'key', type:'keyDown', key:'Backspace', code:'Backspace' });
    send({ t:'key', type:'keyUp', key:'Backspace', code:'Backspace' });
  }
  resetKbd();
});

kbd.addEventListener('keydown', (e) => {
  // Everything that is not a character still comes through as a real key event.
  if (e.key.length === 1) return;                     // handled by the input event above
  if (e.key === 'Backspace') return;                  // handled there too, more reliably
  e.preventDefault();
  send({ t:'key', type:'keyDown', key:e.key, code:e.code, mod:mods(e) });
  send({ t:'key', type:'keyUp', key:e.key, code:e.code, mod:mods(e) });
});

const touchAt = (t) => {
  const r = view.getBoundingClientRect();
  return {
    x: Math.round((t.clientX - r.left) * (view.width / r.width)),
    y: Math.round((t.clientY - r.top) * (view.height / r.height)),
  };
};

let touchStart = null, touchMoved = false;
view.addEventListener('touchstart', (e) => {
  if (!e.touches.length) return;
  /*
   * The keyboard is NO LONGER raised here. Doing it on every touch meant it covered the page each
   * time you scrolled or tapped a link. Instead the server says, right after a tap lands, whether
   * the tap focused a real field — see the 'focus' message below — and only then is the keyboard
   * raised, while this tap's activation is still live.
   */
  touchStart = touchAt(e.touches[0]);
  touchMoved = false;
}, { passive:true });

view.addEventListener('touchmove', (e) => {
  if (!touchStart || !e.touches.length) return;
  const p = touchAt(e.touches[0]);
  const dy = touchStart.y - p.y;
  const dx = touchStart.x - p.x;
  if (Math.abs(dy) > 6 || Math.abs(dx) > 6) {
    e.preventDefault();
    touchMoved = true;
    send({ t:'wheel', x:p.x, y:p.y, dx, dy });
    touchStart = p;
  }
}, { passive:false });

view.addEventListener('touchend', (e) => {
  if (!touchStart) return;
  if (!touchMoved) {
    // A tap, not a drag: press and release where the finger went down.
    send({ t:'mouse', type:'mousePressed', x:touchStart.x, y:touchStart.y, button:'left', clickCount:1 });
    send({ t:'mouse', type:'mouseReleased', x:touchStart.x, y:touchStart.y, button:'left', clickCount:1 });
  }
  touchStart = null;
}, { passive:true });

resetKbd();

// ── Sessions ──────────────────────────────────────────────────────────
async function openSession(takeover = false) {
  const picked = $('profile').value;
  // A preset names a site rather than a profile: the server creates it, labels it, and configures
  // it before the browser starts — which is the only moment those settings can take effect.
  if (picked.startsWith('preset:')) {
    return api('/v1/sessions', { method:'POST', body: JSON.stringify({ preset: picked.slice(7), takeover }) });
  }
  const profile = picked === '__new__' ? '' : picked;
  return api('/v1/sessions', { method:'POST', body: JSON.stringify({ reuse: !profile, profile: profile || undefined, takeover }) });
}

$('open').onclick = async () => {
  try {
    await adopt(await openSession(false));
  } catch (e) {
    if (e.body && e.body.canTakeover) {
      logAction(e.message, 'Take it over', async () => {
        try { const s = await openSession(true); await adopt(s); }
        catch (err) { log(err.message, 'err'); }
      });
    } else { log(e.message, 'err'); }
  }
};

/* Shared by a normal open and a takeover, so the two paths cannot drift. */
async function adopt(s) {
  session = s.sessionId;
  // The dropdown IS the active session now, so whatever actually opened is what it shows.
  activeProfile = s.profile || '';
  if (s.profile && [...$('profile').options].some((o) => o.value === s.profile)) $('profile').value = s.profile;
  // So the next visit opens the same login rather than starting from a throwaway again.
  if (s.profile) { try { localStorage.setItem('gb_profile', s.profile); } catch {} }
  ['go','close','marks'].forEach(id => $(id).disabled = false);
  log('session ' + session + (s.profile ? ' · profile "' + s.profile + '"' : ''), 'ok');
  connectLive();

  /* A preset opens on its own login page and says what is waiting there — a code, a captcha, a
     consent wall. Somebody setting up a login is about to meet one of those, and being told which
     is the difference between a minute and an evening. */
  const preset = PRESETS.find(x => x.profile === s.profile);
  if (preset) {
    $('url').value = preset.start;
    await api('/v1/sessions/' + session + '/navigate', { method:'POST', body: JSON.stringify({ url: preset.start }) }).catch(() => {});
    log(preset.label + ': ' + preset.hint, 'ok');
    await loadProfiles();
    $('profile').value = s.profile;
    loadSiteRow();
    return;
  }

  if ((!s.url || s.url === 'about:blank') && $('url').value.trim()) {
    await api('/v1/sessions/' + session + '/navigate', { method:'POST', body: JSON.stringify({ url: $('url').value }) });
  }
  setTimeout(() => view.focus(), 500);
}

$('close').onclick = async () => {
  try { if (ws) ws.close(); await api('/v1/sessions/' + session, { method:'DELETE' }); log('closed', 'ok'); }
  catch (e) { log(e.message, 'err'); }
  session = null; activeProfile = ''; view.hidden = true; $('empty').classList.remove('hide'); $('hint').hidden = true;
  ['go','close','marks','esc'].forEach(id => $(id).disabled = true);
  loadProfiles();
};
$('closeAll').onclick = async () => {
  try { if (ws) ws.close(); const r = await api('/v1/sessions', { method:'DELETE' }); log('closed ' + r.closed + ' session(s)', 'ok'); }
  catch (e) { log(e.message, 'err'); }
  session = null; activeProfile = ''; view.hidden = true; $('empty').classList.remove('hide');
  ['go','close','marks','esc'].forEach(id => $(id).disabled = true);
};

/* Escape, without needing the canvas to have focus first. A page waiting on a passkey blocks its
   own fallback button, and the way out was "click the canvas, then press Esc" — which does not help
   when the thing you cannot do is click the canvas. */
$('esc').onclick = () => {
  send({ t:'key', type:'keyDown', key:'Escape', code:'Escape' });
  send({ t:'key', type:'keyUp', key:'Escape', code:'Escape' });
  log('sent Escape');
  view.focus();
};

/* Per profile, and off by default: refusing WebAuthn is right for a container with no fingerprint
   reader and wrong for a site that genuinely needs one. */
$('noPasskey').onchange = async () => {
  const profile = $('profile').value;
  if (!profile || profile === '__new__') { log('pick a named profile first', 'err'); $('noPasskey').checked = false; return; }
  const box = $('noPasskey');
  box.disabled = true;
  try {
    // The server reloads any open session on this profile, so this call is not instant — saying so
    // beats a checkbox that looks like it did nothing for three seconds.
    log(box.checked ? 'refusing passkeys and reloading the page…' : 'saving…');
    const r = await api('/v1/profiles/' + encodeURIComponent(profile) + '/settings', {
      method:'PUT', body: JSON.stringify({ blockPasskeys: box.checked }),
    });
    log(r.note || 'saved', 'ok');
  } catch (e) { log(e.message, 'err'); box.checked = !box.checked; }
  finally { box.disabled = false; }
};

/*
 * THE ADDRESS BAR FOLLOWS THE LOGIN YOU PICK.
 *
 * Choosing "linkdin — linkedin.com" and pressing Open while the bar still read facebook.com opened
 * Facebook's login page: the profile was right and the destination was left behind, because Open
 * navigates to whatever is in the bar unless the profile's NAME happens to equal a preset's — and
 * "linkdin" is not "linkedin". So the moment a login is chosen, the bar points at that login's own
 * site, and Open lands where the name says it will.
 */
async function pointUrlAtProfile(alsoRole = false) {
  const v = $('profile').value;
  if (!v || v === '__new__') return;          // a throwaway or an unnamed new one: leave the bar
  if (v.startsWith('preset:')) {
    const preset = PRESETS.find((x) => x.key === v.slice(7));
    if (preset && preset.start) $('url').value = preset.start;
    return;
  }
  // A saved login: aim at its site. A preset for that site knows the login page; otherwise the
  // site's own home — which for a logged-in profile lands on the feed, and for one that is not yet
  // logged in shows the sign-in, which is exactly the invitation to finish setting it up.
  try {
    const cfg = await api('/v1/profiles/' + encodeURIComponent(v) + '/settings');
    let site = String(cfg && cfg.site || '').replace(/^www\./, '');
    /*
     * A login with no site label — like "linkdin", which has visited LinkedIn but is not signed in
     * yet — still has a name that says where it belongs. Guessing from the name only chooses a
     * SUGGESTED address the person can still edit; it changes nothing the agent sees, so a profile
     * that is not really logged in is not advertised to the agent as though it were.
     */
    if (!site) {
      const guess = [
        [/facebook|meta|(^|[^a-z])fb([^a-z]|$)/, 'facebook.com'],
        [/link.?d.?in/, 'linkedin.com'],
        [/google/, 'google.com'],
        [/youtube|(^|[^a-z])yt([^a-z]|$)/, 'youtube.com'],
        [/insta|(^|[^a-z])ig([^a-z]|$)/, 'instagram.com'],
      ].find(([re]) => re.test(v.toLowerCase()));
      if (guess) site = guess[1]; else return;
    }
    const preset = PRESETS.find((x) => x.site === site);
    $('url').value = preset ? preset.start : 'https://www.' + site + '/';
    if (alsoRole) setRoleForSite(site);
  } catch { /* the bar simply keeps whatever it had */ }
}

/*
 * THE ROLE FOLLOWS THE LOGIN, the same way the address bar does.
 *
 * Choosing the LinkedIn login while the role still read "Facebook · Lead scout" is the same
 * confusion as the address bar was — the browser went to LinkedIn and the specialist stayed on
 * Facebook. So picking a login moves the role to that site's scout, UNLESS a role for that same
 * site is already chosen, so a deliberate "Conversations" on the right site is not reset to "scout".
 */
function setRoleForSite(site) {
  const prefix = String(site || '').split('.')[0];      // linkedin.com -> linkedin
  if (!prefix) return;
  const sel = $('roleSel');
  const cur = sel.value || '';
  if (cur.split('.')[0] === prefix) return;             // already this site's craft — keep the exact one
  const opts = Array.from(sel.options);
  const want = opts.find((o) => o.value === prefix + '.scout')     // the reading role, by preference
            || opts.find((o) => o.value.startsWith(prefix + '.')); // otherwise the site's first role
  if (!want) return;                                    // no role for this site (e.g. YouTube) — leave it
  sel.value = want.value;
  try { localStorage.setItem('gb_role', want.value); } catch {}
  showRole();
  gripStatus();
}

$('profile').addEventListener('change', () => { loadSiteRow(); exitState(); pointUrlAtProfile(true); });
$('profile').addEventListener('change', async () => {
  const profile = $('profile').value;
  if (!profile || profile === '__new__') { $('noPasskey').checked = false; return; }
  try { const cfg = await api('/v1/profiles/' + encodeURIComponent(profile) + '/settings'); $('noPasskey').checked = !!cfg.blockPasskeys; }
  catch { $('noPasskey').checked = false; }
});

$('go').onclick = async () => {
  try {
    const r = await api('/v1/sessions/' + session + '/navigate', { method:'POST', body: JSON.stringify({ url: $('url').value }) });
    log('→ ' + r.url + ' (' + r.status + ')');
    view.focus();
  } catch (e) { log(e.message, 'err'); }
};
$('url').onkeydown = (e) => { if (e.key === 'Enter') $('go').click(); };

/* What the AGENT can see on this same page. An empty list means the agent cannot act here and a
   human has to — which is the entire reason this console exists. */
$('marks').onclick = async () => {
  try {
    const a = await api('/v1/sessions/' + session + '/analyze?screenshot=false');
    $('els').innerHTML = '';
    for (const el of a.elements) {
      const li = document.createElement('li');
      li.innerHTML = '<b>' + el.index + '</b><span></span>';
      li.querySelector('span').textContent = el.text || el.placeholder || el.ariaLabel || el.tag;
      li.onclick = () => api('/v1/sessions/' + session + '/click', { method:'POST', body: JSON.stringify({ index: el.index }) })
        .then(r => log('click [' + el.index + '] ' + (r.clicked.text || '')))
        .catch(e => log(e.message, 'err'));
      $('els').appendChild(li);
    }
    log(a.elementCount + ' elements · ' + a.title + (a.elementCount ? '' : ' — nothing the agent can click here'));
  } catch (e) { log(e.message, 'err'); }
};

gateState();
// == THE AGENT ==========================================================================
//
// The panel is a VIEW OF THE JOB RECORD, not a second copy of the story. Every step, lead and
// proposal shown here came off the socket that the server emits from the record itself, and a
// reconnect replays the whole thing - so a dropped phone connection mid-run loses nothing but the
// seconds it was gone.
let job = null, ajws = null, companies = [], cfg = {};

// ---- tabs -----------------------------------------------------------------------------
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  ['agent','els','log'].forEach(t => $('tab-' + t).hidden = (t !== b.dataset.tab));
  if (b.dataset.tab === 'agent') { $('askBadge').classList.add('hide'); }
});
const showTab = (name) => document.querySelector('.tabs button[data-tab="' + name + '"]').click();

// ---- model settings -------------------------------------------------------------------
async function loadCfg() {
  try {
    cfg = await api('/v1/agent/settings');
    $('cfgHost').value = cfg.llmHost || '';
    $('cfgModel').value = cfg.llmModel || '';
    $('cfgAuto').checked = !!cfg.autoAct;
    $('cfgSteps').value = cfg.maxSteps || 60;
    $('cfgKeyState').textContent = cfg.keySet ? ('set ' + cfg.keyHint) : 'not set';
    $('cfgKey2State').textContent = cfg.keys2Set ? 'set' : 'not set';
    // The one thing worth saying on the main panel: whether it can run at all, and whether it will
    // act on its own. Both are answers you want BEFORE typing a job, not after.
    $('modelState').innerHTML = cfg.keySet || !/ollama\.com/.test(cfg.llmHost || '')
      ? (cfg.llmModel + (cfg.autoAct ? ' &middot; <b style="color:var(--warn)">acts without asking</b>' : ' &middot; asks before acting'))
      : '<b style="color:var(--warn)">no API key yet</b> &mdash; press Model';
  } catch (e) { $('modelState').textContent = e.message; }
}
/* In order, not in parallel: loadModels marks the CURRENT model as selected, and it only knows
   which that is once loadCfg has answered. Fired together, the select came back with the first
   model in the list highlighted instead of the one actually configured. */
$('agentCfg').onclick = async () => {
  $('cfgModal').classList.remove('hide');
  loadSiteRow();
  $('cfgModels').textContent = 'asking the host…';
  await loadCfg();
  await loadModels();
};

const CUSTOM = '__custom__';

/* Keep the free-text box in step with the select. It only exists for a host serving something it
   does not advertise; the rest of the time it would just be a second place to get the name wrong. */
function syncModelInput() {
  const custom = $('cfgModelSel').value === CUSTOM;
  $('cfgModel').classList.toggle('hide', !custom);
  if (custom) $('cfgModel').focus();
}
$('cfgModelSel').onchange = syncModelInput;

async function loadModels(force) {
  const sel = $('cfgModelSel');
  try {
    const r = await api('/v1/agent/models' + (force ? '?refresh=1' : ''), {
      method:'POST',
      body: JSON.stringify({ llmHost: $('cfgHost').value.trim(), ...($('cfgKey').value.trim() ? { llmKey: $('cfgKey').value.trim() } : {}), ...($('cfgKey2').value.trim() ? { llmKeys: $('cfgKey2').value.trim() } : {}) }),
    });
    const models = r.models || [];
    const current = cfg.llmModel || $('cfgModel').value || '';
    // Keep whatever is configured selectable even if the host no longer lists it — silently
    // switching someone's model because it fell off a list is a worse outcome than showing it.
    const options = models.includes(current) || !current ? models : [current, ...models];
    sel.innerHTML = options.map(m =>
      '<option value="' + esc(m) + '"' + (m === current ? ' selected' : '') + '>' + esc(m)
      + (m === current && !models.includes(m) ? ' (not listed by the host)' : '') + '</option>').join('')
      + '<option value="' + CUSTOM + '">type a name…</option>';
    syncModelInput();
    // Say where the list came from. A fallback list that looks fetched is worse than no list —
    // you pick a model that is not there and find out forty seconds into a job.
    $('cfgModels').textContent = r.fetched
      ? (models.length + ' models on ' + r.host)
      : 'could not list models (' + (r.reason || 'unknown') + ') — these are the usual cloud ones';
    $('cfgModels').className = r.fetched ? 'cap' : 'cap warn';
  } catch (e) { $('cfgModels').textContent = e.message; $('cfgModels').className = 'cap warn'; }
}
$('cfgRefresh').onclick = () => loadModels(true);
$('cfgClose').onclick = () => $('cfgModal').classList.add('hide');
/* The select unless it says "type a name", in which case the box beneath it. */
const chosenModel = () =>
  ($('cfgModelSel').value === CUSTOM ? $('cfgModel').value.trim() : $('cfgModelSel').value)
  || cfg.llmModel || '';

const cfgBody = () => ({
  llmHost: $('cfgHost').value.trim(), llmModel: chosenModel(),
  autoAct: $('cfgAuto').checked, maxSteps: Number($('cfgSteps').value) || 60,
  // Left blank means "keep the key you already have", not "clear it" - clearing is rare and
  // deleting someone's key because they did not retype it would be its own bug.
  ...($('cfgKey').value.trim() ? { llmKey: $('cfgKey').value.trim() } : {}),
  ...($('cfgKey2').value.trim() ? { llmKeys: $('cfgKey2').value.trim() } : {}),
});
$('cfgSave').onclick = async () => {
  try { await api('/v1/agent/settings', { method:'PUT', body: JSON.stringify(cfgBody()) });
        $('cfgKey').value = ''; $('cfgKey2').value = ''; $('cfgMsg').textContent = 'saved'; $('cfgMsg').className = 'msg ok'; loadCfg(); }
  catch (e) { $('cfgMsg').textContent = e.message; $('cfgMsg').className = 'msg bad'; }
};
// Proving the key works takes three seconds here and saves a job that dies forty seconds in.
$('cfgTest').onclick = async () => {
  $('cfgMsg').textContent = 'asking the model...'; $('cfgMsg').className = 'msg';
  try { const r = await api('/v1/agent/test', { method:'POST', body: JSON.stringify(cfgBody()) });
        $('cfgMsg').textContent = 'works - ' + r.model + ' answered in ' + r.ms + 'ms'; $('cfgMsg').className = 'msg ok'; }
  catch (e) { $('cfgMsg').textContent = e.message; $('cfgMsg').className = 'msg bad'; }
};

// The company profile lived here. It now lives in LeadFlow's Settings, where it already did —
// two copies of the same facts is not redundancy, it is a guarantee that one is stale with no way
// to tell which. The agent reads LeadFlow's, server-side, when a job starts.

// ---- rendering the work ---------------------------------------------------------------
/* What a step is called when a person reads it back. The kinds that are RESULTS of a tool call are
   rendered subordinate to it rather than as events of their own — see below. */
const KIND_LABEL = { lead:'lead', acted:'sent', skipped:'skipped', blocked:'refused',
                     think:'thinking', you:'you', note:'note', learned:'learned',
                     error:'problem', done:'done', end:'ended' };
/* Everything a tool call produces. These hang off the call rather than starting a new block, which
   is the difference between a transcript and a wall. */
const RESULT_KINDS = new Set(['look', 'read', 'open', 'click', 'type', 'scroll']);
const atBottom = () => { const f = $('feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 90; };

function addStep(st) {
  // A proposal renders as its own card; the "asking you" step would just duplicate it.
  if (st.kind === 'ask') return;
  const stick = atBottom();
  const d = document.createElement('div');

  if (st.kind === 'tool') {
    // tool(args) — the ASK, before the page had a chance to answer.
    const m = String(st.text).match(/^([a-z_]+)\((.*)\)$/s);
    d.className = 'ev tool';
    d.innerHTML = m
      ? '<b>' + esc(m[1]) + '</b>(<span class="args">' + esc(m[2]) + '</span>)'
      : esc(st.text);
    if (st.args && Object.keys(st.args).length) {
      // The full arguments are one click away rather than always on screen: you want them when
      // something went wrong and never otherwise.
      const a = document.createElement('a');
      a.href = '#'; a.className = 'peek'; a.textContent = 'args';
      const pre = document.createElement('pre'); pre.hidden = true;
      pre.textContent = JSON.stringify(st.args, null, 2);
      a.onclick = (e) => { e.preventDefault(); pre.hidden = !pre.hidden; };
      d.append(a, pre);
    }
  } else if (RESULT_KINDS.has(st.kind)) {
    d.className = 'ev res';
    d.textContent = st.text;
  } else {
    d.className = 'ev ' + st.kind;
    d.innerHTML = '<span class="k">' + (KIND_LABEL[st.kind] || st.kind) + '</span>' + esc(st.text);
  }

  $('feed').appendChild(d);
  if (stick) d.scrollIntoView({ block:'end' });
}
const esc = (t) => String(t == null ? '' : t).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function renderProposal(p) {
  let card = document.getElementById('prop-' + p.pid);
  if (!card) {
    card = document.createElement('div');
    card.className = 'ev prop'; card.id = 'prop-' + p.pid;
    $('feed').appendChild(card);
    card.scrollIntoView({ block:'end' });
  }
  if (p.state !== 'pending') {
    card.className = 'ev prop done';
    card.innerHTML = '<span class="k">' + (p.state === 'approved' ? 'you approved' : 'you skipped') + '</span>'
      + '<b>' + esc(p.kind) + '</b>' + (p.text ? '<br>' + esc(p.text) : ' &mdash; ' + esc(p.label));
    refreshBadge();
    return;
  }
  card.className = 'ev prop';
  card.innerHTML =
    '<h4>It wants to ' + esc(p.kind) + (p.label ? ' &mdash; "' + esc(p.label) + '"' : '') + '</h4>'
    + (p.why ? '<p class="why">' + esc(p.why) + '</p>' : '')
    + (p.text !== undefined && p.text !== '' ? '<textarea rows="4">' + esc(p.text) + '</textarea>' : '')
    + '<div class="row" style="margin:0"><button class="go" data-ok="1" style="flex:1">Send it</button>'
    + '<button data-ok="0">Skip</button></div>';
  const ta = card.querySelector('textarea');
  card.querySelectorAll('button').forEach(b => b.onclick = async () => {
    card.querySelectorAll('button').forEach(x => x.disabled = true);
    try {
      await api('/v1/agent/jobs/' + job.id + '/proposals/' + p.pid, {
        method:'POST',
        // The edit is the normal case: it picks the right person and nearly the right words.
        body: JSON.stringify({ approve: b.dataset.ok === '1', edit: ta ? ta.value : undefined }),
      });
    } catch (e) { log(e.message, 'err'); card.querySelectorAll('button').forEach(x => x.disabled = false); }
  });
  refreshBadge();
}

function refreshBadge() {
  gripStatus();
  const n = (job?.proposals || []).filter(p => p.state === 'pending').length;
  const b = $('askBadge');
  b.textContent = n; b.classList.toggle('hide', n === 0);
  // A question nobody sees is a job that looks hung, so the tab title carries it too.
  document.title = n ? '(' + n + ') GhostBrowser' : 'GhostBrowser';
}

function renderJob(j) {
  job = j;
  showJobRole(j);
  $('feed').innerHTML = '';
  (j.steps || []).forEach(addStep);
  (j.proposals || []).forEach(renderProposal);
  setRunning();
  updateLeads();
  gripStatus();
}

function updateLeads() {
  const n = (job?.leads || []).length;
  $('leadRow').hidden = !n;
  $('leadCount').textContent = n + (n === 1 ? ' lead' : ' leads')
    + (job?.sink ? ' → ' + job.sink.label + ' #' + job.sink.searchId : '');
  if (job) $('csv').href = mounted('/v1/agent/jobs/' + job.id + '/leads.csv');
}

/* Three states worth telling apart: working, waiting for you, and over. The middle one is the whole
   point of the redesign — it means everything it read is still there and you can just carry on. */
function setRunning() {
  gripStatus();
  const st = job ? job.status : null;
  $('stopJob').disabled = !(st === 'running' || st === 'idle');
  $('convState').textContent =
    st === 'running' ? 'working… (you can still type)' :
    st === 'idle' ? 'waiting for you — it remembers everything above' :
    st === 'failed' ? 'this conversation failed' :
    st === 'stopped' ? 'stopped' : '';
  $('convState').className = st === 'failed' ? 'cap warn' : 'cap';
}

// ---- the socket -----------------------------------------------------------------------
function followJob(id) {
  /* Closing the old one is deliberate, and its onclose must not then speak for the new one. */
  if (ajws) { try { ajws.__replaced = true; ajws.close(); } catch {} }
  /* Did the server ever answer? A refused socket closes without a snapshot, which used to be
     indistinguishable from a job that simply had nothing to say. */
  let heard = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ajws = new WebSocket(proto + '://' + location.host + mounted('/v1/agent') + '?job=' + encodeURIComponent(id));
  ajws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'snapshot') {
      heard = true;
      /*
       * THE PICTURE BEFORE THE TRANSCRIPT, AND THE TRANSCRIPT IN ITS OWN TRY.
       *
       * These used to be one sequence: draw the steps, then connect the live view. So an exception
       * anywhere in the drawing — one unexpected field, one element not on the page yet — killed the
       * whole message handler before the live view was ever connected. The browser swallows a throw
       * inside a socket handler, so the result was a black rectangle with nothing wrong on the
       * server: measured on a page set-up walk, where the job socket connected and the frames socket
       * was never even attempted.
       *
       * The frames are what somebody followed the link for. Drawing the steps is the part that can
       * fail, so it goes second and it goes in a try.
       */
      // Reconnecting mid-run: the conversation may have moved browsers while we were away.
      if (m.job && m.job.sessionId) adoptAgentSession(m.job.sessionId, m.job.profile);
      /* A running job with no session is a real state — it is queued, waiting for a browser — and
         it looks exactly like a broken viewer unless somebody says so. */
      else agentSay('this job has no browser yet — it is waiting for one to free up. The transcript is live; the picture starts when it gets one.', 'note');
      try { renderJob(m.job); }
      catch (e) { agentSay('the transcript could not be drawn: ' + e.message + ' — the live view above is unaffected.', 'error'); }
      return;
    }
    if (m.type === 'step') { addStep(m.step); if (m.step.kind === 'ask') showTab('agent'); return; }
    if (m.type === 'lead') { job.leads.push(m.lead); updateLeads(); return; }
    if (m.type === 'proposal') {
      const i = job.proposals.findIndex(p => p.pid === m.proposal.pid);
      if (i >= 0) job.proposals[i] = m.proposal; else job.proposals.push(m.proposal);
      renderProposal(m.proposal);
      // The one moment the person is genuinely needed. Do not make them go looking for it.
      if (m.proposal.state === 'pending') {
        if ($('tab-agent').hidden) showTab('agent');
        // The one moment the sheet IS what you need, and hunting for a handle then is
        // friction at exactly the wrong time.
        sheet.open('half');
      }
      return;
    }
    if (m.type === 'status') { job.status = m.status; setRunning(); return; }
    if (m.type === 'session') {
      // It changed browsers. Follow, or the screen keeps showing the one it left — which is what
      // made it look like nothing was happening while the transcript said otherwise.
      job.sessionId = m.sessionId;
      adoptAgentSession(m.sessionId, m.profile);
    }
  };
  const mine = ajws;
  ajws.onclose = (ev) => {
    /*
     * ONLY THE CURRENT SOCKET MAY SPEAK, and only about itself.
     *
     * This reported "the browser refused the connection" whenever a socket closed without having
     * delivered a snapshot — including a socket THIS function had just replaced on purpose. So
     * following a job twice printed a refusal for a connection the server had accepted, which is
     * measured: two accepts in the browser's log, and a refusal on screen. A wrong explanation is
     * worse than none, because it sends somebody to fix the wrong thing.
     */
    if (mine.__replaced) return;
    if (ajws === mine) ajws = null;
    if (heard) return;
    /* Closed before it ever spoke. Carry the close code: 1006 is a connection that died, 1000 a
       clean close, and knowing which is the difference between a browser problem and a network one. */
    agentSay(`the browser closed the connection for this job before sending anything (code ${ev && ev.code}). Reload the page; if it happens again, the job may belong to another account or the browser may have restarted.`, 'error');
  };
}

/* Re-point the live view at whichever browser the agent is actually in. Deliberately reuses the
   same connect path as opening a session by hand, so the two cannot drift apart. */
function adoptAgentSession(sessionId, profile) {
  if (!sessionId) return;
  /*
   * SAME SESSION IS NOT THE SAME AS STILL CONNECTED. This returned early whenever the id had not
   * changed, which is right while the picture is live and wrong the moment it is not: leaving the
   * console for Accounts and pressing Watch again re-enters with `session` already set, so nothing
   * was adopted, nothing reconnected, and the dead canvas from last time stayed on screen until a
   * page reload. That is the black Watch. Reconnect unless a socket is genuinely up.
   */
  const connected = ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
  if (sessionId === session && connected) return;
  session = sessionId;
  ['go','close','marks','esc'].forEach(id => $(id).disabled = false);
  if (profile) {
    // The header said "throwaway (no saved cookies)" while the agent worked in a logged-in profile.
    if (![...$('profile').options].some(o => o.value === profile)) {
      $('profile').insertAdjacentHTML('afterbegin', '<option value="' + profile + '">' + esc(profile) + '</option>');
    }
    $('profile').value = profile;
    activeProfile = profile;
    loadSiteRow();
  }
  connectLive();
  log('following the agent into ' + (profile ? '"' + profile + '"' : 'a new session'), 'ok');
}

// ---- starting and steering ------------------------------------------------------------
// Anything the agent panel has to say belongs IN the agent panel. The log tab is for the browser.
function agentSay(text, kind = 'error') {
  const d = document.createElement('div');
  d.className = 'ev ' + kind;
  d.innerHTML = '<span class="k">' + (kind === 'error' ? 'problem' : kind) + '</span>' + esc(text);
  $('feed').appendChild(d);
  d.scrollIntoView({ block:'end' });
  log(text, kind === 'error' ? 'err' : '');
}

/*
 * ONE ACT: you say something.
 *
 * If there is no conversation, this starts one. If there is, it continues it — and if the agent had
 * gone quiet after finishing, this wakes it with everything it already read still in its head.
 *
 * It used to be two buttons: a goal box that started a run, and a separate box that only existed
 * while one was going. That made the first message a form submission and every later one an
 * interruption, when they are the same thing.
 */
async function sendMessage() {
  const text = $('sayText').value.trim();
  if (!text) return;
  $('sayBtn').disabled = true;
  try {
    if (job && job.status !== 'stopped' && job.status !== 'failed') {
      $('sayText').value = ''; growSay();
      await api('/v1/agent/jobs/' + job.id + '/say', { method:'POST', body: JSON.stringify({ text }) });
      return;
    }

    // No session? Open one. Being told to press another button first is a step that exists only
    // because the code was written that way.
    if (!session) {
      agentSay('opening a browser session…', 'think');
      try { await adopt(await openSession(false)); }
      catch (e) {
        // A session of yours is already open elsewhere. Taking it over is what "send" means here.
        if (e.body && e.body.canTakeover) await adopt(await openSession(true));
        else throw e;
      }
    }

    $('sayText').value = ''; growSay();
    const j = await api('/v1/agent/jobs', { method:'POST', body: JSON.stringify({
      goal: text, sessionId: session, role: $('roleSel').value || 'general',
      // Only on the first message: the token is scoped to one search, and a second conversation
      // filling the same search would be a surprise to whoever opened it.
      ...(leadflow ? { leadflow } : {}),
      // Sent on every conversation, not just one with a search: replies are checked long after.
      ...(social ? { social } : {}),
    }) });
    $('feed').innerHTML = '';
    renderJob(j);
    followJob(j.id);
  } catch (e) {
    // Put the text back — losing what you typed to an error is its own small betrayal.
    if (!$('sayText').value) $('sayText').value = text;
    agentSay(e.message);
  } finally {
    $('sayBtn').disabled = false;
    setRunning();
  }
}
$('sayBtn').onclick = () => { sheet.open('half'); sendMessage(); };

/* ── the responsive chrome, wired ──────────────────────────────────────────────────────────
 * The header's ⋯ menu, the one-line role note that expands, and a composer that grows with what
 * you type instead of standing three rows tall on a screen that cannot spare them.
 */

// The overflow menu. Opens on the button, closes on a choice or a tap anywhere else.
$('moreBtn').onclick = (e) => { e.stopPropagation(); $('hdrMenu').classList.toggle('open'); };
document.addEventListener('click', (e) => {
  if (!$('hdrMenu').contains(e.target) && e.target !== $('moreBtn')) $('hdrMenu').classList.remove('open');
});
['closeAll', 'showKey', 'exitBtn', 'logout'].forEach((id) =>
  $(id).addEventListener('click', () => $('hdrMenu').classList.remove('open')));

// One line of the role note, or all of it. The guarantee is on the line you always see.
$('roleLine').addEventListener('click', () => $('roleLine').classList.toggle('open'));

// The composer grows from one line to a cap, then scrolls — never taller than the conversation.
function growSay() {
  const t = $('sayText');
  t.style.height = '42px';
  t.style.height = Math.min(t.scrollHeight, 132) + 'px';
}
$('sayText').addEventListener('input', growSay);
// Enter sends, Shift+Enter is a newline: the convention everywhere, and these messages are often
// two or three lines of instruction.
$('sayText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); sendMessage(); }
});

$('stopJob').onclick = async () => {
  if (!job) return;
  try { renderJob(await api('/v1/agent/jobs/' + job.id + '/stop', { method:'POST' })); }
  catch (e) { agentSay(e.message); }
};

$('newChat').onclick = () => {
  // Deliberately does NOT stop what is running: a conversation that is mid-job should be left alone,
  // and the stop button is right there for when that is what you meant.
  if (job && job.status === 'running' && !confirm('That conversation is still working. Start a new one anyway?')) return;
  if (ajws) { try { ajws.close(); } catch {} ajws = null; }
  job = null;
  $('feed').innerHTML = '';
  $('histList').classList.add('hide');
  updateLeads(); setRunning();
  $('sayText').focus();
};

// ---- earlier conversations (a modal, styled like the dashboard's) ----------------------
$('history').onclick = async () => {
  const modal = $('histModal');
  const box = $('histList');
  modal.classList.remove('hide');
  box.classList.remove('hide');
  box.innerHTML = '<span class="cap">loading…</span>';
  try {
    const r = await api('/v1/agent/jobs');
    const rows = (r.jobs || []).concat((r.history || []).filter(h => !(r.jobs || []).some(j => j.id === h.id)));
    box.innerHTML = rows.length ? rows.map(j =>
      '<div class="histitem" data-open="' + j.id + '">'
      + '<span class="k">' + esc(j.status) + ' &middot; ' + new Date(j.createdAt).toLocaleString()
      + (j.leads ? ' &middot; ' + (j.leads.length ?? j.leads) + ' leads' : '') + '</span>'
      + esc(String(j.goal || '').slice(0, 140)) + '</div>').join('')
      : '<span class="cap">nothing yet</span>';
    box.querySelectorAll('[data-open]').forEach(d => d.onclick = async () => {
      modal.classList.add('hide');
      try {
        const j = await api('/v1/agent/jobs/' + d.dataset.open);
        $('feed').innerHTML = '';
        renderJob(j);
        // A conversation that is still alive can be talked to; one from before a restart is a
        // record you can read, and saying so beats letting someone type into a dead thread.
        if (j.status === 'running' || j.status === 'idle') followJob(j.id);
        else agentSay('This conversation ended (' + j.status + '). Press New to start another.', 'think');
      } catch (e) { agentSay(e.message); }
    });
  } catch (e) { box.innerHTML = '<span class="cap warn">' + esc(e.message) + '</span>'; }
};
// Close the earlier-conversations modal: the Close button, or a click on the backdrop.
$('histClose').onclick = () => $('histModal').classList.add('hide');
$('histModal').addEventListener('click', (e) => { if (e.target === $('histModal')) $('histModal').classList.add('hide'); });

/*
 * ARRIVING FROM LEADFLOW.
 *
 * The Search page opens this browser with everything the run needs in the URL fragment: which
 * search to fill, a token scoped to that one search, and what was typed. A FRAGMENT rather than a
 * query string because it never reaches a server log or a Referer header — the token is the whole
 * reason to care.
 *
 * It is read once and then wiped from the address bar, so a reload or a shared screenshot does not
 * carry a live credential.
 */
(function showHandoff() {
  if (!leadflow) return;

  const b = $('lfBanner');
  b.classList.remove('hide');
  b.innerHTML = '<span class="k">leads go to leadflow</span>'
    + 'Search #' + esc(String(leadflow.searchId))
    + (leadflow.query ? ' &mdash; "' + esc(leadflow.query) + '"' : '')
    + (leadflow.location && leadflow.location !== 'anywhere' ? ' in ' + esc(leadflow.location) : '')
    + '<br><span class="cap">Each lead is sent the moment it is found. Scoring, email lookup and the pipeline happen there.</span>';

  // Pre-fill rather than auto-start: what was typed on a search page is a topic, and this agent
  // works from an instruction. Leaving it editable is the difference between the two.
  if (leadflow.query && !$('sayText').value) {
    $('sayText').value = 'Find leads: ' + leadflow.query
      + (leadflow.location && leadflow.location !== 'anywhere' ? ' in ' + leadflow.location : '')
      + '. Read the posts properly before deciding, save each good one with save_lead, and quote the '
      + 'words that convinced you. Do not post, comment or join anything.';
  }
})();

/*
 * THE SPECIALISTS.
 *
 * A role is a prompt and a set of tools, both resolved on the server — this only ever sends a name.
 * The choice is remembered, because whoever is scouting today is usually scouting tomorrow.
 */
async function loadRoles() {
  try {
    const r = await api('/v1/agent/roles');
    let list = r.roles || [];
    /* PLATFORM-BOUND. When a session was opened for one platform (from an Accounts card), only that
       platform's roles are offered — a Facebook profile never shows Google's roles. Matched on the
       role's site, its group, or any segment of its name (so reach.reddit / post.reddit belong to
       Reddit even though their `site` is null). No platform set (a manual open) → every role, as before. */
    const plat = window.__ghostPlat;
    if (plat) {
      const keys = plat.keys.map(k => String(k).toLowerCase());
      const inKeys = (s) => keys.includes(String(s || '').toLowerCase());
      // An authored profile carries an explicit list of roles it attached — always offer those,
      // whatever their site, on top of anything that matches this platform the usual way.
      const attached = new Set((plat.roles || []).map(r => String(r).toLowerCase()));
      list = list.filter(x => attached.has(String(x.name || '').toLowerCase())
        || inKeys(x.site) || inKeys(x.group)
        || String(x.name || '').toLowerCase().split(/[.\-_]/).some(seg => keys.includes(seg)));
    }
    let last = localStorage.getItem('gb_role') || 'facebook.scout';
    if (plat && !list.some(x => x.name === last)) last = (list[0] && list[0].name) || last;   // default to a role that fits
    /* Grouped by site, because a Facebook scout and a LinkedIn scout are different craft — a
       comment in a group and a comment on a professional record are not the same act, and a flat
       list invites picking the wrong one. */
    const bySite = {};
    for (const x of list) (bySite[x.group] = bySite[x.group] || []).push(x);
    $('roleSel').innerHTML = Object.entries(bySite).map(([group, rs]) =>
      '<optgroup label="' + esc(group) + '">'
      + rs.map(x => '<option value="' + x.name + '" title="' + esc(x.description) + '"'
          + (x.name === last ? ' selected' : '') + '>' + esc(x.label.replace(/^[^·]*·\s*/, '')) + '</option>').join('')
      + '</optgroup>').join('');
    showRole();
  } catch { /* the server decides anyway; a missing list just means the default */ }
}
/*
 * Say what this specialist may do, and what it cannot, under the bar rather than in a tooltip.
 * "Cannot post anything" is the entire reason to choose the scout, and a guarantee nobody can see
 * is a guarantee nobody relies on.
 */
const ROLE_CANNOT = {
  'facebook.scout': 'Cannot post, comment, join or react — this one only reads.',
  'facebook.voice': 'Cannot post or save leads — it only reads your own history.',
  'facebook.conversation': 'Can reply, and every reply waits for you to approve it.',
  'linkedin.scout': 'Cannot post, comment or send connection requests — this one only reads.',
  'linkedin.conversation': 'Can reply, and every reply waits for you to approve it.',
  'google.research': 'Cannot post anywhere — it searches, reads and reports back.',
  'google.prospect': 'Cannot post anywhere — it finds businesses and saves them as leads.',
  'research.company': 'Cannot post anywhere — it reads across every login and reports back.',
  'research.person': 'Cannot post anywhere — it reads across every login and reports back.',
  general: 'Everything in reach. Replies still wait for your approval.',
};
/*
 * THE ROLE ON SCREEN IS THE JOB'S, not the picker's memory of what you last chose.
 *
 * Watching one of Herald's replies showed "Lead scout" and "Reddit demand" above the trace, because
 * the picker kept the owner's own last choice and the description came from that. Both jobs were in
 * fact running herald-reply-linkedin and herald-reply-reddit. A running job's role is a fact about
 * the job, so the picker follows it — and is locked while it runs, because changing it then changes
 * nothing. When the job is over the picker belongs to the owner again.
 */
function showJobRole(j) {
  const sel = $('roleSel'); if (!sel) return;
  const live = j && (j.status === 'running' || j.status === 'idle');
  if (j && j.role) {
    const has = [...sel.options].some((o) => o.value === j.role);
    /* A role the picker does not list — one an organ registered — still gets named rather than
       silently showing somebody else's. */
    if (!has) { const o = document.createElement('option'); o.value = j.role; o.textContent = j.role; o.title = 'the role this job is running'; sel.appendChild(o); }
    sel.value = j.role;
    showRole();
  }
  sel.disabled = !!live;
  sel.title = live ? 'the role this job is running — it cannot be changed mid-run' : '';
}

function showRole() {
  const o = $('roleSel').selectedOptions[0];
  if (!o) return;
  const cannot = ROLE_CANNOT[$('roleSel').value] || '';
  // The guarantee first: on a narrow screen the note is clamped to one line, and the line worth
  // seeing is the one that says this specialist cannot post — not the description of what it does.
  $('roleLine').innerHTML = (cannot ? '<span class="cant">' + esc(cannot) + '</span> ' : '')
    + esc(o.title || '');
  $('roleLine').classList.remove('open');
}
$('roleSel').onchange = () => {
  /* Only the owner's own choice is remembered; a job's role is never written over it. */
  try { if (!$('roleSel').disabled) localStorage.setItem('gb_role', $('roleSel').value); } catch {}
  showRole();
};

/*
 * THE SHEET, on a narrow screen.
 *
 * Three positions rather than open/shut: peeked is for watching the page, half is for following
 * along while still seeing it, full is for reading back or typing something long. Two things open
 * it by themselves — a proposal waiting for approval and sending a message — because both are
 * moments where the sheet is the thing you need and hunting for a handle is friction at exactly
 * the wrong time.
 */
/*
 * FIT TO WHAT IS ACTUALLY ON SCREEN.
 *
 * Inside LeadFlow this whole console is an iframe, and LeadFlow gives it a height taller than the
 * space left under its own header — so the iframe runs off the bottom of the screen, taking the
 * canvas's lower half and the agent sheet with it. An iframe cannot feel that it is clipped, so it
 * has to be told: leadflows.sale/browser is SAME-ORIGIN with the page around it, which means the
 * frame can read the parent's height and its own position in it, work out the visible slice, and
 * size everything to that. Cross-origin (opened on its own) falls back to its own viewport, which
 * is already correct there.
 */
function fitToVisible() {
  let h = window.innerHeight;
  try {
    if (window.frameElement) {
      const rect = window.frameElement.getBoundingClientRect();
      const parentH = window.parent.innerHeight;
      const visible = Math.min(rect.height, parentH - Math.max(0, rect.top));
      if (visible > 240) h = visible;                 // ignore a nonsense measurement mid-layout
    }
  } catch { /* cross-origin: our own innerHeight is the right answer */ }
  document.documentElement.style.setProperty('--appvh', h + 'px');
  document.documentElement.setAttribute('data-fit', '1');
}
fitToVisible();
window.addEventListener('resize', fitToVisible);
window.addEventListener('orientationchange', fitToVisible);
// The parent scrolling changes how much of the iframe shows; follow it when we are allowed to.
try { window.parent.addEventListener('scroll', fitToVisible, { passive: true }); } catch { /* cross-origin */ }
// visualViewport moves under the on-screen keyboard on a phone; keep the composer in view.
try { window.visualViewport && window.visualViewport.addEventListener('resize', fitToVisible); } catch {}

const sheet = {
  states: ['peek', 'half', 'full'],
  at: 'peek',
  narrow: () => matchMedia('(max-width: 980px)').matches,
  set(state) {
    this.at = state;
    const p = $('panel');
    p.classList.toggle('half', state === 'half');
    p.classList.toggle('full', state === 'full');
  },
  cycle() { this.set(this.states[(this.states.indexOf(this.at) + 1) % 3]); },
  // Never shrinks it. Something that needs attention must not close a sheet somebody just opened.
  open(least = 'half') {
    if (!this.narrow()) return;
    if (this.states.indexOf(least) > this.states.indexOf(this.at)) this.set(least);
  },
};

$('grip').onclick = () => sheet.cycle();

/* Dragging, because a sheet that only responds to taps feels like a button pretending to be one. */
(function draggable() {
  const grip = $('grip');
  let startY = null, startAt = null;
  grip.addEventListener('pointerdown', (e) => { startY = e.clientY; startAt = sheet.at; grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointerup', (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    // A real drag snaps to the next position; anything smaller was a tap, which cycles.
    if (Math.abs(dy) < 24) return;
    const i = sheet.states.indexOf(startAt);
    sheet.set(sheet.states[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)))]);
    e.preventDefault();
  });
})();

/* What the handle says while the sheet is shut — the only thing visible then, so it carries whether
   anything is happening and whether anything is waiting. */
function gripStatus() {
  const st = job ? job.status : null;
  const pending = (job?.proposals || []).filter(p => p.state === 'pending').length;
  const leads = (job?.leads || []).length;
  $('gripWho').textContent = ($('roleSel').selectedOptions[0] || {}).textContent || 'Agent';
  $('gripState').textContent = pending ? pending + ' waiting for you'
    : st === 'running' ? (leads ? 'working · ' + leads + ' leads' : 'working…')
    : st === 'idle' ? (leads ? 'done · ' + leads + ' leads' : 'waiting for you')
    : leads ? leads + ' leads' : '';
  $('gripState').style.color = pending ? 'var(--warn)' : '';
}

/*
 * WHERE THE TRAFFIC ACTUALLY LEAVES FROM.
 *
 * It takes three facts and the header used to show one of them: the daemon's exit node. A profile
 * that does not route through the tailnet still showed "exit: WojMagEmi", so the header claimed a
 * laptop in the Netherlands while the browser left from a rack in Finland. Everything it said was
 * true and the impression was false, which is the worse kind of wrong.
 */
async function exitState() {
  const el = $('exitState');
  try {
    const prof = $('profile').value;
    const [t, cfg, all] = await Promise.all([
      api('/v1/tailscale/status'),
      (prof && !prof.startsWith('preset:') && prof !== '__new__')
        ? api('/v1/profiles/' + encodeURIComponent(prof) + '/settings').catch(() => ({}))
        : Promise.resolve({}),
      api('/v1/agent/settings').catch(() => ({})),
    ]);

    /* Three states, not two: insisting, opted out, or following the default — and the default now
       decides for nearly every login, so the header is wrong if it does not read it. */
    const routeAll = all.routeThroughTailnet !== false;
    const wants = cfg.proxy === 'tailscale' || (!cfg.proxy && routeAll);
    const ready = t.running && t.loggedIn && !!t.exitNode;

    if (wants && ready) {
      el.textContent = 'exit: ' + t.exitNode;
      el.style.color = 'var(--ok)';
      el.title = 'This login leaves through ' + t.exitNode + ', not through this server.';
    } else if (wants && !ready) {
      // The dangerous state: configured to use the tailnet and silently not doing so, because a
      // profile set to 'tailscale' falls back to a direct connection when the daemon is not there.
      el.textContent = 'exit: THIS SERVER (tailnet down)';
      el.style.color = 'var(--bad)';
      el.title = !t.running ? 'This login is set to use your tailnet, but it is not running — so it is leaving from this server.'
        : !t.loggedIn ? 'Tailnet is not signed in, so this login is leaving from this server.'
        : 'No exit node is chosen, so this login is leaving from this server.';
    } else if (prof) {
      el.textContent = 'exit: this server';
      el.style.color = 'var(--warn)';
      el.title = cfg.proxy === 'direct'
        ? 'This login is set to always leave from this server — a datacentre IP. Change it in Setup.'
        : 'Every login is leaving from this server’s address — a datacentre IP. Turn on the exit node here.';
    } else {
      el.textContent = t.exitNode ? 'tailnet: ' + t.exitNode : 'tailnet: not set up';
      el.style.color = '';
      el.title = 'Open a login to see where it actually exits.';
    }
  } catch { el.textContent = 'exit: unknown'; el.style.color = ''; }
}

// ---- the login this session is signed in to -------------------------------------------
// The agent chooses a login by SITE. Without a label all it has is a folder name, and picking the
// wrong one means acting on the wrong account.
async function loadSiteRow() {
  const prof = $('profile').value;
  // In Setup now, so it is always present; it just needs a session to describe.
  if (!(session && prof && prof !== '__new__')) return;
  const who = $('siteWho2');
  if (who) who.textContent = prof;
  try {
    const c = await api('/v1/profiles/' + encodeURIComponent(prof) + '/settings');
    $('siteVal').value = c.site || ''; $('siteNote').value = c.note || '';
    $('siteAs').value = c.presentAs || '';
    $('siteExit').value = (c.proxy === 'tailscale' || c.proxy === 'direct') ? c.proxy : '';
    /* Set by the preset, and locked: the agent matches on this, and a corrected site is a login the
       agent can no longer find. The note and the platform stay editable. */
    const preset = PRESETS.find(x => x.profile === prof);
    $('siteVal').readOnly = !!preset;
    $('siteVal').title = preset ? 'Set by the ' + preset.label + ' preset — the agent matches on this' : '';
  } catch {}
}
$('siteForget').onclick = async (e) => {
  e.preventDefault();
  const prof = $('profile').value;
  if (!prof || prof.startsWith('preset:') || prof === '__new__') return;
  if (!confirm('Delete the "' + prof + '" login? Everything signed into it is lost and you would have to sign in again.')) return;
  try {
    await api('/v1/profiles/' + encodeURIComponent(prof), { method:'DELETE' });
    log('deleted the "' + prof + '" login', 'ok');
    await loadProfiles();
  } catch (err) { log(err.message, 'err'); }
};

$('siteSave').onclick = async () => {
  const prof = $('profile').value;
  try {
    await api('/v1/profiles/' + encodeURIComponent(prof) + '/settings', {
      method:'PUT', body: JSON.stringify({ site: $('siteVal').value, note: $('siteNote').value,
                                           presentAs: $('siteAs').value,
                                           // '' means follow the default; the other two are this login
                                           // insisting, and must survive the default changing under it.
                                           proxy: $('siteExit').value || null }) });
    // The platform is fixed when the browser starts, so it takes a fresh session — saying so beats
    // wondering why the "was this you?" screen still says Linux.
    // Both of these are fixed when the browser starts, so neither applies to the session already
    // running — saying so beats wondering why the exit did not change.
    log('saved — close and reopen this login for it to take effect', 'ok');
    exitState();
  } catch (e) { log(e.message, 'err'); }
};

// ---- what it knows about you ----------------------------------------------------------
/* Study me is a ROLE now, not a paragraph of instructions pasted into the box. The role cannot post
   or react at all, which is the right guarantee for something that goes through somebody's own
   history — and it says so rather than relying on a prompt to hold. */
$('studyMe').onclick = () => {
  $('roleSel').value = 'facebook.voice';
  $('cfgModal').classList.add('hide');
  // Written out rather than hidden server-side so it can be read, edited and argued with before it
  // runs - it is about to read the owner's own history, which is not a thing to start blind.
  $('sayText').value =
    'Study me so you can write as me later. Go to my own profile on the site this session is signed in to. '
    + 'Open my posts and my comments, read a good number of them, and use save_my_writing to keep the ones '
    + 'I wrote word for word - my comments on other people\'s posts are the most useful, because that is '
    + 'the voice you will be replying in. Use remember_about_me for what is true about me: my work, where '
    + 'I am, the groups I am in, how I greet people and how I sign off. When you have read enough, call '
    + 'describe_my_voice with a summary of how I write. Do not post, comment or react to anything.';
  $('sayText').focus();
};

/* The scoreboard, read back. Rows and raw numbers rather than a rating: "nothing here yet" and
   "thirty posts and never a lead" have to stay distinguishable, and an average hides that. */
async function loadPlaybook() {
  try {
    const r = await api('/v1/agent/playbook');
    const places = r.places || [];
    $('pbCount').textContent = places.length ? places.length + ' place(s) tried' : '';
    $('pbList').innerHTML = places.length
      ? places.slice(0, 30).map(p =>
          '<div class="pb-row ' + (p.leads ? 'good' : p.dead ? 'dead' : '') + '">'
          + '<span class="what">' + (p.kind === 'group' ? '&#128101; ' : '&#128269; ') + esc(p.what)
          + (p.scope ? ' <span class="n">' + esc(p.scope) + '</span>' : '') + '</span>'
          + '<span class="n">' + p.leads + ' lead' + (p.leads === 1 ? '' : 's')
          + ' / ' + p.posts + ' post' + (p.posts === 1 ? '' : 's')
          + ' / ' + p.sweeps + ' sweep' + (p.sweeps === 1 ? '' : 's') + '</span>'
          + (p.dead ? '<span class="n" style="color:var(--bad)">written off</span>' : '')
          + '</div>').join('')
      : '<span class="cap">Nothing yet. It fills in as the scout runs, and the next run starts from what worked.</span>';
  } catch (e) { $('pbList').innerHTML = '<span class="cap warn">' + esc(e.message) + '</span>'; }
}
$('pbForget').onclick = async () => {
  if (!confirm('Forget everything it has learned about where leads are? The next run starts from nothing.')) return;
  await api('/v1/agent/playbook', { method:'DELETE' }).catch(() => {});
  loadPlaybook();
};

async function loadMe() {
  loadPlaybook();
  const m = await api('/v1/agent/me');
  $('meName').value = m.name || '';
  $('meStyle').value = m.style || '';
  $('meCount').textContent = (m.sampleCount || 0) + ' kept';
  $('meFacts').innerHTML = Object.entries(m.facts || {}).length
    ? Object.entries(m.facts).map(([k, v]) => '<div><b>' + esc(k) + '</b>: ' + esc(v) + '</div>').join('')
    : '<span class="cap">nothing yet - run "Study me"</span>';
  $('meSamples').innerHTML = (m.samples || []).length
    ? m.samples.slice().reverse().map((x, i) =>
        '<div class="ev"><span class="k">' + esc(x.where || '') + '</span>' + esc(x.text)
        + ' <a href="#" data-drop="' + i + '" style="color:var(--bad)">remove</a></div>').join('')
    : '<span class="cap">nothing yet</span>';
  // Removing a sample is the point of showing them; editing one would defeat it, since they are
  // evidence of how someone actually writes.
  $('meSamples').querySelectorAll('[data-drop]').forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    const keep = m.samples.slice().reverse().filter((_, i) => i !== Number(a.dataset.drop)).reverse();
    await api('/v1/agent/me', { method:'PUT', body: JSON.stringify({ samples: keep }) });
    loadMe();
  });
}
$('showMe').onclick = () => { $('meModal').classList.remove('hide'); $('meMsg').textContent = ''; loadMe().catch(e => $('meMsg').textContent = e.message); };
$('meClose').onclick = () => $('meModal').classList.add('hide');
$('meSave').onclick = async () => {
  try { await api('/v1/agent/me', { method:'PUT', body: JSON.stringify({ name: $('meName').value, style: $('meStyle').value }) });
        $('meMsg').textContent = 'saved'; $('meMsg').className = 'msg ok'; }
  catch (e) { $('meMsg').textContent = e.message; $('meMsg').className = 'msg bad'; }
};
$('meForget').onclick = async () => {
  if (!confirm('Delete everything the agent has learned about you?')) return;
  await api('/v1/agent/me', { method:'DELETE' });
  loadMe();
};

/* NOT at load. Signing in happens asynchronously — through LeadFlow when this is a page of it, or
   through the gate when it is not — and firing these before it finishes produced "no valid API key"
   and an empty profile list on a console that was about to be perfectly well signed in. enter()
   calls this once there is a session. */
function loadPanel() { loadCfg(); loadRoles(); }

