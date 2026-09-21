'use strict';
/**
 * GIG WATCHER — new paid work, ranked by how few people are already bidding.
 *
 * A job board is a race, not a noticeboard. The same useme listing that carries 19 offers on the day
 * it appears carries 90 six days later, and no wording beats arriving late. So this watches the BOARD
 * the way postWatch watches a post: every pass re-reads the listing, keys each gig by its stable job
 * url, remembers when it was FIRST seen, and surfaces the ones that are both a fit and still winnable.
 *
 * WHAT IS DATA AND WHAT IS CODE. Adding a board, retuning a keyword or changing how hard competition
 * is punished must never need a deploy — that is the lesson platforms.js and userSites.js already
 * wrote down. So every tunable lives in the WATCHER'S OWN CONFIG (watcherFeed.getConfig/setConfig):
 * which boards to sweep, the fit and reject words with their weights, the thresholds. The constants
 * below are only a SEED, written into the config on first run so the owner can see and edit them.
 * What stays code is the one thing that genuinely is code: reading a specific site's DOM, exactly as
 * sites/facebook.js does.
 *
 * Two numbers decide the ranking and they pull against each other: how well a gig matches the work we
 * can actually do, and how many people are already bidding. A perfect match with 90 offers is worth
 * less than a good match with 19, because only the second can still be won.
 *
 * Reading the board needs no login, so a pass runs unattended. APPLYING is a separate, owner-approved
 * act from the residential node.
 */
const feed = require('./watcherFeed');

/**
 * THE SEED. Plain JSON on purpose: patterns are strings, not RegExp literals, so the whole thing
 * round-trips through the config store and the owner can edit any of it without touching this file.
 */
const DEFAULTS = {
  boards: [
    { url: 'https://useme.com/pl/jobs/category/programowanie-i-it,35/', name: 'Programowanie i IT' },
    { url: 'https://useme.com/pl/jobs/category/serwisy-internetowe,34/', name: 'Serwisy internetowe' },
  ],
  /* What we can actually win. Weighted because these are not equal: a named system we know beats a
     generic "API" mention. The tag travels with the item so the feed can say WHY it ranked. */
  fit: [
    { p: 'scrap|pobieranie danych|web ?scraping|zbieranie danych', w: 6, tag: 'scraping' },
    { p: 'automatyzacj|zautomatyzow|automation', w: 5, tag: 'automation' },
    { p: 'integracj|integration|po[l\\u0142][a\\u0105]czenie', w: 5, tag: 'integration' },
    { p: 'baselinker|allegro|shopify|woocommerce|magento|sap\\b|subiekt|comarch', w: 4, tag: 'ecom-system' },
    { p: 'ollama|llm|agent[oa]w|wieloagentow|multi-?agent', w: 4, tag: 'ai-agents' },
    { p: 'bez api|nie ma api|r[e\\u0119]cznie|przepisywan|r[e\\u0119]czne', w: 5, tag: 'manual-today' },
    { p: 'n8n|make\\.com|zapier|workflow', w: 3, tag: 'no-code-automation' },
    { p: 'excel|csv|arkusz|google sheets|bigquery', w: 3, tag: 'data-files' },
    { p: 'node|react|next\\.?js|postgre|docker|kubernetes|typescript', w: 3, tag: 'our-stack' },
    { p: 'panel|dashboard|crm|erp|saas', w: 2, tag: 'app-build' },
    { p: '\\bapi\\b|rest\\b|webhook', w: 2, tag: 'api' },
  ],
  /* Not our edge, or a different trade entirely. */
  neg: [
    { p: 'grafik|logo|banner|ulotk|projekt graficzny', w: 8 },
    { p: 'copywrit|tekst[oy]|t[l\\u0142]umaczen|redakcj', w: 8 },
    { p: 'ksi[e\\u0119]gow|enova|kadry|p[l\\u0142]ac', w: 8 },
    { p: 'tester manualny|testy penetracyjne|pentest', w: 7 },
    { p: 'gra mobilna|unity|unreal', w: 7 },
    { p: 'flutter|react native|swift', w: 4 },
    { p: 'sharepoint|atlassian|jira|confluence', w: 4 },
    { p: 'wordpress|elementor', w: 3 },
  ],
  minFit: 5,            // below this it is not our trade, so never spend a page load on it
  maxDetail: 10,        // page loads one pass may spend learning offer counts
  offersPerPoint: 10,   // ten people already bidding costs about one strong keyword match
  freshDays: { 1: 4, 2: 3, 4: 1 }, // age in days -> bonus; anything older scores 0

  /* PRICING IS OURS, EFFORT IS THE MODEL'S.
     Asking a model for a price produced 7200 zl and then 13000 zl for the SAME gig - 1.8x on
     identical input, decided by whichever run happened to be approved. Unusable for a number a
     client reads. So the model now estimates HOURS, which it judges far more stably, and the price
     is arithmetic we control: hours * rate * (1 - discount). The rate is the owner's, so "a little
     under market" is a policy here rather than something we hope the model honoured. */
  hourlyRatePln: 130,   // ~ the owner's $35/hr
  discountPct: 12,      // under market on purpose: a profile with no contracts needs a reason
  roundToPln: 50,       // a quote ending in 50 or 00 reads as deliberate, not computed

  /* ASK FOR A SIZE, NOT A NUMBER.
     Even after moving off model-quoted prices, a free hours estimate still wandered: the same SAP
     gig came back 70 h on one run and 50 h on the next (8000 zl vs 5700 zl). Classifying into a
     band is a judgement models make consistently, where guessing an integer is not - so the model
     picks a size and the HOURS FOR THAT SIZE ARE OURS. Retune a band here and every future quote
     moves with it, no deploy. */
  hoursPerDay: 8,
  /*
   * `tiny` exists because a 45-minute job was quoted 900 zl: the smallest band was a full day, so
   * every quick gig priced as one. Quick gigs are the easiest to win and the fastest to get paid
   * for, and a quote ten times the work loses them while looking as though the job was not read.
   * One hour here lands under the minimum below, which is the honest shape: a short remote task is
   * billed as a minimum engagement, not as six minutes of clock time.
   */
  hoursBySize: { tiny: 1, small: 8, medium: 24, large: 60, xl: 110 },
  /* Nothing is taken below this, whatever the arithmetic says. The owner set it at 200 by hand on a
     30-45 minute AnyDesk job, which is what a minimum engagement is actually worth. */
  minPricePln: 200,
  defaultSize: 'medium',
};

