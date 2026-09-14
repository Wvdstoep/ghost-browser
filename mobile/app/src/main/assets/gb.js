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
  function collect() {
    var sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[onclick],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
    var out = [], seen = new Set();
    document.querySelectorAll(sel).forEach(function (el) {
      if (seen.has(el) || !vis(el)) return;
      var r = el.getBoundingClientRect();
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
  function drawOverlay(els) {
    clearOverlay();
    var c = document.createElement('div'); c.id = '__gbmarks';
    c.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none';
    els.forEach(function (o, i) {
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:' + o.x + 'px;top:' + o.y + 'px;width:' + o.w + 'px;height:' + o.h +
        'px;outline:1.5px solid rgba(82,206,103,.85);background:rgba(82,206,103,.06);pointer-events:none;box-sizing:border-box';
      var b = document.createElement('div');
      b.textContent = i;
      b.style.cssText = 'position:fixed;left:' + o.x + 'px;top:' + Math.max(0, o.y - 1) + 'px;transform:translateY(-100%);' +
        'background:#52CE67;color:#04140A;font:700 11px/1.2 monospace;padding:1px 4px;border-radius:4px 4px 4px 0;' +
        'box-shadow:0 0 0 1px #04140A;pointer-events:none;white-space:nowrap';
      c.appendChild(box); c.appendChild(b);
    });
    (document.body || document.documentElement).appendChild(c);
  }
  window.__gb = {
    _els: [],
    mark: function (draw) {
      this._els = collect();
      if (draw !== false) { try { drawOverlay(this._els); } catch (e) {} }
      return this._els.map(function (o, i) {
        return { i: i, tag: o.tag, type: o.type, text: o.text, label: o.label, role: o.role, href: o.href, x: o.x, y: o.y, w: o.w, h: o.h };
      });
    },
    clear: function () { clearOverlay(); return 'ok'; },
    click: function (i) {
      var o = this._els[i]; if (!o) return 'no-element';
      clearOverlay();
      try { o.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      try { o.el.click(); } catch (e) { o.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
      return 'ok';
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
    scroll: function (dy) { clearOverlay(); window.scrollBy(0, dy); return 'ok'; },
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
      try { el2.scrollIntoView({ block: 'center' }); } catch (e) {}
      try { el2.click(); } catch (e) { el2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
      return 'ok';
    },
    text: function () {
      var c = document.getElementById('__gbmarks'); var d = c ? c.style.display : null; if (c) c.style.display = 'none';
      var t = (document.body ? document.body.innerText : '').slice(0, 200000);
      if (c) c.style.display = (d || '');
      return t;
    },
    info: function () { return { url: location.href, title: document.title, ready: document.readyState }; }
  };
})();
