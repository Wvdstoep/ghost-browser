/*
 * GB perceive/act — injected into every page. Idempotent. window.__gb.mark() numbers every visible
 * interactive element (set-of-mark), draws numbered badges over them (so a screenshot shows the numbers
 * for vision), and remembers them; click(i)/type(i,text) act on that same numbered list. Captures real
 * accessible labels (aria-label/title/alt) and strips icon-font glyphs, so icon-only buttons (Facebook,
 * etc.) read as "Menu"/"Your profile" instead of blank private-use glyphs.
 */
(function () {
  if (window.__gb) return;
  var PUA = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu; // icon-font private-use glyphs
  function vis(el) {
    var r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' &&
      parseFloat(s.opacity || '1') > 0.05 && r.bottom > 0 && r.right > 0 &&
      r.top < (innerHeight + 400) && r.left < (innerWidth + 40);
  }
  function label(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '')
      .trim().replace(/\s+/g, ' ').slice(0, 90);
  }
  function cleanText(el) {
    var t = (el.innerText || el.value || '').replace(PUA, '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 90);
  }
  /* COVERED IS NOT THERE. Measured 2026-11-10: with Google's profile editor open (a frame over the whole
   * screen) the search page under it still got numbers 1-36, drawn over the form, and a tap on one of them
   * hit the form instead. An element on screen is kept only when a tap on it would reach it: one of five
   * points on it must land on the element itself, inside it, or on something it sits in. */
  function reachable(el, r) {
    if (typeof document.elementFromPoint !== 'function') return true;
    var pts = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7]], onScreen = false;
    for (var k = 0; k < pts.length; k++) {
      var x = r.left + r.width * pts[k][0], y = r.top + r.height * pts[k][1];
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      onScreen = true;
      var t = document.elementFromPoint(x, y);
      if (!t || t === el || el.contains(t) || t.contains(el)) return true;
      if (t.tagName === 'LABEL' && (t.control === el || t.contains(el))) return true;
    }
    return !onScreen;   // below the fold: scrolling brings it up
  }
  function collect() {
    var sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],[role=combobox],[role=radio],[role=checkbox],[role=switch],[role=treeitem],[onclick],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
    var out = [], seen = new Set();
    document.querySelectorAll(sel).forEach(function (el) {
      if (seen.has(el) || !vis(el)) return;
      var r = el.getBoundingClientRect();
      if (!reachable(el, r)) return;
      var lab = label(el);
      var txt = cleanText(el) || lab || el.getAttribute('placeholder') || el.name || '';
      var href = el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 90) : '';
      out.push({ el: el, tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || ''),
        text: txt.slice(0, 90), label: lab, role: (el.getAttribute('role') || ''), href: href,
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
      seen.add(el);
    });
    return out;
  }
  function clearOverlay() { var c = document.getElementById('__gbmarks'); if (c) c.remove(); }
  /* A realistic tap: many SPA sites (Facebook) bind React handlers to pointer/mouse events, so a bare
   * el.click() does nothing. Dispatch the full sequence at the element's centre. */
  function tap(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect(); var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var o = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
    var seq = ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    seq.forEach(function (type) {
      try { var E = (type.indexOf('pointer') === 0 && window.PointerEvent) ? PointerEvent : MouseEvent; el.dispatchEvent(new E(type, o)); } catch (e) {}
    });
  }
  /* FRAMES. Forms a site keeps on another domain (Google's "Edit profile" lives in a frame of its own)
   * have their own document, which this script cannot reach from the top page. The app injects this same
   * script into every frame and talks to each one through its own channel (FrameBridge.kt); what the frame
   * cannot know is where it sits on the screen. The page above it tells it: geo() sends each visible frame
   * its box in top-page pixels, and a frame passes the sum on to the frames inside it. Only the frame's own
   * parent is listened to, and all it can say is a position. */
  var off = null;
  function postGeo(ox, oy) {
    var fs = document.querySelectorAll('iframe,frame'), n = 0;
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i], r = f.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0) continue;
      var s = getComputedStyle(f);
      if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') <= 0.05) continue;
      var x = ox + r.left + f.clientLeft + (parseFloat(s.paddingLeft) || 0);
      var y = oy + r.top + f.clientTop + (parseFloat(s.paddingTop) || 0);
      try { f.contentWindow.postMessage({ __gbgeo: 1, x: x, y: y }, '*'); n++; } catch (e) {}
    }
    return n;
  }
  if (window !== window.top) {
    window.addEventListener('message', function (e) {
      if (e.source !== window.parent || !e.data || e.data.__gbgeo !== 1) return;
      off = { x: +e.data.x || 0, y: +e.data.y || 0 };
      postGeo(off.x, off.y);
    });
  }
  function drawOverlay(els, base) {
    base = base || 0;
    clearOverlay();
    var c = document.createElement('div'); c.id = '__gbmarks';
    c.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none';
    els.forEach(function (o, i) {
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:' + o.x + 'px;top:' + o.y + 'px;width:' + o.w + 'px;height:' + o.h +
        'px;outline:1.5px solid rgba(82,206,103,.85);background:rgba(82,206,103,.06);pointer-events:none;box-sizing:border-box';
      var b = document.createElement('div');
      b.textContent = i + base;
      b.style.cssText = 'position:fixed;left:' + o.x + 'px;top:' + Math.max(0, o.y - 1) + 'px;transform:translateY(-100%);' +
        'background:#52CE67;color:#04140A;font:700 11px/1.2 monospace;padding:1px 4px;border-radius:4px 4px 4px 0;' +
        'box-shadow:0 0 0 1px #04140A;pointer-events:none;white-space:nowrap';
      c.appendChild(box); c.appendChild(b);
    });
    (document.body || document.documentElement).appendChild(c);
  }
  window.__gb = {
    _els: [],
    mark: function (draw, base) {
      this._els = collect();
      if (draw !== false) { try { drawOverlay(this._els, base); } catch (e) {} }
      return this._els.map(function (o, i) {
        return { i: i, tag: o.tag, type: o.type, text: o.text, label: o.label, role: o.role, href: o.href, x: o.x, y: o.y, w: o.w, h: o.h };
      });
    },
    clear: function () { clearOverlay(); return 'ok'; },
    click: function (i) {
      var o = this._els[i]; if (!o) return 'no-element';
      clearOverlay();
      tap(o.el);
      return 'ok';
    },
    /* Native-tap support. Synthetic events (tap above) are ignored by trusted-input sites (Facebook's
     * JS-onClick rows/buttons never fire), so the Android layer taps for real via a MotionEvent. These
     * return the element's on-screen CENTER in CSS px plus the viewport size, so the native side can
     * map CSS px -> View px (viewX = x * webWidthPx / iw). Scroll it into view first so it is tappable. */
    coords: function (i) {
      var o = this._els[i]; if (!o) return { err: 'no-element' };
      var el = o.el; try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      clearOverlay();
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), iw: window.innerWidth, ih: window.innerHeight };
    },
    coordsText: function (s, nth) {
      s = (s || '').toLowerCase().trim(); nth = nth || 0; if (!s) return { err: 'no-text' };
      var pref = 'a[href],button,[role=button],[role=link],[role=menuitem]';
      var pool = Array.from(document.querySelectorAll(pref)).concat(Array.from(document.querySelectorAll('div,span,li')));
      var hits = [];
      for (var i = 0; i < pool.length; i++) { var el = pool[i]; var r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue; var hay = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase(); if (hay.indexOf(s) > -1) hits.push(el); if (hits.length > nth + 4) break; }
      var el2 = hits[nth]; if (!el2) return { err: 'notfound' };
      var c = el2; for (var k = 0; k < 5 && c; k++) { if (c.tagName === 'A' || c.tagName === 'BUTTON' || (c.getAttribute && c.getAttribute('role') === 'button')) { el2 = c; break; } c = c.parentElement; }
      try { el2.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      clearOverlay();
      var rr = el2.getBoundingClientRect();
      return { x: Math.round(rr.left + rr.width / 2), y: Math.round(rr.top + rr.height / 2), iw: window.innerWidth, ih: window.innerHeight };
    },
    type: function (i, text) {
      var o = this._els[i]; if (!o) return 'no-element';
      clearOverlay();
      var el = o.el; try { el.focus(); } catch (e) {}
      if (el.isContentEditable) { el.textContent = text; }
      else {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) { d.set.call(el, text); } else { el.value = text; }
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    },
    /* A dialog (or a frame holding one) scrolls an inner box, not the window: when the window does not
     * move, scroll the scrollable box under the middle of the screen. */
    /* Before real keystrokes: focus the field and select what is in it, so the first key replaces it.
     * Returns how many characters were selected. */
    select: function (i) {
      var o = this._els[i]; if (!o) return -1;
      var el = o.el; try { el.focus(); } catch (e) {}
      if (el.isContentEditable) {
        var rg = document.createRange(); rg.selectNodeContents(el);
        var sl = window.getSelection(); sl.removeAllRanges(); sl.addRange(rg);
        return (el.textContent || '').length;
      }
      try { el.select(); } catch (e) {}
      return String(el.value || '').length;
    },
    /* What the field holds now (to check that the keystrokes landed). */
    value: function (i) {
      var o = this._els[i]; if (!o) return null;
      return o.el.isContentEditable ? (o.el.innerText || '') : String(o.el.value == null ? '' : o.el.value);
    },
    scroll: function (dy) {
      clearOverlay();
      var before = window.scrollY; window.scrollBy(0, dy);
      if (window.scrollY !== before) return 'ok';
      var el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        var s = getComputedStyle(el);
        if (/(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) {
          var t = el.scrollTop; el.scrollTop = t + dy; if (el.scrollTop !== t) return 'ok';
        }
      }
      return 'ok';
    },
    /* Top page: tell each visible frame where it is (see postGeo); returns the viewport the taps map to. */
    geo: function () { return { iw: window.innerWidth, ih: window.innerHeight, frames: postGeo(0, 0) }; },
    /* In a frame: where it sits in the top page (null until the page above said so) and its own size. */
    frame: function () { return { off: off, iw: window.innerWidth, ih: window.innerHeight, url: location.href }; },
    /* Has the page rendered meaningful content yet (vs a lazy-load skeleton)? Used to wait for settle. */
    ready: function () {
      try {
        var t = (document.body ? document.body.innerText : '').replace(/\s/g, '');
        return t.length > 150 || document.querySelectorAll('[role=article]').length > 0 || collect().length > 8;
      } catch (e) { return true; }
    },
    /* Click the element whose visible text / aria-label contains [s] (nth match, 0-based). Climbs to a
     * clickable ancestor — robust on sites that navigate by JS onclick with no <a href> (Facebook). */
    clickText: function (s, nth) {
      s = (s || '').toLowerCase().trim(); nth = nth || 0; if (!s) return 'no-text';
      var pref = 'a[href],button,[role=button],[role=link],[role=menuitem]';
      var pool = Array.from(document.querySelectorAll(pref)).concat(Array.from(document.querySelectorAll('div,span,li')));
      var hits = [];
      for (var i = 0; i < pool.length; i++) {
        var el = pool[i]; var r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
        var hay = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
        if (hay.indexOf(s) > -1) hits.push(el);
        if (hits.length > nth + 4) break;
      }
      var el2 = hits[nth]; if (!el2) return 'notfound';
      var c = el2; for (var k = 0; k < 5 && c; k++) { if (c.tagName === 'A' || c.tagName === 'BUTTON' || (c.getAttribute && c.getAttribute('role') === 'button')) { el2 = c; break; } c = c.parentElement; }
      clearOverlay();
      tap(el2);
      return 'ok';
    },
    text: function () {
      var c = document.getElementById('__gbmarks'); var d = c ? c.style.display : null; if (c) c.style.display = 'none';
      var t = (document.body ? document.body.innerText : '').slice(0, 200000);
      if (c) c.style.display = (d || '');
      return t;
    },
    /* Extract post-like text blocks from a feed (Facebook etc.). Runs via injected script, so it works
     * where page-CSP blocks eval and where body.innerText is empty (feed text lives in nested divs).
     * Heuristic: a block with real text that carries a post signal (comment/like count, a timestamp,
     * "·"), de-duplicated to the outermost container. This is how you READ a social feed on a node. */
    posts: function () {
      var sig = /opmerking|reacties|reactie|comment|vind-?ik-?leuk|\blike\b|geleden|·|\b\d+\s?(u|d|w|h|m)\b/i;
      var out = [], nodes = document.querySelectorAll('div,article,li');
      for (var i = 0; i < nodes.length && out.length < 30; i++) {
        var t = (nodes[i].innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length < 60 || t.length > 1500) continue;
        if (!sig.test(t)) continue;
        var dup = false;
        for (var j = 0; j < out.length; j++) { if (out[j].indexOf(t) > -1 || t.indexOf(out[j]) > -1) { if (t.length <= out[j].length) { dup = true; } else { out[j] = t; dup = true; } break; } }
        if (!dup) out.push(t);
      }
      return out;
    },
    info: function () { return { url: location.href, title: document.title, ready: document.readyState }; }
  };
})();
