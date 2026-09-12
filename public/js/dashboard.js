(function () {
  const el = (id) => document.getElementById(id);
  const dash = el('dash');
  if (!dash) return;

  // Fixed catalog: each platform in its real brand colour + logo-mark and its home site.
  const PLAT = [
    { id:'facebook',    name:'Facebook',     mark:'f',  brand:'#1877f2', url:'facebook.com',    keys:['facebook','fb'] },
    { id:'google',      name:'Google',       mark:'G',  brand:'#c9433b', url:'google.com',      keys:['google'] },
    { id:'linkedin',    name:'LinkedIn',     mark:'in', brand:'#0a66c2', url:'linkedin.com',    keys:['linkedin'], monoLo:true },
    { id:'reddit',      name:'Reddit',       mark:'R',  brand:'#ff4500', url:'reddit.com',      keys:['reddit'] },
    // The growth desk's rooms — Herald posts and replies here as the owner, so each needs its own sign-in.
    { id:'hn',          name:'Hacker News',  mark:'Y',  brand:'#ff6600', url:'news.ycombinator.com', keys:['ycombinator','hackernews','hacker news'] },
    { id:'indiehackers',name:'Indie Hackers',mark:'IH', brand:'#0e2439', url:'indiehackers.com', keys:['indiehackers','indie hackers'] },
    { id:'producthunt', name:'Product Hunt', mark:'P',  brand:'#da552f', url:'producthunt.com', keys:['producthunt','product hunt','product-hunt'] },
    { id:'youtube',     name:'YouTube',      mark:'▶',  brand:'#ff0000', url:'youtube.com',     keys:['youtube'] },
    { id:'x',           name:'X',            mark:'𝕏',  brand:'#111418', url:'x.com',           keys:['x.com','twitter'] },
  ];
  // Only three honest states — nothing here claims "signed in as <name>", which we cannot know.
  const PILL = { good:['p-good','Connected'], live:['p-live','Live now'], off:['p-off','Not connected'] };

  const has = (plat, s) => { s = String(s || '').toLowerCase(); return plat.keys.some(k => s.includes(k)); };
  const short = (t, n = 56) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const safe = (typeof esc === 'function') ? esc
    : (t => String(t == null ? '' : t).replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c])));
  const logoHtml = (p, extra) =>
    '<div class="logo ' + (p.monoLo ? 'mono-lo' : '') + ' ' + (extra || '') + '" style="--brand:' + p.brand + '">' + safe(p.mark) + '</div>';

  let LAST = [];   // the computed rows, indexed by the data-* attributes the cards carry

  // Join the real endpoints into one status per platform. All best-effort: a failing call just
  // leaves that dimension empty rather than blanking the whole board.
  async function load() {
    const grab = (path) => api(path).catch(() => ({}));
    const [profs, sess, jobsR, rolesR, presetsR] = await Promise.all([
      grab('/v1/profiles'), grab('/v1/sessions'), grab('/v1/agent/jobs'), grab('/v1/agent/roles'), grab('/v1/profiles/presets'),
    ]);

    const presets = presetsR.presets || [];
    const servedBy = {};
    for (const x of presets) if (x.servedBy && x.site) servedBy[x.servedBy] = x.site;

    // Profiles may arrive as bare name strings or as objects carrying a site.
    const profiles = (profs.profiles || []).map(p => {
      if (typeof p === 'string') return { name: p, site: servedBy[p] || '' };
      const name = p.name || p.id || p.profile || '';
      return { name, site: p.site || servedBy[name] || '' };
    }).filter(p => p.name);

    // Active = an open session OR a running job on that profile.
    const sessArr = Array.isArray(sess) ? sess
      : (Array.isArray(sess.sessions) ? sess.sessions : (sess.sessions ? Object.values(sess.sessions) : []));
    const active = new Set();
    // Also remember WHICH session is on each profile, so a card can stop exactly that one.
    const sessByProfile = {};
    /*
     * WHAT IS HOLDING THIS PROFILE, so the card can say it.
     *
     * A session with a RUNNING job already read "running · <goal>". A session whose job has finished
     * and not let go read "a session is open" — which is how a Google login sat parked on a sign-in
     * page for twenty minutes while the owner, who needed to sign in, could neither see what had it
     * nor take it back. The session carries its job now; the card should say so.
     */
    const heldByProfile = {};
    for (const s of sessArr) {
      const pn = s && (s.profile || s.profileName || s.name);
      if (!pn) continue;
      active.add(pn);
      const sid = s.id || s.sessionId;
      if (sid) sessByProfile[pn] = sid;
      if (s.job) heldByProfile[pn] = { ...s.job, yours: s.yours !== false, owner: s.owner || '' };
    }
    /*
     * IDLE IS NOT LIVE, AND CALLING IT LIVE MADE THE STOP BUTTON A NO-OP.
     *
     * "Live" counted every job that was running OR idle. Idle is what a walk becomes when it has
     * FINISHED — the conversation stays open so it can be resumed — and such a job usually holds no
     * session at all. So three cards read "● Live" when one browser session existed, and pressing
     * Stop on the other two did nothing at all and said nothing either: there was no session to
     * close (the id was empty, so the call was skipped) and no running job to end (idle ones were
     * filtered out of stopJobs). No error, no change, still live. The button was not broken so much
     * as asked to act on a state that was not real.
     *
     * A profile is live when a browser session is open on it, or a job is actually running in it.
     * A finished conversation parked on a profile is worth showing and worth being able to end, but
     * it is not the browser being busy.
     */
    const allJobs = (jobsR.jobs || []);
    const runningJobs = allJobs.filter(j => j.status === 'running');
    const parkedJobs = allJobs.filter(j => j.status === 'idle');
    const jobByProfile = {};
    for (const j of runningJobs) { if (j.profile) { active.add(j.profile); (jobByProfile[j.profile] = jobByProfile[j.profile] || []).push(j); } }
    /* Parked jobs are attached so a card can name them and end them — but they never make it live. */
    const parkedByProfile = {};
    for (const j of parkedJobs) { if (j.profile) (parkedByProfile[j.profile] = parkedByProfile[j.profile] || []).push(j); }
    const roles = rolesR.roles || [];
    const labelOf = (nm) => {
      const rr = roles.find(r => r.name === nm);
      return rr ? String(rr.label || rr.name).replace(/^[^·]*·\s*/, '') : nm;
    };

    // The sites the OWNER authored (a URL + roles) arrive in the same preset list, flagged `custom`.
    // Each becomes a card exactly like a built-in one — its own isolated profile, opening on its URL —
    // by handing the shared row logic a synthetic platform. `attachedRoles` are the roles it may run.
    const customPlats = presets.filter(p => p.custom).map(p => ({
      id: 'preset:' + p.key, name: p.label, url: p.site,
      mark: ((p.label || p.site || '＋').trim().charAt(0) || '＋').toUpperCase(), brand: '#64748b',
      keys: [String(p.site || '').toLowerCase(), String(p.label || '').toLowerCase(), String(p.key || '').toLowerCase()].filter(Boolean),
      custom: true, presetKey: p.key, startUrl: p.start || ('https://' + p.site + '/'), attachedRoles: p.roles || [],
    }));

    return PLAT.concat(customPlats).map(plat => {
      const mine = profiles.filter(pr => has(plat, pr.site) || has(plat, pr.name));
      const liveP = mine.find(pr => active.has(pr.name));
      const rls = roles
        .filter(r => has(plat, r.site) || has(plat, r.group) || has(plat, String(r.name || '').split('.')[0]))
        .map(r => String(r.label || r.name || '').replace(/^[^·]*·\s*/, ''));
      // An authored site's explicitly-attached roles come first, whatever their own site.
      for (const nm of (plat.attachedRoles || [])) { const lab = labelOf(nm); if (!rls.includes(lab)) rls.unshift(lab); }
      let state, statusHtml, activity = '', profileValue = '', optLabel = '';
      if (liveP) {
        state = 'live';
        const js = jobByProfile[liveP.name] || [];
        const held = heldByProfile[liveP.name] || null;
        if (js.length) {
          activity = 'running · ' + short(js[0].goal || js[0].role || 'a task');
        } else if (held) {
          /*
           * A JOB THAT HAS FINISHED AND NOT LET GO IS THE THING WORTH SAYING OUT LOUD.
           *
           * It is indistinguishable from work if the card only says "a session is open", and it is
           * the state that blocks a person from signing in. So it names the role that holds it and
           * says plainly that it is finished — which is also the cue that Stop is safe to press.
           */
          const who = labelOf(held.role) || held.role;
          activity = held.status === 'running'
            ? ('running · ' + short(held.goal || who))
            : (who + ' finished and is still holding this login');
        } else {
          activity = 'a session is open';
        }
        statusHtml = '<span class="now">● Live · ' + safe(activity) + '</span>'
          + (held && !held.yours ? '<br><span class="dim">opened by ' + safe(held.owner || 'a connected tool') + '</span>' : '');
        profileValue = liveP.name; optLabel = liveP.name;
      } else if (mine.length) {
        state = 'good';
        /*
         * A FINISHED CONVERSATION PARKED HERE IS WORTH SAYING, without pretending the browser is busy.
         * This is the state that used to read "● Live" on a profile with no session at all.
         */
        const parked = mine.map(pr => (parkedByProfile[pr.name] || []).length).reduce((a, b) => a + b, 0);
        statusHtml = '<b>Connected</b><br>The agent can act here. Open it to check the login or use it yourself.'
          + (parked ? '<br><span class="dim">' + parked + (parked === 1 ? ' finished conversation is' : ' finished conversations are') + ' parked here — nothing is running</span>' : '');
        profileValue = mine[0].name; optLabel = mine[0].name;
      } else {
        state = 'off';
        statusHtml = 'Not connected — sign in once and the agent can act here from then on.';
        // Prefer a known set-up preset (it labels the profile with its site and opens the login page).
        const pre = presets.find(x => has(plat, x.site) && !x.exists) || presets.find(x => has(plat, x.site));
        if (pre) { profileValue = 'preset:' + pre.key; optLabel = pre.label || plat.name; }
        else { profileValue = plat.id; optLabel = plat.name; }
      }
      // For the Stop control: the live session on this profile, and any running jobs to end first.
      // For Watch: the running job to follow (its transcript + live view).
      const liveName = liveP ? liveP.name : '';
      const sessionId = liveName ? (sessByProfile[liveName] || '') : '';
      const liveJobs = liveName ? (jobByProfile[liveName] || []) : [];
      /*
       * STOP MUST BE ABLE TO ACT ON EVERYTHING THE CARD IS SHOWING.
       *
       * It only ever ended RUNNING jobs, so a card offering Stop over a finished-but-parked one had
       * nothing to end and no session to close, and pressing it did nothing and said nothing. A
       * parked conversation is exactly what somebody pressing Stop wants gone.
       */
      const parkedHere = mine.reduce((acc, pr) => acc.concat(parkedByProfile[pr.name] || []), []);
      const stopJobs = liveJobs.filter(j => j.status === 'running').concat(parkedHere).map(j => j.id).filter(Boolean);
      const jobId = (liveJobs[0] && liveJobs[0].id) || stopJobs[0] || '';
      return { plat, state, statusHtml, activity, roles: rls, profileValue, optLabel, sessionId, stopJobs, jobId,
        custom: !!plat.custom, presetKey: plat.presetKey || '', startUrl: plat.startUrl || '', roleNames: plat.attachedRoles || [] };
    });
  }

  function render(rows) {
    LAST = rows;
    const ok = rows.filter(r => r.state === 'good').length;
    const live = rows.filter(r => r.state === 'live').length;
    const off = rows.filter(r => r.state === 'off').length;
    el('dashKpiOk').textContent = ok;
    el('dashKpiOff').textContent = off;
    el('dashKpiLive').textContent = live;
    const lb = el('dashLiveBadge');
    if (live) { lb.textContent = live + ' live'; lb.classList.remove('hide'); } else lb.classList.add('hide');

    const bn = el('dashBanner');
    if (off) {
      const names = rows.filter(r => r.state === 'off').map(r => r.plat.name);
      el('dashBannerT').textContent = off + (off === 1 ? ' account needs you to sign in' : ' accounts need you to sign in');
      el('dashBannerS').textContent = names.join(', ') + (off === 1
        ? " isn't connected yet — the agent can't act there until you sign in once."
        : " aren't connected yet — the agent can't act there until you sign in once.");
      bn.classList.remove('hide');
      bn.dataset.first = rows.findIndex(r => r.state === 'off');
    } else bn.classList.add('hide');

    el('dashGrid').innerHTML = rows.map((r, i) => {
      const p = r.plat, pill = PILL[r.state], cls = pill[0], label = pill[1];
      let acts;
      if (r.state === 'off')
        acts = '<button class="btn primary" data-open="' + i + '" style="--brand:' + p.brand + '">Open &amp; sign in →</button>';
      else if (r.state === 'live')
        acts = '<button class="btn primary" data-watch="' + i + '" style="--brand:' + p.brand + '">Watch</button>'
             + '<button class="btn ghost" data-stop="' + i + '" style="color:var(--bad)" title="Stop this session">Stop</button>'
             + '<button class="btn ghost" data-open="' + i + '" title="Details">⋯</button>';
      else
        acts = '<button class="btn primary" data-run="' + i + '" style="--brand:' + p.brand + '">Open</button>'
             + '<button class="btn ghost" data-open="' + i + '" title="Details">⋯</button>';
      // An authored site can be forgotten again — the card, not the saved login, which stays until removed.
      if (r.custom) acts += '<button class="btn ghost" data-forget="' + i + '" title="Remove this profile" style="margin-left:auto;color:var(--faint)">✕</button>';
      return '<div class="dcard ' + (r.state === 'off' ? 'off' : '') + (r.custom ? ' custom' : '') + '" style="--brand:' + p.brand + '" data-open="' + i + '" tabindex="0">'
        + '<div class="stripe"></div>'
        + '<div class="hd">' + logoHtml(p) + '<div><div class="nm">' + safe(p.name) + '</div><div class="sub mono">' + safe(p.url) + '</div></div>'
        + '<div class="stq"><span class="pill ' + cls + '"><span class="pdot"></span>' + label + '</span></div></div>'
        + '<div class="status">' + r.statusHtml + '</div>'
        + '<div class="roles">' + (r.roles.length
            ? r.roles.map(x => '<span class="role">' + safe(x) + '</span>').join('')
            : '<span class="role" style="opacity:.6">no roles yet</span>') + '</div>'
        + '<div class="acts">' + acts + '</div></div>';
    }).join('')
    // The always-present tile: add a profile for any site, with a URL and (if any exist) roles.
    + '<div class="dcard addcard" id="dashAddCard" tabindex="0" role="button">'
      + '<div class="addplus">＋</div>'
      + '<div class="addttl">Add a profile</div>'
      + '<div class="addsub">Any site — give its login URL and attach the roles that work there.</div></div>';

    const liveRows = rows.filter(r => r.state === 'live');
    el('dashRail').innerHTML = liveRows.length ? liveRows.map(r => {
      const p = r.plat, i = rows.indexOf(r);
      return '<div class="lr">' + logoHtml(p)
        + '<div class="info"><div class="t">' + safe(p.name)
        + (r.roles[0] ? '<span class="role">' + safe(r.roles[0]) + '</span>' : '') + '</div>'
        + '<div class="s">' + safe(r.activity) + '</div></div>'
        + '<div class="prog"><i></i></div>'
        + '<div class="actions"><button class="lb watch" data-watch="' + i + '">Watch</button>'
        + '<button class="lb" data-stop="' + i + '" style="color:var(--bad)">Stop</button>'
        + '<button class="lb" data-open="' + i + '">Details</button></div></div>';
    }).join('')
      : '<div class="lr" style="color:var(--faint)"><div class="info"><div class="s">Nothing running right now. Open an account and ask the agent to do something.</div></div></div>';
  }

  async function refresh() { try { render(await load()); } catch (e) { /* keep whatever is shown */ } }

  // ── Open flow: set the profile, show #app, then reuse the EXISTING (takeover-aware) #open handler.
  function ensureOption(value, label) {
    const sel = el('profile'); if (!sel || !value) return;
    if (![...sel.options].some(o => o.value === value)) {
      const o = document.createElement('option'); o.value = value; o.textContent = label || value; sel.appendChild(o);
    }
    sel.value = value;
  }
  function showApp() { closeModal(); dash.classList.add('hide'); el('app').classList.remove('hide'); }
  function showDash() { window.__ghostPlat = null; el('app').classList.add('hide'); dash.classList.remove('hide'); if (typeof loadRoles === 'function') loadRoles(); }
  // Each platform's own sign-in / home page — the session opens ON this, not the default facebook.com.
  const LOGIN = { facebook:'https://www.facebook.com/', google:'https://accounts.google.com/', linkedin:'https://www.linkedin.com/login', reddit:'https://www.reddit.com/login/', producthunt:'https://www.producthunt.com/', youtube:'https://studio.youtube.com/', x:'https://x.com/login' };
  function runOpen(i) {
    const r = LAST[i]; if (!r) return;
    const p = r.plat;
    // BIND this session to the platform: only its roles are offered, and it opens on its own page.
    window.__ghostPlat = p ? { id: p.id, keys: (p.keys || []).concat([p.id]), name: p.name, roles: r.roleNames || [] } : null;
    ensureOption(r.profileValue, r.optLabel);   // $('profile').value = <profileName>
    // An authored site opens on the exact login URL its owner gave; a catalog one on its known page.
    const target = r.startUrl || (p ? (LOGIN[p.id] || ('https://' + p.url + '/')) : '');
    const url = el('url'); if (url && target) url.value = target;
    showApp();
    if (typeof loadRoles === 'function') loadRoles();          // re-filter the role dropdown to this platform
    const open = el('open'); if (open) open.click();           // → adopt(await openSession())
    /* A profile a PRESET covers lands on its login page from adopt() itself (console.js navigates to
       preset.start). Clicking "go" as well fired a SECOND navigation ~1.3s later, and Chromium aborted
       whichever was still loading — a 500 (net::ERR_ABORTED) on a brand-new Hacker News profile, and a
       black live view while the two fought. One navigation per open: the preset's, or ours. */
    const covered = String(r.profileValue || '').startsWith('preset:')
      || (typeof PRESETS !== 'undefined' && Array.isArray(PRESETS) && PRESETS.some((x) => x && x.profile === r.profileValue));
    if (target && !covered) setTimeout(() => { const go = el('go'); if (go && !go.disabled) go.click(); }, 1300);  // land on the platform's page
  }

  // Watch a session that is ALREADY running: FOLLOW its job (transcript + live view) rather than
  // opening/taking over the profile — the agent owns that browser, and opening it again fights it for
  // the tab (which is why Watch showed a black canvas and reset the role). followJob adopts the running
  // session and connects the live view for us.
  function watchLive(i) {
    const r = LAST[i]; if (!r) return;
    const p = r.plat;
    window.__ghostPlat = p ? { id: p.id, keys: (p.keys || []).concat([p.id]), name: p.name, roles: r.roleNames || [] } : null;
    showApp();
    if (typeof loadRoles === 'function') loadRoles();
    if (r.jobId && typeof followJob === 'function') { followJob(r.jobId); return; }
    // No job id — attach the live view to the known session directly.
    if (r.sessionId && typeof connectLive === 'function') {
      try {
        session = r.sessionId; activeProfile = r.profileValue || '';
        ['go', 'close', 'marks', 'esc'].forEach((id) => { const e = el(id); if (e) e.disabled = false; });
        connectLive();
      } catch (e) { /* fall through */ }
      return;
    }
    runOpen(i);   // nothing running to watch — fall back to opening the platform
  }

  // ── Stop a running session from its card, without leaving the dashboard.
  // Ends any running job on the profile first (so the master stops driving it), then closes the
  // session (which frees the profile). The LOGIN is untouched — a stop is "stop what it is doing
  // now", not "sign out". Results are safe: the master harvests from the job record, not the session.
  async function stopSession(i) {
    const r = LAST[i]; if (!r) return;
    /*
     * A STOP THAT DOES NOTHING MUST SAY SO.
     *
     * Pressing this used to be silent whenever there was nothing to act on — no session (the id was
     * empty so the call was skipped) and no running job (parked ones were filtered out). The card
     * still said Live, so it read as a broken button rather than as an empty state. Now the button
     * reports what it actually ended, and says plainly when there was nothing left to end.
     */
    const jids = (r.stopJobs || []).filter(Boolean);
    if (!jids.length && !r.sessionId) {
      alert('Nothing is running on ' + r.plat.name + ' — there is no open session and no job to end. The login stays saved.');
      refresh();
      return;
    }
    if (!confirm('Stop the ' + r.plat.name + ' session? Anything it is doing right now ends immediately. The login stays saved.')) return;
    let ended = 0, closed = false, failed = null;
    try {
      for (const jid of jids) {
        try { await api('/v1/agent/jobs/' + encodeURIComponent(jid) + '/stop', { method: 'POST' }); ended++; }
        catch (e) { failed = e; /* the session close below still ends it */ }
      }
      if (r.sessionId) { await api('/v1/sessions/' + encodeURIComponent(r.sessionId), { method: 'DELETE' }); closed = true; }
    } catch (e) {
      alert('Could not stop it: ' + (e && e.message ? e.message : e));
      refresh();
      return;
    }
    /* Ending nothing at all, with no error, is the exact state that read as a broken button. */
    if (!ended && !closed) alert('Nothing was stopped on ' + r.plat.name + (failed ? ' — ' + (failed.message || failed) : ' — it had already finished.'));
    refresh();
  }

  // ── The sign-in / open modal.
  function openModal(i) {
    const r = LAST[i]; if (!r) return;
    const p = r.plat, needs = r.state === 'off';
    el('dmLogo').outerHTML = logoHtml(p).replace('class="logo', 'id="dmLogo" class="logo');
    el('dmTitle').textContent = needs ? ('Sign in to ' + p.name)
      : (r.state === 'live' ? (p.name + ' is working') : ('Open ' + p.name));
    el('dmSub').textContent = p.name + ' profile · isolated · own pinned exit route';
    if (needs) {
      el('dmBody').innerHTML =
        '<p>We\'ll open <b>' + safe(p.name) + '</b> in its own profile. Sign in on the page as normal — the agent uses this login from then on, and <b>you won\'t have to do it again</b> unless it expires.</p>'
        + '<div class="frame"><div class="fbar"><div class="dots"><i></i><i></i><i></i></div><div class="url">' + safe(p.url) + '/login</div></div>'
        + '<div class="view"><div class="big">' + safe(p.mark) + '</div><div>The real ' + safe(p.name) + ' sign-in opens here, in a live browser you drive.</div></div></div>'
        + '<div class="msteps"><div class="mstep"><span class="n">1</span>Open ' + safe(p.name) + '</div>'
        + '<div class="mstep"><span class="n">2</span>Sign in on the page</div>'
        + '<div class="mstep"><span class="n">3</span>Done — the agent takes over</div></div>';
      el('dmFoot').innerHTML = '<button class="btn" data-close="1">Cancel</button>'
        + '<button class="btn primary" data-go="' + i + '" style="--brand:' + p.brand + '">Open ' + safe(p.name) + ' →</button>';
    } else if (r.state === 'live') {
      el('dmBody').innerHTML =
        '<p><b>' + safe(p.name) + '</b> is connected and running right now: ' + safe(r.activity) + '.</p>'
        + '<div class="frame"><div class="fbar"><div class="dots"><i></i><i></i><i></i></div><div class="url">' + safe(p.url) + '</div></div>'
        + '<div class="view"><div class="big">👁️</div><div>Live view — watch the agent, or take the wheel any time.</div></div></div>';
      el('dmFoot').innerHTML = '<button class="btn" data-close="1">Close</button>'
        + '<button class="btn" data-stop="' + i + '" style="color:var(--bad)">Stop session</button>'
        + '<button class="btn primary" data-go="' + i + '" style="--brand:' + p.brand + '">Watch live</button>';
    } else {
      el('dmBody').innerHTML =
        '<p><b>' + safe(p.name) + '</b> is connected. Open it to check the login or use it yourself — the agent shares this exact session.</p>'
        + '<div class="frame"><div class="fbar"><div class="dots"><i></i><i></i><i></i></div><div class="url">' + safe(p.url) + '</div></div>'
        + '<div class="view"><div class="big">✓</div><div>Connected and ready' + (r.roles.length ? '. Roles here: ' + safe(r.roles.join(', ')) : '') + '.</div></div></div>';
      el('dmFoot').innerHTML = '<button class="btn" data-close="1">Close</button>'
        + '<button class="btn primary" data-go="' + i + '" style="--brand:' + p.brand + '">Open ' + safe(p.name) + '</button>';
    }
    el('dashModal').classList.add('on');
  }
  function closeModal() { el('dashModal').classList.remove('on'); }

  // ── Add a profile: author a site as DATA — a URL and (if any exist) the roles that work there.
  // Reuses the same modal shell; the server merges the result into the preset list, so the new card
  // opens and sets itself up through the identical path as a built-in platform.
  async function openAddModal() {
    el('dmLogo').outerHTML = logoHtml({ mark:'＋', brand:'#64748b' }).replace('class="logo', 'id="dmLogo" class="logo');
    el('dmTitle').textContent = 'Add a profile';
    el('dmSub').textContent = 'Any site · its own isolated login · own pinned exit route';
    let rolesHtml = '<div class="arole-empty">No roles yet — create some in Roles, then attach them here.</div>';
    try {
      const list = ((await api('/v1/agent/roles')).roles || []);
      if (list.length) {
        const bySite = {};
        for (const x of list) (bySite[x.group || 'other'] = bySite[x.group || 'other'] || []).push(x);
        rolesHtml = Object.entries(bySite).map(([g, rs]) =>
          '<div class="arole-g"><div class="arole-gh">' + safe(g) + '</div>'
          + rs.map(x => '<label class="arole"><input type="checkbox" value="' + safe(x.name) + '">'
              + '<span>' + safe(String(x.label || x.name).replace(/^[^·]*·\s*/, '')) + '</span></label>').join('')
          + '</div>').join('');
      }
    } catch (e) { /* leave the empty note — a missing list just means no roles to attach */ }
    el('dmBody').innerHTML =
      '<p>Give a site its own profile. Sign in once on the page you point to, and the agent works it from then on — signed in, isolated, on its own exit route.</p>'
      + '<label class="afield"><span>Name</span><input id="addLabel" placeholder="e.g. CapCut" autocomplete="off"></label>'
      + '<label class="afield"><span>Login URL</span><input id="addUrl" placeholder="https://www.capcut.com/login" autocomplete="off"></label>'
      + '<div class="afield"><span>Roles it can run <small>(optional)</small></span><div class="aroles">' + rolesHtml + '</div></div>'
      + '<div class="amsg" id="addMsg"></div>';
    el('dmFoot').innerHTML = '<button class="btn" data-close="1">Cancel</button>'
      + '<button class="btn primary" id="addCreate">Create profile</button>';
    el('dashModal').classList.add('on');
    setTimeout(() => { const l = el('addLabel'); if (l) l.focus(); }, 50);
  }
  async function createProfile() {
    const label = (el('addLabel') && el('addLabel').value || '').trim();
    const url = (el('addUrl') && el('addUrl').value || '').trim();
    const msg = el('addMsg');
    if (!url) { if (msg) { msg.textContent = 'A login URL is required (e.g. capcut.com).'; msg.className = 'amsg bad'; } return; }
    const roles = [...document.querySelectorAll('#dmBody .arole input:checked')].map(c => c.value);
    if (msg) { msg.textContent = 'Creating…'; msg.className = 'amsg'; }
    try {
      await api('/v1/profiles/custom', { method:'POST', body: JSON.stringify({ label, url, roles }) });
      closeModal();
      refresh();
    } catch (e) {
      if (msg) { msg.textContent = (e && e.message) ? e.message : 'Could not create it.'; msg.className = 'amsg bad'; }
    }
  }
  async function forgetProfile(i) {
    const r = LAST[i]; if (!r || !r.custom || !r.presetKey) return;
    if (!confirm('Remove the “' + r.plat.name + '” profile? The saved login itself is left alone — delete that from Settings if you want it gone too.')) return;
    try { await api('/v1/profiles/custom/' + encodeURIComponent(r.presetKey), { method:'DELETE' }); } catch (e) { /* refresh shows the truth */ }
    refresh();
  }

  // ── Wiring — event delegation only, nothing global.
  el('dashGrid').addEventListener('click', e => {
    const add = e.target.closest('#dashAddCard');
    if (add) { e.stopPropagation(); openAddModal(); return; }
    const forget = e.target.closest('[data-forget]');
    if (forget) { e.stopPropagation(); forgetProfile(+forget.dataset.forget); return; }
    const watch = e.target.closest('[data-watch]');
    if (watch) { e.stopPropagation(); watchLive(+watch.dataset.watch); return; }
    const stop = e.target.closest('[data-stop]');
    if (stop) { e.stopPropagation(); stopSession(+stop.dataset.stop); return; }
    const run = e.target.closest('[data-run]'), open = e.target.closest('[data-open]');
    if (run) { e.stopPropagation(); runOpen(+run.dataset.run); return; }
    if (open) openModal(+open.dataset.open);
  });
  el('dashGrid').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('#dashAddCard')) { e.preventDefault(); openAddModal(); return; }
    const card = e.target.closest('.dcard[data-open]'); if (card) { e.preventDefault(); openModal(+card.dataset.open); }
  });
  el('dashRail').addEventListener('click', e => {
    const watch = e.target.closest('[data-watch]');
    if (watch) { watchLive(+watch.dataset.watch); return; }
    const stop = e.target.closest('[data-stop]');
    if (stop) { stopSession(+stop.dataset.stop); return; }
    const run = e.target.closest('[data-run]'), open = e.target.closest('[data-open]');
    if (run) runOpen(+run.dataset.run); else if (open) openModal(+open.dataset.open);
  });
  el('dashModal').addEventListener('click', e => {
    if (e.target === el('dashModal')) { closeModal(); return; }
    if (e.target.closest('#addCreate')) { createProfile(); return; }
    const stop = e.target.closest('[data-stop]');
    if (stop) { closeModal(); stopSession(+stop.dataset.stop); return; }
    const go = e.target.closest('[data-go]'), cl = e.target.closest('[data-close]');
    if (cl) closeModal();
    else if (go) { const gi = +go.dataset.go; closeModal(); const r = LAST[gi]; if (r && r.state === 'live') watchLive(gi); else runOpen(gi); }
  });
  el('dashModal').addEventListener('keydown', e => {
    if (e.key === 'Enter' && el('addCreate') && (e.target.id === 'addUrl' || e.target.id === 'addLabel')) {
      e.preventDefault(); createProfile();
    }
  });
  el('dmClose').addEventListener('click', closeModal);
  el('dashBannerBtn').addEventListener('click', () => { const i = +el('dashBanner').dataset.first; if (i >= 0) openModal(i); });
  el('dashGoActivity').addEventListener('click', () => el('dashRail').scrollIntoView({ behavior:'smooth', block:'center' }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && el('dashModal').classList.contains('on')) closeModal(); });

  // The "← Accounts" back button lives in the (static) #app header.
  const back = el('dashBack'); if (back) back.addEventListener('click', showDash);

  // Theme toggle — reuses the app's applyTheme so the whole console moves together.
  let forced = document.documentElement.getAttribute('data-theme') || null;
  el('dashTheme').addEventListener('click', () => {
    forced = forced === 'dark' ? 'light' : (forced === 'light' ? null : 'dark');
    if (typeof applyTheme === 'function') applyTheme(forced || undefined);
    else if (forced) document.documentElement.setAttribute('data-theme', forced);
    else document.documentElement.removeAttribute('data-theme');
  });

  // ═══════════════════════ Settings sub-view + mobile nav drawer ═══════════════════════
  // Two in-place views inside the SAME #dash main area: Accounts (the grid) and Settings. The nav
  // swaps between them; nothing here reaches #app or #gate, and every control talks to the real
  // endpoints via the shared api() helper.
  const dwrap        = dash.querySelector('.dwrap');
  const accountsView = el('dashAccountsView');
  const settingsView = el('dashSettingsView');
  const apiView      = el('dashApiView');
  const rolesView    = el('dashRolesView');
  const autoView     = el('dashAutoView');
  const filesView    = el('dashFilesView');
  const navAccounts  = el('dashGoAccounts');
  const navSettings  = el('dashGoSettings');
  const navApi       = el('dashGoApi');
  const navRoles     = el('dashGoRoles');
  const navAuto      = el('dashGoAuto');
  const navFiles     = el('dashGoFiles');
  const platformsView = el('dashPlatformsView');
  const navPlatforms  = el('dashGoPlatforms');
  const adminView    = el('dashAdminView');
  const navAdmin     = el('dashGoAdmin');
  const topTitle     = dash.querySelector('.top h1');
  const topStat      = dash.querySelector('.top .stat');
  // Restore the topbar heading exactly as authored when returning to Accounts.
  const ACC_TITLE = 'Accounts<small>The logins the agent works through — one per platform</small>';
  const SET_TITLE = 'Settings<small>Connection, the agent, your account and per-login exit routes</small>';
  const API_TITLE = 'API<small>Drive the Ghost Browser over HTTP — the same interface the master agent uses</small>';
  const ROLES_TITLE = 'Roles<small>The specialists your agent can run — create, browse and import them</small>';
  const AUTO_TITLE = 'Automation<small>Wire roles and profiles into steps that run in a line — collect, then act on it</small>';
  const FILES_TITLE = 'Files<small>Everything the agent has generated — images, voiceovers, music, clips — across every session</small>';
  const ADMIN_TITLE = 'Superadmin<small>Every user, and the flows and roles they created — across all Ghost Browsers</small>';
  const PLAT_TITLE = 'Platforms<small>Every platform the agent knows — where you are signed in, how fast it is read, and whether a private message may be sent</small>';

  function setNavOn(active) {
    dash.querySelectorAll('.nav .navi').forEach(b => b.classList.toggle('on', b === active));
  }
  function closeDrawer() { if (dwrap) dwrap.classList.remove('draw'); }

  // One place shows a view and hides the rest, so a new tab never leaves two on screen at once.
  const ALL_VIEWS = [accountsView, settingsView, apiView, rolesView, autoView, filesView, platformsView, adminView];
  function onlyView(v) { ALL_VIEWS.forEach(x => { if (x) x.classList.toggle('hide', x !== v); }); }

  function showAccounts() {
    closeDrawer();
    onlyView(accountsView);
    if (topStat) topStat.style.display = '';
    if (topTitle) topTitle.innerHTML = ACC_TITLE;
    setNavOn(navAccounts);
  }
  function showSettings() {
    closeDrawer();
    onlyView(settingsView);
    if (topStat) topStat.style.display = 'none';   // the KPIs are about the accounts grid
    if (topTitle) topTitle.innerHTML = SET_TITLE;
    setNavOn(navSettings);
    loadSettings();
  }
  // The API reference is pure static documentation — nothing to load, only the base-URL hint to
  // fill in with the origin actually serving this console.
  function showApi() {
    closeDrawer();
    onlyView(apiView);
    if (topStat) topStat.style.display = 'none';   // the KPIs are about the accounts grid
    if (topTitle) topTitle.innerHTML = API_TITLE;
    setNavOn(navApi);
    const base = el('apiBaseUrl');
    if (base) { try { base.textContent = location.origin; } catch (e) { /* leave the placeholder */ } }
  }
  // The Roles marketplace — its own module (window.Marketplace) fills #dashRolesView on demand.
  function showRoles() {
    closeDrawer();
    onlyView(rolesView);
    if (topStat) topStat.style.display = 'none';
    if (topTitle) topTitle.innerHTML = ROLES_TITLE;
    setNavOn(navRoles);
    if (window.Marketplace && window.Marketplace.load) window.Marketplace.load();
  }
  if (navAccounts) navAccounts.addEventListener('click', showAccounts);
  if (navSettings) navSettings.addEventListener('click', showSettings);
  if (navApi) navApi.addEventListener('click', showApi);
  if (navRoles) navRoles.addEventListener('click', showRoles);
  // The Automation workbench — its own module (window.Automation) fills #dashAutoView on demand.
  function showAuto() {
    closeDrawer();
    onlyView(autoView);
    if (topStat) topStat.style.display = 'none';
    if (topTitle) topTitle.innerHTML = AUTO_TITLE;
    setNavOn(navAuto);
    if (window.Automation && window.Automation.load) window.Automation.load();
  }
  if (navAuto) navAuto.addEventListener('click', showAuto);

  // The Files tab — its own module (window.Files) fills #dashFilesView on demand.
  function showFiles() {
    closeDrawer();
    onlyView(filesView);
    if (topStat) topStat.style.display = 'none';
    if (topTitle) topTitle.innerHTML = FILES_TITLE;
    setNavOn(navFiles);
    if (window.Files && window.Files.load) window.Files.load();
  }
  if (navFiles) navFiles.addEventListener('click', showFiles);

  /*
   * The Platforms tab — its own module (window.Platforms) fills #dashPlatformsView on demand. It
   * joins the two halves that were never connected: the logins on the Accounts page, and the rules
   * every service reads about each platform.
   */
  function showPlatforms() {
    closeDrawer();
    onlyView(platformsView);
    if (topStat) topStat.style.display = 'none';
    if (topTitle) topTitle.innerHTML = PLAT_TITLE;
    setNavOn(navPlatforms);
    if (window.Platforms && window.Platforms.load) window.Platforms.load();
  }
  if (navPlatforms) navPlatforms.addEventListener('click', showPlatforms);

  // ── Superadmin (platform) — cross-tenant Users / Flows / Roles from /v1/admin/tenants-overview.
  //    The nav item stays hidden until we confirm this login is a superadmin (the endpoint 200s).
  let ADMIN_DATA = null, ADMIN_TAB = 'users';
  const fmtDate = (t) => { if (!t) return '—'; const d = new Date(t); return isNaN(d) ? '—' : d.toLocaleString(); };
  function showAdmin() {
    closeDrawer();
    onlyView(adminView);
    if (topStat) topStat.style.display = 'none';
    if (topTitle) topTitle.innerHTML = ADMIN_TITLE;
    setNavOn(navAdmin);
    loadAdmin();
  }
  async function loadAdmin() {
    const body = el('adminBody'); if (!body) return;
    if (!ADMIN_DATA) body.innerHTML = '<p class="admin-empty">Loading…</p>';
    try {
      const r = await api('/v1/admin/tenants-overview');
      ADMIN_DATA = (r && r.tenants) || [];
      renderAdmin();
    } catch (e) { body.innerHTML = '<p class="admin-empty">Could not load: ' + safe(e.message) + '</p>'; }
  }
  function renderAdmin() {
    const body = el('adminBody'); if (!body) return;
    const tenants = ADMIN_DATA || [];
    adminView.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('on', b.dataset.atab === ADMIN_TAB));
    if (!tenants.length) { body.innerHTML = '<p class="admin-empty">No instances reported.</p>'; return; }
    const owner = (t) => safe(t.owner && t.owner.username || '—');
    let h = '';
    if (ADMIN_TAB === 'users') {
      h = '<table class="admin-tbl"><thead><tr><th>User</th><th>Instance</th><th>Sessions</th><th>Flows</th><th>Roles</th><th>Since</th></tr></thead><tbody>';
      for (const t of tenants) {
        if (t.error) { h += '<tr><td colspan="6" class="admin-err">' + safe(t.base) + ' — ' + safe(t.error) + '</td></tr>'; continue; }
        const c = t.counts || {};
        h += '<tr><td class="admin-strong">' + owner(t) + '</td><td class="admin-dim">' + safe(t.tenant || t.base || '') + '</td><td>' + (c.sessions || 0) + '</td><td>' + (c.workflows || 0) + '</td><td>' + (c.createdRoles || 0) + '</td><td class="admin-dim">' + fmtDate(t.owner && t.owner.createdAt) + '</td></tr>';
      }
      h += '</tbody></table>';
    } else if (ADMIN_TAB === 'flows') {
      h = '<table class="admin-tbl"><thead><tr><th>Flow</th><th>By</th><th>Steps</th><th>Active</th><th>Updated</th></tr></thead><tbody>'; let n = 0;
      for (const t of tenants) { if (t.error) continue; for (const w of (t.workflows || [])) { n++; h += '<tr><td class="admin-strong">' + safe(w.name || w.id) + '</td><td class="admin-dim">' + owner(t) + '</td><td>' + (w.nodes || 0) + '</td><td>' + (w.active ? '<span class="admin-on">on</span>' : '<span class="admin-off">off</span>') + '</td><td class="admin-dim">' + fmtDate(w.updatedAt || w.createdAt) + '</td></tr>'; } }
      if (!n) h += '<tr><td colspan="5" class="admin-empty">No flows yet.</td></tr>';
      h += '</tbody></table>';
    } else {
      h = '<table class="admin-tbl"><thead><tr><th>Role</th><th>By</th><th>Group</th><th>Tools</th><th>Created</th></tr></thead><tbody>'; let n = 0;
      for (const t of tenants) { if (t.error) continue; for (const r of (t.roles || [])) { n++; h += '<tr><td class="admin-strong">' + safe(r.label || r.id) + '</td><td class="admin-dim">' + owner(t) + '</td><td class="admin-dim">' + safe(r.group || '') + '</td><td>' + (r.tools || 0) + '</td><td class="admin-dim">' + fmtDate(r.createdAt) + '</td></tr>'; } }
      if (!n) h += '<tr><td colspan="5" class="admin-empty">No created roles yet.</td></tr>';
      h += '</tbody></table>';
    }
    body.innerHTML = h;
  }
  if (navAdmin) navAdmin.addEventListener('click', showAdmin);
  if (adminView) adminView.addEventListener('click', (e) => {
    const tab = e.target.closest('.admin-tab');
    if (tab) { ADMIN_TAB = tab.dataset.atab; renderAdmin(); return; }
    if (e.target.closest('#adminRefresh')) { ADMIN_DATA = null; loadAdmin(); }
  });
  /*
   * Reveal the Superadmin nav only when this login actually is one — ASKED, not attempted.
   *
   * This used to call /v1/admin/overview and catch the refusal. It worked, and it meant every
   * ordinary page load printed a red 403 in the browser's console: noise that reads exactly like a
   * broken page and twice sent the owner hunting a bug that was not there. The sign-in state already
   * says who you are, so the question is asked there and the refusal never happens.
   */
  (async () => {
    try {
      const s = await api('/api/auth/state');
      if (s.superadmin && navAdmin) navAdmin.classList.remove('hide');
    } catch (e) { /* not signed in yet — the nav stays hidden, as it should */ }
  })();

  // Copy buttons on the docs' code blocks. Delegated, so it covers every block with no per-button
  // wiring; it only ever reads the adjacent <pre> and writes the clipboard.
  if (apiView) apiView.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copybtn');
    if (!btn) return;
    const pre = btn.closest('.codewrap') && btn.closest('.codewrap').querySelector('pre.code');
    if (!pre) return;
    try {
      await navigator.clipboard.writeText(pre.textContent);
      const was = btn.textContent;
      btn.textContent = 'Copied'; btn.classList.add('ok');
      setTimeout(() => { btn.textContent = was; btn.classList.remove('ok'); }, 1400);
    } catch (err) { btn.textContent = 'Copy failed'; setTimeout(() => { btn.textContent = 'Copy'; }, 1400); }
  });

  // Any nav choice closes the drawer (requirement: close on nav-click).
  const navEl = dash.querySelector('.nav');
  if (navEl) navEl.addEventListener('click', e => { if (e.target.closest('.navi')) closeDrawer(); });

  // Hamburger + scrim + Escape drive the off-canvas drawer (class lives on .dwrap, not #dash).
  const ham = el('dashHam'), scrim = el('dashScrim');
  if (ham) ham.addEventListener('click', () => { if (dwrap) dwrap.classList.toggle('draw'); });
  if (scrim) scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && dwrap && dwrap.classList.contains('draw')) closeDrawer();
  });

  function loadSettings() { setTsRefresh(); loadSetAgent(); loadSetProfiles(); }

  // ── Connection / exit route (same endpoints as #exitPanel, targeting the settings controls) ──
  async function setTsRefresh() {
    const st = el('setTsState'), nodes = el('setTsNodes'), login = el('setTsLogin');
    if (!st) return;
    try {
      const t = await api('/v1/tailscale/status');
      try { el('setTsAll').checked = (await api('/v1/agent/settings')).routeThroughTailnet !== false; } catch (e) {}
      if (!t.installed) { st.textContent = 'not available in this image'; nodes.innerHTML = ''; login.classList.add('hide'); return; }
      st.textContent = !t.running ? 'not running'
        : t.loggedIn ? ('connected as ' + ((t.self && t.self.name) || '?') + (t.exitNode ? ' → exiting via ' + t.exitNode : ' · no exit node chosen'))
        : (t.backendState || 'starting…');
      if (t.loginUrl && !t.loggedIn) {
        login.classList.remove('hide');
        login.innerHTML = 'Open this to authorise, then press Connect again: '
          + '<a href="' + safe(t.loginUrl) + '" target="_blank" rel="noreferrer">' + safe(t.loginUrl) + '</a>';
      } else login.classList.add('hide');
      const list = t.exitNodes || [];
      if (!t.loggedIn) { nodes.innerHTML = ''; return; }
      if (!list.length) {
        const others = (t.devices || []).filter(d => !d.canExit).map(d => d.name + (d.online ? '' : ' (offline)')).join(', ');
        nodes.innerHTML = '<span class="snote" style="color:var(--warn)">No device is offering itself as an exit node'
          + (others ? '. Seen on your tailnet: ' + safe(others) : '') + '</span>';
        return;
      }
      nodes.innerHTML = '';
      for (const n of list) {
        const b = document.createElement('button');
        b.className = 'snode' + (n.inUse ? ' on' : '');
        b.textContent = (n.inUse ? '● ' : '') + n.name + (n.os ? ' (' + n.os + ')' : '') + (n.online ? '' : ' — offline');
        b.disabled = !n.online;
        b.onclick = async () => {
          try { await api('/v1/tailscale/exit-node', { method:'POST', body: JSON.stringify({ node: n.name }) }); setTsRefresh(); }
          catch (e) { st.textContent = e.message; }
        };
        nodes.appendChild(b);
      }
      const off = document.createElement('button');
      off.className = 'snode'; off.textContent = 'no exit node';
      off.onclick = async () => {
        try { await api('/v1/tailscale/exit-node', { method:'POST', body: JSON.stringify({ node: '' }) }); setTsRefresh(); }
        catch (e) { st.textContent = e.message; }
      };
      nodes.appendChild(off);
    } catch (e) { st.textContent = e.message; }
  }
  const _up = el('setTsUp'); if (_up) _up.addEventListener('click', async () => {
    const st = el('setTsState'); st.textContent = 'connecting…';
    try {
      const r = await api('/v1/tailscale/up', { method:'POST', body: JSON.stringify({ authKey: el('setTsKey').value.trim() || undefined }) });
      el('setTsKey').value = '';   // used once, never stored
      if (r.loginUrl && !r.loggedIn) st.textContent = 'open the Tailscale link to authorise';
      setTsRefresh();
    } catch (e) { st.textContent = e.message || 'failed'; }
  });
  const _down = el('setTsDown'); if (_down) _down.addEventListener('click', async () => {
    try { await api('/v1/tailscale/down', { method:'POST' }); setTsRefresh(); }
    catch (e) { el('setTsState').textContent = e.message; }
  });
  const _all = el('setTsAll'); if (_all) _all.addEventListener('change', async () => {
    const on = _all.checked;
    try { await api('/v1/agent/settings', { method:'PUT', body: JSON.stringify({ routeThroughTailnet: on }) }); }
    catch (e) { _all.checked = !on; el('setTsState').textContent = e.message; }
  });

  // ── Agent & AI (/v1/agent/settings + /v1/agent/models + /v1/agent/test) ──
  let setCfg = {};
  const SET_CUSTOM = '__custom__';
  async function loadSetAgent() {
    try {
      setCfg = await api('/v1/agent/settings');
      el('setHost').value = setCfg.llmHost || '';
      el('setAuto').checked = !!setCfg.autoAct;
      el('setSteps').value = setCfg.maxSteps || 60;
      el('setKeyState').textContent = setCfg.keySet ? ('set ' + (setCfg.keyHint || '')) : 'not set';
      el('setKey2State').textContent = setCfg.keys2Set ? 'set' : 'not set';
      el('setModel').value = setCfg.llmModel || '';
      await loadSetModels(false);
    } catch (e) { el('setModelState').textContent = e.message; }
  }
  function setSyncModel() {
    const custom = el('setModelSel').value === SET_CUSTOM;
    el('setModel').classList.toggle('hide', !custom);
    if (custom) el('setModel').focus();
  }
  async function loadSetModels(force) {
    const sel = el('setModelSel'), note = el('setModelState');
    note.textContent = 'asking the host…';
    try {
      const body = { llmHost: el('setHost').value.trim() };
      if (el('setKey').value.trim())  body.llmKey  = el('setKey').value.trim();
      if (el('setKey2').value.trim()) body.llmKeys = el('setKey2').value.trim();
      const r = await api('/v1/agent/models' + (force ? '?refresh=1' : ''), { method:'POST', body: JSON.stringify(body) });
      const models = r.models || [];
      const current = setCfg.llmModel || el('setModel').value || '';
      // Keep whatever is configured selectable even if the host stopped listing it.
      const options = (models.includes(current) || !current) ? models : [current].concat(models);
      sel.innerHTML = options.map(m =>
        '<option value="' + safe(m) + '"' + (m === current ? ' selected' : '') + '>' + safe(m)
        + (m === current && !models.includes(m) ? ' (not listed by the host)' : '') + '</option>').join('')
        + '<option value="' + SET_CUSTOM + '">type a name…</option>';
      setSyncModel();
      note.textContent = r.fetched ? (models.length + ' models on ' + safe(r.host || ''))
        : ('could not list (' + safe(r.reason || 'unknown') + ') — showing the usual cloud ones');
    } catch (e) { note.textContent = e.message; }
  }
  const _msel = el('setModelSel'); if (_msel) _msel.addEventListener('change', setSyncModel);
  const _mlist = el('setModelList'); if (_mlist) _mlist.addEventListener('click', () => loadSetModels(true));
  const setChosenModel = () =>
    (el('setModelSel').value === SET_CUSTOM ? el('setModel').value.trim() : el('setModelSel').value) || setCfg.llmModel || '';
  const setAgentBody = () => {
    const b = { llmHost: el('setHost').value.trim(), llmModel: setChosenModel(),
                autoAct: el('setAuto').checked, maxSteps: Number(el('setSteps').value) || 60 };
    // Blank means "keep the key you have", not "clear it".
    if (el('setKey').value.trim())  b.llmKey  = el('setKey').value.trim();
    if (el('setKey2').value.trim()) b.llmKeys = el('setKey2').value.trim();
    return b;
  };
  const _save = el('setSave'); if (_save) _save.addEventListener('click', async () => {
    const msg = el('setAgentMsg');
    try {
      await api('/v1/agent/settings', { method:'PUT', body: JSON.stringify(setAgentBody()) });
      el('setKey').value = ''; el('setKey2').value = '';
      msg.textContent = 'Saved.'; msg.className = 'smsg ok'; loadSetAgent();
    } catch (e) { msg.textContent = e.message; msg.className = 'smsg bad'; }
  });
  const _test = el('setTest'); if (_test) _test.addEventListener('click', async () => {
    const msg = el('setAgentMsg'); msg.textContent = 'asking the model…'; msg.className = 'smsg';
    try {
      const r = await api('/v1/agent/test', { method:'POST', body: JSON.stringify(setAgentBody()) });
      msg.textContent = 'Works — ' + safe(r.model) + ' answered in ' + r.ms + 'ms'; msg.className = 'smsg ok';
    } catch (e) { msg.textContent = e.message; msg.className = 'smsg bad'; }
  });

  // ── Account (/api/auth/key + /api/auth/logout) ──
  const _reveal = el('setKeyReveal'); if (_reveal) _reveal.addEventListener('click', async () => {
    const box = el('setKeyBox'), copy = el('setKeyCopy');
    try {
      const r = await api('/api/auth/key');
      const keys = r.keys || [];
      box.textContent = keys.map(k => k.key + '  (' + k.plan + ')').join('\n') || 'no keys configured';
      box.classList.remove('hide');
      if (keys.length) { copy.classList.remove('hide'); copy.dataset.key = keys.map(k => k.key).join('\n'); }
    } catch (e) { box.textContent = e.message; box.classList.remove('hide'); }
  });
  const _copy = el('setKeyCopy'); if (_copy) _copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(_copy.dataset.key || ''); _copy.textContent = 'Copied'; }
    catch (e) { _copy.textContent = 'Copy failed'; }
    setTimeout(() => { _copy.textContent = 'Copy'; }, 1400);
  });
  const _logout = el('setLogout'); if (_logout) _logout.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method:'POST' }); } catch (e) {}
    location.reload();
  });
  // Sidebar sign-out — the always-visible one next to "Signed in · this browser".
  const _dashLogout = el('dashLogout'); if (_dashLogout) _dashLogout.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    location.reload();
  });

  // ── Per-login exit route (/v1/profiles + /v1/profiles/:name/settings) ──
  const proxyLabel = (v) => v === 'tailscale' ? 'exit: always your tailnet'
    : v === 'direct' ? 'exit: always this server' : 'exit: follow the default';
  async function loadSetProfiles() {
    const wrap = el('setProfiles'), msg = el('setProfMsg');
    if (!wrap) return;
    msg.textContent = ''; msg.className = 'smsg';
    wrap.innerHTML = '<div class="sempty">Loading logins…</div>';
    try {
      const r = await api('/v1/profiles');
      const names = (r.profiles || [])
        .map(p => typeof p === 'string' ? p : (p.name || p.id || p.profile || ''))
        .filter(Boolean).filter(n => !n.startsWith('preset:') && n !== '__new__');
      if (!names.length) { wrap.innerHTML = '<div class="sempty">No saved logins yet. Sign in to a platform from Accounts first.</div>'; return; }
      // Index-based data attributes so a profile name never has to be escaped into a selector.
      wrap.innerHTML = names.map((n, i) =>
        '<div class="sprof"><div class="sgrow"><div class="pn">' + safe(n) + '</div>'
        + '<div class="ps" id="setPs' + i + '">exit: …</div></div>'
        + '<select class="sin" data-pi="' + i + '">'
        + '<option value="">follow the default</option>'
        + '<option value="tailscale">always my tailnet</option>'
        + '<option value="direct">always this server</option></select></div>').join('');
      names.forEach((n, i) => {
        api('/v1/profiles/' + encodeURIComponent(n) + '/settings').then(c => {
          const sel = wrap.querySelector('select[data-pi="' + i + '"]'), ps = el('setPs' + i);
          const proxy = (c.proxy === 'tailscale' || c.proxy === 'direct') ? c.proxy : '';
          if (sel) sel.value = proxy;
          if (ps) ps.textContent = proxyLabel(proxy);
        }).catch(() => {});
      });
      wrap.onchange = async (e) => {
        const sel = e.target.closest('select[data-pi]'); if (!sel) return;
        const i = +sel.dataset.pi, n = names[i]; if (n == null) return;
        const val = sel.value;
        msg.textContent = 'saving…'; msg.className = 'smsg';
        try {
          // The server merges settings on PUT (see #exitPanel / blockPasskeys), so proxy alone is safe.
          await api('/v1/profiles/' + encodeURIComponent(n) + '/settings',
            { method:'PUT', body: JSON.stringify({ proxy: val || null }) });
          const ps = el('setPs' + i); if (ps) ps.textContent = proxyLabel(val);
          msg.textContent = 'Saved — takes effect on the next session for “' + n + '”.'; msg.className = 'smsg ok';
        } catch (err) { msg.textContent = err.message; msg.className = 'smsg bad'; }
      };
    } catch (e) {
      wrap.innerHTML = '<div class="sempty">Could not load logins.</div>';
      msg.textContent = e.message; msg.className = 'smsg bad';
    }
  }

  // Render whenever the dashboard becomes visible: enter() reveals it after login, and the back
  // button reveals it again — without either having to know this controller exists. The drawer's
  // open state lives on .dwrap, so this observer never fires for it.
  /*
   * A DEEP LINK TO ONE WALK: #job=<id>.
   *
   * An organ sends somebody here to WATCH the browser do the thing they just approved. Creating a
   * Facebook page fills a real form and clicks through a real flow for several minutes, and a
   * progress bar during that says nothing — it is the moment somebody most wants to see what is
   * happening, both to trust it and to step in. Landing them on the account board and asking them to
   * find the right row is the same as not linking at all.
   *
   * Consumed once: it opens the live view on that job and then leaves the hash alone, so pressing
   * back to the board and forward again does not yank the person into it a second time.
   */
  let deepLinked = false;
  function followDeepLink() {
    if (deepLinked) return;
    const m = (location.hash || '').match(/[#&]job=([^&]+)/);
    if (!m) return;
    deepLinked = true;
    const id = decodeURIComponent(m[1]);
    showApp();
    if (typeof loadRoles === 'function') loadRoles();
    if (typeof followJob === 'function') followJob(id);
  }

  new MutationObserver(() => {
    if (dash.classList.contains('hide')) { closeDrawer(); return; }
    showAccounts();   // always land on the Accounts view on a fresh entry
    refresh();
    /* After the board is up, because the deep link takes the person straight off it again. */
    followDeepLink();
  }).observe(dash, { attributes: true, attributeFilter: ['class'] });
  // Keep "Live now" fresh while the board is on screen.
  setInterval(() => { if (!dash.classList.contains('hide')) refresh(); }, 12000);
})();