/** Config is JSON, so patterns arrive as strings. Compile once per pass, and never let a bad pattern
 *  written by hand take the whole watcher down. */
function compile(rows) {
  const out = [];
  for (const r of rows || []) {
    try { out.push({ re: new RegExp(r.p, 'i'), w: Number(r.w) || 0, tag: r.tag || '' }); } catch (e) { /* skip a malformed pattern */ }
  }
  return out;
}

const scoreText = (text, table) => {
  let sum = 0; const tags = [];
  for (const r of table) if (r.re.test(text)) { sum += r.w; if (r.tag) tags.push(r.tag); }
  return { sum, tags };
};

/** Competition is not a tiebreak, it is subtracted - it is the number that decides winnability. */
const competitionPenalty = (offers, perPoint) => (Number(offers) > 0 ? Number(offers) / (Number(perPoint) || 10) : 0);

/** A gig seen on its first day is worth bidding; one that has sat a week rarely is. */
function freshnessBonus(days, table) {
  const t = table || {};
  const keys = Object.keys(t).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  for (const k of keys) if (days <= k) return Number(t[k]) || 0;
  return 0;
}

function rank(item, cfg, fitTable, negTable) {
  const hay = `${item.title || ''} ${item.snippet || ''} ${item.desc || ''}`;
  const fit = scoreText(hay, fitTable);
  const neg = scoreText(hay, negTable);
  const penalty = competitionPenalty(item.offers, cfg.offersPerPoint);
  const fresh = freshnessBonus(item.ageDays, cfg.freshDays);
  const score = (fit.sum - neg.sum) - penalty + fresh;
  return {
    score: Math.round(score * 10) / 10,
    fit: fit.sum, tags: fit.tags,
    penalty: -Math.round(penalty * 10) / 10,
    fresh,
  };
}

/** Pull the listing rows. useme job urls are /pl/jobs/{slug},{id}/ and the id is stable. */
async function readListing(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const seen = {}; const out = [];
    document.querySelectorAll('a').forEach((a) => {
      const h = a.getAttribute('href') || '';
      if (!/^\/(pl|en)\/jobs\/[^/]+,\d+\/?$/.test(h) || seen[h]) return;
      seen[h] = 1;
      const card = a.closest('div,li,article');
      const ctx = card ? (card.textContent || '').replace(/\s+/g, ' ').trim() : '';
      out.push({ href: h, title: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160), snippet: ctx.slice(0, 400) });
    });
    return out;
  });
}

