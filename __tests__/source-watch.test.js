/*
 * A SOURCES WATCHER READS FROM THE SERVER AND ONLY FROM THE SERVER.
 *
 * The first OSINT walk through the browser moved a Russian court's search page to the owner's phone,
 * and the page printed the owner's mobile IP and city. The browser exits through the tailnet (the
 * owner's device) and hands walled sessions to the device ring — both right for a shop, both wrong
 * here. These tests hold the line: no browser, no device, no tailnet in the pass; a refused page is
 * recorded as blocked and never retried elsewhere; only new things reach the feed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PROFILE_DIR = mkdtempSync(join(tmpdir(), 'gb-sources-'));
const require = createRequire(import.meta.url);
const sw = require('../src/sourceWatch');
const feed = require('../src/watcherFeed');
const src = (f) => readFileSync(fileURLToPath(new URL('../src/' + f, import.meta.url)), 'utf8');

const publicLookup = async () => [{ address: '93.184.216.34' }];
const res = (status, body, headers = {}) => ({
  status, ok: status < 400,
  headers: { get: (k) => headers[k.toLowerCase()] ?? (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer, body: null,
  json: async () => JSON.parse(body),
});
const tgPage = (posts) => '<html><body>' + posts.map(([id, text]) => `<div class="tgme_widget_message" data-post="klops_news/${id}"><div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div><time datetime="2026-11-05T10:00:00+00:00"></time></div>`).join('') + '</body></html>';
const newsPage = (heads) => '<html><head><title>x</title></head><body><nav><a href="/kontakt">Kontakt</a><a href="/news">News</a></nav>'
  + heads.map(([href, t]) => `<a href="${href}">${t}</a>`).join('') + '<a href="https://facebook.com/share?u=1">Share this article on Facebook right now please</a></body></html>';

let n = 0;
const wid = () => 'sources-test-' + (++n);
const noSleep = async () => {};

describe('reading a page', () => {
  it('takes one item per Telegram post, keyed by the post id', () => {
    const items = sw.extractTelegram(tgPage([['101', 'Под Черняховском разбился военный самолёт &laquo;Су-30&raquo;'], ['102', 'short']]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'tg:klops_news/101', url: 'https://t.me/klops_news/101', published: '2026-11-05T10:00:00+00:00' });
    expect(items[0].title).toContain('«Су-30»');
  });

  it('takes same-site headline links, drops menus, other sites and tracking parameters', () => {
    const items = sw.extractHeadlines(newsPage([
      ['/2026/11/05/strzelanie-na-poligonie?utm_source=fb', 'Ćwiczenia wojsk przy granicy z Królewcem potrwają do piątku'],
      ['https://www.tko.pl/x', 'Bartoszyce: nowe utrudnienia na przejściu granicznym Bezledy dziś'],
    ]), 'https://tko.pl/');
    expect(items.map((i) => i.url)).toEqual(['https://tko.pl/2026/11/05/strzelanie-na-poligonie', 'https://www.tko.pl/x']);
  });

  it('calls a refusal a wall, and a long news page that mentions a captcha not one', () => {
    expect(sw.isWall(429, 'whatever')).toBe(true);
    expect(sw.isWall(200, 'Just a moment... checking your browser')).toBe(true);
    expect(sw.isWall(200, 'Проверка браузера, подождите')).toBe(true);
    expect(sw.isWall(200, 'news '.repeat(1000) + 'captcha')).toBe(false);
  });

  it('decodes a windows-1251 page', () => {
    const buf = Buffer.from([0xcf, 0xee, 0xeb, 0xfc, 0xf8, 0xe0]);   // "Польша"
    expect(sw.decode(buf, 'text/html; charset=windows-1251')).toBe('Польша');
  });
});

describe('only public https is read', () => {
  it('refuses http, credentials, odd ports, internal names and private addresses', async () => {
    await expect(sw.assertPublicUrl('http://example.com', { lookup: publicLookup })).rejects.toThrow(/https/);
    await expect(sw.assertPublicUrl('https://u:p@example.com', { lookup: publicLookup })).rejects.toThrow(/credentials/);
    await expect(sw.assertPublicUrl('https://example.com:8443', { lookup: publicLookup })).rejects.toThrow(/port/);
    await expect(sw.assertPublicUrl('https://ghost-browser.pod.svc', { lookup: publicLookup })).rejects.toThrow(/internal/);
    await expect(sw.assertPublicUrl('https://10.0.0.5/')).rejects.toThrow(/private/);
    await expect(sw.assertPublicUrl('https://evil.example', { lookup: async () => [{ address: '169.254.169.254' }] })).rejects.toThrow(/private/);
    await expect(sw.assertPublicUrl('https://example.com', { lookup: publicLookup })).resolves.toBeTruthy();
    expect(sw.isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(sw.isPrivateIp('100.101.1.1')).toBe(true);   // a tailnet address is not public either
  });

  it('checks every redirect hop, so a public page cannot bounce the read into the cluster', async () => {
    const fetchImpl = async (u) => (u.startsWith('https://example.com') ? res(302, '', { location: 'https://internal.example/' }) : res(200, 'x'));
    const lookup = async (h) => (h === 'internal.example' ? [{ address: '10.43.0.1' }] : [{ address: '93.184.216.34' }]);
    await expect(sw.fetchPage('https://example.com/', { fetchImpl, lookup })).rejects.toThrow(/private/);
  });

  it('keeps only https sources in the config', () => {
    const s = sw.normalizeSources([{ id: 'klops', url: 'https://t.me/s/klops_news', lang: 'ru' }, { id: 'bad', url: 'http://x.ru' }, { url: 'javascript:alert(1)' }]);
    expect(s.map((x) => [x.id, x.kind])).toEqual([['klops', 'telegram']]);
  });
});

describe('a pass files only what is new', () => {
  let clock;
  beforeEach(() => { clock = Date.parse('2026-11-05T08:00:00Z'); });
  const cfg = { sources: [{ id: 'klops', name: 'Klops', url: 'https://t.me/s/klops_news', lang: 'ru' }], keywords: ['Польш', 'Черняхов'] };
  const run = (id, page, opts = {}) => sw.pass(id, cfg, { feed, lookup: publicLookup, sleep: noSleep, now: () => clock, fetchImpl: async () => res(200, page), ...opts });

  it('first pass is a baseline: it remembers everything and files only keyword hits', async () => {
    const id = wid();
    const r = await run(id, tgPage([['1', 'Самолёт разбился под Черняховском во время учений'], ['2', 'Погода в Калининграде на выходные: дожди']]));
    expect(r.ran).toBe(true);
    const items = feed.list(id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'Klops', sourceId: 'klops', lang: 'ru', keywordHits: ['Черняхов'], url: 'https://t.me/klops_news/1' });
    expect(items[0].urgency).toBeGreaterThan(1);
  });

  it('a later pass files the new posts only — a repeat is never filed twice', async () => {
    const id = wid();
    await run(id, tgPage([['1', 'Погода в Калининграде на выходные: дожди']]));
    clock += sw.MIN_INTERVAL_MS;
    await run(id, tgPage([['1', 'Погода в Калининграде на выходные: дожди'], ['2', 'Новые ограничения на границе с Польшей с понедельника']]));
    clock += sw.MIN_INTERVAL_MS;
    await run(id, tgPage([['1', 'Погода в Калининграде на выходные: дожди'], ['2', 'Новые ограничения на границе с Польшей с понедельника']]));
    const items = feed.list(id);
    expect(items.map((i) => i.url)).toEqual(['https://t.me/klops_news/2']);
    expect(items[0].keywordHits).toEqual(['Польш']);
  });

  it('a page that refuses the server is BLOCKED, files nothing and is not retried anywhere else', async () => {
    const id = wid(); const asked = [];
    const r = await run(id, '', { fetchImpl: async (u) => { asked.push(u); return res(429, 'Too many requests'); } });
    expect(r.sources[0]).toMatchObject({ status: 'blocked', filed: 0 });
    expect(asked).toEqual(['https://t.me/s/klops_news']);
    expect(feed.list(id)).toHaveLength(0);
    expect(sw.statusOf(id, cfg).sources[0].status).toBe('blocked');
  });

  it('reads at most once an hour on schedule, and not again within five minutes by hand', async () => {
    const id = wid(); const page = tgPage([['1', 'Погода в Калининграде на выходные: дожди']]);
    expect((await run(id, page)).ran).toBe(true);
    clock += 10 * 60e3;
    expect((await run(id, page)).ran).toBe(false);
    expect((await run(id, page, { force: true })).ran).toBe(true);
    clock += 60e3;
    expect((await run(id, page, { force: true })).ran).toBe(false);
  });

  it('asks one page at a time, with a pause between requests', async () => {
    const id = wid(); let open = 0, most = 0; const pauses = [];
    const two = { ...cfg, sources: [...cfg.sources, { id: 'b', url: 'https://t.me/s/borderRussiaEuropa' }] };
    await sw.pass(id, two, { feed, lookup: publicLookup, now: () => clock, sleep: async (ms) => { pauses.push(ms); },
      fetchImpl: async () => { open++; most = Math.max(most, open); await new Promise((r) => setTimeout(r, 5)); open--; return res(200, tgPage([])); } });
    expect(most).toBe(1);
    expect(pauses).toEqual([2000]);
  });
});

describe('feeds, replies and what gets filed', () => {
  let clock = Date.parse('2026-11-05T08:00:00Z');
  const rss = (items, host = 'news.err.ee') => '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>ERR</title>'
    + items.map(([id, t, d]) => `<item><title><![CDATA[${t}]]></title><link>https://${host}/${id}?utm_source=rss</link><description>${d || ''}</description><pubDate>Wed, 04 Nov 2026 10:00:00 GMT</pubDate></item>`).join('') + '</channel></rss>';

  it('reads an RSS feed: title, clean link, unescaped summary, ISO date', () => {
    const [it] = sw.extract({ kind: 'page', url: 'https://news.err.ee/rss' }, rss([['1', 'Drone spotted over Narva', '&lt;p&gt;An object crossed the &amp;quot;border&amp;quot;&lt;/p&gt;']]));
    expect(it).toMatchObject({ url: 'https://news.err.ee/1', title: 'Drone spotted over Narva', published: '2026-11-04T10:00:00.000Z' });
    expect(it.summary).toBe('An object crossed the "border"');
  });

  it('reads an Atom feed', () => {
    const atom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Border guard notice</title><link href="https://raja.fi/en/n/1"/><updated>2026-11-04T09:00:00Z</updated><summary>Text</summary></entry></feed>';
    expect(sw.extract({ kind: 'page', url: 'https://raja.fi/' }, atom)[0]).toMatchObject({ url: 'https://raja.fi/en/n/1', title: 'Border guard notice' });
  });

  it('a Telegram reply is the reply, not the message it quotes', () => {
    const html = '<div class="tgme_widget_message" data-post="motolkohelp/9"><div class="tgme_widget_message_text js-message_reply_text" dir="auto">The quoted parent message text here</div>'
      + '<div class="tgme_widget_message_text js-message_text" dir="auto">The reply itself, about the border guard committee</div></div>';
    expect(sw.extractTelegram(html)[0].title).toBe('The reply itself, about the border guard committee');
  });

  it('a general newsroom files keyword hits only; a source marked "all" files everything new', async () => {
    const id = wid();
    const cfg2 = { keywords: ['Narva'], sources: [{ id: 'err', url: 'https://news.err.ee/rss' }, { id: 'ppa', url: 'https://www.politsei.ee/rss', all: true }] };
    const pages = { first: rss([['0', 'Old news nobody needs']]), second: rss([['0', 'Old news nobody needs'], ['1', 'Football results tonight'], ['2', 'Drone over Narva river']]) };
    let page = pages.first;
    const go = () => sw.pass(id, cfg2, { feed, lookup: publicLookup, sleep: noSleep, now: () => clock, fetchImpl: async (u) => res(200, u.includes('politsei') ? page.replace(/news\.err\.ee/g, 'www.politsei.ee') : page, { 'content-type': 'application/rss+xml' }) });
    await go(); page = pages.second; clock += sw.MIN_INTERVAL_MS; await go();
    const bySrc = (s) => feed.list(id).filter((i) => i.sourceId === s).map((i) => i.title).sort();
    expect(bySrc('err')).toEqual(['Drone over Narva river']);
    expect(bySrc('ppa')).toEqual(['Drone over Narva river', 'Football results tonight']);
  });

  it('a switched-off source stays in the list and is not read', async () => {
    const id = wid(); const asked = [];
    const cfg3 = { keywords: [], sources: [{ id: 'a', url: 'https://a.example/' }, { id: 'b', url: 'https://b.example/', enabled: false }] };
    await sw.pass(id, cfg3, { feed, lookup: publicLookup, sleep: noSleep, now: () => clock, fetchImpl: async (u) => { asked.push(u); return res(200, '<html></html>'); } });
    expect(asked).toEqual(['https://a.example/']);
    expect(sw.statusOf(id, cfg3).sources.map((s) => [s.id, s.status])).toEqual([['a', 'thin'], ['b', 'off']]);
  });
});

describe('the address the sources see', () => {
  it('is measured with the same plain fetch and always reports via cluster', async () => {
    const out = await sw.egress({ fetchImpl: async () => res(200, JSON.stringify({ ip: '65.108.13.228', country: 'FI', org: 'AS24940 Hetzner Online GmbH' })) });
    expect(out).toEqual({ ip: '65.108.13.228', country: 'FI', org: 'AS24940 Hetzner Online GmbH', via: 'cluster' });
  });
});

describe('the pass cannot reach the owner', () => {
  it('sourceWatch.js uses no browser, no device ring, no tailnet', () => {
    const code = src('sourceWatch.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of ['./pool', './device-hub', './sessionRing', './tailscale', 'playwright', './profiles', './deviceThread']) expect(code).not.toContain(m);
  });

  it('the scheduler starts a sources pass before the device ring and the browser gate are consulted', () => {
    const s = src('server.js');
    const tick = s.slice(s.indexOf('async function scheduleTick()'));
    const at = tick.indexOf("=== 'sources') { startSourcePass(wf); continue; }");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(tick.indexOf('sites.needsDevice('));
    expect(at).toBeLessThan(tick.indexOf('runPassOnDevice('));
    expect(at).toBeLessThan(tick.indexOf('runningWatchers.add(wf.id)'));
  });

  it('a sources pass never takes the one-browser gate', () => {
    const s = src('server.js');
    const at = s.indexOf('function startSourcePass(');
    const fn = s.slice(at, s.indexOf('\n}\n', at));
    expect(fn).toContain('sourcePasses.add(wf.id)');
    expect(fn).not.toContain('runningWatchers.add');
    expect(fn).not.toContain('pool.');
  });
});
