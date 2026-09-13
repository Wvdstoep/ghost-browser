/**
 * live.js — the page as a live stream you can actually use.
 *
 * The first version of the console polled a screenshot every 1.5 seconds and offered a side panel
 * with a text box to type into. It worked in the sense that the bytes moved, and it was miserable:
 * you clicked a field on a picture, then reached for a different box in a different panel to type
 * into it, and nothing about that resembles using a browser. It also could not show you anything
 * that happens between frames — a dropdown opening, a hover state, a validation message that comes
 * and goes.
 *
 * This is the real thing, and it is how every hosted-browser product does it:
 *
 *   - CHROME DEVTOOLS PROTOCOL SCREENCAST. Chromium pushes a frame whenever the page actually
 *     changes, instead of us asking every N seconds and mostly re-fetching an identical picture.
 *     Idle pages cost nothing; busy pages look smooth.
 *   - RAW INPUT, RELAYED. Your mousedown, mouseup, move, wheel and keystrokes are dispatched into
 *     the page as real input events. You click the email field and type — no side panel, no form,
 *     no "click a field first".
 *
 * The keyboard is the fiddly part, and the detail that matters is small: a keyDown event carrying
 * `text` is what inserts a character — not a `char` event alongside it, and not a keyDown without
 * text. The first doubles every letter, the second types nothing at all, and both were shipped
 * here before this comment was.
 */

const WebSocket = require('ws');

/* Virtual key codes for the keys that are not just text. Without these, Enter, Tab, Backspace and
   the arrows do nothing at all — which is most of what a login form needs after the typing. */
const VK = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, CapsLock: 20, Escape: 27,
  ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46, Meta: 91,
};

const modifierBits = (m = {}) =>
  (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);

