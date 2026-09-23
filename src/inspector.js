/**
 * pageInspector.js — Set-of-Mark (SoM) Page Analysis
 *
 * Extracts every interactive element from the live page, overlays numbered
 * bounding boxes directly in the DOM (so they appear in screenshots), then
 * returns a structured element map the agent uses to decide what to click.
 *
 * Flow: analyze() → inject labels → screenshot → strip labels → return
 */

const LABEL_CLASS = '__ghost_som_label';
const HIGHLIGHT_CLASS = '__ghost_som_highlight';

// CSS injected once per page
const SOM_STYLE = `
  .${LABEL_CLASS} {
    position: fixed !important;
    z-index: 2147483646 !important;
    pointer-events: none !important;
    background: rgba(124,58,237,0.92) !important;
    color: #fff !important;
    font: bold 10px/14px monospace !important;
    padding: 1px 4px !important;
    border-radius: 3px 3px 0 0 !important;
    white-space: nowrap !important;
    transform: translateY(-100%) !important;
  }
  .${HIGHLIGHT_CLASS} {
    position: fixed !important;
    z-index: 2147483645 !important;
    pointer-events: none !important;
    border: 2px solid rgba(124,58,237,0.8) !important;
    border-radius: 3px !important;
    background: rgba(124,58,237,0.08) !important;
  }
`;

