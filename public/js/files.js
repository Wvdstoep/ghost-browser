/*
 * The Files tab — every generated asset across ALL sessions, in one place, so nothing the factory
 * makes (images, voiceovers, music, per-scene clips, screen recordings) is lost or invisible. It reads
 * the cross-session store via /v1/files and shows each file inline: images render, video and audio
 * play, everything is downloadable. Its own module, filled into #dashFilesView on demand — the same
 * pattern as the Roles marketplace and the Automation workbench.
 */
(function () {
  const view = document.getElementById('dashFilesView');
  if (!view) return;

  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const size = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const when = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };
  const icon = (m) => (/video/.test(m) ? '🎬' : /audio/.test(m) ? '🎵' : /image/.test(m) ? '🖼️' : '📄');
  const url = (id) => (typeof mounted === 'function' ? mounted : (p) => p)('/v1/files/' + encodeURIComponent(id) + '/raw');

  if (!document.getElementById('filesCss')) {
    const s = document.createElement('style'); s.id = 'filesCss';
    s.textContent = `
      #dashFilesView .fhead{color:var(--faint,#8a93a6);font-size:13px;margin:2px 2px 14px}
      #dashFilesView .fempty,#dashFilesView .fnote{color:var(--faint,#8a93a6);padding:40px 8px;text-align:center;max-width:520px;margin:0 auto;line-height:1.5}
      #dashFilesView .fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
      #dashFilesView .fcard{background:var(--card,#11151c);border:1px solid var(--line,#232a36);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
      #dashFilesView .fmedia{aspect-ratio:16/10;background:#0b0e13;display:flex;align-items:center;justify-content:center;overflow:hidden}
      #dashFilesView .fmedia img,#dashFilesView .fmedia video{width:100%;height:100%;object-fit:contain;background:#0b0e13}
      #dashFilesView .fmedia audio{width:92%}
      #dashFilesView .fico{font-size:44px;opacity:.5}
      #dashFilesView .fmeta{padding:10px 12px;display:flex;flex-direction:column;gap:3px}
      #dashFilesView .fkind{font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--faint,#8a93a6)}
      #dashFilesView .fname{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #dashFilesView .fsub{font-size:12px;color:var(--faint,#8a93a6)}
      #dashFilesView .facts{display:flex;gap:8px;margin-top:8px}
      #dashFilesView .fbtn{font-size:12px;padding:5px 10px;border-radius:7px;border:1px solid var(--line,#232a36);background:transparent;color:inherit;text-decoration:none;cursor:pointer}
      #dashFilesView .fbtn.del{color:var(--bad,#e5534b);margin-left:auto}
      #dashFilesView .fbtn:hover{background:var(--line,#232a36)}`;
    document.head.appendChild(s);
  }

  function card(f) {
    const raw = url(f.id);
    let media;
    if (/^image\//.test(f.mime)) media = '<img loading="lazy" src="' + raw + '">';
    else if (/^video\//.test(f.mime)) media = '<video controls preload="metadata" src="' + raw + '"></video>';
    else if (/^audio\//.test(f.mime)) media = '<audio controls preload="none" src="' + raw + '"></audio>';
    else media = '<div class="fico">📄</div>';
    return '<div class="fcard"><div class="fmedia">' + media + '</div>'
      + '<div class="fmeta"><span class="fkind">' + icon(f.mime) + ' ' + esc(f.kind || 'file') + '</span>'
      + '<span class="fname" title="' + esc(f.name || f.id) + '">' + esc(f.name || f.id) + '</span>'
      + '<span class="fsub">' + size(f.size || 0) + ' · ' + esc(when(f.at)) + '</span>'
      + '<div class="facts"><a class="fbtn" href="' + raw + '?download=1" target="_blank" rel="noreferrer">Download</a>'
      + '<button class="fbtn del" data-del="' + esc(f.id) + '">Delete</button></div></div></div>';
  }

  async function load() {
    view.innerHTML = '<div class="fnote">Loading files…</div>';
    let r;
    try { r = await api('/v1/files'); } catch (e) { view.innerHTML = '<div class="fnote">Could not load files: ' + esc(e.message) + '</div>'; return; }
    const files = r.files || [];
    if (!files.length) { view.innerHTML = '<div class="fempty">No files yet.<br>Generated images, voiceovers, music and video clips land here — across every session — as the factory produces them.</div>'; return; }
    view.innerHTML = '<div class="fhead">' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' · ' + size(r.bytes || 0) + ' · across all sessions</div>'
      + '<div class="fgrid">' + files.map(card).join('') + '</div>';
    view.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { if (!confirm('Delete this file permanently?')) return; try { await api('/v1/files/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); } catch (e) {} load(); }; });
  }

  window.Files = { load };
})();