/** The offer count lives only on the gig's own page, so this is the expensive call. */
async function readDetail(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(900);
  return page.evaluate(() => {
    const c = document.body.cloneNode(true);
    c.querySelectorAll('script,style,noscript,svg').forEach((e) => e.remove());
    const t = (c.textContent || '').replace(/\s+/g, ' ');
    const offers = (t.match(/Wys[^\s]*ane oferty \((\d+)\)/) || [, null])[1];
    const budget = (t.match(/Bud[^\s]*et ([^P]{0,40})/) || [, ''])[1].trim();
    const posted = (t.match(/Opublikowano ([^K]{0,25})/) || [, ''])[1].trim();
    const desc = (t.match(/Opis (.{0,900})/) || [, ''])[1].trim();
    return { offers: offers == null ? null : Number(offers), budget, posted, desc };
  });
}

/** "6 dni temu" / "wczoraj" / "godzine temu" -> days, so freshness can be scored. */
function ageDaysOf(posted) {
  const s = String(posted || '').toLowerCase();
  if (/godzin|minut|chwil/.test(s)) return 0;
  if (/wczoraj/.test(s)) return 1;
  const m = s.match(/(\d+)\s*dni/); if (m) return Number(m[1]);
  const w = s.match(/(\d+)\s*tyg/); if (w) return Number(w[1]) * 7;
  return 99;
}

/** The watcher's config, seeded with the defaults the first time so the owner can see and edit it. */
function configFor(wid) {
  const cur = feed.getConfig(wid) || {};
  if (!cur.boards || !cur.fit) return feed.setConfig(wid, Object.assign({ mode: 'gigs' }, DEFAULTS, cur));
  return cur;
}

/**
 * One pass: sweep the boards, pre-filter on the listing, open only the plausible gigs to learn how
 * crowded they are, then upsert into this watcher's own feed so re-runs surface only what is new.
 */
async function tick(getPage, wid, opts) {
  const o = opts || {};
  const cfg = Object.assign({}, DEFAULTS, configFor(wid), o.config || {});
  const fitTable = compile(cfg.fit);
  const negTable = compile(cfg.neg);
  const minFit = Number(cfg.minFit);
  const maxDetail = Number(cfg.maxDetail);
  const log = o.log || (() => {});
  const page = await getPage();

  const rows = [];
  for (const b of cfg.boards || []) {
    try {
      const list = await readListing(page, b.url);
      log(`[gig-watch] ${b.name || b.url}: ${list.length} listed`);
      for (const r of list) rows.push(Object.assign({ category: b.name || '' }, r));
    } catch (e) { log(`[gig-watch] ${b.name || b.url}: ${e.message}`); }
  }

  /* Pre-rank WITHOUT the offer count so page loads are only spent on plausible gigs. */
  const pre = rows.map((r) => {
    const hay = `${r.title} ${r.snippet}`;
    return Object.assign({}, r, { preFit: scoreText(hay, fitTable).sum - scoreText(hay, negTable).sum });
  }).sort((a, b) => b.preFit - a.preFit);

  /* What we already know, by url: a gig already costed a detail load keeps its numbers, so a re-run
     spends its budget reaching NEW gigs instead of re-reading the same ones. */
  const knownByUrl = {};
  try { feed.list(wid).forEach((e) => { if (e.url) knownByUrl[e.url] = e; }); } catch (e) { /* first run */ }

  const out = [];
  let spent = 0;
  for (const r of pre) {
    const url = 'https://useme.com' + r.href;
    const known = knownByUrl[url];
    const kf = (known && known.fields) || {};
    let detail = null;
    if (r.preFit >= minFit && spent < maxDetail && (!known || kf.offers == null)) {
      try { detail = await readDetail(page, url); spent++; } catch (e) { log(`[gig-watch] detail ${r.href}: ${e.message}`); }
    }
    const item = {
      url, title: r.title, snippet: r.snippet, category: r.category,
      offers: detail ? detail.offers : (kf.offers != null ? kf.offers : null),
      budget: detail ? detail.budget : (kf.budget || ''),
      posted: detail ? detail.posted : (kf.posted || ''),
      desc: detail ? detail.desc : (kf.desc || ''),
    };
    item.ageDays = ageDaysOf(item.posted);
    Object.assign(item, rank(item, cfg, fitTable, negTable));
    if (r.preFit >= minFit || (known && known.handled !== true)) out.push(item);
  }

  out.sort((a, b) => b.score - a.score);
  for (const it of out) {
    try {
      feed.upsert(wid, {
        url: it.url, title: it.title, kind: 'gig',
        fields: {
          type: 'gig', score: it.score, fit: it.fit, penalty: it.penalty, fresh: it.fresh,
          tags: it.tags, offers: it.offers, budget: it.budget, posted: it.posted,
          ageDays: it.ageDays, category: it.category, snippet: it.snippet, desc: it.desc,
        },
      });
    } catch (e) { log(`[gig-watch] upsert: ${e.message}`); }
  }
  log(`[gig-watch] ${out.length} ranked, ${spent} detail loads`);
  return out;
}