// The extractor runs INSIDE each frame. It returns element boxes in that frame's own viewport
// coordinates; the caller translates them into top-page space by adding the frame's offset, so a
// coordinate click (page.mouse.click) lands correctly whether the element is in the main document
// or inside an iframe. This is what lets the agent read a logged-in dashboard SPA (Useme, and any
// app that renders its real content inside a frame) instead of seeing an empty shell.
const FRAME_EXTRACTOR = () => {
  // [role="option"] is the one that was missing and it matters a lot: every typeahead / autocomplete /
  // combobox renders its suggestions as role=option items inside a role=listbox. Without it, look()
  // showed the input but never the DROPDOWN — so a category/city/tag field that only accepts a PICKED
  // suggestion was unfillable, and a walk looped retyping into a field that would not commit. Seen
  // live: Facebook's page-create category. menuitemradio/checkbox and switch round out the ARIA
  // widgets a form can hang a required choice on.
  // `jsaction` is Google's own click-handler attribute — YouTube Studio, Gemini, Search and every
  // Google app hang their buttons off it, and those buttons are custom elements (ytcp-button, paper-
  // button…) with NO native <button>, role or onclick, so without this the reader saw "0 things to
  // click" on a fully interactive page. `[tabindex]:not([tabindex="-1"])` catches focusable custom
  // controls the same way. [role="option"] and the ARIA widgets stay for dropdowns/typeaheads.
  const TAGS = 'button, input:not([type=hidden]), textarea, select, a[href], [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="switch"], [role="tab"], [contenteditable="true"], [onclick], [jsaction], [tabindex]:not([tabindex="-1"])';
  // Collect matches from the light DOM AND every open shadow root (web-component apps render their
  // controls inside shadow trees that a plain querySelectorAll never sees). ALSO collect anything the
  // page styles as clickable (cursor:pointer) at control size — the one signal a custom button always
  // carries even when it has no tag, role, or attribute the selector can name. Bounded so a
  // pathological page cannot hang the walk.
  /*
   * WHEN A DIALOG IS OPEN, THE DIALOG IS THE PAGE.
   *
   * Measured, live, on the cover-photo flow: the walk clicked "Wijzigen", Facebook opened its editor
   * over the page, and the read came back "48 things to click" — of which the dialog's own controls
   * were almost none. The numbers went on what was BEHIND the modal: the left rail, the tabs, the
   * composer, the page chrome, all of it sorted first in reading order and all of it inert. The only
   * thing inside the dialog the reader did surface was "Annuleren", so the walk cancelled, reopened,
   * cancelled again, and looped.
   *
   * The cap is 90 and Facebook's manage view spends it before it reaches the middle of the screen,
   * which is exactly where a centred modal lives. Raising the cap would not fix it either: the
   * background is not merely lower priority, it is UNCLICKABLE while a modal is up. A browser knows
   * that, a person knows it, and the accessibility tree says it outright by marking the rest hidden.
   * So the reader now says it too.
   *
   * The scope is the topmost modal PLUS any popup layer that opened after it — a select's listbox or
   * a menu is routinely rendered in a portal at the end of <body>, outside the dialog it belongs to,
   * and scoping strictly to the dialog subtree would hide exactly the dropdown the walk needs.
   */
  const modalScope = () => {
    let cands;
    try {
      cands = [...document.querySelectorAll('[aria-modal="true"], dialog[open], [role="dialog"], [role="alertdialog"]')];
    } catch { return null; }
    const open = cands.filter((d) => {
      try {
        if (d.closest('[aria-hidden="true"],[inert]')) return false;
        if (d.getAttribute('aria-hidden') === 'true') return false;
        const st = getComputedStyle(d);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        /*
         * A DIALOG THAT IS BUILT BUT NOT SHOWN MUST NOT BECOME THE PAGE.
         *
         * display and visibility were the only two ways of being hidden this knew about, and a
         * single-page app has several more. Search Console keeps its panels in the document and
         * hides them with opacity, or parks them outside the window — so every read of the
         * performance report came back as "Verwijderingen — 14 things to click (inside the open
         * dialog)". The walk opened the right address, was told a Removals dialog covered it, closed
         * a dialog that was not there, looked again, and got the same answer. Twenty steps of a loop
         * with nothing wrong on the screen at all.
         *
         * Three cheap tests close it: a thing faded out is not shown; a thing outside the window is
         * not covering anything; and a thing that cannot be clicked where it sits is not in front.
         */
        if (Number(st.opacity) === 0) return false;
        if (st.pointerEvents === 'none') return false;
        const r = d.getBoundingClientRect();
        /* A real dialog is a panel. This size floor keeps out the tooltip-sized things Facebook also
           labels role="dialog", which must never blind the walk to the rest of the page. */
        if (r.width < 200 || r.height < 120) return false;
        const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
        if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
        /*
         * THE DECIDING TEST: is it actually in front? A modal covers the page, so the point at its
         * centre belongs to it. Only a definite answer naming something ELSE excludes it — when the
         * browser cannot say (a null, a cross-origin frame), the dialog is kept, because wrongly
         * ignoring a real modal is how the walk went blind on Facebook in the first place.
         */
        const cx = Math.min(Math.max((r.left + r.right) / 2, 1), vw - 1);
        const cy = Math.min(Math.max((r.top + r.bottom) / 2, 1), vh - 1);
        const at = document.elementFromPoint(cx, cy);
        if (at && at !== d && !d.contains(at) && !at.contains(d)) return false;
        /*
         * ── AND A NAVIGATION DRAWER IS NOT A MODAL ──────────────────────────────────────────────
         *
         * Every test above asks "is this thing visible and in front", and a permanent left-hand
         * navigation passes all of them: it is on screen, opaque, clickable, and comfortably bigger
         * than the size floor. Search Console's nav carries a dialog role, so the reader kept
         * answering "a dialog is open — 14 things to click", handed the walk the fourteen nav links,
         * and hid the report it was standing on. Three separate walks then spent 130, 159 and 166
         * steps trying to close a drawer that was never covering anything.
         *
         * The question that actually separates them is not whether it is visible but whether it has
         * TAKEN OVER: a modal makes the rest of the page unreachable, and a drawer leaves it exactly
         * where it was. The platform says so in two ways that mean it beyond doubt — aria-modal, and
         * a <dialog> opened as a modal — and anything else has to prove it by the page behind it
         * actually being inert. A role alone proves nothing; it is the most-guessed-at attribute on
         * the web.
         */
        const declared = d.getAttribute('aria-modal') === 'true'
          || (d.tagName === 'DIALOG' && d.hasAttribute('open'));
        if (!declared) {
          const main = document.querySelector('main,[role="main"]');
          const blocked = main
            ? !!main.closest('[aria-hidden="true"],[inert]')
            : !!document.querySelector('body > [aria-hidden="true"], body > [inert]');
          if (!blocked) return false;
        }
        return true;
      } catch { return false; }
    });
    if (!open.length) return null;
    /* Last in document order is the topmost: overlays are appended, and a dialog opened from inside
       another dialog comes after it. */
    const top = open[open.length - 1];
    const after = [];
    try {
      for (const m of document.querySelectorAll('[role="menu"],[role="listbox"],[role="tree"],[role="grid"],[role="tooltip"]')) {
        if (top.contains(m)) continue;
        // eslint-disable-next-line no-bitwise
        if (top.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) after.push(m);
      }
    } catch { /* a portal we cannot walk is simply not added */ }
    return [top, ...after];
  };

  const deepQuery = (sel, scope) => {
    const roots = scope && scope.length ? [...scope] : [document];
    const found = new Set();
    let guard = 0;
    for (let i = 0; i < roots.length && guard < 20000; i++) {
      const root = roots[i];
      let all;
      try { all = root.querySelectorAll('*'); } catch { continue; }
      try { for (const m of root.querySelectorAll(sel)) found.add(m); } catch { /* ignore bad root */ }
      /* A scope root can itself be a control (a role=menu that is also the clickable). querySelectorAll
         never returns the root it is called on, so it is offered separately. */
      try { if (root !== document && root.matches && root.matches(sel)) found.add(root); } catch { /* not an element */ }
      for (const el of all) {
        guard++;
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (found.has(el)) continue;
        // cursor:pointer heuristic — a custom button always carries it. Bounded to control-sized
        // elements so a giant clickable panel or a 1px sliver does not flood the list.
        let cur = '';
        try { cur = getComputedStyle(el).cursor; } catch { /* detached / cross-origin */ }
        if (cur === 'pointer') {
          const r = el.getBoundingClientRect();
          if (r.width >= 8 && r.height >= 8 && r.width <= 680 && r.height <= 260) found.add(el);
        }
      }
    }
    return [...found];
  };
  const scope = modalScope();
  const out = [];
  for (const el of deepQuery(TAGS, scope)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const testId = el.getAttribute('data-testid');
    const ariaLabel = el.getAttribute('aria-label') || '';
    const id = el.id ? `#${el.id}` : null;
    const selector = id || (testId ? `[data-testid="${testId}"]` : null);
    const text = (
      el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') ||
      el.value || el.textContent || el.getAttribute('name') || ''
    ).trim().replace(/\s+/g, ' ').slice(0, 60);
    // Is this a place text can be TYPED? A rich-text "O mnie" editor is a contenteditable <div> that
    // otherwise looks like any other element — marking it is what lets the agent find where to type
    // instead of clicking around it forever.
    const editable = !!(
      el.isContentEditable ||
      el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && /^(text|email|search|url|tel|number|password|)$/i.test(el.type || '')) ||
      el.getAttribute('role') === 'textbox'
    );
    // Is this control currently ON? Checkbox/radio checked, or an ARIA-selected/pressed/checked
    // widget, or a custom toggle whose class says selected/active. A category picker, a tabs row, a
    // multi-select — all are unusable blind to state: the agent must SEE what it has already picked,
    // or it re-toggles things off and never knows when it is done. Same idea as the ✎ FIELD marker,
    // for the other big family of widgets.
    const cls = typeof el.className === 'string' ? el.className : '';
    const on = !!(
      el.checked === true ||
      el.getAttribute('aria-checked') === 'true' ||
      el.getAttribute('aria-selected') === 'true' ||
      el.getAttribute('aria-pressed') === 'true' ||
      /(?:^|\s)(?:selected|active|checked|is-selected|is-active|is-checked)(?:\s|$)/.test(cls)
    );
    out.push({
      tag: el.tagName.toLowerCase(), type: el.type || null, id: el.id || null, selector, ariaLabel,
      placeholder: el.placeholder || null, role: el.getAttribute('role') || null, text, editable, on,
      href: el.tagName === 'A' ? el.getAttribute('href') : null,
      left: r.left, top: r.top, width: r.width, height: r.height,
    });
  }
  /* The caller needs to know this happened: "12 things to click" on a page that plainly has fifty is
     alarming unless it is also told a dialog is open and these are the dialog's. */
  return { elements: out, modal: !!scope, title: scope ? (scope[0].getAttribute('aria-label') || (scope[0].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)) : '' };
};

