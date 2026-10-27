'use strict';
const { buildReplay, afterReplay } = require('./routecards');

// A transport acknowledgement is not proof that an action happened.
function classifyResponse(result = {}) {
  const status = Number(result.status) || 0;
  const text = String(result.text || '');
  const url = String(result.url || '');
  if (status === 401 || /\/(login(?:\.php)?|signin|checkpoint|accounts\/login)([/?#]|$)/i.test(url)
      || /accounts\.google\.[^/]+\//i.test(url)
      || /<form[^>]+(?:login|signin)|id=["']login_form|name=["']login["']/i.test(text)) {
    return { kind: 'login_required', message: 'Sign in to the site in this browser, then run the task again.' };
  }
  let data = result.data;
  if (data === undefined) {
    try { data = JSON.parse(text.replace(/^for\s*\(;;\);\s*/, '')); } catch {}
  }
  const errors = data && (data.errors || data.error);
  if (errors && (!Array.isArray(errors) || errors.length)) {
    if (/"(?:code|error_subcode)"\s*:\s*(?:102|190|1348006)\b|not logged in|login required|session expired/i.test(JSON.stringify(errors))) {
      return { kind: 'login_required', message: 'The site session expired. Sign in, then run the task again.' };
    }
    const first = Array.isArray(errors) ? errors[0] : errors;
    const detail = typeof first === 'object' ? String(first.message || first.summary || first.code || '') : String(first);
    const safe = detail.replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]').replace(/[\r\n]+/g, ' ').slice(0, 240);
    return { kind: 'application_error', message: 'The site returned an application error' + (safe ? ' (site says: ' + safe + ')' : '') + '; inspect the page and choose the next step.' };
  }
  if (result.notSent) return { kind: 'not_applicable', message: 'The request was not sent because live session fields are unavailable. Inspect the page.' };
  if (data && (data.ok === false || data.success === false)) return { kind: 'application_error', message: 'The site rejected the action.' };
  if (status < 200 || status >= 300) return { kind: status ? 'http_error' : 'uncertain', message: 'Request returned ' + (status || 'no response') + '. Inspect before retrying.' };
  return { kind: 'unconfirmed', message: 'Request accepted; the intended effect still needs verification.' };
}

async function attemptReplay({ card, values = {}, runInPage, ensureOrigin = null, verify = null, prepare = null, now = 0 }) {
  const request = buildReplay(card, values);
  if (!request) return { done: false, healed: false, card, status: null, kind: 'not_applicable', reason: 'the card cannot be rebuilt from the values at hand - walking the UI' };
  if (ensureOrigin) {
    try {
      const at = await ensureOrigin(card.origin);
      if (typeof at === 'string' && classifyResponse({status:200,url:at}).kind === 'login_required') return {done:false,healed:false,card,status:200,kind:'login_required',stop:true,reason:'Sign in to the site in this browser, then run the task again.'};
    }
    catch { return { done: false, healed: false, card, status: null, kind: 'not_applicable', reason: 'could not reach the origin - walking the UI' }; }
  }
  let baseline;
  if (prepare) {
    try { baseline = await prepare({ card, values }); }
    catch { return { done: false, healed: false, card, kind: 'not_applicable', status: null, reason: 'Could not prepare independent verification; request not sent.' }; }
    if (baseline && baseline.kind === 'login_required') return { done:false,healed:false,card,status:null,kind:'login_required',stop:true,reason:'Sign in to the site, then run the task again.' };
    if (!baseline || !Number.isFinite(baseline.count)) return { done: false, healed: false, card, kind: 'not_applicable', status: null, reason: 'Verification baseline unavailable; request not sent.' };
  }
  let result;
  try { result = await runInPage(request); } catch { result = { status: 0 }; }
  result = result || {};
  const status = Number(result.status) || 0;
  let verdict = classifyResponse(result);
  if (verdict.kind === 'login_required') return { done: false, healed: false, card, status, ...verdict, reason: verdict.message, stop: true };
  if (verdict.kind === 'not_applicable') return { done: false, healed: false, card, status, kind: verdict.kind, reason: verdict.message };
  if (verdict.kind === 'unconfirmed' && verify) {
    try {
      const proof = await verify({ card, values, result, baseline });
      if (proof === true || (proof && proof.confirmed === true)) verdict = { kind: 'success', message: 'The intended effect was independently verified.' };
      else if (proof && proof.kind === 'login_required') return { done: false, healed: false, card, status, kind: proof.kind, stop: true, reason: 'Sign in to the site, then run the task again.' };
    } catch {}
  }
  const done = verdict.kind === 'success';
  const outcome = afterReplay(card, { ok: done, now });
  return { done, healed: !done, card: outcome.card, status, kind: verdict.kind, inspectBeforeRetry: !done,
    reason: done ? verdict.message : verdict.message + ' The card is quarantined; inspect the current state before any new write.' };
}

// Runs in Chromium. Resolve authentication from this session, never the recording.
const IN_PAGE_FETCH = async (r) => {
  if (/\/(login(?:\.php)?|signin|checkpoint)([/?#]|$)/i.test(location.href) || /accounts\.google\./i.test(location.hostname)) return { status: 401, url: location.href, notSent: true };
  if (new URL(r.url, location.href).origin !== location.origin) return { status: 0, error: 'origin mismatch', notSent: true };
  function liveToken(name) {
    const aliases = { 'x-fb-lsd': ['lsd'], 'fb-dtsg': ['fb_dtsg'] };
    for (const key of [name, ...(aliases[name] || [])]) {
      try {
        const input = document.querySelector('input[name="' + CSS.escape(key) + '"]');
        if (input && input.value) return input.value;
        const meta = document.querySelector('meta[name="' + CSS.escape(key) + '"]');
        if (meta && meta.content) return meta.content;
        for (const cookie of document.cookie.split(';')) {
          const at = cookie.indexOf('=');
          if (cookie.slice(0, at).trim() === key) return decodeURIComponent(cookie.slice(at + 1));
        }
      } catch {}
    }
    return null;
  }
  const headers = {};
  const values = { ...(r.constants || {}), ...(r.values || {}) };
  for (const name of r.liveSlots || []) {
    const value = liveToken(name);
    if (value == null) return { status: 0, error: 'missing live session fields', notSent: true };
    values[name] = value;
  }
  for (const a of r.authAt || []) {
    const token = liveToken(a.name);
    if (token == null) return { status: 0, error: 'live authentication field unavailable', notSent: true };
    if (a.in === 'header') headers[a.name] = token;
    else values[a.name] = token;
  }
  let body;
  if (r.bodyKind === 'json') { headers['content-type'] = 'application/json'; body = JSON.stringify(values); }
  else if (r.bodyKind === 'form') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(Object.entries(values).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString();
  }
  try {
    const response = await fetch(r.url, { method: r.method, headers, body, credentials: 'include' });
    const text = await response.text();
    return { status: response.status, url: response.url, redirected: response.redirected,
      contentType: response.headers.get('content-type'), text: text.slice(0, 65536), truncated: text.length > 65536 };
  } catch { return { status: 0, error: 'request failed; outcome unknown' }; }
};

// Declarative same-origin readback; no generated JavaScript or off-origin credential requests.
const IN_PAGE_VERIFY = async ({ spec, values, baseline }) => {
  if (!spec || typeof spec.url !== 'string' || !Array.isArray(spec.path) || !spec.match) return false;
  const url = new URL(spec.url.replace(/\{\{(\w+)\}\}/g, (_, k) => encodeURIComponent(String(values[k] ?? ''))), location.href);
  if (url.origin !== location.origin) return false;
  const response = await fetch(url.href, { credentials: 'include', cache: 'no-store' });
  if (/\/(login(?:\.php)?|signin|checkpoint)([/?#]|$)/i.test(response.url) || /accounts\.google\./i.test(new URL(response.url).hostname)) return {kind:'login_required'};
  if (!response.ok || response.redirected) return false;
  let data = await response.json();
  for (const key of spec.path) data = data && data[key];
  const expected = values[spec.match.slot];
  if (expected == null || expected === '') return false;
  const count = (Array.isArray(data) ? data : [data]).filter(row => (spec.match.field ? row && row[spec.match.field] : row) === expected).length;
  return { count, confirmed: !!baseline && Number.isFinite(baseline.count) && count > baseline.count };
};
module.exports = { attemptReplay, IN_PAGE_FETCH, IN_PAGE_VERIFY, classifyResponse };