/**
 * THE OFFER, DRAFTED FROM THE GIG ITSELF.
 *
 * The two offers that got no reply were not badly written - they were late and they leaned on a demo
 * link. So a draft does the opposite: it names the client's own system back to them, says what runs
 * in days, and ends on ONE question. A demo link goes in ONLY when the caller has verified it answers
 * 200 with a valid certificate, because a link that throws a browser warning costs more than no link.
 *
 * Nothing is sent from here. The draft lands on the feed item and the owner approves it.
 */
/* WRITTEN IN CORRECT POLISH ON PURPOSE. The previous version of this block was itself
   spelled without diacritics, so it demonstrated diacritic-free Polish to the model and got
   diacritic-free Polish back. The instruction and the example now agree. */
const VOICE_PL = 'Pisz po polsku, zwyczajnie i konkretnie, jak człowiek który zna się na rzeczy. '
  + 'Bez mydlenia oczu, bez "z przyjemnością", bez listy zalet, bez emoji, bez podpisu na końcu. '
  + 'Nie używaj myślników ani średników. Krótko: 5 do 9 zdań. Zacznij od TEGO, co klient opisał, '
  + 'własnymi słowami, żeby było jasne że przeczytałeś zlecenie. Powiedz co dokładnie zrobisz '
  + 'i w jakim czasie. Zakończ JEDNYM konkretnym pytaniem. Nigdy nie wspominaj o AI.'
  + ' ORTOGRAFIA: pisz poprawną polszczyzną z pełnymi polskimi znakami ą ć ę ł ń ó ś ź ż. '
  + 'Tekst bez polskich znaków wygląda na wygenerowany maszynowo i przekreśla ofertę. '
  + 'Nie zostawiaj literówek.'
  + ' FORMA: zwracaj się do klienta konsekwentnie w liczbie mnogiej, czyli "potrzebujecie", '
  + '"macie", "waszym", "u was". Nigdy nie mieszaj tego z formą pojedynczą "potrzebujesz" '
  + 'ani "masz", i nie zmieniaj formy w trakcie tekstu.';

/** What may be claimed. Kept beside the prompt so a draft never invents experience. */
const EVIDENCE = 'Buduje i utrzymuje wielodostepna platforme na Kubernetes (ponad 100 uslug, certyfikaty TLS '
  + 'per klient, automatyczne wdrozenia, monitoring). Stack: Node.js, React, PostgreSQL, Redis, Docker, '
  + 'Kubernetes, Kotlin/Android. Robie automatyzacje na prawdziwym Chromium, wiec radze sobie tam gdzie '
  + 'nie ma API, gdzie trzeba byc zalogowanym i gdzie Zapier czy Make sie poddaja.';

/**
 * PRICE IS PART OF THE OFFER, NOT A SETTING.
 *
 * A flat rate cannot fit both "wgranie plikow csv" and a multi-warehouse SAP integration, so the
 * price is read off the GIG: scope, systems named, how much is still unknown. It is then placed a
 * little UNDER what the work would normally fetch in Poland - the same launch tactic as the hourly
 * rate: a profile with no completed contracts needs a reason to be picked, and a modest discount is
 * that reason without signalling cheap work. The bounds below are a sanity net, not the price: they
 * only stop an absurd answer from reaching a client.
 */
