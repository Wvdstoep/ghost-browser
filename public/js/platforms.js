/*
 * The Platforms tab — every platform the agent knows, whether we are signed in to it, and the rules
 * that keep the account alive.
 *
 * WHY IT EXISTS. Until now "which platforms can this thing work, and am I signed in to them?" had no
 * answer anywhere: the knowledge sat in three services' source, the logins sat in Accounts, and the
 * two were only connected in somebody's head. A walk on a platform with no login runs signed out and
 * reports nothing useful, and nothing about that looks broken. This page joins the two halves, and it
 * is also where the rules are edited — the read pace and whether a private message may be sent at all
 * — which used to need an edit in three repositories and a deploy.
 *
 * Its own module, filled into #dashPlatformsView on demand: the same pattern as Roles and Files.
 */
(function () {
  const view = document.getElementById('dashPlatformsView');
  if (!view) return;

  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mins = (ms) => Math.round(Number(ms || 0) / 60000);
  const when = (iso) => { if (!iso) return 'never'; try { const d = new Date(iso); return isNaN(d) ? 'never' : d.toLocaleString(); } catch { return 'never'; } };

  /* What each answer MEANS, in the words an owner would use — the rules only work if they are read. */
  const DM = {
    ok: { cls: 'ok', text: 'A first message is fine here', why: 'A business platform: people expect to be written to about their work.' },
    'invited-only': { cls: 'warn', text: 'Only after they write first', why: 'A stranger’s message is out of place here. Once they answer in public — "DM me", an address — the conversation may go private.' },
    never: { cls: 'no', text: 'No private messages', why: 'A cold message lands in a request folder nobody opens, and asking is the fastest way to lose the account.' },
  };
  const KIND = { business: 'Business', community: 'Community', personal: 'Personal', search: 'Search', freelance: 'Freelance' };

  if (!document.getElementById('platformsCss')) {
    const s = document.createElement('style'); s.id = 'platformsCss';
    s.textContent = `
      #dashPlatformsView .phead{color:var(--faint,#8a93a6);font-size:13px;margin:2px 2px 14px;max-width:70ch;line-height:1.5}
      #dashPlatformsView .pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
      #dashPlatformsView .pcard{background:var(--card,#11151c);border:1px solid var(--line,#232a36);border-radius:12px;padding:14px 15px;display:flex;flex-direction:column;gap:9px}
      #dashPlatformsView .pcard.off{opacity:.72}
      #dashPlatformsView .ptop{display:flex;align-items:center;gap:8px}
      #dashPlatformsView .pname{font-weight:600;font-size:15px}
      #dashPlatformsView .pkind{font-size:11px;color:var(--faint,#8a93a6);border:1px solid var(--line,#232a36);border-radius:99px;padding:1px 8px}
      #dashPlatformsView .dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
      #dashPlatformsView .dot.on{background:#3fb950;box-shadow:0 0 0 3px rgba(63,185,80,.18)}
      #dashPlatformsView .dot.off{background:#5b6472}
      #dashPlatformsView .pline{font-size:12.5px;color:var(--faint,#8a93a6);line-height:1.45}
      #dashPlatformsView .pline b{color:var(--ink,#e6e9ef);font-weight:600}
      #dashPlatformsView .rule{display:flex;align-items:center;gap:6px;font-size:12.5px}
      #dashPlatformsView .rule .tag{font-size:11px;border-radius:6px;padding:1px 7px;font-weight:600}
      #dashPlatformsView .tag.ok{background:rgba(63,185,80,.14);color:#3fb950}
      #dashPlatformsView .tag.warn{background:rgba(210,153,34,.16);color:#d29922}
      #dashPlatformsView .tag.no{background:rgba(139,148,158,.16);color:#8b949e}
      #dashPlatformsView .prow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px}
      #dashPlatformsView .pbtn{background:transparent;border:1px solid var(--line,#232a36);color:var(--ink,#e6e9ef);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
      #dashPlatformsView .pbtn:hover{border-color:#3fb950;color:#3fb950}
      #dashPlatformsView .pbtn[disabled]{opacity:.45;cursor:default}
      #dashPlatformsView .pin{width:64px;background:var(--bg,#0b0e13);border:1px solid var(--line,#232a36);color:var(--ink,#e6e9ef);border-radius:6px;padding:3px 6px;font-size:12px}
      #dashPlatformsView .refuse{font-size:12px;color:#d29922}
      #dashPlatformsView .pempty{color:var(--faint,#8a93a6);padding:40px 8px;text-align:center}
    `;
    document.head.appendChild(s);
  }

  function card(p) {
    const dm = DM[p.dm] || DM.never;
    const roles = [p.roles && p.roles.scan, p.roles && p.roles.scout].filter(Boolean);
    return `
      <div class="pcard ${p.signedIn ? '' : 'off'}" data-key="${esc(p.key)}">
        <div class="ptop">
          <span class="dot ${p.signedIn ? 'on' : 'off'}"></span>
          <span class="pname">${esc(p.label)}</span>
          <span class="pkind">${esc(KIND[p.kind] || p.kind || '')}</span>
        </div>
        <div class="pline">${p.signedIn
          ? `Signed in — <b>${esc(p.servedBy)}</b> holds this login${p.loginProfile && p.loginProfile !== p.servedBy ? ` (it signs in through ${esc(p.loginProfile)})` : ''}.`
          : `<b>Not signed in.</b> Add it on the Accounts page — until then a walk here runs signed out and finds nothing.`}</div>
        <div class="rule" title="${esc(dm.why)}"><span class="tag ${dm.cls}">${esc(dm.text)}</span></div>
        <div class="pline">
          Reads every <b class="gapv">${mins(p.readGapMs)}</b> min · at most <b>${Number(p.repliesPerDay || 0)}</b> ${Number(p.repliesPerDay) === 1 ? 'reply' : 'replies'} per room a day${roles.length ? ` · ${esc(roles.join(', '))}` : ''}
        </div>
        <div class="pline">Last used ${esc(when(p.lastUsedAt))}</div>
        ${p.lastRefusal ? `<div class="refuse">Pushed back ${esc(when(p.lastRefusalAt))} — ${esc(p.lastRefusal)}</div>` : ''}
        <div class="prow">
          <label class="pline">pace <input class="pin" type="number" min="1" max="360" value="${mins(p.readGapMs)}" data-gap="${esc(p.key)}"> min</label>
          <button class="pbtn" data-save="${esc(p.key)}">Save</button>
          <button class="pbtn" data-reset="${esc(p.key)}">Back to default</button>
        </div>
      </div>`;
  }

  async function load() {
    view.innerHTML = '<div class="pempty">Loading…</div>';
    let r;
    try { r = await api('/v1/platforms'); }
    catch (e) { view.innerHTML = '<div class="pempty">Could not load the platforms: ' + esc(e.message) + '</div>'; return; }
    const list = (r && r.platforms) || [];
    const on = list.filter((p) => p.signedIn).length;
    view.innerHTML = `
      <div class="phead">
        The platforms this browser knows, and whether a login exists for each — <b>${on} of ${list.length} signed in</b>.
        Herald and LeadFlow both read this list: it decides which profile a walk opens in, how fast a
        platform may be read, and whether a private message may be sent there at all. Change a rule here
        and both obey it — no deploy.
      </div>
      <div class="pgrid">${list.map(card).join('')}</div>`;

    view.querySelectorAll('[data-save]').forEach((b) => { b.onclick = async () => {
      const key = b.dataset.save;
      const input = view.querySelector(`[data-gap="${CSS.escape(key)}"]`);
      const minutes = Math.max(1, Math.min(360, parseInt(input && input.value, 10) || 15));
      b.disabled = true;
      try { await api('/v1/platforms/' + encodeURIComponent(key), { method: 'PUT', body: JSON.stringify({ readGapMs: minutes * 60000 }) }); }
      catch (e) { alert('Could not save that: ' + e.message); }
      b.disabled = false; load();
    }; });
    view.querySelectorAll('[data-reset]').forEach((b) => { b.onclick = async () => {
      b.disabled = true;
      try { await api('/v1/platforms/' + encodeURIComponent(b.dataset.reset) + '/override', { method: 'DELETE' }); }
      catch (e) { alert('Could not reset that: ' + e.message); }
      b.disabled = false; load();
    }; });
  }

  window.Platforms = { load };
})();
