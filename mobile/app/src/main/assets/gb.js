/*
 * GB perceive/act — injected into every page. Idempotent (guards re-definition so the marked element
 * list survives repeated eval within a page). window.__gb.mark() numbers every visible interactive
 * element (set-of-mark) and remembers them; click(i)/type(i,text) act on that same numbered list, so
 * the backend can "see element 12, click 12" exactly like the server engine.
 */
(function () {
  if (window.__gb) return;
  function vis(el) {
    var r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' &&
      parseFloat(s.opacity || '1') > 0.05 && r.bottom > 0 && r.right > 0 &&
      r.top < (innerHeight + 400) && r.left < (innerWidth + 40);
  }
  function collect() {
    var sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[onclick],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
    var out = [], seen = new Set();
    document.querySelectorAll(sel).forEach(function (el) {
      if (seen.has(el) || !vis(el)) return;
      var r = el.getBoundingClientRect();
      var txt = (el.innerText || el.value || el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') || el.name || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 90);
      out.push({ el: el, tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || ''), text: txt,
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
      seen.add(el);
    });
    return out;
  }
  window.__gb = {
    _els: [],
    mark: function () {
      this._els = collect();
      return this._els.map(function (o, i) {
        return { i: i, tag: o.tag, type: o.type, text: o.text, x: o.x, y: o.y, w: o.w, h: o.h };
      });
    },
    click: function (i) {
      var o = this._els[i]; if (!o) return 'no-element';
      try { o.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      try { o.el.click(); } catch (e) { o.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
      return 'ok';
    },
    type: function (i, text) {
      var o = this._els[i]; if (!o) return 'no-element';
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
    scroll: function (dy) { window.scrollBy(0, dy); return 'ok'; },
    text: function () { return (document.body ? document.body.innerText : '').slice(0, 200000); },
    info: function () { return { url: location.href, title: document.title, ready: document.readyState }; }
  };
})();
