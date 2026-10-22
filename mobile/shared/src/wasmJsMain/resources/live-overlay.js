/*
 * live-overlay.js — the Browser tab's LIVE VIEW for the Compose web console, and you can drive it.
 *
 * WHY THIS IS NO LONGER READ-ONLY.
 *
 * The first version watched only, on the reasoning that a streamed browser is laggy to drive and
 * that the native apps are the place to interact. Half of that is true — every input here is a
 * round-trip and a repaint, and it will never feel like a local browser. The other half was wrong
 * in a way that mattered: the phone and desktop apps drive their OWN browsers, in their own
 * profiles. They cannot touch a session running on the cluster. So "open the app to interact" sent
 * people to something that could not do the thing, and there was no way at all to sign a CLUSTER
 * profile in by hand.
 *
 * That is not a small gap. A login is the one act that cannot be automated here on purpose — the
 * owner does it once, by hand — and Search Console sat unreadable for weeks because the Google
 * profile on the cluster was signed out with no way to sign it in. Laggy beats impossible.
 *
 * The server side needed nothing: /v1/live has relayed Input.dispatchMouseEvent,
 * dispatchKeyEvent and insertText since it was written, and it even answers each click with
 * {t:'focus', editable} so a touch client knows whether to raise its keyboard. This module was the
 * only client that never sent anything.
 *
 * Compose calls window.gbLive.start(session,x,y,w,h) / .resize(...) / .stop(); coordinates are CSS px.
 */