function attach({ server, pool, authorize, path = '/v1/live', logger = console }) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
    if (url.pathname !== path) return;   // leave other upgrades alone

    /*
     * Authorised BEFORE the socket is accepted. A WebSocket that is opened first and checked later
     * is a WebSocket that has already been opened.
     */
    const sessionId = url.searchParams.get('session');
    const who = authorize(req, url);
    if (!who) {
      logger.warn?.(`[live] refused: not signed in (session ${sessionId})`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy();
    }

    let session;
    try { session = pool.get(sessionId); } catch { session = null; }
    /* A key watches only its own sessions. The owner's console watches any session in this browser —
       a session opened by an organ's key refused her, which is the black viewport behind Watch. */
    if (!session || (session.owner !== who.owner && !who.console)) {
      /* The picture is the whole feature: a silent refusal here is indistinguishable from a broken
         browser, so the reason is written down even though the socket is about to be destroyed. */
      logger.warn?.(`[live] refused: ${session ? `session ${sessionId} belongs to ${session.owner}, not ${who.owner}` : `no session ${sessionId} (it may have expired)`}`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy();
    }
    logger.info?.(`[live] ${who.owner} is watching ${sessionId}${session.profile ? ` (profile "${session.profile}")` : ''}`);

    wss.handleUpgrade(req, socket, head, (ws) => stream(ws, session));
  });

  async function stream(ws, session) {
    /*
     * NOT destructured. A sign-in popup replaces session.page, and a screencast bound to the page
     * the session started with keeps happily streaming the form behind the popup — which is exactly
     * what made "Continue with Google" look like a dead button.
     */
    let page = session.page;
    let cdp = null;
    let closed = false;

    const bye = async () => {
      if (closed) return;
      closed = true;
      try { await cdp?.send('Page.stopScreencast'); } catch { /* page may be gone */ }
      try { await cdp?.detach(); } catch { /* already detached */ }
      try { ws.close(); } catch { /* already closed */ }
    };

    /* Everything below sends through whatever is currently bound, so a re-bind is invisible to it. */
    const startOn = async (target) => {
      page = target;
      /*
       * RAISE THE TAB FIRST. Chromium only PAINTS the front tab of a window, and a screencast of a
       * background one returns solid black frames — forever, at full frame rate, so nothing looks
       * broken from the server's side: the socket is up, frames flow, the page is fine, and a
       * screenshot of the very same page comes back correct (Playwright captures it another way).
       * That is the "live view stays black" report, and it happens whenever the session's page is
       * not the tab in front: a sign-in popup, a second tab a site opened, a profile that came back
       * with more than one page. Raising it costs nothing when it is already in front.
       */
      try { await page.bringToFront(); } catch { /* a page that will not raise still streams if it is alone */ }
      cdp = await session.context.newCDPSession(page);
      await cdp.send('Page.enable');
      // Static pages never emit a screencast frame until something paints; seed one screenshot
      // so the console is not left on a black canvas after connect.
      try {
        const shot = await cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: Number(process.env.SCREENCAST_QUALITY) || 60,
        });
        if (ws.readyState === WebSocket.OPEN && shot?.data) {
          const viewport = page.viewportSize?.() || {};
          ws.send(JSON.stringify({
            t: 'frame',
            data: shot.data,
            w: viewport.width,
            h: viewport.height,
          }));
        }
      } catch { /* capture can fail on a closing page; screencast still starts below */ }

      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        // 60 is the point where text is still crisp and a full-page frame stays well under 100 KB.
        quality: Number(process.env.SCREENCAST_QUALITY) || 60,
        maxWidth: 1280, maxHeight: 800,
        everyNthFrame: 1,
      });

      cdp.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
        /*
         * Acknowledge every frame, always. Chromium stops sending until the last one is acked, so a
         * missed ack does not drop a frame — it ends the stream, and the page appears to freeze.
         */
        try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch { /* stream ended */ }
        if (ws.readyState !== WebSocket.OPEN) return;
        // Backpressure: if the client is already behind, skip this frame rather than queueing more
        // of them. A stale frame delivered late is worse than a frame never sent.
        if (ws.bufferedAmount > 2_000_000) return;
        ws.send(JSON.stringify({ t: 'frame', data, w: metadata?.deviceWidth, h: metadata?.deviceHeight }));
      });

      const sendUrl = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'url', url: page.url() }));
        }
      };
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) sendUrl(); });
      sendUrl();
    };

    try {
      await startOn(session.page);

      /*
       * Watch for the page changing under us. A popup can appear at any moment — the person presses
       * "Continue with Google" and the browser opens a window this socket has never heard of. One
       * second is fast enough that it feels like the click did it.
       */
      const watch = setInterval(async () => {
        if (closed || !session.page || session.page === page) return;
        const next = session.page;
        try { await cdp?.send('Page.stopScreencast'); } catch { /* the old page may be gone */ }
        try { await cdp?.detach(); } catch { /* already detached */ }
        try {
          await startOn(next);
          logger.info?.(`[live] following the browser to ${next.url()}`);
        } catch (e) {
          logger.warn?.(`[live] could not follow to the new window: ${e.message}`);
        }
      }, 1000);
      ws.on('close', () => clearInterval(watch));
    } catch (e) {
      logger.warn?.(`[live] could not start: ${e.message}`);
      try { ws.send(JSON.stringify({ t: 'error', error: e.message })); } catch { /* gone */ }
      return bye();
    }

    ws.on('message', async (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      session.lastUsed = Date.now();   // driving the page by hand counts as activity
      try {
        if (m.t === 'mouse') {
          await cdp.send('Input.dispatchMouseEvent', {
            type: m.type,                       // mousePressed | mouseReleased | mouseMoved
            x: m.x, y: m.y,
            button: m.button || 'left',
            clickCount: m.clickCount ?? (m.type === 'mouseMoved' ? 0 : 1),
            modifiers: modifierBits(m.mod),
          });
          /*
           * DID THAT TAP LAND ON SOMETHING YOU CAN TYPE INTO?
           *
           * A phone will not raise its keyboard for a canvas, so the console focuses a hidden input
           * to catch it — but doing that on EVERY tap means the keyboard covers half the page each
           * time you scroll or click a link. So after a click completes, look at what the page now
           * has focused and tell the client: it raises the keyboard only for a real field, and puts
           * it away otherwise. The client acts while the tap's user-activation is still live, which
           * is the only window in which a browser will open the keyboard at all.
           */
          if (m.type === 'mouseReleased') {
            try {
              const r = await cdp.send('Runtime.evaluate', {
                expression: `(() => { const e = document.activeElement; if (!e) return false;
                  if (e.isContentEditable) return true;
                  const t = (e.tagName || '').toLowerCase();
                  if (t === 'textarea') return true;
                  if (t !== 'input') return false;
                  const ty = (e.type || 'text').toLowerCase();
                  return !['button','submit','reset','checkbox','radio','range','color','file','image','hidden'].includes(ty);
                })()`,
                returnByValue: true,
              });
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ t: 'focus', editable: !!(r && r.result && r.result.value) }));
              }
            } catch { /* a navigation mid-click is fine; the next tap will report */ }
          }
        } else if (m.t === 'wheel') {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.dx || 0, deltaY: m.dy || 0,
            modifiers: modifierBits(m.mod),
          });
        } else if (m.t === 'key') {
          const key = m.key;
          const printable = m.type === 'keyDown' && key && key.length === 1 && !m.mod?.ctrl && !m.mod?.meta;
          /*
           * A CHARACTER'S CODE POINT IS NOT ITS VIRTUAL KEY CODE.
           *
           * Deriving one from the other holds for letters and digits by coincidence — 'A' is 65 in
           * both — and is wrong for everything else, sometimes catastrophically. '.' is code point
           * 46, and virtual key 46 is DELETE: typing an email address dropped the dot and ate the
           * character after it, which is how "hobbyprodrone@gmail.com" arrived as
           * "hobbyprodrone@gmailcom".
           *
           * Punctuation gets 0. The `text` field is what inserts the character, and a zero key code
           * simply means "no particular key" rather than an actively wrong one.
           */
          const alnum = key && key.length === 1 && /[a-zA-Z0-9]/.test(key);
          const code = VK[key] ?? (alnum ? key.toUpperCase().charCodeAt(0) : 0);
          await cdp.send('Input.dispatchKeyEvent', {
            type: m.type,                       // keyDown | keyUp
            key, code: m.code, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
            /*
             * `text` is what makes the character appear. A keyDown carrying text inserts it; a
             * keyDown without text is just a key going down and moves nothing into the field.
             *
             * And that is the WHOLE story — there must be no separate `char` event alongside it.
             * Sending both was this file's first bug: every letter arrived twice, so typing "we"
             * produced "wee". A `char` event is only needed after `rawKeyDown`, which is not what
             * is sent here.
             */
            text: printable ? key : (key === 'Enter' ? '\r' : undefined),
            unmodifiedText: printable ? key : undefined,
            modifiers: modifierBits(m.mod),
          });
        } else if (m.t === 'paste' && typeof m.text === 'string') {
          await cdp.send('Input.insertText', { text: m.text.slice(0, 10000) });
        }
      } catch (e) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'error', error: e.message }));
      }
    });

    ws.on('close', bye);
    ws.on('error', bye);
  }

  return wss;
}

module.exports = { attach, VK };
