'use strict';

function inputs(value) {
  const business = String(value.business || '').trim();
  const city = String(value.city || '').trim();
  const categoryTerms = (Array.isArray(value.categoryTerms) ? value.categoryTerms : [business]).map(x => String(x).trim()).filter(Boolean).slice(0, 12);
  if (!business || !city || business.length > 160 || city.length > 160 || !categoryTerms.length) throw new Error('Business type, city and category terms are required.');
  return { business, city, categoryTerms, limit: Math.min(25, Math.max(1, Math.floor(Number(value.limit) || 10))) };
}
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const contains = (value, term) => (' ' + fold(value) + ' ').includes(' ' + fold(term) + ' ');

// DOM contracts rather than pixel coordinates or opaque Maps RPC bodies.
// These functions are serialized by Playwright and must have no external dependencies.
function readSearch() {
  const text = document.body.innerText || '';
  const url = location.href;
  if (/consent\.google\./.test(location.hostname) || /before you continue|voordat je verdergaat|voordat u verdergaat/i.test(text)) return { kind: 'consent_required' };
  if (/\/sorry\/|unusual traffic|ongebruikelijk verkeer|captcha/i.test(url + ' ' + text)) return { kind: 'challenge_required' };
  if (/accounts\.google\./.test(location.hostname)) return { kind: 'login_required' };
  const box = document.querySelector('#searchboxinput, input[name="q"], input[role="combobox"]');
  const links = [...document.querySelectorAll('[role="feed"] a[href*="/maps/place/"]')].map(a => ({ url: a.href, name: a.getAttribute('aria-label') || a.innerText || '' }));
  return { kind: 'results', query: box && box.value || new URL(url).searchParams.get('query') || '', links };
}
function readPlace() {
  const main = document.querySelector('[role="main"]') || document;
  const name = (main.querySelector('h1')?.innerText || '').trim();
  const category = (main.querySelector('button[jsaction*="category"], button[data-category]')?.innerText || '').trim();
  const read = selector => {
    const el = main.querySelector(selector);
    return el ? (el.getAttribute('aria-label') || el.innerText || '').replace(/^(address|adres|phone|telefoon):\s*/i, '').trim() : '';
  };
  return { name, category, address: read('[data-item-id="address"]'), phone: read('[data-item-id^="phone:tel:"]'),
    website: main.querySelector('a[data-item-id="authority"]')?.href || '', mapsUrl: location.href };
}

async function rejectOptionalConsent(page) {
  if (!/^https:\/\/consent\.google\.[a-z.]+\//i.test(page.url())) return false;
  const button = page.getByRole('button', { name: /^(Alles afwijzen|Reject all|Alle ablehnen|Tout refuser|Rechazar todo|Rifiuta tutto)$/i });
  if (await button.count() !== 1) return false;
  await button.click();
  await page.waitForURL(url => !/^consent\.google\./.test(url.hostname), { timeout: 15000 }).catch(() => {});
  return !/^https:\/\/consent\.google\./.test(page.url());
}

async function searchPlaces(page, raw, { store = null, timeout = 20000, baseUrl = 'https://www.google.com' } = {}) {
  const input = inputs(raw);
  // baseUrl is injectable for fixture tests, not accepted from the agent's tool arguments.
  const query = input.business + ' ' + input.city;
  const intent = 'routine.google.maps.search.v1';
  const previous = store && store.get('https://www.google.com', intent);
  const url = baseUrl + '/maps/search/?api=1&query=' + encodeURIComponent(query);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => document.querySelector('[role="feed"], h1, form[action*="consent"]') || /consent\.google\.|accounts\.google\./.test(location.hostname), null, { timeout }).catch(() => {});
  let state = await page.evaluate(readSearch);
  if (state.kind === 'consent_required' && await rejectOptionalConsent(page)) {
    await page.waitForFunction(() => !!document.querySelector('[role="feed"] a[href*="/maps/place/"], h1'), null, { timeout }).catch(() => {});
    state = await page.evaluate(readSearch);
  }
  if (state.kind !== 'results') return { ...state, input, leads: [], complete: false };
  // An old list left visible by a failed SPA navigation is not the new search.
  if (fold(state.query) !== fold(query)) return { kind: 'unconfirmed', reason: 'The visible search does not match this request.', input, leads: [], complete: false };
  const links = new Map();
  for (let round = 0; round < 5; round++) {
    for (const row of state.links) {
      try {
        const u = new URL(row.url);
        if (u.origin === new URL(baseUrl).origin && u.pathname.startsWith('/maps/place/')) links.set(u.href, row);
      } catch {}
    }
    if (links.size >= input.limit * 2) break;
    const before = links.size;
    await page.evaluate(() => { const feed = document.querySelector('[role="feed"]'); if (feed) feed.scrollTop = feed.scrollHeight; });
    await page.waitForTimeout(500);
    state = await page.evaluate(readSearch);
    if (state.kind !== 'results') return { ...state, input, leads: [], complete: false };
    if (state.links.every(row => links.has(row.url)) && before === links.size) break;
  }
  const leads = [], rejected = [], seen = new Set();
  for (const row of [...links.values()].slice(0, 50)) {
    if (leads.length >= input.limit) break;
    await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => !!document.querySelector('h1'), null, { timeout }).catch(() => {});
    const gate = await page.evaluate(readSearch);
    if (gate.kind !== 'results') return { ...gate, input, leads, rejected, complete: false };
    const place = await page.evaluate(readPlace);
    if (!place.name || !place.category || !contains(place.address, input.city) || !input.categoryTerms.some(term => contains(place.category, term))) {
      rejected.push({ name: place.name, reason: 'Missing details or category/city does not match.' });
      continue;
    }
    const key = fold(place.name + ' ' + place.address);
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push({ ...place, city: input.city, kind: 'place', platform: 'google', url: place.mapsUrl, postUrl: place.mapsUrl,
      why: 'Category and address read from Maps match ' + query, sourceQuery: query });
  }
  const result = { kind: leads.length ? 'success' : 'unconfirmed', input, query, leads, rejected,
    complete: leads.length >= input.limit, mode: previous && previous.routineVersion === 1 ? 'replay' : 'record' };
  // The card contains a reusable contract only. Never retain the old query, businesses or results.
  if (store && leads.length) store.put({ origin: 'https://www.google.com', intent, kind: 'browser-routine',
    routine: 'google.maps.search', routineVersion: 1, inputKeys: ['business','city','categoryTerms','limit'],
    learnedAt: previous?.learnedAt || Date.now(), lastVerified: Date.now(), confidence: Math.min(5, (previous?.confidence || 0) + 1) });
  return result;
}
module.exports = { inputs, contains, readSearch, readPlace, searchPlaces, rejectOptionalConsent };