/**
 * Extract visible interactive elements across the main document AND every reachable child frame,
 * returned in top-page coordinates, ordered top-left → bottom-right, viewport-clipped, capped at 90
 * with primary action buttons (Generate/Publish/Download…) and text fields ALWAYS kept.
 */
async function extractElements(page) {
  const main = page.mainFrame();
  const collected = [];
  let modal = null;                 // the dialog that owns the screen, if one does
  for (const frame of page.frames()) {
    let ox = 0, oy = 0;
    if (frame !== main) {
      // The frame's position in the top page = the bounding box of the <iframe> that hosts it.
      // Cross-origin frames throw on evaluate/frameElement — skip them rather than fail the whole read.
      try {
        const fe = await frame.frameElement();
        const box = fe && await fe.boundingBox();
        if (!box) continue;
        ox = box.x; oy = box.y;
      } catch { continue; }
    }
    let got;
    try { got = await frame.evaluate(FRAME_EXTRACTOR); } catch { continue; }
    /* A frame that has a modal open owns the screen; the first one found wins, and the main document
       is read first, so a page-level dialog beats one inside an advert frame. */
    if (got && got.modal && !modal) modal = { title: got.title || '' };
    /* A bare list is still a list. The extractor returns { elements, modal } now; tolerating the old
       shape costs one branch and means a frame that answers either way is read, never dropped. */
    const raw = Array.isArray(got) ? got : ((got && got.elements) || []);
    for (const e of raw) {
      collected.push({
        tag: e.tag, type: e.type, id: e.id, selector: e.selector, ariaLabel: e.ariaLabel,
        placeholder: e.placeholder, role: e.role, text: e.text, href: e.href,
        editable: e.editable, // CARRY THIS THROUGH — dropping it here is what blinded the agent to
        //                       every text field: the ✎ FIELD marker is built from it downstream.
        on: e.on,             // selection/toggle state — the ✓ marker, same reason: carry it through.
        left: Math.round(e.left + ox), top: Math.round(e.top + oy),
        width: Math.round(e.width), height: Math.round(e.height),
        x: Math.round(e.left + ox + e.width / 2), y: Math.round(e.top + oy + e.height / 2),
        visible: true,
      });
    }
  }

  // Clip to the top-page viewport (in top-page coordinates) and keep the reading order.
  const vw = await page.evaluate(() => window.innerWidth).catch(() => 1280);
  const vh = await page.evaluate(() => window.innerHeight).catch(() => 800);
  const inView = (e) => !(e.top + e.height < 0 || e.top > vh || e.left + e.width < 0 || e.left > vw);
  const sized = collected.filter((e) => e.width >= 2 && e.height >= 2);
  const bySpot = (a, b) => (a.top !== b.top ? a.top - b.top : a.left - b.left);
  // EDITABLE fields are kept even when OFF-SCREEN — a long form (Useme's offer form) scrolls its
  // message box out of view, and if the reader hides it the agent scroll-hunts forever and never
  // types. The click path scrolls an off-screen field into view before clicking. Everything else
  // must be in the viewport to be a valid coordinate click target. The cap never drops a field.
  const fields = sized.filter((e) => e.editable).sort(bySpot);
  // PRIMARY ACTIONS (Generate / Publish / Publiceren / Download / Save / Continue …) get the SAME
  // protection as fields: never dropped by the cap. This is the fix for the "60 things to click"
  // loop — a page's main CTA is almost always a bottom-right or sticky button that sorts LAST in
  // reading order, so a plain top-left cap sliced off the ONE button the agent came to click, and
  // it looped forever while a human saw Generate/Publiceren plainly (ElevenLabs, YouTube Studio).
  // Proven the cap, not the model: glm AND a stronger model both typed then failed to click the
  // exact same missing button. The cap is also raised 60 → 90 so dense SPAs (big left nav + several
  // toolbars + card grids) keep their real controls instead of burning the budget on chrome.
  const CAP = 90;
  const ACTION_WORDS = new Set(['generate', 'publish', 'publiceren', 'post', 'share', 'delen',
    'download', 'save', 'opslaan', 'submit', 'verzenden', 'send', 'verstuur', 'continue', 'doorgaan',
    'next', 'volgende', 'create', 'maak', 'done', 'klaar', 'gereed', 'confirm', 'bevestig', 'apply',
    'toepassen', 'export', 'upload', 'finish', 'voltooien', 'render', 'convert', 'accept', 'accepteren',
    // "run" (AI Studio / Colab), "play"/"speak" (a TTS preview), "start"/"begin" — the same decisive
    // control under a different name. Kept short-labelled so a paragraph never matches.
    'run', 'play', 'speak', 'start', 'begin',
    // JOIN / FOLLOW / CONNECT — the commit control that REPEATS down a LIST. A Facebook groups search
    // is a page of "Lid worden" buttons, LinkedIn is rows of "Connect", a feed is rows of "Volgen".
    // These sort LATE and repeat, so a plain top-left cap (filled first by the left nav + filters) kept
    // only the FIRST row's button — the rest were unmarked, so the agent could not click them and
    // kept RE-SEARCHING instead of joining the groups already in view. As actions they are ALL kept
    // (and kept off-screen), so the agent can batch-join a whole results page in one pass.
    'join', 'deelnemen', 'lid', 'worden', 'follow', 'volgen', 'volg', 'connect', 'subscribe',
    'abonneren', 'request', 'aanvragen']);
  const isAction = (e) => {
    if (e.editable) return false;
    // An input the page styles as a submit/button IS the submit, whatever it is labelled.
    if (e.tag === 'input' && (e.type === 'submit' || e.type === 'button')) return true;
    const w = String(e.text || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
    return w.length > 0 && w.length <= 4 && w.some((x) => ACTION_WORDS.has(x));
  };
  // Actions are kept even OFF-SCREEN, exactly like fields — this is what closes the whole "can type
  // but can't submit" class. v163 stopped the CAP from dropping the one button a walk exists to click;
  // but a SCROLL still dropped it: AI Studio's Run is top-right and leaves the viewport the instant the
  // page scrolls, a sticky-footer Publish / a Generate below the fold are off-screen from the start —
  // and an inView-only action tier hid every one of them. The click path (bringIntoView in agent.js)
  // scrolls any listed target to mid-viewport before clicking, so an off-screen coordinate is fine.
  // Only NON-action clickables still require inView (a coordinate click needs a real on-screen point).
  // COLLAPSE NESTED DUPLICATES. A single control is usually a stack of elements — the <a>/role=button
  // wrapper AND its inner spans — and once join/CTA words are actions, ALL of them qualify, so ONE
  // "Lid worden" button drew ~5 numbered boxes. That clutters the overlay AND makes the agent click
  // the same button several times (it read five indices as five groups → dozens of phantom joins). So
  // within a cluster of heavily-overlapping boxes keep only the LARGEST (the real clickable wrapper),
  // giving one control = one number. Distinct controls sit apart and never overlap enough to merge.
  const overlapFrac = (a, b) => {
    const ix = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
    const iy = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
    const small = Math.min(a.width * a.height, b.width * b.height);
    return small > 0 ? (ix * iy) / small : 0;
  };
  // 0.85 = a child essentially INSIDE its parent (inner span within the button wrapper → ~1.0 of the
  // small box is covered), which is exactly the nesting we want to collapse. Distinct-but-adjacent
  // controls only partially overlap and stay separate.
  /*
   * A STACK AND A LIST LOOK IDENTICAL TO THE RULE ABOVE, AND THEY ARE OPPOSITES.
   *
   * Keeping the largest box is right for ONE control drawn as several — the <a> wrapper and its
   * inner spans all cover the same place, and numbering each drew five boxes for one button.
   *
   * It is exactly wrong for several controls inside one box. overlapFrac divides by the SMALLER
   * area, so a card sitting inside a panel scores ~1.0 and is dropped in favour of the panel.
   * Measured on Google Maps: look() returned six elements and the fifth was a single div holding
   * every search result concatenated — "Hydraulik Wrocław -Pogotowie Hydrauliczne WrocławHydraulik
   * W…". The agent could not click any one plumber, looked three times, and was forced to act by
   * the observe limiter.
   *
   * Two conditions separate them, and both are needed. An icon and a label inside one button do not
   * overlap each other either, so "children that sit apart" alone would split every button in two:
   *
   *   THREE OR MORE children that do not overlap one another — a stack has one place, a list has
   *     several, and two is the ordinary icon-plus-label button.
   *   THE PARENT IS MUCH BIGGER THAN ANY CHILD — a button wrapper is barely larger than its label,
   *     while a panel of five results is several times one card.
   */
  const looksLikeAList = (parent, kids) => {
    const distinct = [];
    for (const c of kids) if (!distinct.some((d) => overlapFrac(c, d) > 0.4)) distinct.push(c);
    if (distinct.length < 3) return null;
    const biggest = Math.max(...distinct.map((c) => c.width * c.height));
    if (biggest <= 0 || (parent.width * parent.height) < biggest * 3) return null;
    return distinct;
  };

  const dedupe = (list) => {
    const kept = [];
    const swallowed = new Map();   // index in `kept` -> the boxes it absorbed
    for (const e of [...list].sort((a, b) => (b.width * b.height) - (a.width * a.height))) {
      const at = kept.findIndex((k) => overlapFrac(e, k) > 0.85);
      if (at < 0) { kept.push(e); continue; }
      if (!swallowed.has(at)) swallowed.set(at, []);
      swallowed.get(at).push(e);
    }
    const out = [];
    kept.forEach((k, i) => {
      const kids = looksLikeAList(k, swallowed.get(i) || []);
      /* A container of distinct controls hands back its children; anything else stays one control. */
      if (kids) out.push(...kids); else out.push(k);
    });
    return out;
  };
  const actions = dedupe(sized.filter((e) => isAction(e))).sort(bySpot);
  // rest excludes EVERY action (not just the kept ones) so a de-duped inner span cannot leak back in.
  const rest = dedupe(sized.filter((e) => !e.editable && !isAction(e) && inView(e))).sort(bySpot)
    .slice(0, Math.max(0, CAP - fields.length - actions.length));
  const listed = [...fields, ...actions, ...rest].sort(bySpot).map((el, i) => ({ ...el, index: i + 1 }));
  /* Carried on the array rather than changing the return type: every caller reads it as a list, and
     one that does not care about the dialog must keep working untouched. */
  if (modal) { listed.modal = true; listed.modalTitle = modal.title || ''; }
  return listed;
}

/**
 * Give a freshly navigated page a moment to settle before it is read: wait for the network to go
 * quiet (bounded — some apps long-poll forever) then a short beat for the framework to paint. Reading
 * on `domcontentloaded` alone hands the agent an un-hydrated shell, which is why an SPA looked empty.
 */
async function settle(page, ms = 700) {
  try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch { /* long-poll apps never idle */ }
  try { await page.waitForTimeout(ms); } catch { /* page may have navigated */ }
}

/**
 * Inject numbered SoM labels + highlight boxes over every element.
 * These appear in the Playwright screenshot.
 */
async function injectAnnotations(page, elements) {
  await page.evaluate(({ elements, labelClass, highlightClass, style }) => {
    // Inject stylesheet once
    if (!document.getElementById('__ghost_som_style')) {
      const s = document.createElement('style');
      s.id = '__ghost_som_style';
      s.textContent = style;
      document.head?.appendChild(s);
    }

    // Remove stale annotations
    document.querySelectorAll(`.${labelClass},.${highlightClass}`).forEach(e => e.remove());

    elements.forEach(el => {
      // Highlight box
      const box = document.createElement('div');
      box.className = highlightClass;
      box.style.left   = el.left + 'px';
      box.style.top    = el.top  + 'px';
      box.style.width  = el.width  + 'px';
      box.style.height = el.height + 'px';
      document.documentElement.appendChild(box);

      // Number label
      const label = document.createElement('div');
      label.className = labelClass;
      label.textContent = el.index;
      label.style.left = el.left + 'px';
      label.style.top  = el.top  + 'px';
      document.documentElement.appendChild(label);
    });
  }, { elements, labelClass: LABEL_CLASS, highlightClass: HIGHLIGHT_CLASS, style: SOM_STYLE });
}

/**
 * Dismiss a cookie / consent banner if one is covering the page. These overlay the BOTTOM (or a
 * modal over everything) — exactly where a page's primary CTA lives — so even a correctly-listed
 * Run/Publish/Generate button has a consent bar sitting ON TOP of its coordinates, and the click
 * lands on the banner instead. This is the THIRD cause of the "can type but can't submit" class
 * (after the cap and off-screen). Once accepted the cookie is set and it never returns, so this is a
 * cheap no-op on every later look. Tightly scoped: only an EXACT known consent phrase is clicked, so
 * it can never fire on a real content button. Runs across the main frame + child frames (many CMPs
 * render inside an iframe). Returns the phrase clicked, or null.
 */
async function dismissConsent(page) {
  const CLICKER = () => {
    const PHRASES = new Set(['ok, got it', 'ok got it', 'got it', 'accept all', 'accept all cookies',
      'accept', 'i accept', 'i agree', 'agree', 'allow all', 'alle accepteren', 'accepteren',
      'alles accepteren', 'akkoord', 'ik ga akkoord', 'tout accepter', 'accepter', 'j\'accepte',
      'alle akzeptieren', 'zustimmen', 'akzeptieren', 'aceptar', 'aceptar todo', 'entendido',
      // Polish — useme.pl's banner ('Akceptuję') cost a scout 86 steps because none of these were here.
      'akceptuję', 'akceptuj', 'akceptuj wszystkie', 'akceptuj wszystko', 'zaakceptuj', 'zaakceptuj wszystkie', 'zaakceptuj wszystko',
      'zgadzam się', 'zgoda', 'rozumiem', 'przejdź do serwisu', 'przejdź do strony',
      // Czech / Slovak, Italian, Portuguese, Nordic, Finnish — the markets the company ships apps into.
      'přijmout vše', 'přijmout', 'souhlasím', 'prijať všetko', 'súhlasím',
      'accetta tutto', 'accetta', 'accetto', 'aceitar tudo', 'aceitar', 'concordo',
      'acceptera alla', 'godkänn alla', 'godkänn', 'accepter alle', 'godta alle', 'tillad alle', 'hyväksy kaikki', 'hyväksy']);
    const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
    for (const b of document.querySelectorAll('button, [role="button"], a')) {
      if (!PHRASES.has(norm(b.textContent))) continue;
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { try { b.click(); return norm(b.textContent); } catch { /* keep looking */ } }
    }
    return null;
  };
  try {
    for (const f of page.frames()) {
      let hit = null;
      try { hit = await f.evaluate(CLICKER); } catch { continue; }
      if (hit) return hit;
    }
  } catch { /* never fatal — a missing banner is the normal case */ }
  return null;
}

/** Remove all SoM annotations from the page */
async function stripAnnotations(page) {
  await page.evaluate(({ lc, hc }) => {
    document.querySelectorAll(`.${lc},.${hc}`).forEach(e => e.remove());
  }, { lc: LABEL_CLASS, hc: HIGHLIGHT_CLASS }).catch(() => {});
}

/**
 * Main entry point.
 * Returns { elements, screenshot } where screenshot is a base64 JPEG
 * with numbered bounding boxes drawn over every interactive element.
 */
async function analyzePage(page) {
  // Clear an overlaying cookie/consent banner FIRST — otherwise it sits on top of the page's main
  // button and every click lands on the banner. No-op once the profile has accepted (cookie is set).
  await dismissConsent(page);

  // Extract elements
  const elements = await extractElements(page);

  // Annotate page
  await injectAnnotations(page, elements);

  // Screenshot WITH annotations
  let screenshot = null;
  try {
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: 82,
      clip: { x: 0, y: 0, width: 1280, height: 800 }
    });
    screenshot = buf.toString('base64');
  } catch {
    // headed mode with viewport:null — try without clip
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 82 });
      screenshot = buf.toString('base64');
    } catch {}
  }

  // Strip annotations so they don't interfere with user interaction
  await stripAnnotations(page);

  // Build compact summary for text LLMs. Editable fields are called out with a ✎ marker and an
  // explicit "type here" so the model reaches for type() rather than clicking a text box.
  /*
   * SAY THAT A DIALOG OWNS THE SCREEN. Without this line a read that drops from 50 controls to 12
   * looks like a broken page, and the walk's next move is to go looking for what it "lost" — which
   * is precisely the loop this fixes: open the cover editor, fail to see it, press Annuleren.
   */
  const head = elements.modal
    ? `A DIALOG IS OPEN${elements.modalTitle ? ` ("${elements.modalTitle}")` : ''} and it owns the screen. Everything listed below is INSIDE it — the page behind it cannot be clicked while it is up, which is why there are fewer things than usual. Finish here, or close it, before looking for anything else.
`
    : '';
  const summary = head + elements.map(e =>
    `[${e.index}] ${e.on ? '✓ ' : ''}${e.editable ? '✎ FIELD' : e.tag}${e.type ? `[${e.type}]` : ''} — "${e.text || e.placeholder || e.ariaLabel || '(no label)'}"${e.on ? ' (SELECTED)' : ''}${e.editable ? ` ← a text field; type here with type([${e.index}], "...")` : ''}${e.selector ? ` (${e.selector})` : ''} @ (${e.x},${e.y})`
  ).join('\n');

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    elementCount: elements.length,
    modal: !!elements.modal, modalTitle: elements.modalTitle || '',
    elements,     // full structured list
    summary,      // compact text for LLM context
    screenshot    // base64 JPEG with SoM boxes
  };
}

/**
 * Click a specific element by its SoM index number.
 * Fetches fresh bounding box (element may have moved since analysis).
 */
async function clickByIndex(page, index, elements) {
  const el = elements.find(e => e.index === index);
  if (!el) throw new Error(`Element [${index}] not found in last analysis. Call analyze_page first.`);
  return { x: el.x, y: el.y, text: el.text, selector: el.selector };
}

module.exports = { analyzePage, extractElements, dismissConsent, clickByIndex, stripAnnotations, settle };