/*
 * A MINIMUM ENGAGEMENT, not a sanity net. At 300 a one-hour band could never produce a real quote
 * for a quick job — it was clamped up past what such a job is worth, which is how the smallest
 * possible offer became 900 zl. Overridable per watcher as `minPricePln`.
 */
const PRICE_FLOOR_PLN = 200;
const PRICE_CEIL_PLN = 60000;
/** Days, never weeks: the owner's promise is a few days, a week at the outside. */
const MAX_WORK_DAYS = 7;
/*
 * AND A MINIMUM, BECAUSE USEME ENFORCES ONE. Measured on a live gig: work_days of 1, 2, 3 and 5
 * were each refused with "Podaj poprawna liczbe dni" — the value was in the field and the field
 * still errored — and 7 submitted at once. The SAP offer only worked first time because the ceiling
 * happened to sit on that floor. The window filed is therefore 7; the OFFER TEXT carries when the
 * work will really be done, which for a 45-minute job is the same day.
 */
const MIN_WORK_DAYS = 7;
const PRICING_PL = 'ROZMIAR. NIE podawaj ceny ani liczby godzin. Zaklasyfikuj zlecenie do jednego rozmiaru '
  + 'w polu `size`, dokladnie jedna z wartosci: "tiny", "small", "medium", "large", "xl".\n'
  + '  tiny   - drobna pomoc do godziny, zwykle zdalnie przez AnyDesk lub TeamViewer (np. ustawienie '
  + 'konwersji, jedna poprawka, jedno ustawienie w panelu)\n'
  + '  small  - male, jednoznaczne zadanie, jeden system, kilka godzin pracy (np. wgranie pliku CSV, '
  + 'drobna poprawka, prosty skrypt)\n'
  + '  medium - jedna integracja albo jasno opisany modul, jeden lub dwa systemy\n'
  + '  large  - integracja wielu systemow albo caly modul z logika biznesowa i przypadkami brzegowymi\n'
  + '  xl     - duzy projekt: wiele systemow, migracja danych, duzo nieznanych, dlugie wdrozenie\n'
  + 'Godziny i cene policzy system na podstawie rozmiaru.\n\n'
  /* {PRICE} USED TO MEAN "THE WHOLE GIG", WHICH CONTRADICTED THE TERMIN BLOCK BELOW.
     The days rule says: if the gig will not fit in a week, promise only a working first part.
     The price rule said: quote the whole project. A model obeying BOTH produced an offer that
     delivered stage one in 7 days and priced all three stages at one number - which is how an xl
     multi-system integration came out at a single small figure with a one-week date on the form.
     The price now covers exactly what the offer COMMITS to deliver inside work_days. */
  + 'W tresci oferty wstaw dokladnie token {PRICE} tam, gdzie ma pojawic sie kwota w zl za TO, CO '
  + 'DEKLARUJESZ ODDAC w terminie work_days. To NIE jest cena calego zlecenia. '
  + 'Nie wpisuj zadnej wlasnej liczby jako ceny.\n'
  + 'Jesli cale zlecenie nie zmiesci sie w work_days, {PRICE} jest cena PIERWSZEGO ETAPU i musisz '
  + 'napisac wprost, ze kolejne etapy wyceniasz osobno po odbiorze pierwszego. '
  + 'Nie pisz "calosc wyceniam na", bo wyceniasz etap, nie calosc.\n\n'
  /* {PRICE} substitutes a BARE NUMBER, so a body reading "Cena pierwszego etapu to 6850"
     shipped with no currency at all. The form field carries it, the sentence did not. */
  /* SPELLED WITH THE POLISH SIGN ON PURPOSE. The first version of this rule said " zl" in
     ASCII while the voice block demanded diacritics, so the model followed the more specific
     instruction and wrote "6850 zl". The two rules now agree. */
  + 'Po tokenie {PRICE} zawsze dopisz jednostke " zł", na przyklad "Cena pierwszego etapu to {PRICE} zł".'
  /*
   * THE FORM WINDOW IS NOT THE PROMISE. useme refuses anything under 7, so 7 is always filed. That
   * must not stop a quick job saying it will be done today — the window is the contract's outer
   * bound and the sentence is what the client reads.
   */
  + 'TERMIN. Formularz useme przyjmuje tylko 7 dni, wiec tyle zawsze wpisujemy, ale to TYLKO gorna '
  + 'granica umowy. W tresci napisz KIEDY realnie oddasz prace: przy drobnej pomocy napisz wprost, '
  + 'ze mozesz zrobic to dzisiaj albo w ciagu doby. Szybkosc jest tu przewaga. '
  + 'Jesli cale zlecenie realnie nie zmiesci sie w tygodniu, NIE obiecuj calosci - w tresci oferty '
  + 'zadeklaruj, ze w tym terminie oddajesz DZIALAJACA pierwsza czesc (konkretnie nazwij ktora), '
  + 'a reszte dowozisz etapami. Nigdy nie pisz o tygodniach ani miesiacach jako terminie startowym.';

