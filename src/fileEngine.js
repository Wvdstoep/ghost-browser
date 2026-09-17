/**
 * THE FILE ENGINE — the rules for every file that leaves a page, in one place.
 *
 * A page hands a file over in four ways, and each used to be its own accident: the browser's download
 * event (a Save dialog the pool self-saves), a new tab that just SHOWS the file (an image, a PDF, a
 * video opened inline — Google Flow, many "open in new tab" links), an <img> the agent takes out of
 * the page (download_image), and a plain link to a file (download_file). All four end in the file
 * store (fileAssets) with a name, a mime, a kind and where it came from; the assistant lists and
 * shows them; the app saves them to the device. These helpers decide names, kinds and what to capture.
 */
const path = require('path');

const KIND_BY_MIME = [[/^image\//, 'image'], [/^video\//, 'video'], [/^audio\//, 'audio'], [/pdf/, 'document'], [/zip|x-tar|gzip|x-7z|x-rar/, 'archive'], [/msword|officedocument|opendocument|text\/csv|text\/plain|json/, 'document']];
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'application/pdf': 'pdf', 'application/zip': 'zip', 'application/json': 'json', 'text/csv': 'csv', 'text/plain': 'txt' };
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));
MIME_BY_EXT.jpeg = 'image/jpeg';

/** image | video | audio | document | archive | file */
function kindOf(mime) { const m = String(mime || '').toLowerCase(); for (const [rx, k] of KIND_BY_MIME) if (rx.test(m)) return k; return 'file'; }
function extFor(mime) { return EXT_BY_MIME[String(mime || '').toLowerCase().split(';')[0].trim()] || 'bin'; }
function mimeFor(name) { const e = String(name || '').split('.').pop().toLowerCase(); return MIME_BY_EXT[e] || 'application/octet-stream'; }

/** A response a page navigated to that IS a file (not a page): worth capturing when it is inline in a tab. */
function shouldCapture(contentType, contentLength) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (!ct || /^text\/html|^application\/xhtml|^text\/javascript|^application\/javascript|^text\/css/.test(ct)) return false;
  const k = kindOf(ct); if (k === 'file' && ct !== 'application/octet-stream') return false;
  const len = Number(contentLength); if (Number.isFinite(len) && len > 200 * 1024 * 1024) return false;   // 200 MB: keep memory sane
  return true;
}

/** The file's name: Content-Disposition first, then the url's last segment, then a stamp — always with an extension that fits the mime. */
function nameFrom({ contentDisposition = '', url = '', mime = '' } = {}) {
  let name = '';
  const cd = String(contentDisposition || '');
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i); const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (star) { try { name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { name = star[1].trim(); } }
  else if (plain) name = plain[1].trim();
  if (!name) { try { const u = new URL(String(url)); const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || ''); if (seg && /\.[a-z0-9]{2,5}$/i.test(seg)) name = seg; } catch { /* no url */ } }
  if (!name) name = `file-${Date.now()}`;
  name = name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  const ext = extFor(mime);
  if (mime && ext !== 'bin' && !new RegExp(`\\.${ext}$`, 'i').test(name) && !(ext === 'jpg' && /\.jpeg$/i.test(name))) name = name.replace(/\.[a-z0-9]{2,5}$/i, '') + '.' + ext;
  return name;
}

/** One line the chat and the log show for a captured file. */
function describe(f) { return `${f.name || 'file'} (${kindOf(f.mime)}, ${Math.round((f.size || (f.bytes && f.bytes.length) || 0) / 1024)} KB${f.source ? `, from ${f.source}` : ''})`; }

module.exports = { kindOf, extFor, mimeFor, shouldCapture, nameFrom, describe, path };