window.gbLive = (function () {
  let ws = null, canvas = null, ctx = null, kb = null, session = '', box = { x: 0, y: 0, w: 0, h: 0 };
  let down = false;

  const send = (m) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); } catch (e) { /* gone */ } };

  /*
   * THE FRAME IS NOT THE ELEMENT. The canvas carries the cluster viewport at its own pixel size
   * (1280x800, or a phone-sized box) and is displayed at whatever CSS size Compose gave it, so every
   * coordinate has to be scaled or clicks land somewhere else entirely — further off the further
   * down the page you click, which is the confusing kind of wrong.
   */
  function at(ev) {
    const r = canvas.getBoundingClientRect();
    const sx = r.width ? (canvas.width / r.width) : 1;
    const sy = r.height ? (canvas.height / r.height) : 1;
    return { x: Math.round((ev.clientX - r.left) * sx), y: Math.round((ev.clientY - r.top) * sy) };
  }

  const mod = (ev) => ({ alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey });

  /*
   * A CANVAS DOES NOT RAISE A PHONE KEYBOARD. So a hidden input is focused when the server reports
   * that the click landed on something editable, and only then — focusing on every tap puts the
   * keyboard over half the page each time you scroll. Its own keystrokes are forwarded and never
   * allowed to accumulate, because the text lives in the remote page, not here.
   */
  function keyboard() {
    if (kb) return kb;
    kb = document.createElement('input');
    kb.setAttribute('autocomplete', 'off');
    kb.setAttribute('autocorrect', 'off');
    kb.setAttribute('autocapitalize', 'off');
    kb.setAttribute('spellcheck', 'false');
    Object.assign(kb.style, {
      position: 'fixed', left: '-9999px', top: '0', width: '1px', height: '1px', opacity: '0',
    });
    kb.addEventListener('keydown', onKeyDown);
    kb.addEventListener('keyup', onKeyUp);
    kb.addEventListener('paste', onPaste);
    /* Anything the field manages to collect is sent as text and then dropped. */
    kb.addEventListener('input', () => {
      const v = kb.value;
      if (v) { send({ t: 'paste', text: v }); kb.value = ''; }
    });
    document.body.appendChild(kb);
    return kb;
  }

  /* Keys the page needs and the browser would otherwise spend on itself (scrolling, focus moves). */
  const SWALLOW = {
    Tab: 1, Enter: 1, Backspace: 1, Delete: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    Home: 1, End: 1, PageUp: 1, PageDown: 1, ' ': 1, Escape: 1,
  };

  function onKeyDown(ev) {
    /* Leave the real shortcuts alone: copy, paste, reload, devtools, tab switching. */
    if (ev.ctrlKey || ev.metaKey) {
      if (ev.key === 'v' || ev.key === 'V') return;   // paste arrives as its own event
      if (ev.key === 'c' || ev.key === 'C' || ev.key === 'a' || ev.key === 'A') { /* fall through, relay it */ }
      else return;
    }
    if (SWALLOW[ev.key] || ev.key.length === 1) ev.preventDefault();
    send({ t: 'key', type: 'keyDown', key: ev.key, code: ev.code, mod: mod(ev) });
  }

  function onKeyUp(ev) {
    if (ev.ctrlKey || ev.metaKey) { if (!(ev.key === 'c' || ev.key === 'C' || ev.key === 'a' || ev.key === 'A')) return; }
    if (SWALLOW[ev.key] || ev.key.length === 1) ev.preventDefault();
    send({ t: 'key', type: 'keyUp', key: ev.key, code: ev.code, mod: mod(ev) });
  }

  function onPaste(ev) {
    const text = (ev.clipboardData || window.clipboardData) && (ev.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    ev.preventDefault();
    send({ t: 'paste', text: String(text).slice(0, 10000) });
  }

  function ensure() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'gbLiveView';
    canvas.tabIndex = 0;                      // focusable, so it can receive keystrokes at all
    Object.assign(canvas.style, {
      position: 'fixed', zIndex: '10', background: '#0e0f12', display: 'none',
      outline: 'none', cursor: 'default', touchAction: 'none',
    });

    canvas.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      canvas.focus();
      down = true;
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not fatal */ }
      const p = at(ev);
      send({ t: 'mouse', type: 'mousePressed', x: p.x, y: p.y, button: ev.button === 2 ? 'right' : (ev.button === 1 ? 'middle' : 'left'), clickCount: 1, mod: mod(ev) });
    });

    canvas.addEventListener('pointerup', (ev) => {
      ev.preventDefault();
      down = false;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* fine */ }
      const p = at(ev);
      send({ t: 'mouse', type: 'mouseReleased', x: p.x, y: p.y, button: ev.button === 2 ? 'right' : (ev.button === 1 ? 'middle' : 'left'), clickCount: 1, mod: mod(ev) });
    });

    /*
     * Moves are only sent while a button is down. A stream of hover events costs a round-trip each
     * and the page almost never needs them, but a drag is unusable without them.
     */
    canvas.addEventListener('pointermove', (ev) => {
      if (!down) return;
      const p = at(ev);
      send({ t: 'mouse', type: 'mouseMoved', x: p.x, y: p.y, button: 'left', mod: mod(ev) });
    });

    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = at(ev);
      send({ t: 'wheel', x: p.x, y: p.y, dx: ev.deltaX, dy: ev.deltaY, mod: mod(ev) });
    }, { passive: false });

    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('paste', onPaste);

    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d', { alpha: false });
  }

  function place() {
    if (!canvas) return;
    canvas.style.left = box.x + 'px'; canvas.style.top = box.y + 'px';
    canvas.style.width = box.w + 'px'; canvas.style.height = box.h + 'px';
  }

  function connect() {
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Ask the cluster to render at a mobile viewport sized to our box on a phone, so the watched page
    // shows its mobile layout and frames fit with no stretch (desktop browsers stay at 1280x800).
    let q = '/v1/live?session=' + encodeURIComponent(session);
    if (Math.min(window.innerWidth, window.innerHeight) < 820 && box.w > 0 && box.h > 0) {
      q += '&mobile=1&w=' + Math.round(box.w) + '&h=' + Math.round(box.h);
    }
    ws = new WebSocket(proto + '//' + location.host + q);
    ws.onmessage = async (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      /*
       * The server tells us whether the last click landed on something typable. Acting on it here,
       * while the tap's user activation is still live, is the only moment a browser will open a
       * phone keyboard at all.
       */
      if (m.t === 'focus') {
        const k = keyboard();
        if (m.editable) { try { k.focus({ preventScroll: true }); } catch (e) { k.focus(); } }
        else { try { k.blur(); canvas.focus(); } catch (e) { /* fine */ } }
        return;
      }
      if (m.t !== 'frame') return;
      try {
        const bin = atob(m.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
        ctx.drawImage(bmp, 0, 0); bmp.close();
      } catch (e) {}
    };
  }

  return {
    start: function (sess, x, y, w, h) { ensure(); session = sess; box = { x, y, w, h }; place(); canvas.style.display = 'block'; connect(); },
    resize: function (x, y, w, h) { box = { x, y, w, h }; place(); },
    stop: function () {
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      if (kb) { try { kb.blur(); } catch (e) {} }
      down = false;
      if (canvas) canvas.style.display = 'none';
    },
  };
})();