const clampPrice = (n, floor = PRICE_FLOOR_PLN) => Math.max(Number(floor) || PRICE_FLOOR_PLN, Math.min(PRICE_CEIL_PLN, Math.round(Number(n) || 0)));

/** Pull the first JSON object out of a model answer that may be wrapped in prose or fences. */
function firstJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  for (let end = s.lastIndexOf('}'); end > start; end = s.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { /* try a shorter tail */ }
  }
  return null;
}

/**
 * The offer: the words, the price and the days, all derived from the gig. Returns
 * { text, payment, workDays, priced } - `priced` false means the model gave no usable number and the
 * caller must not submit a price it invented.
 */
/* A PROMPT IS A REQUEST, THIS IS THE CHECK.
 * The first real offer came back with no diacritics anywhere and a bare number for the
 * price, and nothing in the pipeline noticed - the owner did, reading the draft. These are
 * the three faults that are cheap to detect and expensive to send, so the watcher looks for
 * them in its own output, retries once, and reports whatever survives.
 *
 * Checked on the MESSAGE TEMPLATE, before {PRICE} is substituted, so the currency rule can
 * be verified against the token itself rather than against a number.
 */
const PL_DIACRITICS = /[\u0105\u0107\u0119\u0142\u0144\u00f3\u015b\u017a\u017c\u0104\u0106\u0118\u0141\u0143\u00d3\u015a\u0179\u017b]/;
function voiceIssues(message) {
  const t = String(message || '');
  const out = [];
  /* Polish this long without a single diacritic is not a style choice, it is machine output.
     Short strings are exempt because a genuine one-liner can legitimately carry none. */
  if (t.length > 120 && !PL_DIACRITICS.test(t)) out.push('brak-polskich-znakow');
  if (t.includes('{PRICE}') && !/\{PRICE\}\s*(zl|z\u0142|PLN)/.test(t)) out.push('cena-bez-waluty');
  /* Mixing plural and singular address inside one offer reads worse than either alone. */
  const plural = /\b(potrzebujecie|macie|waszym|waszej|u was)\b/i.test(t);
  const singular = /\b(potrzebujesz|masz|twoim|twojej|u ciebie)\b/i.test(t);
  if (plural && singular) out.push('mieszana-forma-adresu');
  return out;
}

async function offerFor(gig, opts) {
  const o = opts || {};
  const llm = require('./llm');
  const f = (gig && gig.fields) || {};
  /* Declared before the prompt, because the prompt has to carry it. */
  const pinnedDays = Math.max(0, Math.min(MAX_WORK_DAYS, Math.round(Number(o.pinnedWorkDays) || 0)));
  const pFloor = (o.pricing || {});
  const demo = o.demoUrl && o.demoVerified ? o.demoUrl : '';
  /* Tone is the owner's, not the code's: a watcher's config may carry its own `voice`, so
     changing how offers read never needs a deploy. Falls back to VOICE_PL. */
  const voice = String((o.pricing || {}).voice || VOICE_PL);
  const sys = `${voice}\n\nO wykonawcy (tylko prawda, nie zmyslaj nic poza tym):\n${EVIDENCE}`
    + (demo ? `\n\nMozesz podac dzialajace demo: ${demo}` : '\n\nNIE podawaj zadnych linkow.')
    + `\n\n${PRICING_PL}`
    + '\n\nODPOWIEDZ WYLACZNIE JSON-em, bez komentarza i bez znacznikow kodu, dokladnie w tym ksztalcie:\n'
    + '{"size": "small|medium|large|xl", "work_days": <liczba>, "message": "<tresc oferty po polsku, z tokenem {PRICE}>", '
    + '"message_en": "<doslowne tlumaczenie message na angielski, z tym samym tokenem {PRICE}>"}\n'
    + 'message_en to WYLACZNIE tlumaczenie tego samego tekstu dla wlasciciela konta, ktory nie mowi po polsku. '
    + 'Nie dodawaj tam nic, czego nie ma w message.';
  const user = 'Zlecenie z useme.\n\n'
    + `TYTUL: ${gig.title || ''}\n`
    + `OPIS: ${String(f.desc || f.snippet || '').slice(0, 1500)}\n`
    + `LICZBA ZLOZONYCH OFERT: ${f.offers == null ? 'nieznana' : f.offers}\n`
    + `BUDZET: ${f.budget || 'do negocjacji'}\n\n`
    + 'W polu message napisz sama tresc oferty, bez tematu i bez podpisu.'
    /* A PINNED TERM IS A CONSTRAINT ON THE WORDS, NOT JUST ON THE FORM FIELD. Clamping work_days
       after the model has written its message is what produced the first broken offer: the prose
       described one scope while the form committed to another. If the owner has already seen a
       term, the model is told so and must scope stage one to fit it. */
    + (pinnedDays
      ? `\n\nTERMIN JEST JUZ USTALONY I NIE WOLNO GO ZMIENIAC: work_days = ${pinnedDays}. `
        + `Opisz zakres pierwszego etapu tak, zeby realnie zmiescil sie w ${pinnedDays} dniach roboczych.`
      : '');
  /* llm.chat is the call that exists everywhere (complete does not ship in every build), and it
     answers with a message object, so the text is out.content. */
  const cfg = o.settings || {};
  /* ONE CORRECTIVE RETRY. The faults voiceIssues finds are the kind a model fixes when told
     exactly what was wrong, so it is worth a second call before handing the owner a bad draft.
     Whatever still fails after the retry is RETURNED rather than swallowed, so a rough offer is
     visible in the results screen instead of only being caught by someone reading Polish. */
  let raw = '';
  let j = null;
  let issues = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sysNow = attempt === 0 ? sys : sys
      + '\n\nPOPRAWKA. Poprzednia odpowiedz miala te bledy: ' + issues.join(', ') + '. '
      + 'Napisz pole message jeszcze raz, poprawna polszczyzna z pelnymi polskimi znakami, '
      + 'konsekwentnie w liczbie mnogiej, z waluta po tokenie {PRICE}.';
    const out = await llm.chat({
      host: cfg.llmHost, model: cfg.llmModel, key: cfg.llmKey,
      messages: [{ role: 'system', content: sysNow }, { role: 'user', content: user }],
    });
    raw = String((out && out.content) || '').trim();
    j = firstJson(raw);
    if (!j || !j.message) break;
    issues = voiceIssues(j.message);
    if (!issues.length) break;
  }
  if (!j || !j.message) {
    /* No usable JSON: keep the words (better than nothing) but refuse to invent a price. */
    return { text: raw, textEn: '', payment: 0, workDays: 0, hours: 0, priced: false };
  }

  /* The price is arithmetic, not opinion: the model's hours, the owner's rate, the owner's discount.
     Same gig in, same number out - which is the whole point of moving off a model-quoted price. */
  const p = o.pricing || {};
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const rate = num(p.hourlyRatePln, DEFAULTS.hourlyRatePln);
  const disc = Math.max(0, Math.min(60, Number(p.discountPct != null ? p.discountPct : DEFAULTS.discountPct)));
  const step = num(p.roundToPln, DEFAULTS.roundToPln);
  const bands = Object.assign({}, DEFAULTS.hoursBySize, p.hoursBySize || {});
  const size = String(j.size || '').toLowerCase().trim();
  const known = Object.prototype.hasOwnProperty.call(bands, size);
  const usedSize = known ? size : String(p.defaultSize || DEFAULTS.defaultSize);
  /* DAYS FIRST, BECAUSE THE PROMISE BOUNDS THE QUOTE. The bands were decoupled from the day cap:
     `xl` is 110 hours, which at 8h/day is ~14 working days, so an xl gig quoted a fortnight of
     labour while the form committed to 7 days. Capping hours at workDays * hoursPerDay is what
     makes {PRICE} the price of the commitment rather than of a scope we are not promising. */
  /* ONCE AGREED, STAY AGREED - the same rule the price already follows. */
  const dayFloor = num(p.minWorkDays, MIN_WORK_DAYS);
  const workDays = Math.max(dayFloor, pinnedDays
    || Math.max(1, Math.min(MAX_WORK_DAYS, Math.round(Number(j.work_days) || MAX_WORK_DAYS))));
  const perDay = num(p.hoursPerDay, DEFAULTS.hoursPerDay);
  const bandHours = num(bands[usedSize], DEFAULTS.hoursBySize[DEFAULTS.defaultSize]);
  const hours = Math.min(bandHours, workDays * perDay);
  /* scoped = the gig is bigger than the promise, so this quote is stage one and the words must say
     so. Surfaced in the return so the results screen can show it instead of it being invisible. */
  const scoped = hours < bandHours;
  /* ONCE PRICED, STAY PRICED. A gig the owner has already seen a number for keeps that number on a
     redraft, so rewriting the words can never quietly move the quote. Repricing is deliberate. */
  const floor = num(p.minPricePln, DEFAULTS.minPricePln);
  const pinned = Number(o.pinnedPayment) > 0 ? clampPrice(o.pinnedPayment, floor) : 0;
  const payment = pinned || clampPrice(Math.round((hours * rate * (1 - disc / 100)) / step) * step, floor);
  const priced = payment > 0;


  const money = String(payment);
  const put = (s) => String(s || '').replace(/\{PRICE\}/g, money).trim();
  let text = put(j.message);
  let textEn = put(j.message_en);
  /* A model that forgot the token would otherwise send an offer with no number in it at all. */
  if (priced && !String(j.message).includes('{PRICE}') && !text.includes(money)) {
    text += scoped ? ` Ten etap wyceniam na ${money} zł.` : ` Wyceniam to na ${money} zł.`;
    if (textEn) textEn += scoped ? ` I price this stage at ${money} PLN.` : ` I price this at ${money} PLN.`;
  }

  return {
    /* text is what gets SENT. textEn exists only so an owner who does not read Polish can see what
       he is approving - it must never reach the form, which is why the caller stores it under
       fields and never under draft. */
    text, textEn, payment, workDays, hours, priced,
    size: usedSize, sizeFromModel: known, scoped, bandHours, daysPinned: pinnedDays > 0,
    voiceIssues: issues,
  };
}

/** Back-compat: the text alone, for callers that only want a draft. */
async function draftFor(gig, opts) { return (await offerFor(gig, opts)).text; }

/*
 * WHICH FRESH GIGS EARN A DRAFT. Pure on purpose: a draft is a model call, so this is the function
 * that spends money, and it must be checkable without a browser or a feed.
 *
 * The bar is the board's own economics. A gig here collects five offers in fourteen minutes and
 * ninety in six days, so being late is the same as being absent — but drafting everything would
 * spend the most on the gigs least likely to answer. Hence: fresh AND above the score bar, best
 * first, a couple at a time, and never anything already drafted, handled or sent.
 */
function pickForAutoDraft(items, cfg = {}) {
  if (cfg.autoDraft === false) return [];
  const top = Math.max(0, Math.min(5, Number(cfg.autoDraftTop == null ? 2 : cfg.autoDraftTop)));
  if (!top) return [];
  const maxAge = Number(cfg.autoDraftMaxAgeDays == null ? 1 : cfg.autoDraftMaxAgeDays);
  const bar = Number(cfg.autoDraftMinScore == null ? 0 : cfg.autoDraftMinScore);

  return (items || []).filter((it) => {
    if (!it) return false;
    const f = it.fields || null;
    /* Nothing to read is not a draftable gig. An unknown age still is (see below); an absent body
       never is — it would reach the model as an offer about nothing. */
    if (!f) return false;
    if (!String(it.title || f.desc || f.description || '').trim()) return false;
    if (it.handled || it.posted || it.posting) return false;              // already dealt with
    if (String(it.draftState || '') === 'drafted') return false;
    if (String(it.draft || '').trim()) return false;                      // has words already
    if (f.type && f.type !== 'gig') return false;                         // replies/posts are not gigs
    const age = Number(f.ageDays);
    if (Number.isFinite(age) && age > maxAge) return false;               // stale is not a money-moment
    return Number(f.score || 0) >= bar;
  }).sort((a, b) => Number((b.fields || {}).score || 0) - Number((a.fields || {}).score || 0))
    .slice(0, top);
}

module.exports = { pickForAutoDraft, voiceIssues, tick, rank, ageDaysOf, draftFor, offerFor, configFor, compile, DEFAULTS, clampPrice, firstJson };
