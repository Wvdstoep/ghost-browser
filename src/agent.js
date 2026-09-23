/**
 * agent.js — the loop that drives the browser.
 *
 * The agent sees exactly what the console's "Agent view" button shows: the page reduced to a
 * numbered list of things that can be clicked, plus the text around them. That view was built for a
 * person to sanity-check and it turns out to be the whole interface a model needs — every action is
 * "the number of the thing I mean", which is checkable, replayable and impossible to fake a
 * selector for.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING HERE: this runs on a real account, under a real name. Reading
 * is free and reversible. Joining a group, commenting, following, messaging — none of those can be
 * taken back, because the notification has already gone out to a person. So they do not happen
 * through `click`. They happen through `act`, which asks first.
 *
 * That is enforced twice on purpose. The prompt says so, and a guard checks what the model is about
 * to click and turns a "Post" or "Join" into a proposal even when the model asked for a plain click.
 * The guard is a heuristic over button labels — it will not catch everything, and it is the second
 * line, not the first.
 */

const { analyzePage, clickByIndex, settle } = require('./inspector');
const jobsStore = require('./jobs');
const conversations = require('./conversations');   // the owner's deliberately-started chats (Flow1→Flow2 seam)
const llm = require('./llm');
const company = require('./company');
const me = require('./me');
const profiles = require('./profiles');
const fb = require('./sites/facebook');
const gg = require('./sites/google');
const diagnostics = require('./diagnostics');
const { makeKeyring, isSpent } = require('./keyring');
const toolRegistry = require('./tools');
const li = require('./sites/linkedin');
const roles = require('./roles');
const routecards = require('./routecards');
const replay = require('./replay');
const { makeCardStore } = require('./cardstore');
/* One card store per process, beside the profiles. A Herald walk records its traffic and learns a
   card at the end; H3's operate runs replay a verified card, falling back to the UI (and re-recording)
   on any failure. Module-level so every run shares what the browser has learned. */
const cardStore = makeCardStore({});
const playbook = require('./playbook');
const { makeSink } = require('./sink');

/* Human pacing. Not a fingerprinting trick — a person reading a group does not open eleven posts in
   four seconds, and the accounts that get restricted are the ones that do. */
/* Older than this and the person has moved on. Three months is generous for a request for a
   tradesman and about right for the slowest of them. */
const MAX_LEAD_AGE_DAYS = Number(process.env.MAX_LEAD_AGE_DAYS) || 92;

const PAUSE_READ = [1200, 3200];
const PAUSE_WRITE = [7000, 16000];
/* `pace` scales both. It exists because these waits are the difference between an account that
   survives and one that gets restricted, so they cannot simply be short — but a test that has to
   sit through sixteen real seconds to check who approved a comment is a test nobody runs. */
const rand = ([a, b], pace = 1) => Math.round((a + Math.floor(Math.random() * (b - a))) * pace);
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/*
 * Labels that mean "this does something to the world". Matched against the button text the page
 * itself shows, in the languages this is actually used in — a Dutch Facebook says "Plaatsen" and
 * "Lid worden", and an English-only list would wave both straight through.
 */
/*
 * DRIFT, AND THE SESSION IT HOLDS. Two bounds, and neither of them is a cap on how deep a job may
 * dig — depth is the point, and a run that keeps finding things should keep going.
 *
 * WHAT ACTUALLY WENT WRONG, measured: a LinkedIn research run read post after post for two hours,
 * spent its whole 120-turn budget, produced no report, and then PARKED — because hitting the limit
 * marks a job 'idle' and waits half an hour for a person to say "carry on". Nobody was watching; the
 * master had dispatched it. So it held the one browser session for the entire time, starved QA and
 * the hunt behind it, pushed the pod past its memory ceiling into a drain it could not recover
 * from, and produced NOTHING — the two hours of reading went in the bin because it never concluded.
 * On a week where the model quota finished at 99.8%, that is the expensive kind of nothing.
 *
 * So: a job nobody is watching must CONCLUDE rather than park, and it gets a small extra budget to
 * write the report rather than being cut off mid-thought — losing the work is what made the old
 * behaviour so costly. And every so often it is reminded what it came for, which is the cheap way
 * to keep a long run pointed at its goal instead of drifting into the next interesting page.
 */
const WRAP_UP_TURNS = 8;      // enough to write a report, not enough to start a new line of enquiry
const REANCHOR_EVERY = 25;    // turns between "what have you actually got?" — a nudge, never a limit
/*
 * The tools that deliberately go somewhere NEW. Past the page budget these are refused; look,
 * read, scroll, sweep and finish are not, so a walk can always write up the page it is on.
 */
const GOES_SOMEWHERE_NEW = new Set(['open', 'dig', 'google']);

const WRITE_WORDS = [
  'post', 'plaats', 'reageer', 'reageren', 'comment', 'reply', 'antwoord',
  'join', 'lid worden', 'deelnemen', 'aanmelden',
  'send', 'verstuur', 'verzend', 'stuur',
  'follow', 'volgen', 'add friend', 'vriend toevoegen', 'connect', 'uitnodig', 'invite',
    'like', 'vind ik leuk', 'share', 'delen', 'publish', 'publiceer', 'submit',
  /* NOT 'save' or 'opslaan'. Every second page has a "Saved items" or an "Opgeslagen" link, and
     blocking those blocks navigation, not writing. The words here have to be things a person only
     ever presses to send something. */
];

/*
 * Fields that PUBLISH when you press Enter in them.
 *
 * A search box and a comment box both accept Enter; only one of them says something to other
 * people. What tells them apart is the field's own placeholder — every social site writes an
 * invitation in it, in the language of the page.
 */
const COMPOSER_WORDS = [
  'comment', 'reageer', 'reactie', 'schrijf', 'antwoord', 'reply',
  'message', 'bericht', 'aa het woord', 'write something', 'zeg iets',
  'post', 'plaats', 'wat wil je delen', "what's on your mind", 'wat denk je',
];

/** Does typing here and pressing Enter say something to other people? */
function looksLikeComposer(el) {
  if (!el) return false;
  const hay = `${el.placeholder || ''} ${el.ariaLabel || ''} ${el.text || ''}`.toLowerCase();
  if (!hay.trim()) return false;
  return COMPOSER_WORDS.some((w) => hay.includes(w));
}

/**
 * Does this element look like it writes to the world?
 *
 * Matched at the START of the label, not anywhere inside it. A plain substring test looked right
 * and was not: a link reading "Open the post" contains "post", so the guard refused to let the
 * agent open a post — the single most ordinary thing it does. Caught by the test that asserted the
 * opposite, which is the entire reason that test exists.
 *
 * Anchoring at the start works because these controls are verbs: a button says "Reageren",
 * "Plaatsen", "Lid worden". A phrase that merely mentions one of those words does not start with it.
 * The length cap is the same idea from the other end — a paragraph is not a button.
 */
function looksLikeWrite(el) {
  if (!el) return false;
  const labels = [el.text, el.ariaLabel].filter((x) => x && String(x).trim());
  return labels.some((raw) => {
    const rawLabel = String(raw).trim().toLowerCase();
    const label = rawLabel.replace(/^[^a-z]+/, '');
    if (!label || label.length > 40) return false;
    /* REVEAL controls expand hidden content and publish NOTHING — "11 antwoorden bekijken",
       "Bekijk meer reacties", "View 3 replies", "See more", "Meer weergeven", "Verberg". A reply
       thread cannot be read without them, and gating them deadlocked the reply flow. */
    if (/bekijk|weergeven|verberg|see more|show more|\bview\b|more repl|more comment|meer reacti|meer antwoord|meer opmerking/.test(rawLabel)) return false;
    if (/^\d+\s*(antwoord|reacti|opmerking|repl|comment)/.test(rawLabel)) return false;
    /* Prefix, not whole word: Dutch inflects these — "plaats" becomes "Plaatsen", "verzend"
       becomes "Verzenden" — and a boundary check rejected exactly the buttons this is for. The
       length cap above is what keeps a prefix match from swallowing a sentence. */
    return WRITE_WORDS.some((w) => label.startsWith(w));
  });
}

/*
 * OUR OWN GROUND — where the approval gate is protecting nobody, and deadlocks the run instead.
 *
 * THE RUN THAT MADE THIS NECESSARY. QA was sent to exercise a freshly built app of ours. It found
 * the one button the acceptance criteria are about — "Connect Etsy shop" — clicked it, and was
 * refused: `connect` is in WRITE_WORDS because on LinkedIn it sends a connection request to a real
 * person. Correct there, and exactly wrong here. The click became an act proposal, the proposal
 * waited for a human who was never coming (nobody is watching an autonomous QA run), and the job
 * sat there holding the one browser session until the three-hour watchdog. QA cannot test an app by
 * refusing to press its buttons.
 *
 * The heuristic cannot tell those two "Connect"s apart from the label, and it should not have to.
 * The ORIGIN tells it. On an app we just built there is no account to damage, no stranger who sees
 * anything, and pressing the buttons IS the job.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is trust a role. It trusts an ORIGIN, per job, and only for a
 * role that asked for it. That distinction is the whole safety of it: "Connect Etsy shop" sends QA
 * straight to Etsy's real OAuth screen, on Etsy's origin — and there it is gated again, exactly as
 * it should be, because authorising a real account against a real service is not ours to do.
 */
function ownGround(rawOrigin) {
  /*
   * HTTP AND HTTPS ONLY, and the test that forced this: every non-web scheme reports its origin as
   * the STRING "null" — `javascript:`, `data:`, and `about:blank`, which a real page genuinely sits
   * on between navigations. Comparing origins would then match two unrelated null-origin URLs and
   * call a blank tab "our own app". Narrow, but it is the wrong direction to be wrong in.
   */
  const parse = (u) => {
    try {
      const p = new URL(String(u));
      return (p.protocol === 'http:' || p.protocol === 'https:') ? p.origin : null;
    } catch { return null; }
  };
  const origin = rawOrigin ? parse(rawOrigin) : null;
  return {
    origin,
    /** True only when the page we are standing on right now is the app this job was sent to test. */
    covers(currentUrl) {
      if (!origin) return false;
      return parse(currentUrl) === origin;
    },
  };
}

// ── The tools, as the model sees them ─────────────────────────────────────────────────────
/*
 * A SCRIPT MAY READ THE PAGE; IT MAY NOT ACT ON IT.
 *
 * run_script exists because reading rendered prose is the wrong way to get data out of a web app.
 * It is not a way around the act gate: clicking, submitting, fetching, navigating and writing
 * storage are refused here, by pattern, before the snippet ever reaches the page — and the refusal
 * names the tool that does the job properly, because a refusal alone just gets worked around.
 * Reading cookies is refused too: a session token in a transcript is a token that has leaked.
 */
const SCRIPT_REFUSALS = [
  [/\bfetch\s*\(|XMLHttpRequest|sendBeacon|\bimport\s*\(/, 'a script may not make requests — use fetch_data, which fetches in this browser\'s own session and cannot act'],
  [/\.\s*(click|submit)\s*\(/, 'a script may not click or submit — use click, type or act, which pass the owner\'s approval gate'],
  [/\.\s*dispatchEvent\s*\(|new\s+(Mouse|Keyboard|Pointer)Event/, 'a script may not fire events at the page — use click, type or act'],
  [/document\s*\.\s*cookie/, 'a script may not touch cookies — a session token must never leave the browser'],
  [/(local|session)Storage\s*\.\s*(setItem|removeItem|clear)/, 'a script may not write storage'],
  /* Only LOCATION's assign/replace navigate. The old pattern caught any `.replace(` — so a script that
     cleaned whitespace with String.replace was refused as navigation, and Object.assign would fall the
     same way. A read-only scout tripped it on its first zero-model run. */
  [/\bwindow\s*\.\s*open\s*\(|\blocation\s*\.\s*(assign|replace)\s*\(|location\s*(\.\s*href\s*)?=[^=]/, 'a script may not navigate — use open, and tabs / switch_tab for a new tab'],
  [/document\s*\.\s*write\s*\(|\.\s*(innerHTML|outerHTML)\s*=[^=]/, 'a script may not rewrite the page'],
];
/** Why this snippet is refused, or null when it only reads. */
function scriptRefusal(src) {
  const s = String(src || '');
  if (!s.trim()) return 'the script is empty';
  if (s.length > 8000) return 'the script is too long — return less, or narrow the selector';
  for (const [re, why] of SCRIPT_REFUSALS) if (re.test(s)) return why;
  return null;
}

/** Walk a dot path into parsed data ("data.children.0.title"); undefined when it does not lead there. */
function pickPath(value, path) {
  if (!path) return value;
  return String(path).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), value);
}

const TOOLS = [
  { type: 'function', function: { name: 'look', description: 'The CONTROLS on this page — buttons, links and fields — as a numbered list. This is how you find something to CLICK, and the numbers change whenever the page does, so call it just before clicking. It is not how you read content: for that use read.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read', description: 'The WORDS on this page — the posts themselves. This is what you judge a lead on. Call it after every scroll: a feed loads a screenful at a time, so the first read is never all there is.', parameters: { type: 'object', properties: {} } } },
  /*
   * NUMBERS COME BACK AS CELLS, NOT AS PROSE FOR THE MODEL TO RETYPE.
   *
   * Reading a report with `read` means the numbers arrive inside a page of text and get transcribed
   * — the one step in the chain that can be silently wrong, because a misread impression count looks
   * exactly like a right one. It is also the slow way: look, read, scroll, read again.
   */
  { type: 'function', function: { name: 'read_table', description: 'The TABLES on this page, as their own cells — headers and rows exactly as the page has them. Use this for any report, dashboard or list of numbers instead of read: the figures come back verbatim rather than retyped out of a paragraph, and one call replaces a look/read/scroll loop. Tables come back biggest first; pass index to pick another, rows to get more.', parameters: { type: 'object', properties: { index: { type: 'integer', description: 'Which table, when the page has several. 0 (the biggest) by default.' }, rows: { type: 'integer', description: 'How many body rows to return (default 25, max 100).' } } } } },
  /*
   * THE HANDS FOR WHEN A PAGE WILL NOT SIMPLY BE READ. Live: a scout spent 122 steps on a Reddit
   * listing, came back with nothing, and worked out for itself that it needed to run a script and
   * to fetch the feed — so these are the two it asked for, plus the four a person uses without
   * thinking: a key, a wait, a dropdown, and the tab that just opened.
   */
  { type: 'function', function: { name: 'click_text', description: 'Click a control by the words ON it, when look() did not list it. Custom tabs, toggles and buttons inside app components are sometimes missing from the numbered list even though you can see them; this finds the first button, link, tab or submit control whose visible text or aria-label contains your words (case and accents ignored) and clicks it with a real mouse event. It passes the SAME gate as click: something other people will see (post, send, publish, apply, pay) is refused and needs act. Use a short, distinctive phrase exactly as the page shows it, e.g. "Załóż konto".', parameters: { type: 'object', properties: { text: { type: 'string', description: 'The words on the control, as shown on the page' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'run_script', description: 'Run a small piece of JavaScript IN THIS PAGE and get its value back as DATA. This is how you read what read() cannot: a JSON blob on the page, every row of a web app\'s table, a lazy-loaded list, an attribute, the page\'s own state. End the snippet with `return <the data>` (a single expression also works). READ-ONLY: no clicking, submitting, fetching, navigating or rewriting — use click / type / act for those (they pass the owner\'s gate) and fetch_data to fetch.', parameters: { type: 'object', properties: { script: { type: 'string', description: 'The snippet, e.g. return [...document.querySelectorAll(\'article\')].map(a => ({ title: a.querySelector(\'h3\')?.innerText, url: a.querySelector(\'a\')?.href }))' } }, required: ['script'] } } },
  { type: 'function', function: { name: 'fetch_data', description: 'Fetch ONE web address in THIS browser\'s own session — its cookies and logins apply — and get the body back whole. For a JSON feed, an API, a CSV export, a sitemap: the data arrives complete instead of as truncated page text, and no page has to be opened. Read-only (GET).', parameters: { type: 'object', properties: { url: { type: 'string', description: 'The full http(s) address' }, pick: { type: 'string', description: 'Optional dot path into JSON, e.g. "data.children" — returns only that part, which keeps the answer small' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'press_key', description: 'Press one key. Escape closes a dialog, a cookie banner or a popup that has no visible close button; Enter submits the focused field; Tab moves on; PageDown pages through a long list. The fastest way past something in the way.', parameters: { type: 'object', properties: { key: { type: 'string', description: 'Escape | Enter | Tab | PageDown | PageUp | ArrowDown | ArrowUp | Home | End | Backspace' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'wait_for', description: 'Wait until some TEXT appears on the page — or until it is gone. For a list that loads after the page, a spinner that must finish, a result that arrives late. Use this instead of scrolling and reading again and again.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'The text to wait for' }, gone: { type: 'boolean', description: 'true = wait until it has GONE (a "Loading…" that must finish)' }, seconds: { type: 'integer', description: 'At most this long (default 15, max 30)' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'choose_option', description: 'Pick a value in a dropdown (a real <select>) by its visible text — a category filter, a country, a currency, a sort order. Clicking a native dropdown does nothing useful; this sets it and tells the page it changed.', parameters: { type: 'object', properties: { index: { type: 'integer', description: 'The dropdown\'s number from look()' }, option: { type: 'string', description: 'The option\'s visible text (its value also works)' } }, required: ['index', 'option'] } } },
  { type: 'function', function: { name: 'tabs', description: 'List the tabs open in this browser right now — numbered, with their titles and addresses. Use it when a link, a sign-in or a payment opened a new tab.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'switch_tab', description: 'Work in another tab from now on (its number comes from tabs). For a sign-in popup, a payment window, or a link that opened beside the page. The numbers from look() belong to the old tab — call look again after switching.', parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] } } },
  { type: 'function', function: { name: 'open', description: 'Go to a web address.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  /*
   * MAKING, NOT ONLY FINDING. A brief asks for a CV, a marketplace asks for a portfolio, a signup
   * asks for an authenticator code, a menu opens only under the pointer. Each of those stopped real
   * work dead while the browser could read and click perfectly well.
   */
  { type: 'function', function: { name: 'make_document', description: 'Write a DOCUMENT and keep it as a real PDF — a CV, a portfolio, a one-page proposal, an invoice. You compose it as HTML (headings, paragraphs, lists, a table); it is printed by this same browser, so what you write is what the PDF holds, and a clean print stylesheet is applied unless you send your own <style>. Returns an asset id — attach it with upload_file once the page\'s upload control is open.', parameters: { type: 'object', properties: { html: { type: 'string', description: 'The document itself as HTML. Write real content, not a template.' }, filename: { type: 'string', description: 'What it should be called, e.g. wesley-van-der-stoep-cv.pdf' }, title: { type: 'string', description: 'The document title (shown in a PDF reader)' }, kind: { type: 'string', description: 'What it is, for the record: cv | portfolio | proposal | invoice | document' } }, required: ['html'] } } },
  { type: 'function', function: { name: 'save_totp_secret', description: 'Remember a platform\'s two-factor authenticator, ONCE, at the moment its security page shows the setup key. Read that key off the page first (it is base32, or an otpauth:// link behind the QR code — there is usually a \'can\'t scan the code?\' link that reveals it). After this, totp_code answers every later sign-in without a phone. The secret is stored with the logins and never shown again.', parameters: { type: 'object', properties: { account: { type: 'string', description: 'The platform, e.g. upwork' }, secret: { type: 'string', description: 'The base32 key, or the whole otpauth:// link, exactly as the page shows it' } }, required: ['account', 'secret'] } } },
  { type: 'function', function: { name: 'totp_code', description: 'The six-digit code an authenticator app would show right now, for an account whose authenticator was saved. Use it whenever a sign-in asks for a code from an app. Each code lasts under a minute; call again for the next one.', parameters: { type: 'object', properties: { account: { type: 'string', description: 'The platform, e.g. upwork' } }, required: ['account'] } } },
  { type: 'function', function: { name: 'hover', description: 'Put the pointer on a numbered element without clicking — for a menu, a tooltip or a submenu that only appears while hovered. Call look afterwards: whatever opened has its own numbers.', parameters: { type: 'object', properties: { index: { type: 'integer', description: 'The element\'s number from look()' } }, required: ['index'] } } },
  { type: 'function', function: { name: 'click', description: 'Click a numbered element. ONLY for moving around: opening a group, a post, a menu, a search result. Never for posting, joining, following, liking or sending — use act for those.', parameters: { type: 'object', properties: { index: { type: 'integer' }, why: { type: 'string', description: 'what you expect this to do' } }, required: ['index'] } } },
  { type: 'function', function: { name: 'type', description: 'Type into a numbered field — a search box, a login form. Set submit true to press Enter after. Do NOT use this to write a comment or a message: pressing Enter in one of those publishes it, and anything other people can see goes through act so the owner approves it first.', parameters: { type: 'object', properties: { index: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['index', 'text'] } } },
  { type: 'function', function: { name: 'paste_text', description: 'Drop a WHOLE block of text into a numbered field at once — for long text like a script, a narration, or song lyrics, where typing it character by character is slow and can be rejected. It selects the field and inserts the whole block, firing the input events React and rich editors need to accept it. Set submit true only to press Enter after — the same publishing guard as type applies, so Enter in a field others can see still needs approval.', parameters: { type: 'object', properties: { index: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['index', 'text'] } } },
  { type: 'function', function: { name: 'scroll', description: 'Scroll down to make the feed load more. Facebook loads a screenful at a time, so scrolling then reading again is how you see past the first few posts — expect to do it four or five times in one group before deciding it is empty.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] }, amount: { type: 'integer', description: 'pixels, default 700' } } } } },
  { type: 'function', function: { name: 'back', description: 'Go back to the previous page.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'current_url', description: 'Report the URL (and title) of the page you are on right now. Use it to read an id out of the path before building a link — e.g. open the app home, then read your YouTube channel id from studio.youtube.com/channel/<id>/ and construct the link from that, instead of guessing a path segment (which lands on an error page).', parameters: { type: 'object', properties: {} } } },
  /*
   * THE TOOL THAT REPLACES A DOZEN. Facebook is understood in code — see sites/facebook.js — so
   * reading a feed is one call rather than look, click, read, scroll, read. The scrolling and the
   * stopping happen inside it, because "keep going until nothing new appears" is a loop and a model
   * running a loop one turn at a time is a budget being spent on scrolling.
   */
  { type: 'function', function: { name: 'sweep', description: 'Read a whole feed in one go — Facebook or LinkedIn, whichever you are on and get back the posts themselves — who wrote each one, what it says, how old it is, and its link. Scrolls until nothing new loads and leaves out anything too old. THIS IS HOW YOU LOOK FOR LEADS: use it instead of look/read/scroll, and spend your thinking on judging the people it hands you.', parameters: { type: 'object', properties: {
      search: { type: 'string', description: 'words to search Facebook posts for — write what a person in trouble would write, not what a supplier would' },
      site: { type: 'string', enum: ['facebook', 'linkedin'], description: 'which site to search — defaults to the one you are already on' },
      group: { type: 'string', description: 'a Facebook group id or its address, to read that group instead' },
      inGroup: { type: 'string', description: 'search INSIDE the group named in `group` for these words' },
      myGroups: { type: 'boolean', description: 'read the feed of every group this account belongs to' },
      url: { type: 'string', description: 'any other Facebook page to read as a feed' },
    } } } },

  /*
   * RESEARCH. Doing this by hand costs five or six calls per source — look at sixty links, guess
   * which are results, click, read ten thousand characters of which nine are menus. Here the
   * results arrive as data and a page arrives as its content, so following four sources costs five
   * calls and every word that comes back is worth reading.
   */
  { type: 'function', function: { name: 'google', description: 'Search Google and get the results as a list — title, address and the snippet. Use Google\'s own operators: quotes for an exact phrase, site: to search one domain, -word to exclude, intitle: for the title only. Then use dig to read the ones worth reading.', parameters: { type: 'object', properties: {
      query: { type: 'string' },
      recentDays: { type: 'integer', description: 'only results from the last N days, when age matters' },
    }, required: ['query'] } } },
  { type: 'function', function: { name: 'dig', description: 'Open one result and read what it actually says — the content with the navigation, cookie banners and footers stripped out, plus any email addresses and phone numbers on the page. This is how you go deeper on something a search turned up. Only open links you have actually SEEN — an address exactly as google() listed it or as it appears on a page you read. Never an address composed from memory: sites like Reddit do not 404 a wrong id, they redirect to an unrelated page, and that page then reads as evidence. A composed address that lands elsewhere is refused.', parameters: { type: 'object', properties: {
      url: { type: 'string', description: 'exactly as listed by google() or seen on a page — never typed from memory' },
    }, required: ['url'] } } },

  { type: 'function', function: { name: 'collect', description: 'Save ONE thing you found - a person, a company, an address, a profile with its photo, a job post, ANY item worth keeping. This is for data gathering of every shape, not just leads: put what it is in title, and every detail in fields as key/value (for example an email, a role, an address). Add url if it links somewhere, and image for a photo or avatar URL. Call it the moment you find each item, one call per item.', parameters: { type: 'object', properties: { title: { type: 'string', description: 'what this item is - a name, a company, a headline' }, fields: { type: 'object', description: 'every detail as key:value' }, url: { type: 'string', description: 'a link to it, if any' }, image: { type: 'string', description: 'a photo or avatar URL, if any' }, draft: { type: 'string', description: 'ONLY for a comment/reply that needs an answer: a ready reply draft' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'save_lead', description: 'Record someone worth approaching. Do this the moment you find one — do not wait until the end. On a social site, a lead is a PERSON who wrote a PARTICULAR THING in a PARTICULAR PLACE: fill in the person, the post and the group, because a reply that does not refer to their own words is the one that reads as a bot.', parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'the person, as their profile shows it' },
      why: { type: 'string', description: 'what in their own words makes them a lead' },
      postText: { type: 'string', description: 'what they actually wrote, as close to word for word as you can' },
      postUrl: { type: 'string', description: 'THE LINK TO THIS POST — the post timestamp is itself a link to it. Without this nobody can open the lead, which is the only thing anyone does with one. A group address is not a post address.' },
      profileUrl: { type: 'string' },
      groupName: { type: 'string', description: 'the group or page it was posted in' },
      groupUrl: { type: 'string' },
      platform: { type: 'string', description: 'facebook, linkedin, …' },
      postedAt: { type: 'string', description: 'when they posted it, from the date next to their name. Anything older than three months should not be saved at all — someone who asked in 2021 has long since found what they needed.' },
      city: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
      website: { type: 'string' }, contact: { type: 'string' },
    }, required: ['name', 'why'] } } },

  /*
   * A PLACE IS NOT A POST, and save_lead could not hold one.
   *
   * save_lead is shaped for a person who wrote something somewhere: name, what they wrote, the link
   * to it. A business on Maps has none of that and has a great deal else — a category, an address,
   * opening hours, a rating out of a number of ratings, a price level, whether the owner has claimed
   * the listing, and the REVIEWS, which are the most valuable thing on the page: they say in
   * customers' own words what the business is bad at, and the owner's replies say whether anybody is
   * even reading them. save_lead dropped every one of those fields on the floor (it builds a fixed
   * object), so a Maps walk could save a name, a sentence and one quote, and nothing else. That is
   * why a walk for garages could hand back a review of a parking garage and look like it had worked.
   *
   * So places get their own record. Everything a Maps card shows, plus what it does NOT show — the
   * absence is the reason to approach them, and it is the thing a places API could never answer.
   */
  { type: 'function', function: { name: 'save_place', description: 'Record ONE business you have OPENED on Google Maps — the whole card, plus its reviews. Call it the moment you have read the place, not at the end. Only for a place whose own category matches what you were asked to find: a parking garage is not a car repair garage, and saving it wastes the person who has to ring it.', parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'the business name exactly as Maps shows it' },
      category: { type: 'string', description: 'THE CATEGORY MAPS ITSELF PRINTS under the name ("Auto repair shop", "Parkeergarage"). Not your summary of it — this is what proves the place is the kind of business that was asked for.' },
      why: { type: 'string', description: 'why they are worth approaching: what they have, and what they are MISSING, in one sentence' },
      missing: { type: 'array', items: { type: 'string' }, description: 'what is absent, each as a short phrase: "no website", "Facebook page used as the website", "no way to book online", "hours not updated since 2023", "no reply to any negative review"' },
      address: { type: 'string' }, city: { type: 'string' }, country: { type: 'string', description: 'two-letter code' },
      phone: { type: 'string' }, website: { type: 'string', description: 'the site Maps links to — leave it out entirely if there is none, never invent one' },
      email: { type: 'string', description: 'only if the card or their own site shows one' },
      mapsUrl: { type: 'string', description: 'the link to THIS place on Maps — the share link or the address bar. Without it nobody can open the lead.' },
      rating: { type: 'number', description: 'the star average, as shown (4.3)' },
      ratingsCount: { type: 'integer', description: 'how many ratings that average is over — 4.9 from 3 people is not 4.9 from 300' },
      priceLevel: { type: 'string', description: 'the € / €€ / €€€ marker if the card shows one' },
      hours: { type: 'string', description: 'the opening hours as shown, one line' },
      claimed: { type: 'boolean', description: 'false when the card offers "Claim this business" — an unclaimed listing means nobody is minding it, which is a strong opening' },
      attributes: { type: 'array', items: { type: 'string' }, description: 'what the card lists under About/services — "Appointment required", "Wheelchair accessible", "Online estimates"' },
      reviews: { type: 'array', description: 'THE REVIEWS, as written. Read the newest and the lowest-rated: the complaints are where the work is.', items: { type: 'object', properties: {
        author: { type: 'string' }, rating: { type: 'number' },
        when: { type: 'string', description: 'as Maps words it — "2 weeks ago"' },
        text: { type: 'string', description: 'word for word, not summarised' },
        ownerReply: { type: 'string', description: 'the owner\'s reply if there is one. No reply to an angry review is itself the finding.' },
      } } },
    }, required: ['name', 'category', 'why', 'mapsUrl'] } } },

  { type: 'function', function: { name: 'save_gig', description: 'Record a freelance BRIEF worth bidding on, the moment you read it — do not wait until the end. A gig is a concrete piece of work with a budget and a link; the link is what everything downstream opens, so a gig without its URL is a rumour.', parameters: { type: 'object', properties: {
      title: { type: 'string', description: 'the brief\'s own title' },
      url: { type: 'string', description: 'THE LINK TO THIS BRIEF — the one thing a proposal cannot be sent without' },
      platform: { type: 'string', description: 'useme, upwork, …' },
      budget: { type: 'string', description: 'as listed — amount and currency, or "not stated"' },
      deadline: { type: 'string', description: 'as listed, if any' },
      brief: { type: 'string', description: 'what they want, in their words — enough to write a proposal from without reopening the page' },
      fit: { type: 'string', description: 'WHY this is winnable for a builder that ships working Stripe-wired web apps in 48h — name the match, not vibes' },
      client: { type: 'string', description: 'the client name as shown, if shown' },
      postedAt: { type: 'string', description: 'when it was posted — old briefs are filled briefs' },
    }, required: ['title', 'url', 'brief', 'fit'] } } },
  { type: 'function', function: { name: 'save_reply', description: 'Record a client REPLY or offer-status change on a brief the account already submitted to — the moment you read it. This is how a sent proposal becomes a conversation the owner can act on; without the brief URL it cannot be linked back to the gig, so always include it.', parameters: { type: 'object', properties: {
      url: { type: 'string', description: 'THE BRIEF / OFFER URL — links this reply back to the gig it answers' },
      title: { type: 'string', description: 'the brief title as shown' },
      from: { type: 'string', description: 'who replied — the client name as shown, if shown' },
      text: { type: 'string', description: 'what they said, in their words' },
      status: { type: 'string', description: 'offer status if it changed: accepted, rejected, awaiting, message, other' },
      at: { type: 'string', description: 'when the reply was posted, if shown' },
    }, required: ['url', 'text'] } } },
  { type: 'function', function: { name: 'save_reach', description: 'Record one day\'s REACH numbers read off a platform\'s own analytics page (impressions/views shown, clicks/engagement) — the moment you read them. Record ONLY numbers the page actually shows; never estimate. One call per day-row; a totals-only page is one call with its date range noted.', parameters: { type: 'object', properties: {
      day: { type: 'string', description: 'the day the numbers are for, YYYY-MM-DD (the page\'s own date)' },
      impressions: { type: 'integer', description: 'impressions/views/reach as the page names it' },
      clicks: { type: 'integer', description: 'clicks/engagements as the page names it' },
      note: { type: 'string', description: 'what the page called these numbers, e.g. "post impressions + link clicks"' },
    }, required: ['day'] } } },
  { type: 'function', function: { name: 'save_keywords', description: 'Record ONE keyword the audience actually searches, read off a Google keyword tool (Keyword Planner, Trends, autocomplete) — the moment it is in front of you, never from memory. Only terms a tool actually showed; a term or volume you did not see is left out, never invented. One call per term.', parameters: { type: 'object', properties: {
      keyword: { type: 'string', description: 'the search term exactly as the tool shows it' },
      volume: { type: 'string', description: 'monthly searches or the range the tool shows (e.g. "1K–10K"), verbatim; empty if not shown' },
      competition: { type: 'string', description: 'competition/difficulty as the tool names it (low/medium/high or a number), if shown' },
      intent: { type: 'string', description: 'what someone typing this wants, one short phrase: informational / comparison / ready-to-buy' },
      note: { type: 'string', description: 'which tool it came from and anything notable, e.g. "Keyword Planner, top of the plan"' },
    }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'save_search', description: 'Record ONE row from the Google Search Console PERFORMANCE page — a real search term the app already ranks for, exactly as the table shows it. Only rows the page displays; never a guess. One call per term.', parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'the search term exactly as the Performance table shows it' },
      impressions: { type: 'integer', description: 'impressions for this term, as shown' },
      clicks: { type: 'integer', description: 'clicks for this term, as shown' },
      position: { type: 'number', description: 'the average position for this term (a number like 4.2), as shown' },
    }, required: ['query'] } } },
  { type: 'function', function: { name: 'save_gsc_health', description: 'Record ONE thing you read in Google Search Console that is not a performance number — an unread message, a page-indexing count or a reason pages were not indexed, a sitemap status, a manual action, or a Core Web Vitals verdict. Call it once per finding, as you read each one, rather than saving them all up.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['message', 'indexing', 'sitemap', 'manual_action', 'vitals'], description: 'which part of the console this came from' }, label: { type: 'string', description: 'what it is called on screen, in the console’s own words' }, value: { type: 'string', description: 'the number or status beside it, exactly as shown' }, detail: { type: 'string', description: 'anything else the row said that a person would need to act on it' }, pages: { type: 'array', items: { type: 'string' }, description: 'THE ACTUAL ADDRESSES behind this row, when the screen lists them — open a "why pages are not indexed" reason and it shows the example URLs. A count cannot be fixed; a URL can. Copy them exactly as shown, full addresses, as many as the table gives you.' } }, required: ['kind', 'label'] } } },
  { type: 'function', function: { name: 'save_gsc_token', description: 'Record the Google Search Console VERIFICATION TOKEN — the content="..." value from the HTML-tag verification method Google shows when you add a property. The platform plants it in the app so the property can be verified. Copy it EXACTLY, the whole string; never invent one.', parameters: { type: 'object', properties: {
      token: { type: 'string', description: 'the exact content value of the <meta name="google-site-verification" content="..."> tag Google shows' },
    }, required: ['token'] } } },
  { type: 'function', function: { name: 'save_opportunity', description: 'Record ONE product opportunity you found — a recurring pain real people describe that a small product could solve. Call it the moment the evidence is in front of you, never at the end from memory. Every opportunity MUST carry the threads it came from: the link, the title, and THE DATE THE PAGE ITSELF SHOWS on each one. Do not estimate a date and do not round it to "recent" — copy what the page says. An opportunity you cannot link to at least one real thread is not one; leave it out.', parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'a short name for the product, 2-5 words' },
      idea: { type: 'string', description: 'what it would be and who for, 1-3 plain sentences' },
      pain: { type: 'string', description: 'the recurring pain, in the words the posters actually used' },
      evidence: { type: 'array', description: 'the threads this comes from — at least one, more is stronger', items: { type: 'object', properties: {
        url: { type: 'string', description: 'the thread link' },
        title: { type: 'string', description: 'its title' },
        postedAt: { type: 'string', description: 'the date the page shows for it (YYYY-MM-DD, or exactly what it says e.g. "5 days ago")' },
        quote: { type: 'string', description: 'a short line from it, in the words the poster used' },
      }, required: ['url'] } },
      price_hint: { type: 'string', description: 'what people say they pay or would pay, if the threads say' },
    }, required: ['name', 'idea', 'evidence'] } } },
  { type: 'function', function: { name: 'diagnostics', description: 'What the BROWSER saw that the page does not show you: uncaught JavaScript errors, failed network requests with their status codes, console errors, and every address the page navigated to (which is how a redirect loop becomes visible). Call this the moment something looks wrong \u2014 a page that will not render, a form you cannot fill, a screen that keeps bouncing. It is the difference between "it did not work" and knowing why.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'act', description: 'Do something that other people will see, under the account owner’s name: comment, reply, join a group, follow, like, send a message. This asks the owner first and does nothing until they say yes. Write the full text you want to send.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['comment', 'reply', 'join', 'follow', 'like', 'message', 'other'] }, index: { type: 'integer', description: 'the numbered element to click — the comment box, the Join button' }, text: { type: 'string', description: 'exactly what to write, in the owner’s voice. Leave empty for join/follow/like.' }, why: { type: 'string', description: 'why this person, in one line' }, leadId: { type: 'integer', description: 'the lead this is for, so the conversation is recorded against them' } }, required: ['kind', 'index'] } } },
  { type: 'function', function: { name: 'make_brand_image', description: 'Draw a clean brand image and keep it ready to upload — a square mark (the brand initials on its colour) for the PROFILE picture, or a wide banner (the brand name) for the COVER. Needs nothing external. Returns an asset id you then pass to upload_image. Use it to give a blank page an identity.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['profile', 'cover'], description: 'profile = square avatar, cover = wide banner' }, name: { type: 'string', description: 'the brand name — becomes the initials on a profile mark, or the wordmark on a cover' }, accent: { type: 'string', description: 'the brand accent colour as a hex like #d62b2b; defaults to a neutral blue if omitted' }, tagline: { type: 'string', description: 'optional one line shown small under the name on a COVER only' } }, required: ['kind', 'name'] } } },
  { type: 'function', function: { name: 'upload_image', description: 'Put a stored image (from make_brand_image or download_image) onto the page by setting the photo uploader. FIRST open the page\'s profile-photo or cover editor so its upload control is on screen, THEN call this. After it, a Save/Apply/crop-confirm step remains — do that through act.', parameters: { type: 'object', properties: { assetId: { type: 'string', description: 'the id make_brand_image / download_image returned; omit to use the most recent image of the given kind' }, kind: { type: 'string', enum: ['profile', 'cover'], description: 'which image to use when assetId is omitted' } } } } },
  { type: 'function', function: { name: 'screenshot_page', description: 'Take a picture OF the screen you are looking at, and store it. Use it to show our own product doing the thing a page describes. It measures what it took, because an image published without its width and height shifts the layout as it loads. Pass a numbered element to frame just that part, which is usually far more useful than the whole window.', parameters: { type: 'object', properties: { index: { type: 'integer', description: 'a numbered element to frame; omit for the visible screen' }, kind: { type: 'string', description: 'what the picture is for, so it can be found later' }, name: { type: 'string', description: 'a short name saying what is in it' } } } } },
  { type: 'function', function: { name: 'paste_image', description: 'Paste a STORED image into the prompt box on this page, the way a person pastes a screenshot into a chat — this is how you give an image generator a REFERENCE picture to work from. The attach button on those pages opens the operating system file dialog, which you cannot answer; the paste handler is the path that works. Click into the prompt box first, then call this, then LOOK to confirm a thumbnail appeared before writing the prompt.', parameters: { type: 'object', properties: { assetId: { type: 'string', description: 'the id of the stored image; omit to use the most recent one of the given kind' }, kind: { type: 'string', description: 'which stored image to paste when assetId is omitted, e.g. brandmark' } } } } },
  { type: 'function', function: { name: 'download_link', description: 'Fetch a LINKED FILE out of the current page — a PDF, an export, a zip, a video, an image behind a link — inside the logged-in session, and store it with its real name so the owner can see and save it from the chat (and upload_file can reuse it). Pass the index of the link the look showed, or a url. When a page offers a Download BUTTON instead, click it: the browser captures every download and every file a tab opens by itself.', parameters: { type: 'object', properties: { index: { type: 'integer', description: 'a numbered link (or element inside one) from the look' }, url: { type: 'string', description: 'a direct file address' }, name: { type: 'string', description: 'a name for the file, if the page gives none' } } } } },
  { type: 'function', function: { name: 'download_image', description: 'Take an image OUT of the current page — a photo an image tool (Gemini) just generated in its chat, or one on a stock page — and store it so you can upload_image it onto a brand page. By default grabs the most recent large picture (the one just generated); pass index to point at a specific numbered image the look shows. Reads the bytes inside the logged-in page, so the tool\'s/stock site\'s entitlement applies.', parameters: { type: 'object', properties: { index: { type: 'integer', description: 'a numbered element that IS or CONTAINS the image; omit to grab the most recent large image' }, kind: { type: 'string', description: 'what this image is for — profile, cover, or post — so upload_image can find it later' }, source: { type: 'string', description: 'where it came from, e.g. gemini or unsplash, for the record' } } } } },
  /*
   * MOVING BETWEEN LOGINS.
   *
   * Every stored profile is a browser that is already signed in somewhere. "Search LinkedIn" should
   * use the LinkedIn login, not whichever session happened to be open — and the agent cannot infer
   * that from a folder name, so each profile carries the site it belongs to and the agent picks by
   * that. Switching is a real switch: a different browser context, different cookies, a different
   * account. It is worth a step of its own rather than a flag on something else.
   */
  { type: 'function', function: { name: 'use_profile', description: 'Switch to one of the stored logins — use this when the job is about a site your current session is not signed in to. Call list_profiles first to see what is available.', parameters: { type: 'object', properties: { profile: { type: 'string' } }, required: ['profile'] } } },
  { type: 'function', function: { name: 'use_my_profile', description: 'On FACEBOOK: switch back to the owner\'s PERSONAL profile if Facebook is acting as a Page. While it acts as a Page, your groups and personal things are hidden. This is deterministic — it does not need the account menu — so call it FIRST on Facebook, before trying to read groups.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'use_role', description: 'Change which specialist you are working as, when this job needs something your current role cannot do. A role carries a playbook for a kind of work and the tools that go with it — so a download needs one that can fetch files, and recording businesses off a map needs one that can save places. Call this the moment a tool is refused, rather than working around it: the refusal means you were given the wrong specialist, not that the job is impossible. Use "general" when nothing more specific fits; it can reach everything.', parameters: { type: 'object', properties: { role: { type: 'string', description: 'the role to work as from now on; pass an unknown name to be told which exist' }, why: { type: 'string', description: 'why this job needs it, in one line' } }, required: ['role'] } } },
  { type: 'function', function: { name: 'list_profiles', description: 'The logins available: which site each one is signed in to, and which you are using now.', parameters: { type: 'object', properties: {} } } },

  /*
   * LEARNING THE PERSON.
   *
   * Used by the "study me" job, but available to any job — if the agent notices how the owner signs
   * off halfway through a lead hunt, that is worth keeping.
   */
  { type: 'function', function: { name: 'remember_about_me', description: 'Write down something true about the account owner that will help you act as them later: their trade, their region, the groups they are in, how they sign off. One fact per call.', parameters: { type: 'object', properties: { label: { type: 'string', description: 'short label, e.g. "trade" or "region"' }, value: { type: 'string' }, source: { type: 'string', description: 'where you saw it' } }, required: ['label', 'value'] } } },
  { type: 'function', function: { name: 'save_my_writing', description: 'Save something the owner themselves actually wrote — one of their own posts or comments, word for word. These are what make your replies sound like them, so keep them verbatim and do not tidy them up.', parameters: { type: 'object', properties: { text: { type: 'string' }, where: { type: 'string', description: 'which group, post or page it came from' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'describe_my_voice', description: 'After reading enough of their writing, summarise how they write: length, formality, punctuation, greetings and sign-offs, the words they reach for, whether they use emoji. Replaces any earlier summary.', parameters: { type: 'object', properties: { style: { type: 'string' } }, required: ['style'] } } },

  /*
   * THE CONVERSATION.
   *
   * A Facebook reply does not land in an inbox — it arrives as a NOTIFICATION. So the sweep is not
   * "read the inbox": ask who you are waiting on, then look at the notifications and match names
   * you are already carrying. That is why waiting_on returns what was said as well as who to.
   */
  { type: 'function', function: { name: 'waiting_on', description: 'The people you have written to who have not answered yet — with their post and exactly what you said to them. Call this FIRST when checking for replies: you can then read a notifications page and recognise the names, instead of opening every notification to find out whose it is.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'whose_is_this', description: 'Match a post, profile or name you are looking at to one of your leads, and see what was already said to them. Use it when a notification names somebody and you want to be sure which conversation it belongs to.', parameters: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, profileUrl: { type: 'string' } } } } },
  { type: 'function', function: { name: 'record_reply', description: 'They answered. Record what they said, word for word — this is what decides whether they are interested, want a call, or are not worth following, and it moves them along the pipeline automatically.', parameters: { type: 'object', properties: { leadId: { type: 'integer' }, text: { type: 'string' }, url: { type: 'string' }, channel: { type: 'string', enum: ['comment', 'reply', 'dm', 'reaction'] } }, required: ['leadId', 'text'] } } },
  { type: 'function', function: { name: 'remember_conversation', description: 'Mark this chat as one the owner MANAGES — call it right after you SEND an approved opening message to someone, so the reply-watcher knows to follow up here (and only here). The owner chose this person by approving the first message; this is what records that choice.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'who the chat is with' }, threadUrl: { type: 'string', description: 'the /messages/t/ link of the thread' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'managed_conversations', description: 'The chats the owner manages — the people they have already messaged with approval. Call this FIRST when watching for replies, and follow up ONLY with people on this list; ignore any incoming message from anyone not on it. This is how a stranger who messages out of the blue never gets an automatic reply.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'store_data', description: 'Save a piece of STRUCTURED OUTPUT under a name, so a LATER step in the automation can use it. This is how a planning step hands its result to the next — a script, a storyboard, a list of scenes, any object or text. Store the finished thing once, under a clear key like "script" or "storyboard". Prefer real structure (an object/array) over one long string when the next step needs the parts.', parameters: { type: 'object', properties: { key: { type: 'string', description: 'a short name for this output, e.g. "script" or "storyboard"' }, value: { description: 'the content to save — an object, an array, or text' } }, required: ['key', 'value'] } } },
  { type: 'function', function: { name: 'download_file', description: 'Get a generated FILE — an image or a VIDEO clip — off the page and into storage, so a LATER step on another site can upload it. Takes the most recent video / download link / large image, or a numbered element if you pass one. Call it once the file has finished generating (use wait_for_ready first if it is still rendering). Hands back an asset id.', parameters: { type: 'object', properties: { index: { type: 'integer', description: 'the numbered element holding the file, if the look shows it' }, kind: { type: 'string', description: 'optional label, e.g. "clip" or "final"' }, name: { type: 'string', description: 'optional file name' } } } } },
  { type: 'function', function: { name: 'upload_file', description: 'Put a STORED file onto the current page — sets the site\'s file input. Two sources: a file asset saved earlier by download_file/stop_recording (assetId), or a finished PLATFORM RECORDING the console shows (recordingId, e.g. rec-mua8tecc-mo53l). Open the upload / "Add media" control first so the file input exists, then call this. Use it to feed an image into a video generator, or footage into an editor.', parameters: { type: 'object', properties: { assetId: { type: 'string', description: 'the asset id a download_file or stop_recording step returned' }, recordingId: { type: 'string', description: 'the id of a finished recording (rec-…) — its video is read straight from the recorder\'s store, nothing needs downloading first' } } } } },
  { type: 'function', function: { name: 'wait_for_ready', description: 'Wait for a slow generation or export to finish before doing the next thing. Polls the page until a cue appears — pass the text that shows when it is done (e.g. "Download", "Complete"), or nothing to wait for a video/download link to appear. Use it after starting a render (Kling/Veo clip, a CapCut export) instead of guessing at fixed waits.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'the text that appears when it is ready, e.g. "Download"' }, seconds: { type: 'integer', description: 'how long to wait at most (default 180)' } } } } },
  { type: 'function', function: { name: 'start_recording', description: 'Begin recording the screen of the current page into a video. Call this, THEN do what you want on camera — open tabs, scroll, show a page working — then call stop_recording to save it. This is how you film a live demo (e.g. a tour of a console) as real footage for an edit.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'stop_recording', description: 'Stop the screen recording started by start_recording, encode it to a video, and store it as an asset (returns an asset id you can upload_file later). Call it once you have shown everything you wanted on camera.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'optional file name for the clip' } } } } },
  { type: 'function', function: { name: 'conversation', description: 'Everything said to and from one lead so far. Read it before answering, so you continue a conversation instead of starting it again.', parameters: { type: 'object', properties: { leadId: { type: 'integer' } }, required: ['leadId'] } } },

  { type: 'function', function: { name: 'note', description: 'Tell the person watching what you are thinking or why you are stuck. Use this instead of going quiet.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'knowledge_query', description: "Ask the owner's OWN connected knowledge base / vector database (e.g. Alquarium's aquarium database) a question, and get an answer to base your reply on. Call this BEFORE answering someone's question in a group, so the reply is grounded in the owner's own data instead of guesswork. If no base is connected it tells you to answer from your own expertise.", parameters: { type: 'object', properties: { question: { type: 'string', description: 'the question to look up an answer for' }, connector: { type: 'string', description: "name of the connected knowledge base to use (a connector the owner added, e.g. 'alquarium'); omit to use the default" } }, required: ['question'] } } },
  { type: 'function', function: { name: 'knowledge_store', description: "Write a strong expert answer BACK into the owner's knowledge base / vector database, so it learns and improves. Use when another expert in a group has given a good, correct answer worth keeping — pass the answer text and the topic/object it is about.", parameters: { type: 'object', properties: { content: { type: 'string', description: 'the expert answer text to store' }, object: { type: 'string', description: 'the topic or object it relates to (e.g. the fish species or the question subject)' }, connector: { type: 'string', description: "name of the connected knowledge base to write to (a connector the owner added, e.g. 'alquarium'); omit to use the default" } }, required: ['content'] } } },
  { type: 'function', function: { name: 'finish', description: 'The job is done or cannot go further. Say what you found and what you would do next.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
];

/*
 * The logins, as a line each. Site first, because that is what the agent matches a job against.
 */
/* The call as one line: the tool, then the arguments that actually identify it. Long text is cut
   here rather than in the UI, because this also goes to disk. */
/*
 * Which failures are worth trying again.
 *
 * 500/502/503/504 and a dropped connection are the other end having a moment, and most are gone by
 * the second attempt. 401 and 404 are a setting being wrong: retrying those just burns the wait
 * three times before reporting the same thing.
 */
const PERMANENT = new Set([400, 401, 403, 404]);

/*
 * ONE ring per key-list, kept for the life of the process. Rebuilding it per model turn would
 * forget which account is spent and retry a dead key every single time — one wasted round-trip each,
 * which over a 120-turn job is most of them. Rebuilt only when the keys themselves change, so a key
 * added in the settings still takes effect without a restart.
 */
let _ring = null, _ringFrom = null;
function ringFor(settings) {
  /* PRIMARY FIRST, BACKUP AFTER. Built the other way round, the reserve account becomes the one
     every call uses and the main key only ever sees its failures — which is the opposite of what a
     backup is for, and it silently stops using a working key the moment a second one is saved. */
  const list = [settings.llmKey, ...String(settings.llmKeys || '').split(',')];
  const sig = list.join('|');
  if (sig !== _ringFrom) { _ringFrom = sig; _ring = makeKeyring(list); }
  return _ring;
}

/*
 * DID THE WORDS ACTUALLY LAND? Read the page back and look for them.
 *
 * A distinctive slice from the MIDDLE of what was sent, compared on letters and digits only:
 * platforms re-wrap lines, swap quotes for smart ones, collapse spaces and hang a "· 1m" on the
 * end, and none of that means the comment is missing. The middle is used because a composer that
 * still holds the draft would match the beginning just as well — it is the whole point to tell a
 * posted comment from an unsent one sitting in the box.
 */
const lettersOnly = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Two pieces of text that are the same words — the composer re-wraps and re-quotes what it holds. */
function sameWords(a, b) {
  const x = lettersOnly(a), y = lettersOnly(b);
  if (x.length < 25 || y.length < 25) return false;   // too short to be sure it is the same message
  return x === y || x.includes(y) || y.includes(x);
}

/*
 * IS THIS A LOGIN WALL? Answered structurally, so it holds in any language.
 *
 * A password field is the plainest signal a page can give: nothing but a sign-in asks for one. A
 * login path in the address is the other, and it catches the walls that ask for an email first and
 * a password on the next screen — which is exactly what Indie Hackers does through Google.
 *
 * Injected, so self-contained and it must never throw. Unknown is NOT a wall: saying a page is a
 * login screen when it is not would stop the desk replying anywhere.
 */
function loginWall() {
  try {
    if (document.querySelector('input[type="password"]')) return true;
    const host = (location.hostname || '').toLowerCase();
    if (host === 'accounts.google.com' || host.endsWith('.accounts.google.com')) return true;
    const path = (location.pathname || '').toLowerCase();
    return /(^|\/)(login|signin|sign-in|sign_in|log-in|checkpoint|uas\/login|authwall)(\/|$)/.test(path);
  } catch (e) { return false; }
}

/*
 * THE PAGE AS A READER SEES IT — every editable box left out.
 *
 * Injected, so self-contained and it must never throw. `document.body.innerText` includes whatever
 * is sitting in the comment box, so a reply that was typed and never sent read exactly like one
 * that had posted: a LinkedIn article said "No comments, yet." while Herald said REPLIED.
 *
 * A posted comment is in the document. A typed one is inside something editable. That is the whole
 * difference, so the walk skips contenteditable, textarea, input and role=textbox — and script and
 * style, which are in the DOM but on nobody's screen.
 */
function readableText() {
  const SKIP = { TEXTAREA: 1, INPUT: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SELECT: 1 };
  const walk = (node) => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out += child.nodeValue; continue; }   // text
      if (child.nodeType !== 1) continue;
      if (SKIP[child.tagName]) continue;
      /* isContentEditable is inherited, so this skips the whole composer in one go. */
      if (child.isContentEditable) continue;
      if (child.getAttribute && child.getAttribute('role') === 'textbox') continue;
      out += ' ' + walk(child);
    }
    return out;
  };
  try { return document.body ? walk(document.body) : ''; } catch (e) { return ''; }
}

/*
 * DOES THIS PAGE SAY THIS? — the verify step's question, and NOT the one confirmPosted answers.
 *
 * confirmPosted asks "is the thing I typed actually posted?", so it demands a long distinctive string
 * and refuses to guess below 40 alphanumerics, returning null. The verify step of a flow asks
 * something far simpler: does the page contain this evidence. Routing that through confirmPosted made
 * every short, sensible proof unsatisfiable — "PLN" is 3 characters, a page heading is about 22 — so
 * `found` was false for text sitting in plain view, no flow could ever be verified, and nothing ever
 * reached the library. Six builds died against this.
 *
 * Normalised on both sides so the answer does not hinge on typography: case folded, accents removed
 * (a Polish heading must match whether or not the builder typed the diacritics), and every run of
 * non-alphanumerics flattened to one space, so line breaks and markup spacing cannot hide a match.
 * The same patient retries as confirmPosted, because a listing page is often still settling.
 */
/* NFD splits an accented letter into the letter plus a combining mark; the marks are then dropped by
 * code point rather than by a regex range, so nothing here depends on exotic characters surviving a
 * copy. Dropping them must not leave a gap: flattening them to spaces instead would split
 * "freelancerow" into two words and lose the match it exists to find. */
const stripMarks = (t) => Array.from(String(t == null ? '' : t))
  .filter((c) => { const n = c.codePointAt(0); return n < 768 || n > 879; })
  .join('');
const flatten = (t) => stripMarks(String(t == null ? '' : t).normalize('NFD'))
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function pageHasText(page, text, waits = [600, 1500, 3000]) {
  const want = flatten(text);
  /* Two characters cannot be evidence of anything; below that we say "cannot tell", never "yes". */
  if (want.length < 3) return null;
  for (const wait of waits) {
    await new Promise((r) => setTimeout(r, wait));
    let body = '';
    try { body = await page.evaluate(readableText); } catch { return null; }
    if (flatten(body).includes(want)) return true;
  }
  return false;
}

async function confirmPosted(page, sent, waits = [900, 1800, 3000]) {
  const want = lettersOnly(sent);
  if (want.length < 40) return null;   // too short to identify — do not guess either way
  /* A distinctive slice from the middle: past any greeting, before any trailing question. */
  const needle = want.slice(Math.floor(want.length / 2) - 30, Math.floor(want.length / 2) + 30);
  for (const wait of waits) {
    await new Promise((r) => setTimeout(r, wait));
    let body = '';
    try { body = await page.evaluate(readableText); } catch { return null; }
    if (lettersOnly(body).includes(needle)) return true;
  }
  return false;
}
async function askWithRetry({ chat, settings, messages, signal, job, pace = 1, attempts = 3 }) {
  let last;
  /*
   * KEYS, PLURAL. The whole factory ran on one account, and the day its weekly allowance ended
   * everything stopped together — the builder, the master's verdicts and this browser's QA. A second
   * account only helps if something reaches for it. The ring moves on when a key is EXHAUSTED and
   * never when it is merely rate-limited: a busy minute clears by waiting, and spending the second
   * account on it would waste both.
   */
  const ring = ringFor(settings);
  let key = ring.current();
  for (let i = 1; i <= attempts; i++) {
    try {
      return await chat({
        host: settings.llmHost, model: settings.llmModel, key,
        messages, tools: TOOLS, signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (isSpent(e)) {
        const next = ring.spend(key, e.message);
        if (next && next !== key) {
          key = next;
          if (job) jobsStore.step(job, 'note', 'that account is out of allowance for this period — carrying on with the next key');
          continue;                            // a fresh key deserves its attempt, not a backoff
        }
        /*
         * EVERY KEY IS SPENT. Retrying is pointless — an allowance does not come back in four
         * seconds — and the backoff below would spend three more attempts saying nothing useful.
         * Live, this read as "The model stopped answering" and a walk that never opened a page was
         * reported downstream as "nobody works there", which is a conclusion nobody had checked.
         * So it stops immediately and says the one thing that is true and actionable.
         */
        const st = ring.state();
        const spent = Object.assign(
          new Error(`every model key is out of allowance for this period (${st.usable} of ${st.total} usable) — nothing can run until the allowance resets or another account's key is added in Settings`),
          { status: 429, permanent: true, allKeysSpent: true },
        );
        if (job) jobsStore.step(job, 'blocked', spent.message);
        throw spent;
      }
      if (PERMANENT.has(e.status)) { e.permanent = true; throw e; }
      last = e;
      if (i === attempts) break;
      // Backing off rather than hammering: a model that just 500ed is not helped by three more
      // requests in the same second, and the wait is what usually makes the difference.
      // `pace` and not `pace || 1`: pace is 0 in tests, and `||` turned that back into a full
      // four and a half seconds of real waiting — which is how this was first noticed.
      const wait = Math.round(1500 * Math.pow(2, i - 1) * pace);
      if (job) jobsStore.step(job, 'note', `the model errored (${e.message}) — trying again in ${Math.round(wait / 1000)}s`);
      await sleep(wait, signal);
    }
  }
  throw last;
}

/*
 * Which site is this, actually? Read from the address rather than from what the role intended,
 * because a research run crosses sites inside one conversation and the page is the only thing that
 * knows where it is.
 */
function adapterFor(currentUrl) {
  const u = String(currentUrl || '').toLowerCase();
  if (/(^|\.)linkedin\.com/.test(u) || u.includes('//www.linkedin.')) return { name: 'linkedin', mod: li };
  if (/(^|\.)facebook\.com/.test(u) || u.includes('//www.facebook.')) return { name: 'facebook', mod: fb };
  return null;
}

function summariseCall(name, a = {}) {
  const bits = [];
  if (a.index !== undefined) bits.push(`[${a.index}]`);
  if (a.url) bits.push(String(a.url).slice(0, 120));
  if (a.profile) bits.push(String(a.profile));
  if (a.kind) bits.push(String(a.kind));
  if (a.direction) bits.push(String(a.direction));
  if (a.label) bits.push(String(a.label));
  if (a.name) bits.push(String(a.name));
  const text = a.text || a.style || a.value || a.summary;
  if (text) bits.push(`"${String(text).slice(0, 140)}"`);
  return `${name}(${bits.join(' ')})`;
}

const compactArgs = (a = {}) => {
  const out = {};
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === 'string' ? v.slice(0, 400) : v;
  return out;
};

function describeProfiles(current) {
  try {
    const dirs = require('fs').readdirSync(process.env.PROFILE_DIR || '/profiles', { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
    if (!dirs.length) return '';
    return dirs.map((n) => {
      const cfg = profiles.read(n);
      const bits = [cfg.site || 'site not set', cfg.note].filter(Boolean).join(' — ');
      return `- ${n}: ${bits}${current?.profile === n ? '  (you are using this one)' : ''}`;
    }).join('\n');
  } catch { return ''; }
}

function systemPrompt({ goal, companyContext, meContext, profileList, autoAct, role, playbookContext }) {
  const site = (role && role.site) || 'facebook';
  const findExamples = site === 'linkedin'
    ? [
        '  sweep({ site: "linkedin", search: "programmeur gezocht" })   LinkedIn\'s content search',
        '  sweep({ site: "linkedin" })                                  your own LinkedIn feed',
        '',
        'Expect fewer posts than on Facebook and be more selective. People here announce rather than',
        'ask: a hiring push, a launch, "we are rebuilding our platform", "looking for recommendations for".',
      ].join('\n')
    : [
        '  sweep({ search: "wie kan een webshop bouwen" })   posts anywhere on Facebook',
        '  sweep({ myGroups: true })                          every group this account is in',
        '  sweep({ group: "123456" })                         one group\'s feed',
        '  sweep({ group: "123456", inGroup: "developer" })   search inside that group',
      ].join('\n');
  return `You are working inside a real web browser that is already logged in to the account owner's
social accounts. You act on their behalf.

HOW YOU SEE A PAGE
You call look, and get every clickable thing as a numbered list. You act by number. The numbers are
only valid for the page as it is right now — after anything changes the page, call look again before
you click. If you are not sure what is on screen, look. It is cheap.

Two markers in that list tell you WHAT a control is, so you reach for the right tool:
- "✎ FIELD" is a text box (an input, a description, a rich-text editor). You TYPE into it with
  type([number], "the text") — clicking it never fills it. If you opened a section to enter text and
  do not see a ✎ FIELD, look again (it may have just appeared) or scroll to it.
- "✓ (SELECTED)" means that option, category, checkbox or tab is ALREADY on. Clicking it again turns
  it OFF. Click only the unselected ones you want, then look to confirm they now show "✓ (SELECTED)".

HOW YOU READ
look shows you the CONTROLS — buttons, links, fields — and is how you find something to click. read
shows you the WORDS. You cannot judge a post from a look; that is judging a page by its buttons. If
you want to know what people are saying, read.

FINDING LEADS — use sweep, not your hands

sweep is the tool for this. It reads a whole feed and hands you the posts themselves — the person,
their words, how old, and the link — having scrolled to the end and dropped anything stale. One call
instead of a dozen. Then you do the part only you can do: read what each person actually wrote and
decide whether they need what we sell.

THE ONE MISTAKE THAT WASTES A WHOLE RUN: building a search URL yourself, open()ing it, and read()ing
the page. That returns the page frame, not the posts — the posts only appear as you scroll, which is
what sweep does. If you find yourself opening search after search, stop: you are doing sweep's job by
hand and getting nothing. Call sweep with the words, let it scroll and extract, then save_lead each
real one BEFORE trying different words.

${findExamples}

Search the words a person in trouble would write, not the words a supplier would. Somebody who needs
a developer writes "wie kan mij helpen met", "iemand die een webshop kan bouwen", "programmeur
gezocht" — they do not write "software development services". Try several phrasings and sweep each:
the first one rarely gives the best posts, and each sweep is cheap.

Save every lead as you read it. Do not go and open pages to check things first.

look, read, click and type still exist for when something is in the way — a cookie wall, a
checkpoint, a page that is not a feed. Use them for that, not for looking for people.

WHEN YOU DO NEED YOUR HANDS

Search posts, not groups. A group is a place; a post is a person saying something. These addresses
work and are the fastest way in:

  https://www.facebook.com/search/posts?q=WORDS       posts containing those words
  https://www.facebook.com/search/groups?q=WORDS      groups about a subject
  https://www.facebook.com/groups/ID/search/?q=WORDS  search INSIDE one group you are in
  https://www.facebook.com/groups/feed/               the feed of every group you are a member of

Use the whole address including https://. A bare one is rejected as invalid and costs you a step.

Search the words a person in trouble would write, not the words a supplier would. Somebody needing a
roofer writes "lekkage", "wie kent een goede dakdekker", "iemand ervaring met" — they do not write
"roofing services". Try several phrasings; the first one rarely gives the best posts.

A FEED IS EMPTY UNTIL YOU SCROLL. Facebook loads a screenful at a time, so what you see on arrival
is almost never all there is. The rhythm is: read, scroll, read, scroll — four or five times in one
place before you decide it is not worth it. If a read comes back the same as the last one, THEN
nothing more is loading and you can move on.

WORK ONE PLACE PROPERLY. Opening five groups and glancing at each finds nothing; going through one
group's posts properly finds two or three real leads. Do not leave a group until you have scrolled
and read it several times, or you have read something that tells you it is the wrong group entirely.

HOW OLD IS TOO OLD — this matters more than it sounds
Somebody who asked for a roofer in 2021 has had a roof for four years. Replying to them is not
merely useless: an account answering years-old posts is the clearest possible sign to the people
reading it that nobody is home. Facebook search returns old posts freely, so this is on you.

  Under a month     good, act on it
  One to three      worth saving, say how old it is when you propose a reply
  Over three months skip it, and do not save it
  No date visible   scroll to the post itself; the date is next to the author's name. If you truly
                    cannot find one, say so in the lead rather than guessing.

SAVE FIRST. THE LINK IS A BONUS.
The moment you read something that is a lead, call save_lead. Do not go looking for anything first.
A lead with the person's name and their own words is worth a great deal; the same lead never saved
because you were hunting for a link is worth nothing, and that is exactly what happened in the last
run — forty-two steps, sixteen pages read, not one lead recorded.

The link, when you have it without effort:
  - if you are standing ON the post (its own page), the address you were just told IS the permalink.
    Use it. Nothing needs clicking.
  - if you are in a feed or a results list, save the lead anyway and leave postUrl empty rather than
    going hunting. You can always open it later; you cannot recover a lead you never wrote down.
A group address is not a post address, so do not pass one as if it were.

WHAT YOU MAY DO ON YOUR OWN
Navigate, search, open groups and posts, scroll, read, and record leads. All of that is reversible
and none of it is visible to anyone else.

WHAT YOU MUST ASK FIRST
${autoAct
  ? 'The owner has allowed you to act without asking. Still use act (not click) for anything other people will see, so it is written down, and still keep each one specific to the person you are replying to.'
  : `Anything other people can see happens through act, never through click: commenting, replying,
joining a group, following, liking, sending a message. act shows the owner exactly what you want to
write and does nothing until they approve it. Do not try to reach the Post or Join button with click
— it will be refused and you will have wasted a step.`}

HOW TO WRITE, WHEN YOU DO
Under a real person's name. Specific to what that person actually said — quote them or refer to
their situation. No template that would fit any post. No sales pitch in a first reply. Match the
language of the group. If the company profile below gives a voice, use it.

CHECKING WHETHER ANYONE ANSWERED
A reply on Facebook does NOT arrive in an inbox. It arrives as a notification. So: call waiting_on
first — it gives you every person you are waiting on, their post, and exactly what you said to them.
Then open the notifications page and look for those names. You do not need to open notifications one
by one to find out whose they are; you are already carrying the list. Only open the ones that match.
Direct messages are separate and do live in a message list, so check that too if the job asks.

When you find an answer, use record_reply with their words as they wrote them. That is what decides
whether they are interested or want a call, and it moves them along by itself — do not guess the
outcome, just record what was said. If somebody asks for a call, say so and stop; a person should
make that one.

WHEN SOMETHING BLOCKS YOU
A captcha, a login, a checkpoint, an "are you a robot" — stop and use note to say exactly what you
see. A human is watching this browser and can solve it in seconds. Never try to work around it.

BE HONEST
If a group is a dead end, say so and move on. A short list of real leads is the goal; a long list of
maybes is worse than nothing because someone has to check every one.

${meContext ? `WHO YOU ARE ACTING AS\n${meContext}\n
Everything you write goes out under this person's name. Match how they actually write — the length,
the punctuation, the greeting, the sign-off. A reply that is more polished than their own writing is
as wrong as one that is worse.\n` : ''}
${profileList ? `LOGINS YOU CAN USE\n${profileList}\nIf the job is about a site you are not signed in to, switch with use_profile before anything else.\n` : ''}
${companyContext ? `WHO YOU WORK FOR\n${companyContext}\n` : ''}
${role && role.prompt ? role.prompt + '\n' : ''}
${playbookContext ? `WHAT THIS ACCOUNT HAS ALREADY LEARNED
This is earned from previous runs — how many leads each place actually produced, not anybody's
opinion of it. Start from what has worked; do not spend this run rediscovering it.

${playbookContext}
` : ''}
THE JOB
${goal}

Work in small steps: look, decide, do one thing, look again. Call finish when you are done or truly
stuck.`;
}

/** The model's transcript grows fast — a page dump is thousands of characters. Keep the shape, drop
    the bulk of anything old: recent observations are what it reasons over, older ones only need to
    be remembered as having happened. */
function trimTranscript(messages, keepFull = 6) {
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const shrink = toolIdx.slice(0, Math.max(0, toolIdx.length - keepFull));
  for (const i of shrink) {
    if (messages[i].content && messages[i].content.length > 300) {
      messages[i] = { ...messages[i], content: `${messages[i].content.slice(0, 240)}… (older observation, trimmed)` };
    }
  }
  return messages;
}

/** Wait for a person to approve, edit or skip. Polls the record rather than holding a callback, so a
    decision made from any tab — or a stop — lands the same way. */
/*
 * WAIT FOR THE HUMAN — and keep the session ALIVE while waiting. An act off our own ground parks
 * here until the owner approves it in the queue, which takes MINUTES. The main loop bumps
 * session.lastUsed every iteration so a working session is never idle-reaped; but this wait is not
 * the main loop, so without help the 5-minute idle sweep closes the session out from under a pending
 * approval — and when the owner finally clicks Approve, the act fails with "the browser was closed"
 * and nothing is created. Seen live: the first PrintOps Facebook page. So `onWait` (which bumps the
 * live session's lastUsed) is called every poll — the session's life is tied to the pending decision.
 */
/*
 * A cheap/quantized model can corrupt a message mid-generation — fusing two candidate replies into
 * junk ("hebT eje ż zicn iom ę…"), or repeating the whole thing. That must never AUTO-SEND to a real
 * person; a garbled draft should be held for a human instead. Heuristic on purpose — a false positive
 * only parks a fine message for approval, which is the safe direction. Catches the two seen failures:
 * a duplicated run of text, and word-salad (capitals inside words, lone letters).
 */
function looksGarbled(text) {
  const t = String(text || '').trim();
  if (t.length < 12) return false;
  // 1. A 20-char run that appears again later — duplication / two candidates fused (the seen failure
  //    ended with its whole clean message repeated verbatim).
  for (let i = 0; i + 20 <= t.length; i += 8) {
    if (t.indexOf(t.slice(i, i + 20), i + 20) >= 0) return true;
  }
  // 2. Word salad: too many tokens with a capital INSIDE the word ("hebT"), lone single letters, or a
  //    run of 4+ consecutive consonants (nonsense strings like "erbgaenrsd").
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 6) {
    const weird = words.filter((w) =>
      /\p{Ll}\p{Lu}/u.test(w) || /^\p{L}$/u.test(w) || /[bcdfghjklmnpqrstvwxzżźćńśł]{4,}/iu.test(w)
    ).length;
    if (weird / words.length > 0.18) return true;
  }
  return false;
}

async function awaitDecision(job, pid, signal, onWait) {
  for (;;) {
    const p = job.proposals.find((x) => x.pid === pid);
    if (!p || p.state !== 'pending') return p;
    if (signal.aborted) return { ...p, state: 'skipped' };
    try { onWait && onWait(); } catch { /* keeping the session alive must never break the wait */ }
    await sleep(700, signal);
  }
}

/**
 * Run a job to completion. Everything it does is written to the job as it happens, so the UI is a
 * view of the record rather than a parallel story that can disagree with it.
 */
/*
 * `chat` is a parameter rather than a straight call to llm.chat so the loop can be exercised without
 * a model behind it. That is not a testing nicety — the decisions in here (ask, refuse, or act) are
 * the part that touches someone's real account, and they need to be checkable without depending on
 * what a hosted model happens to answer today.
 */
async function run({ job, session, settings, switchProfile = null, chat = llm.chat, pace = 1,
                     idleTimeoutMs = 30 * 60 * 1000, sink = null, convo = null, role = 'general', ownOrigin = null,
                     unattended = false,
                     log = console }) {
  const signal = job.stop.signal;
  /*
   * NOT a const, and not destructured. The agent can move to a different stored login mid-job, and
   * that is a different browser context with a different page object — every helper below has to
   * read the CURRENT one, or the first switch would leave the whole loop driving the old browser
   * while the person watches the new one do nothing.
   */
  const page = () => session.page;
  /*
   * Who this is for, from LeadFlow when there is one — that is where a person edits it, and where
   * the rest of that app already reads it. The console's own copy is the fallback for when the
   * browser is running on its own with nothing behind it.
   */
  let ctx = company.asContext(company.get(job.companyId));
  if (convo) {
    try {
      const b = await convo.business();
      if (b && b.context) ctx = b.context;
      if (b && !b.configured) {
        jobsStore.step(job, 'note', 'no business profile set in LeadFlow yet — judging leads on the job alone');
      }
    } catch (e) {
      jobsStore.step(job, 'note', `could not read your business profile: ${e.message}`);
    }
  }
  // One browser means nothing to switch to, so the agent is never told it can — which also stops
  // it spending steps hunting for a login it is already inside.
  const profileList = settings.singleBrowser ? '' : describeProfiles(session);
  /*
   * The role decides the instructions and what is within reach. Resolved HERE from the registry —
   * a caller picks a name and can neither write a prompt nor grant itself a tool.
   */
  /*
   * THE ROLE IS STATE NOW, NOT A CONSTANT.
   *
   * It used to be resolved once and fixed for the whole run, which meant capability was decided by
   * WHERE THE OWNER HAPPENED TO BE LOGGED IN rather than by what was asked for. Measured twice on
   * live runs: a download refused to facebook.scout because the profile was facebook, and
   * save_place refused to google.research because the profile was google. Both jobs were impossible
   * from the first step and nothing said so until the run was over.
   *
   * A role should describe how to work somewhere, not what the agent may never become. It can now
   * change its own — see use_role below — so a specialist that turns out to be the wrong one is a
   * correction the agent makes, rather than a wall it spends sixty steps against.
   */
  let theRole = roles.get(role);
  let myTools = roles.toolsFor(role, TOOLS);
  /*
   * AND THE ROLE IS ENFORCED, not merely advertised.
   *
   * toolsFor decides what the model is TOLD it has. The loop below then ran whatever name came back,
   * so a read-only role could still act: a research.web scan of a Discord — dispatched with a goal
   * that says in capitals do not post, comment, vote, react, message, JOIN, follow or sign up — called
   * act() and put 'Join the Discord Community' in front of the owner for approval. The gate caught
   * that one. A reply walk runs auto-approved and there would have been no gate to catch it.
   *
   * A tool the role does not have is now refused where the other policy lives, not left to the model's
   * discretion. Only KNOWN tools are refused; an unknown name still falls through to be handled as it
   * always was.
   */
  let allowedTools = new Set(myTools.map((t) => t.function && t.function.name).filter(Boolean));
  const everyToolName = new Set(TOOLS.map((t) => t.function && t.function.name).filter(Boolean));
  /* Only a role that ASKED for it may be handed an own-origin, and it still only covers the one
     origin this job was sent to. A role that never declared it gets nothing, whatever is passed. */
  let ground = ownGround(theRole.trustsOwnOrigin ? ownOrigin : null);
  let site = theRole.site || null;
  let book = site ? playbook.asContext(site) : '';

  const messages = [{ role: 'system', content: systemPrompt({
    goal: job.goal, companyContext: ctx, meContext: me.asContext(), profileList,
    autoAct: settings.autoAct, role: theRole, playbookContext: book,
  }) }];
  if (book) jobsStore.step(job, 'note', `starting from what has worked before on ${site}`);
  job.transcript = messages;

  /**
   * BECOME A DIFFERENT SPECIALIST, MID-RUN.
   *
   * Everything the role decides is recomputed: the tools, what is enforced, the site playbook, and
   * the system message itself — the model must be TOLD what it can now do, or it will keep working
   * from the instructions it was given at the start and never use what it just gained.
   *
   * Returns a sentence for the agent to read, because a silent capability change is indistinguishable
   * from nothing having happened.
   */
  const becomeRole = (want, why) => {
    const row = roles.get(want);
    if (!row || !row.name) {
      const names = (roles.list() || []).map((r) => r.name).slice(0, 40).join(', ');
      return `There is no role called "${want}". The ones that exist are: ${names}. "general" can reach every tool.`;
    }
    const was = theRole.name || role;
    theRole = row;
    myTools = roles.toolsFor(row.name, TOOLS);
    allowedTools = new Set(myTools.map((x) => x.function && x.function.name).filter(Boolean));
    ground = ownGround(theRole.trustsOwnOrigin ? ownOrigin : null);
    site = theRole.site || null;
    book = site ? playbook.asContext(site) : '';
    /* The instructions travel with the role, so the system message is rewritten in place — the
       transcript keeps its shape and the model simply finds itself better briefed. */
    messages[0] = { role: 'system', content: systemPrompt({
      goal: job.goal, companyContext: ctx, meContext: me.asContext(), profileList,
      autoAct: settings.autoAct, role: theRole, playbookContext: book,
    }) };
    job.role = theRole.name;
    jobsStore.step(job, 'note', `working as ${theRole.name} now (was ${was})${why ? ` — ${why}` : ''}`);
    return `You are working as ${theRole.name} now. Your tools are: ${[...allowedTools].join(', ')}. Carry on with the goal.`;
  };

  /*
   * ARM THE ROUTE-CARD RECORDER for a Herald walk. The role name IS the intent (herald.facebook.setup,
   * herald.facebook.operate, …), so the card learned by a setup walk is replayed by the operate run of
   * the same platform later. Only Herald arms it — a research or reach run records nothing. Best-effort:
   * a session with no recorder (an old context) simply learns no card.
   */
  /*
   * WHAT THIS RUN WILL LEARN, AND UNDER WHAT NAME.
   *
   * A FLOW STEP is the best possible card: it repeats the same act on the same site every run, so
   * the walk it replaces is paid for over and over. Its intent is the STEP (flow:<flow>:<node>) —
   * not the role, which several flows may share — so two steps of one flow learn two cards and a
   * shared role never collides with itself. A Herald walk keeps learning under its role name, which
   * is how the setup walk still teaches the operate run of the same platform.
   */
  const flowIntent = (job.workflowId && job.nodeId) ? `flow:${job.workflowId}:${job.nodeId}` : null;
  const learnsCards = !!flowIntent || /^herald\./.test(String(role || ''));
  const cardIntent = flowIntent || roles.canonical(role);
  if (learnsCards && session && session.recorder) {
    try { session.recorder.arm({ intent: cardIntent }); }
    catch (e) { log.warn?.(`[agent] ${job.id}: could not arm recorder: ${e.message}`); }
  }

  const observe = (text) => { messages.push({ role: 'tool', content: String(text).slice(0, 6000) }); };
  /*
   * DATA GETS A BIGGER BUDGET THAN PROSE. The 6000 above is right for a page of text; it is wrong for
   * a JSON feed or three hundred extracted rows, and truncating those is exactly the failure that sent
   * a build looking for tools that did not exist. Only run_script and fetch_data use this.
   */
  const DATA_CAP = 24000;
  const observeData = (text) => {
    const s = String(text == null ? '' : text);
    messages.push({ role: 'tool', content: s.length > DATA_CAP ? s.slice(0, DATA_CAP) + `\n… (${s.length - DATA_CAP} more characters — return less: fewer fields, fewer rows, or a narrower pick)` : s });
  };

  /*
   * WHAT AN EXTRACTED TOOL IS GIVEN. Everything a tool legitimately needs and nothing it does not:
   * no access to the step budget, the guards or the transcript, because those are the loop's own
   * business. `session` is a getter/setter pair rather than a value — use_profile replaces the
   * entire browser mid-run, and a tool holding a stale reference would drive the one it left.
   */
  const toolCtx = {
    page: () => page(),
    session: () => session,
    setSession: (next) => { session = next; },
    observe,
    step: (kind, text, extra) => jobsStore.step(job, kind, text, extra || {}),
    /* For what is only knowable after the step was written — see jobs.annotate. */
    annotate: (s, extra) => jobsStore.annotate(job, s, extra),
    switchedSession: (info) => jobsStore.switchedSession(job, info),
    switchProfile,
    describeProfiles,
    // The LeadFlow window. Absent on a run that was not started from it, and every tool that uses
    // it says so plainly rather than pretending to have a pipeline.
    convo,
    // The typed rows a run produces. The store owns the deduping, so a tool never has to.
    addGig: (row) => jobsStore.addGig(job, row),
    addReach: (row) => jobsStore.addReach(job, row),
    addKeywords: (row) => jobsStore.addKeywords(job, row),
    addSearch: (row) => jobsStore.addSearch(job, row),
    addGscToken: (token) => jobsStore.addGscToken(job, token),
    addGscHealth: (row) => jobsStore.addGscHealth(job, row),
    addOpportunity: (row) => jobsStore.addOpportunity(job, row),
    counts: () => ({ leads: job.leads.length, gigs: job.gigs.length, opportunities: (job.opportunities || []).length, keywords: (job.keywords || []).length }),
    // The role's site, used as the default platform when a page does not say which it is.
    get site() { return site; },
    /* Finishing is the loop's business, not a tool's: it parks the job AND starts the idle
       clock that eventually releases the browser. A tool that only did the first would leave
       the session held by a job nobody is watching. */
    // The summary is kept whole as the job's report BEFORE it becomes a (cut) step line.
    finish: (summary) => { jobsStore.setReport(job, summary); jobsStore.finish(job, 'idle', summary); idleSince = Date.now(); },
    /* Paced and interruptible: a tool that used a bare setTimeout would keep sleeping after a
       stop, and `pace` is 0 in tests so a real wait never leaks into a test run. */
    sleep: (ms) => sleep(ms * pace, signal),
    settle: (ms) => settle(page(), ms),
    /*
     * Perception. freshAnalysis re-reads the page and caches it on the session, which is what makes
     * the click numbers valid; resetClickLoop tells the loop guard that real progress happened, so a
     * new page does not count toward the repeat-click breaker.
     *
     * WRAPPED, NOT REFERENCED. This object is built before those are declared, so naming them
     * directly reads them in the temporal dead zone and every tool throws "cannot access before
     * initialization". Deferring the lookup to call time is the whole fix.
     */
    freshAnalysis: (...args) => freshAnalysis(...args),
    resetClickLoop: (...args) => resetClickLoop(...args),
    get memo() { return memo; },
  };

  // Called before every model turn: the person watching gets to steer without stopping anything.
  const drainInbox = () => {
    while (job.inbox.length) {
      const m = job.inbox.shift();
      messages.push({ role: 'user', content: `The person watching says: ${m.text}` });
    }
  };

  const freshAnalysis = async () => {
    let a = await analyzePage(page());
    // An empty page right after navigation is usually an un-hydrated SPA (or one whose content lives
    // in a frame that had not attached yet). Give it one settle-and-retry before believing "nothing
    // to click" — that false reading is exactly what sent the account run wandering a live dashboard.
    if (a.elementCount === 0) {
      await settle(page(), 900);
      a = await analyzePage(page());
    }
    session.lastAnalysis = { elements: a.elements, url: a.url, scrollY: await page().evaluate(() => window.scrollY).catch(() => 0) };
    return a;
  };

  const elementAt = (index) => (session.lastAnalysis?.elements || []).find((e) => e.index === Number(index));

  /**
   * Make sure there is still a live page to act on.
   *
   * Facebook closes pages out from under you — a popup that finishes, a tab it replaces, a
   * navigation that tears one down. The context always knows which of its pages are alive, so
   * recovering is a matter of asking, and the difference between a lost step and a lost run.
   *
   * Returns whether it had to intervene, so the model can be told the numbers it was carrying are
   * gone. Clicking [42] on a page that was rebuilt underneath is worse than not clicking at all.
   */
  const healPage = async () => {
    const p = session.page;
    if (p && typeof p.isClosed === 'function' && !p.isClosed()) return false;
    if (p && typeof p.isClosed !== 'function') return false;   // a stub in tests

    let alive = [];
    try { alive = (session.context.pages() || []).filter((x) => !x.isClosed()); } catch { /* context gone too */ }
    let next = alive[alive.length - 1];
    if (!next) {
      try { next = await session.context.newPage(); }
      catch (e) {
        // The whole context is gone. Nothing here can fix that, and saying so beats twenty more
        // attempts that all fail identically.
        jobsStore.finish(job, 'idle', `The browser was closed and could not be reopened (${e.message}). Open a session and say "carry on".`);
        return true;
      }
    }
    session.page = next;
    session.lastAnalysis = null;
    memo.look = null;
    jobsStore.step(job, 'note', 'the page had closed — picked up a live one');
    return true;
  };

  /* A field the reader listed may sit OFF the current viewport — a long form scrolls its message box
     out of view, and the reader now lists editable fields even off-screen so the agent can still reach
     them. A raw coordinate click on an off-screen point misses, so first scroll the target's Y to
     mid-viewport and click the adjusted position. THIS is what lets type([n]) work on a field the
     agent can see in the list but not on screen — the fix for the endless scroll-hunt on Useme's
     offer form. */
  const bringIntoView = async (target) => {
    const vh = await page().evaluate(() => window.innerHeight).catch(() => 800);
    if (target.y < 40 || target.y > vh - 40) {
      await page().mouse.wheel(0, target.y - Math.round(vh / 2));
      await sleep(500, signal);
      target.y = Math.round(vh / 2);
    }
    return target;
  };

  /* Click by number, re-analysing first if the page moved — the same rule the REST API uses, for the
     same reason: the model asked to click a THING, and the number is only a handle on it. */
  const clickIndex = async (index) => {
    const scrollY = await page().evaluate(() => window.scrollY).catch(() => 0);
    if (!session.lastAnalysis || page().url() !== session.lastAnalysis.url || Math.abs(scrollY - session.lastAnalysis.scrollY) > 40) {
      await freshAnalysis();
    }
    const target = await bringIntoView(await clickByIndex(page(), Number(index), session.lastAnalysis.elements));
    await page().mouse.click(target.x, target.y);
    await page().waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    return target;
  };

  const typeInto = async (index, text, submit) => {
    const target = await bringIntoView(await clickByIndex(page(), Number(index), session.lastAnalysis?.elements || []));
    // CLEAR THE FIELD FIRST, but SCOPED TO THE FIELD. A triple-click focuses the box AND selects the
    // text already in it (a line / paragraph), so typing REPLACES it — a name box that reads "Wesley
    // Van der stoep" becomes the new name, not the two stacked. Crucially it is NOT a page-wide
    // Ctrl+A: that selected the WHOLE document when the click landed a pixel outside the input (the
    // "entire page highlighted blue, field unchanged" bug), and left the real field untouched.
    await page().mouse.click(target.x, target.y, { clickCount: 3 });
    // Typed, not filled: instantaneous text in a field is one of the cheapest automation tells.
    await page().keyboard.type(String(text), { delay: 45 + Math.floor(Math.random() * 55) });
    if (submit) {
      await page().keyboard.press('Enter');
      await page().waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    }
    return target;
  };

  // Paste, not type: a whole block dropped in at once. For a script or lyrics, typing char-by-char is
  // both slow (a minute for a paragraph) and fragile; insertText fires the input events a rich editor
  // needs, so React-controlled boxes (ElevenLabs, Suno, most creative tools) actually register it.
  const pasteInto = async (index, text, submit) => {
    const target = await bringIntoView(await clickByIndex(page(), Number(index), session.lastAnalysis?.elements || []));
    await page().mouse.click(target.x, target.y);
    // Select whatever is already there so the paste replaces it, then insert the whole block at once.
    await page().keyboard.press('Control+A').catch(() => {});
    await page().keyboard.insertText(String(text));
    if (submit) {
      await page().keyboard.press('Enter');
      await page().waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    }
    return target;
  };

  let steps = 0;
  /*
   * THE BUDGETS FOR THIS JOB. A five-minute room skim and a two-hour research walk used to share one
   * global number, so the skim was handed 120 steps and no page limit at all and spent two and a half
   * hours on 29 pages against a brief of 15. A caller that knows the shape of the work now says so;
   * everything that does not keeps the global default, and no page budget, exactly as before.
   */
  const maxSteps = Number(job.maxSteps) > 0 ? Number(job.maxSteps) : settings.maxSteps;
  const maxPages = Number(job.maxPages) > 0 ? Number(job.maxPages) : 0;   // 0 = uncounted, the old behaviour
  let pagesSpent = 0;
  /*
   * A SEND THAT WAS TYPED AND NOT SEEN. Holds the exact text of an act whose words were not on the
   * page afterwards, so the loop can (a) keep looking for them and (b) refuse to type them again.
   * Null the rest of the time, which is every walk that never had an unconfirmed act.
   */
  let pendingSend = null;
  /* Seeded with wherever the session already sits, so the walk is not charged a page for standing
     still: an empty string here made the very first turn spend one of the fifteen on nothing. */
  let lastPageUrl = (() => { try { return page().url() || ''; } catch { return ''; } })();
  let idleSince = 0;
  /*
   * WHAT IT HAS ALREADY SEEN — one object rather than three loose bindings, because both the loop
   * and the tools legitimately write to it. The loop clears `look` when a page dies (a fingerprint
   * from a closed page is worse than none), and the perception tools set it to avoid resending
   * sixty identical element lines, which was most of the token bill.
   */
  const memo = { look: null, read: null, place: null };
  // Click-loop guard: clicking MOVES, it never FILLS. A weaker model can open the same control over
  // and over (or oscillate between two) and never type — which is exactly how the account setup got
  // stuck on Useme's description editor. We track recent click labels and reset them the moment real
  // progress happens (a type, an act, or a navigation).
  let clickHistory = [];
  let loopBlocks = 0;
  const resetClickLoop = () => { clickHistory = []; loopBlocks = 0; };
  // Observe-loop guard: a weak model on a dense page (YouTube Studio's 60-control customization) can
  // look/read/scroll forever without ever typing or clicking — pure observation paralysis. Count
  // consecutive observe-only calls; once past the limit, force a page-CHANGING action every step.
  let observeStreak = 0;
  const OBSERVE_ONLY = new Set(['look', 'read', 'read_table', 'scroll', 'current_url', 'note']);
  const OBSERVE_LIMIT = 4;
  /* Every post seen in this conversation, so a second sweep of the same place returns
     only what has appeared since — which is what makes checking back cheap. */
  const sweptPosts = new Set();
  /* Where the last sweep looked, so a lead saved after it can be credited to it. */

  /* Which site the last sweep was actually on, so a lead is credited to the right playbook. */
  let lastSite = null;
  let wrappingUp = false;   // asked to conclude; no new lines of enquiry from here
  try {
    jobsStore.step(job, 'you', job.goal);

    /*
     * ROUTE-CARD FAST PATH. Before walking the UI, ask what the browser has already learned for this
     * intent. A PROVEN card is replayed as one in-page fetch (no clicks); on success the job is finished
     * HERE, so the loop below — guarded on !isOver — is skipped entirely and normal end-of-run cleanup
     * still runs. On any failure the card is quarantined and we fall through to the UI walk, whose armed
     * recorder re-records it. An unproven card (freshly recorded, never verified) plans to 'ui' on
     * purpose: we do NOT re-fire a create just to prove a card — the walk records, and the fast path
     * waits until a card is trusted. So during a live brand launch nothing risky ever auto-fires.
     */
    if (learnsCards) {
      try {
        const intent = cardIntent;
        const card = cardStore.findByIntent(intent);
        const plan = routecards.planFor(card);
        jobsStore.step(job, 'note', `route card — ${plan.reason}`);
        if (plan.mode === 'fast') {
          const ensureOrigin = async (origin) => {
            if (routecards.originOf(page().url()) !== origin) {
              await page().goto(origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
            }
          };
          const runInPage = (r) => page().evaluate(replay.IN_PAGE_FETCH, r);
          const outcome = await replay.attemptReplay({
            card: plan.card, values: settings.replayValues || {}, runInPage, ensureOrigin, now: Date.now(),
          });
          if (outcome.card) cardStore.put(outcome.card);
          jobsStore.step(job, outcome.done ? 'acted' : 'note', outcome.reason);
          if (outcome.done) {
            try { if (session.recorder) session.recorder.discard(); } catch { /* nothing recorded to keep */ }
            jobsStore.finish(job, 'idle', 'completed by route-card replay — the UI walk was not needed');
            idleSince = Date.now();
          }
        }
      } catch (e) {
        jobsStore.step(job, 'error', `route-card fast path could not run (${e.message}) — walking the UI`);
      }
    }

    while (!jobsStore.isOver(job) && !signal.aborted) {
      /*
       * KEEP THE SESSION ALIVE WHILE THE JOB RUNS. The pool reaps a session after idleMs (5 min) of
       * no lastUsed bump — but lastUsed is only bumped by pool.get(), which an autonomous agent never
       * calls: it holds the page and drives it directly. So a run longer than 5 minutes had its
       * browser closed out from under it mid-step (the account setup died at exactly this, after
       * saving one field). Bumping lastUsed each iteration ties the session's life to the job's own
       * bounds (maxSteps + the idle timeout below), not to a 5-minute wall-clock.
       */
      try { session.lastUsed = Date.now(); } catch { /* defensive */ }
      /*
       * IDLE, NOT FINISHED. It has done what it was asked and is waiting for the next thing. The
       * transcript stays in memory, so what you say next arrives with everything it already read —
       * which is the difference between an assistant and a form you submit twice.
       */
      if (job.status === 'idle') {
        if (!job.inbox.length) {
          /*
           * It cannot wait forever. A parked conversation is holding a browser context — one of two
           * — and an agent still nominally alive at three in the morning is a session nobody can
           * open. Half an hour is long enough to make a cup of tea and come back to it.
           */
          if (Date.now() - idleSince > idleTimeoutMs) {
            jobsStore.finish(job, 'stopped', 'Closed after sitting idle — start a new conversation when you need it.');
            break;
          }
          await sleep(500, signal);
          continue;
        }
        idleSince = 0;
        steps = 0;                       // a new request gets a full budget, not the leftovers
        drainInbox();
        continue;
      }
      /*
       * HOW MANY PAGES HAVE WE SPENT? Counted from the address bar, not from any one tool: an
       * open, a dig, a search result and a click that navigates all move it, and reading the same
       * page twice costs nothing. That is what "open at most 15 pages" always meant.
       */
      try { const u = page().url(); if (u && u !== lastPageUrl) { lastPageUrl = u; pagesSpent++; } } catch { /* no page yet */ }
      if (++steps > maxSteps) {
        /*
         * PARKING IS ONLY KIND IF SOMEBODY IS THERE. For a conversation a person is watching, going
         * idle is right: they read the tail and say "carry on". For a job the master dispatched,
         * nobody is coming — so parking means holding the one browser session for another half hour
         * and then expiring with nothing to show for the whole run.
         */
        if (!unattended) {
          jobsStore.finish(job, 'idle', `Paused at the ${maxSteps}-step limit — ${job.leads.length} lead(s) so far. Say "carry on" and I will continue from here.`);
          idleSince = Date.now();
          continue;
        }
        /*
         * Asked to conclude, not cut off. The two hours that produced nothing produced nothing
         * because the run ENDED mid-thought — everything it had read was still only in its head.
         * A few turns to write it down turns a wasted run into a short one.
         */
        if (steps > maxSteps + WRAP_UP_TURNS) {
          jobsStore.finish(job, 'idle', `Stopped at the ${maxSteps}-step budget: it was asked to conclude and did not, so the session goes back to the queue.`);
          break;
        }
        if (!wrappingUp) {
          wrappingUp = true;
          jobsStore.step(job, 'note', `${maxSteps}-step budget reached — asked to report what it has and stop`);
          observe(`You have used your whole budget of ${maxSteps} steps. STOP INVESTIGATING NOW.`
            + ' Do not open another page, run another search, or follow another link — there is no time'
            + ' left to act on what you would find.\n\nCall finish() on your very next turn with what you'
            + ' ALREADY have: what you were asked, what you actually found (with the links), and what'
            + ' you did not get to. A short honest report of partial findings is worth a great deal;'
            + ' everything you have read so far is worth NOTHING if you do not write it down now.');
        }
      }
      /*
       * WHAT DID YOU COME FOR? A long run drifts one reasonable page at a time — each next click
       * defensible, the goal quietly out of sight two hours ago. This is deliberately a REMINDER and
       * not a limit: it never stops anything, and a run that is still finding things sails past it.
       */
      /*
       * THE PAGE BUDGET, ENFORCED. It used to live only in the goal text, and a two-and-a-half-hour
       * read of one Facebook group went to 29 pages on a brief of 15 — twenty of them searches it
       * invented and member profiles nobody asked for. Refusing the three tools that go somewhere
       * new is what makes it a budget rather than a suggestion; everything needed to REPORT stays
       * available, and finish() is never blocked.
       */
      /*
       * DID THE SEND LAND YET? A walk that clicked a send button had no way to find out, so it
       * typed the comment again to be sure — twice, in the run that produced this. Looking for it
       * costs one page read a turn and only while something is pending.
       */
      if (pendingSend) {
        let landedNow = null;
        try { landedNow = await confirmPosted(page(), pendingSend, [0]); } catch { landedNow = null; }
        if (landedNow === true) {
          jobsStore.step(job, 'acted', `sent: "${pendingSend.slice(0, 200)}"`, { url: page().url() });
          observe('It is on the page now — your text posted. Do NOT type or send it again. Call finish() with what you did.');
          pendingSend = null;
        }
      }
      if (maxPages && pagesSpent >= maxPages && !wrappingUp) {
        wrappingUp = true;
        jobsStore.step(job, 'note', `${maxPages}-page budget spent (${pagesSpent} pages) — asked to report what it has and stop`);
        observe(`You have opened ${pagesSpent} pages and your budget for this job was ${maxPages}.`
          + ' STOP INVESTIGATING NOW. open, dig and google are closed to you from here — a page you have'
          + ' not read yet cannot be part of this report.\n\nCall finish() on your very next turn with'
          + ' what you ALREADY have: what you were asked, what you actually found (with the links), and'
          + ' what you did not get to. Everything you have read is worth nothing if you do not write it'
          + ' down now.');
      }
      if (!wrappingUp && steps > 0 && steps % REANCHOR_EVERY === 0) {
        jobsStore.step(job, 'note', `step ${steps} — re-read the goal`);
        observe(`STEP ${steps} of ${maxSteps}. Before your next move, re-read what you were`
          + ` asked for:\n\n${String(job.goal).slice(0, 600)}\n\nSay in one line what you have actually`
          + ' FOUND so far, and whether your last few steps moved you closer to it. If you already have'
          + ' enough to answer, call finish() now rather than reading one more page. If your current'
          + ' approach has stopped producing anything new, change it — do not keep going out of habit.');
      }
      drainInbox();
      trimTranscript(messages);

      let reply;
      try {
        reply = await askWithRetry({ chat, settings, messages, signal, job, pace });
      } catch (e) {
        if (signal.aborted) break;
        /*
         * A rejected key or a missing model is not something another attempt fixes — it needs a
         * person to change a setting, so say so and stop. Anything else has already been retried
         * and simply is not working right now, which is a pause, not an ending.
         */
        if (e.permanent) jobsStore.finish(job, 'failed', e.message);
        else {
          jobsStore.finish(job, 'idle', `The model stopped answering — ${e.message}. Nothing is lost; say "carry on" to pick up where this left off.`);
          idleSince = Date.now();
        }
        continue;
      }

      messages.push({ role: 'assistant', content: reply.content || '', tool_calls: reply.raw?.message?.tool_calls || [] });

      // A model that answers in prose with no tool call has usually stopped working without saying
      // so. Show whatever it said, then ask it plainly for the next action.
      if (!reply.toolCalls.length) {
        if (reply.content && reply.content.trim()) jobsStore.step(job, 'think', reply.content.trim());
        messages.push({ role: 'user', content: 'Choose one tool and call it now, or call finish if you are done.' });
        await sleep(rand(PAUSE_READ, pace), signal);
        continue;
      }

      for (const call of reply.toolCalls) {
        if (signal.aborted || job.status !== 'running') break;
        const a = call.args || {};
        /*
         * THE CALL, then the RESULT — two lines, not one.
         *
         * A single "clicked [3] Open the post" hides the thing you most want when an agent goes
         * wrong: what it ASKED for, before the page answered. Recording the call separately means a
         * refused click, a failed navigation and a click that silently did nothing all read
         * differently instead of all reading as absence.
         */
        jobsStore.step(job, 'tool', summariseCall(call.name, a), { tool: call.name, args: compactArgs(a) });

        // Observe-loop guard. A page-changing call resets the streak; an observe-only one grows it,
        // and once it is over the limit EVERY further observe-only turn is pushed hard to act. This is
        // what breaks the "look/read/scroll forever, never type" paralysis a weak model falls into on
        // a dense page — the mechanical blockers are gone, so the only thing left is making it commit.
        if (OBSERVE_ONLY.has(call.name)) {
          observeStreak += 1;
          if (observeStreak >= OBSERVE_LIMIT) {
            if (observeStreak === OBSERVE_LIMIT) jobsStore.step(job, 'blocked', `${observeStreak} looks/reads in a row with no action — forcing an action`);
            observe(`STOP OBSERVING. You have called look/read/scroll ${observeStreak} times in a row WITHOUT changing the page — that is paralysis, not thoroughness. Looking never fills a field or clicks a button. Your NEXT call MUST be a page-CHANGING action: type([n],"..."), click([n]), upload_image, or act — on the single next item your goal lists that is not done yet. Pick it and DO it this turn. Do not look/read/scroll again until you have acted.`);
          }
        } else {
          observeStreak = 0;
        }

        // Before anything else: is there still a page? Three real runs died on this.
        const healed = await healPage();
        if (jobsStore.isOver(job) || job.status === 'idle') break;
        if (healed) {
          observe('The page you were on had closed, so you are now on a live one. Whatever numbers you were holding are gone — call look before clicking anything.');
          if (call.name === 'click' || call.name === 'type' || call.name === 'act') break;
        }

        try {
          /*
           * EXTRACTED TOOLS FIRST. `run()` grew to 970 lines around a 28-case switch with every
           * tool inlined; tools/ holds the ones moved out so far, and this consults it before
           * falling through to what remains. The registry is checked and not merged into the
           * switch so the split can proceed one verifiable group at a time rather than as one
           * 636-line rewrite that is either entirely right or silently wrong.
           *
           * The GUARDS above stay in the loop deliberately — they are policy, and a tool that
           * carried its own permission check is a tool somebody can edit the check out of.
           */
          /* A tool this role was never given is refused, whoever named it. See allowedTools above. */
          if (everyToolName.has(call.name) && !allowedTools.has(call.name)) {
            jobsStore.step(job, 'blocked', `refused ${call.name} — this walk's role (${role}) does not have it`);
            observe(`Refused: ${call.name} is not one of your tools as ${theRole.name || role}. You have: ${[...allowedTools].join(', ')}. If this job genuinely needs ${call.name}, call use_role to work as a specialist that has it — being handed the wrong role is not a reason to give up on the goal.`
              + ' Use one of those, or call finish and say what you could not do.');
            continue;
          }
          /*
           * THE SAME WORDS ARE NEVER TYPED TWICE. Told not to, the walk did it anyway — the whole
           * reply, into a fresh field, two more times. Refusing is the only thing that holds.
           */
          /* paste_text is the THIRD way to put words in a box. Refused type, the walk reached for it
             and pasted the whole reply into another field — so the list is every tool that writes. */
          if (pendingSend && ['type', 'act', 'paste_text'].includes(call.name) && sameWords(a && (a.text ?? a.body), pendingSend)) {
            jobsStore.step(job, 'blocked', `refused to ${call.name === 'paste_text' ? 'paste' : 'type'} the ${call.name === 'act' ? 'reply' : 'text'} a second time — it is already in the box`);
            observe('Refused: that is the same text you already typed and it is still in the box. Typing it again would post it twice.'
              + ' Call look and click the control that SENDS what is in the box — it is beside the box, and may be an arrow or a word in the page\'s own language.');
            continue;
          }
          /* And it is REFUSED, not merely asked. See the budget above. */
          if (maxPages && pagesSpent >= maxPages && GOES_SOMEWHERE_NEW.has(call.name)) {
            jobsStore.step(job, 'blocked', `${call.name} refused — the ${maxPages}-page budget for this job is spent`);
            observe(`Refused: ${call.name} opens a page you have not seen, and this job's ${maxPages}-page budget is spent.`
              + ' Call finish() now with what you already have — the links included.');
            continue;
          }
          if (toolRegistry.has(call.name)) {
            await toolRegistry.run(call.name, toolCtx, a);
            continue;
          }
          switch (call.name) {
            /*
             * READ THE PAGE AS DATA. The snippet runs in the page, so it sees what the page sees —
             * its DOM, its JSON, its state — and the value comes back serialized. It is wrapped in an
             * async function so `return` works and `await` is allowed; a bare expression is wrapped
             * as one. A throw is reported and changes nothing, which is the point of read-only.
             */
            case 'click_text': {
              /*
               * THE ESCAPE HATCH FOR WHAT look() DID NOT INDEX. The register tab on login.olx.pl was
               * on the page, provable by script, and absent from the numbered list; the agent burned
               * sixty steps on Tab keys and could never press it. Finding a control by its words is
               * the general answer. It is not a way around the gate: the same looksLikeWrite check
               * that guards a numbered click guards this, so a "Post" found by text still parks.
               */
              const want = String(a.text || '').trim();
              if (want.length < 2) { observe('click_text needs the words on the control — two characters at least.'); break; }
              const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
              let loc = null, info = null;
              try {
                const cands = page().locator('button, a, [role=button], [role=tab], [role=link], [role=menuitem], summary, label, input[type=submit], input[type=button]');
                const n = await cands.count();
                const wantF = fold(want);
                for (let i = 0; i < Math.min(n, 400); i++) {
                  const c = cands.nth(i);
                  const t = await c.evaluate((e) => ({ text: (e.innerText || e.textContent || e.value || '').trim().slice(0, 160), ariaLabel: e.getAttribute('aria-label') || '', visible: (() => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })() })).catch(() => null);
                  if (!t || !t.visible) continue;
                  if (fold(t.text).includes(wantF) || fold(t.ariaLabel).includes(wantF)) { loc = c; info = t; break; }
                }
              } catch (e) { observe(`click_text could not search the page: ${String(e && e.message).slice(0, 120)}`); break; }
              if (!loc) {
                jobsStore.step(job, 'read', `click_text found nothing reading "${want.slice(0, 60)}"`, { url: page().url() });
                observe(`No visible control on this page carries the words "${want}". The words may differ from what you expect (accents and case are ignored, but the spelling must match), the control may sit inside an iframe, or it may not be rendered yet — scroll or wait_for, then try a shorter distinctive phrase.`);
                break;
              }
              if (!settings.autoAct && !ground.covers(page().url()) && looksLikeWrite(info)) {
                jobsStore.step(job, 'blocked', `refused click_text on "${(info.text || info.ariaLabel || '').trim().slice(0, 60)}" — that is visible to other people, so it needs act`);
                observe(`Refused: "${(info.text || info.ariaLabel || '').trim()}" does something other people will see. Use act with kind, index and the text you want to send — call look first so it has a number. The owner approves it first.`);
                break;
              }
              try {
                await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
                await loc.click({ timeout: 8000 });
                await page().waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
              } catch (e) {
                jobsStore.step(job, 'read', `click_text "${want.slice(0, 60)}" failed: ${String(e && e.message).slice(0, 120)}`, { url: page().url() });
                observe(`Found "${info.text || info.ariaLabel}" but the click did not land: ${String(e && e.message).slice(0, 200)}. Try look and a numbered click, or scroll it into view first.`);
                break;
              }
              session.lastAnalysis = null;   // the page changed under us; the next look must be fresh
              resetClickLoop();
              jobsStore.step(job, 'read', `click_text "${(info.text || info.ariaLabel || want).trim().slice(0, 60)}"`, { url: page().url() });
              observe(`Clicked "${(info.text || info.ariaLabel || want).trim()}" (found by its words; it was not in the numbered list). Call look to see what changed.`);
              break;
            }
            case 'run_script': {
              const src = String(a.script || '');
              const no = scriptRefusal(src);
              if (no) {
                jobsStore.step(job, 'blocked', `run_script refused: ${no}`);
                observe(`Refused: ${no}.`);
                break;
              }
              const wrapped = /\breturn\b/.test(src) ? `(async () => { ${src} })()` : `(async () => (${src}))()`;
              let value;
              try { value = await page().evaluate(wrapped); }
              catch (e) {
                jobsStore.step(job, 'read', `run_script failed: ${String(e && e.message).slice(0, 140)}`, { url: page().url() });
                observe(`The script threw: ${String(e && e.message).slice(0, 500)}. The page is unchanged — fix the snippet and try again. Tip: check your selector with a smaller script first, e.g. return document.querySelectorAll('article').length`);
                break;
              }
              let out;
              if (value === undefined) out = null;
              else if (typeof value === 'string') out = value;
              else { try { out = JSON.stringify(value, null, 1); } catch { out = String(value); } }
              if (out == null) {
                jobsStore.step(job, 'read', 'run_script returned nothing', { url: page().url() });
                observe('The script ran but returned nothing. End it with `return <the data>` — e.g. return [...document.querySelectorAll(\'a\')].map(a => a.href)');
                break;
              }
              jobsStore.step(job, 'read', `run_script → ${out.length} character(s) of data`, { url: page().url() });
              observeData(`run_script returned:\n\n${out}`);
              break;
            }
            /*
             * FETCH IT IN THIS SESSION. Playwright's request context shares the browser context's
             * cookies, so a logged-in feed answers exactly as it would in the page — and because it
             * is not the page, nothing has to be navigated away from. GET only: it cannot act.
             */
            case 'fetch_data': {
              const url = String(a.url || '');
              if (!/^https?:\/\//i.test(url)) { observe('fetch_data needs a full http(s) address, exactly as it appears — never typed from memory.'); break; }
              let body = '', code = 0, ctype = '';
              try {
                const rq = session.context && session.context.request;
                if (!rq) throw new Error('this browser has no request context');
                const r = await rq.get(url, { timeout: 30000, failOnStatusCode: false });
                code = r.status(); ctype = String((r.headers() || {})['content-type'] || '');
                body = await r.text();
              } catch (e) {
                jobsStore.step(job, 'read', `fetch_data failed: ${String(e && e.message).slice(0, 140)}`, { url });
                observe(`Could not fetch ${url.slice(0, 200)}: ${String(e && e.message).slice(0, 300)}`);
                break;
              }
              if (code >= 400) {
                jobsStore.step(job, 'blocked', `fetch_data ${code} on ${url.slice(0, 120)}`, { url });
                observe(`${url.slice(0, 200)} answered ${code}${code === 403 || code === 401 ? ' — this address needs a login this profile does not have, or refuses automated fetches. Open the page instead and read it.' : ''}${body ? `\n\n${body.slice(0, 600)}` : ''}`);
                break;
              }
              let out = body, shape = ctype.split(';')[0] || 'text';
              if (/json/i.test(ctype) || /^\s*[[{]/.test(body)) {
                try {
                  const parsed = JSON.parse(body);
                  const picked = a.pick ? pickPath(parsed, a.pick) : parsed;
                  if (a.pick && picked === undefined) {
                    observe(`The path "${String(a.pick).slice(0, 80)}" does not lead anywhere in that JSON. The top-level keys are: ${(parsed && typeof parsed === 'object' ? Object.keys(parsed) : []).slice(0, 30).join(', ') || '(not an object)'}`);
                    break;
                  }
                  out = JSON.stringify(picked, null, 1);
                  shape = 'json' + (a.pick ? ` at ${a.pick}` : '');
                } catch { /* not JSON after all — hand back the text */ }
              }
              jobsStore.step(job, 'read', `fetch_data ${code} ${shape} — ${out.length} character(s) from ${url.slice(0, 120)}`, { url });
              observeData(`${url}\n${code} · ${shape}\n\n${out}`);
              break;
            }
            /* ONE KEY. Escape is the close button a modal often does not draw. */
            case 'press_key': {
              const KEYS = ['Escape', 'Enter', 'Tab', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Backspace', 'Delete'];
              const key = KEYS.find((k) => k.toLowerCase() === String(a.key || '').trim().toLowerCase());
              if (!key) { observe(`press_key takes one of: ${KEYS.join(', ')}.`); break; }
              /* Enter in a field that publishes is the act gate's business — the same rule as type(submit). */
              if (key === 'Enter' && !settings.autoAct && !ground.covers(page().url()) && looksLikeComposer(elementAt(session.lastFocusIndex))) {
                jobsStore.step(job, 'blocked', 'refused Enter — the focused field publishes what is in it');
                observe('Refused: pressing Enter there publishes it. Use act with the full text so the owner can approve it.');
                break;
              }
              try { await page().keyboard.press(key); } catch (e) { observe(`The key did not register: ${String(e && e.message).slice(0, 200)}`); break; }
              await page().waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
              session.lastAnalysis = null;   // whatever was numbered may be gone
              jobsStore.step(job, 'click', `pressed ${key}`, { url: page().url() });
              observe(`Pressed ${key}. Now at ${page().url()}. Call look to see what changed.`);
              break;
            }
            /* WAIT, INSTEAD OF LOOKING AGAIN AND AGAIN. */
            case 'wait_for': {
              const want = String(a.text || '').trim();
              if (!want) { observe('wait_for needs the text to wait for.'); break; }
              const ms = Math.min(30, Math.max(1, Number(a.seconds) || 15)) * 1000;
              const gone = !!a.gone;
              const t0 = Date.now();
              let ok = false;
              try {
                await page().waitForFunction(({ t, g }) => {
                  const has = (document.body ? document.body.innerText || '' : '').toLowerCase().includes(String(t).toLowerCase());
                  return g ? !has : has;
                }, { t: want, g: gone }, { timeout: ms, polling: 500 });
                ok = true;
              } catch { ok = false; }
              const secs = Math.round((Date.now() - t0) / 1000);
              jobsStore.step(job, 'read', `waited ${secs}s for "${want.slice(0, 60)}"${gone ? ' to go' : ''} — ${ok ? 'there' : 'never came'}`, { url: page().url() });
              observe(ok
                ? `"${want.slice(0, 80)}" ${gone ? 'is gone' : 'is on the page'} after ${secs}s. Read or look now.`
                : `"${want.slice(0, 80)}" ${gone ? 'was still there' : 'never appeared'} after ${secs}s. It may be worded differently, behind a dialog, or further down — look at the page, or try run_script to see what is actually in the DOM.`);
              break;
            }
            /* A REAL DROPDOWN. Clicking one opens a native list the page cannot see; setting it works. */
            case 'choose_option': {
              if (!session.lastAnalysis) await freshAnalysis();
              let target;
              try { target = await bringIntoView(await clickByIndex(page(), Number(a.index), session.lastAnalysis?.elements || [])); }
              catch (e) { observe(`There is no [${a.index}] on this page any more: ${String(e && e.message).slice(0, 160)}. Call look again.`); break; }
              const res = await page().evaluate(({ x, y, want }) => {
                const at = document.elementFromPoint(x, y);
                if (!at) return { ok: false, why: 'nothing is at that spot any more' };
                if (at.tagName === 'IFRAME') return { ok: false, why: 'that dropdown is inside a frame — reach it with run_script instead' };
                const sel = at.tagName === 'SELECT' ? at : (at.closest ? at.closest('select') : null);
                if (!sel) return { ok: false, why: `[${at.tagName.toLowerCase()}] is not a dropdown — a menu that only LOOKS like one is opened with click, then its item clicked` };
                const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
                const opts = Array.from(sel.options || []);
                const w = norm(want);
                const hit = opts.find((o) => norm(o.textContent) === w) || opts.find((o) => norm(o.value) === w) || opts.find((o) => norm(o.textContent).includes(w));
                if (!hit) return { ok: false, why: 'no option matches', options: opts.slice(0, 40).map((o) => String(o.textContent).trim()) };
                sel.value = hit.value;
                sel.dispatchEvent(new Event('input', { bubbles: true }));
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, chosen: String(hit.textContent).trim(), value: hit.value, of: opts.length };
              }, { x: target.x, y: target.y, want: String(a.option || '') });
              if (!res.ok) {
                jobsStore.step(job, 'blocked', `choose_option [${a.index}]: ${res.why}`, { url: page().url() });
                observe(`${res.why}.${res.options ? ` The options are: ${res.options.join(' · ')}` : ''}`);
                break;
              }
              await page().waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
              session.lastAnalysis = null;
              jobsStore.step(job, 'type', `chose "${res.chosen}" in [${a.index}]`, { url: page().url() });
              observe(`Chose "${res.chosen}" (one of ${res.of}). The page was told it changed; look or read to see the result.`);
              break;
            }
            /* THE TAB THAT JUST OPENED. A sign-in, a payment, a link with target=_blank. */
            case 'tabs':
            case 'switch_tab': {
              let open = [];
              try { open = (session.context.pages() || []).filter((p) => !p.isClosed()); } catch { open = []; }
              if (!open.length) { observe('This browser has no open tabs to list — the page may have been torn down; call look to recover.'); break; }
              const rows = [];
              for (let i = 0; i < open.length; i++) {
                let t = '', u = '';
                try { u = open[i].url(); t = await open[i].title(); } catch { /* a tab mid-navigation */ }
                rows.push(`[${i}]${open[i] === page() ? ' (you are here)' : ''} ${String(t).slice(0, 80)} — ${String(u).slice(0, 160)}`);
              }
              if (call.name === 'tabs') {
                jobsStore.step(job, 'read', `${open.length} tab(s) open`, { url: page().url() });
                observe(`${open.length} tab(s):\n${rows.join('\n')}\nUse switch_tab with a number to work in one.`);
                break;
              }
              const idx = Number(a.index);
              if (!Number.isInteger(idx) || idx < 0 || idx >= open.length) { observe(`There is no tab [${a.index}]. The tabs are:\n${rows.join('\n')}`); break; }
              session.page = open[idx];
              session.lastAnalysis = null;
              try { await session.page.bringToFront(); } catch { /* headless contexts do not mind */ }
              let u = ''; try { u = session.page.url(); } catch { /* */ }
              jobsStore.step(job, 'click', `switched to tab [${idx}]`, { url: u });
              observe(`Working in tab [${idx}] now (${String(u).slice(0, 180)}). The old numbers are void — call look.`);
              break;
            }
            case 'click': {
              const el = elementAt(a.index);
              /*
               * THE SECOND LINE. The prompt already says not to click these; a model under pressure
               * to finish will do it anyway, and the cost lands on someone's real account. Refusing
               * and naming the alternative is better than refusing alone — it gets used.
               */
              if (!settings.autoAct && !ground.covers(page().url()) && looksLikeWrite(el)) {
                jobsStore.step(job, 'blocked', `refused a direct click on "${(el.text || el.ariaLabel || '').trim().slice(0, 60)}" — that is visible to other people, so it needs act`);
                observe(`Refused: [${a.index}] "${(el.text || el.ariaLabel || '').trim()}" does something other people will see. Use act with kind, index and the text you want to send. The owner approves it first.`);
                break;
              }
              // Loop guard: has this same control been clicked before with no progress since?
              const rawClickLabel = (el?.text || el?.ariaLabel || '').trim().toLowerCase().slice(0, 60);
              // Expanders ("1 antwoord bekijken" / "View replies") repeat the SAME label across many
              // different threads; keying the loop guard on that shared text made expanding a second
              // thread look like a loop and killed the run. Key those on the element index instead.
              const isExpander = /bekijk|weergeven|antwoord|repl|meer reacti|meer opmerking|more comment/.test(rawClickLabel);
              const clickLabel = isExpander ? `#${a.index}` : (rawClickLabel || `#${a.index}`);
              clickHistory.push(clickLabel);
              if (clickHistory.length > 8) clickHistory.shift();
              const repeats = clickHistory.filter((l) => l === clickLabel).length;
              if (repeats >= 3) {
                loopBlocks++;
                if (loopBlocks >= 2) {
                  jobsStore.finish(job, 'stopped', `Stuck clicking "${clickLabel}" — the field could not be filled. Stopped rather than burn the whole run; a stronger pass or a human can finish it.`);
                  break;
                }
                jobsStore.step(job, 'blocked', `click loop on "${clickLabel}" (${repeats}×) — refused, told to type instead`);
                observe(`STOP — you have clicked "${clickLabel}" ${repeats} times and nothing progressed. Clicking OPENS things; it never FILLS them. If you came here to enter text, the field is on the page now: call look and find the item marked "✎ FIELD" (a text box), then use type([number], "your text") to fill it — that is the ONLY thing that enters text. If you genuinely cannot find a "✎ FIELD" after looking, note in one line exactly what is missing and FINISH. Do not click "${clickLabel}" again.`);
                break;
              }
              const t = await clickIndex(a.index);
              jobsStore.step(job, 'click', `[${a.index}] ${t.text || '(no label)'}${a.why ? ` — ${a.why}` : ''}`, { url: page().url() });
              observe(`Clicked [${a.index}] "${t.text || ''}". Now at ${page().url()}. Call look to see the new page.`);
              break;
            }
            case 'type': {
              if (!session.lastAnalysis) await freshAnalysis();

              /*
               * SUBMITTING IS PUBLISHING, in a field like this one.
               *
               * `act` was guarded and `type` was not, and type takes submit:true — which presses
               * Enter, which in a comment box posts the comment. The gate could be walked straight
               * past by typing. Typing itself stays free: it is Enter, in a field that publishes,
               * that needs a person.
               */
              const field = elementAt(a.index);
              if (a.submit && !settings.autoAct && !ground.covers(page().url()) && looksLikeComposer(field)) {
                jobsStore.step(job, 'blocked', `refused to submit into "${(field.placeholder || field.ariaLabel || '').trim().slice(0, 60)}" — that posts it`);
                observe('Refused: pressing Enter in that field publishes what you typed, and anything other people can see needs the owner to approve it first. Use act with the full text instead.');
                break;
              }

              const t = await typeInto(a.index, a.text ?? '', !!a.submit);
              resetClickLoop(); // typing is progress — the loop guard starts fresh
              jobsStore.step(job, 'type', `typed into [${a.index}] ${t.text ? `"${t.text}"` : ''}: ${String(a.text).slice(0, 120)}`);
              observe(`Typed into [${a.index}]${a.submit ? ' and pressed Enter' : ''}. Now at ${page().url()}. Call look.`);
              break;
            }
            case 'paste_text': {
              if (!session.lastAnalysis) await freshAnalysis();
              // Same publishing guard as type: Enter in a field others can see still needs approval.
              const field = elementAt(a.index);
              if (a.submit && !settings.autoAct && !ground.covers(page().url()) && looksLikeComposer(field)) {
                jobsStore.step(job, 'blocked', `refused to submit into "${(field.placeholder || field.ariaLabel || '').trim().slice(0, 60)}" — that posts it`);
                observe('Refused: pressing Enter in that field publishes what you pasted, and anything other people can see needs the owner to approve it first. Use act instead.');
                break;
              }
              await pasteInto(a.index, a.text ?? '', !!a.submit);
              resetClickLoop(); // pasting is progress — the loop guard starts fresh
              jobsStore.step(job, 'type', `pasted ${String(a.text ?? '').length} chars into [${a.index}]`);
              observe(`Pasted the text into [${a.index}]${a.submit ? ' and pressed Enter' : ''}. Now at ${page().url()}. Call look, then start the generation.`);
              break;
            }
            case 'sweep': {
              /*
               * Where to sweep. An explicit address wins; otherwise the site currently open decides
               * how to read the request, so "sweep for these words" means post search on Facebook
               * and content search on LinkedIn without the caller having to know which.
               */
              const onNow = adapterFor(page().url());
              const site2 = a.site ? String(a.site).toLowerCase() : (onNow ? onNow.name : 'facebook');
              const mod = site2 === 'linkedin' ? li : fb;

              const where = a.url ? a.url
                : a.search ? (site2 === 'linkedin' ? li.url.searchPosts(a.search) : fb.url.searchPosts(a.search))
                : (a.group && a.inGroup) ? fb.url.groupSearch(String(a.group).replace(/^.*groups\//, '').replace(/\/.*$/, ''), a.inGroup)
                : a.group ? (/^https?:/.test(a.group) ? a.group : `https://www.facebook.com/groups/${a.group}`)
                : a.myGroups ? fb.url.myGroupsFeed()
                : site2 === 'linkedin' ? li.url.feed()
                : fb.url.myGroupsFeed();

              await page().goto(where, { waitUntil: 'domcontentloaded', timeout: 45000 });
              await sleep(1500 * (pace || 1), signal);

              // `settle` is how long it waits for Facebook to load the next screenful, so it is
              // waiting like everything else here and belongs under the same pace control.
              // Whichever site's reader matches the page — they share a contract on purpose.
              const r = await mod.readFeed(page(), {
                maxAgeDays: MAX_LEAD_AGE_DAYS, seen: sweptPosts, now: Date.now,
                settle: Math.round(1200 * pace),
              });

              /*
               * Written down as it happens, and NOT as the model reports it. What a place returned
               * is a fact; what the agent thought of it is not. Leads saved before the next sweep
               * are attributed here, which is why the current place is remembered rather than asked
               * for later.
               */
              memo.place = a.search ? { kind: 'search', what: a.search }
                : (a.group && a.inGroup) ? { kind: 'search', what: a.inGroup, scope: `group ${a.group}` }
                : a.group ? { kind: 'group', what: String(a.group) }
                : a.myGroups ? { kind: 'group', what: 'all my groups' }
                : { kind: 'search', what: String(a.url || 'somewhere') };
              lastSite = site2;
              playbook.recordSweep(site2, memo.place, { posts: r.posts.length, tooOld: r.tooOld });
              jobsStore.step(job, 'read', `swept ${where.replace('https://www.facebook.com', '')} — ${r.posts.length} post(s) worth reading`
                + (r.tooOld ? `, ${r.tooOld} too old` : '') + (r.skippedSeen ? `, ${r.skippedSeen} already seen` : ''), { url: where });

              if (r.error) { observe(`Could not read that page: ${r.error}. Try look() to see what is actually on screen.`); break; }
              if (!r.posts.length) {
                /* THREE different zeroes, and only one of them means "try different words". Old
                   posts mean move on; already-seen means you are back where you were; but a page
                   full of text that yielded no posts (r.note) is the reader failing to recognise
                   the markup — telling the agent to rephrase there just burns steps, which is
                   exactly what happened for a whole LinkedIn run. */
                observe(r.tooOld
                  ? `Nothing recent — every one of the ${r.tooOld} posts there was older than ${MAX_LEAD_AGE_DAYS} days. Those people found what they needed long ago. Try different words, or a more active place.`
                  : r.skippedSeen
                  ? 'Nothing new since you last looked here.'
                  : r.note
                  ? `${r.note}. Do not just retry different words — call look() and read() to see the page directly, and report what you see so this can be fixed.`
                  : 'No posts came back. Either this is not a feed, or the page had not loaded — call look() to see where you actually are.');
                if (r.note) jobsStore.step(job, 'note', `sweep read the page but recognised no posts (chars ${r.diag && r.diag.chars}) — extractor may be stale`, { url: where });
                break;
              }

              observe(`${r.posts.length} post(s) from ${where} (stopped: ${r.stopped}).\n\n`
                + r.posts.map((x, i) =>
                    `[${i + 1}] ${x.author || 'someone'}${x.group ? ` in ${x.group}` : ''}`
                    + ` — ${x.ageDays === null ? 'date unknown' : x.ageDays === 0 ? 'today' : `${x.ageDays} days ago`}\n`
                    + `    ${String(x.text).replace(/\n+/g, ' ').slice(0, 420)}\n`
                    + `    link: ${x.url || '(none on this page)'}`).join('\n\n')
                + `\n\nSave every one of these that is a lead, with save_lead — the link above is the postUrl. Judging them is the job; do not go looking at pages.`);
              break;
            }
            case 'google': {
              const r = await gg.search(page(), String(a.query || ''), {
                recentDays: a.recentDays || null, settle: Math.round(1200 * pace),
              });
              /* A broken search must say so in the STEP, not only in the observation: the master
                 reads these lines back as the research report, and a run whose fifteen searches all
                 failed was read by the market gate as "zero demand found". */
              const searchFailed = !!(r.blocked || r.consent);
              jobsStore.step(job, 'read',
                searchFailed ? `google "${a.query}" — SEARCH DID NOT RUN: ${String(r.error || '').slice(0, 120)}`
                             : `google "${a.query}" — ${r.results.length} result(s)`,
                { url: r.url });
              if (r.error) { observe(r.error); break; }
              if (!r.results.length) { observe(`Nothing came back for "${a.query}". Try different words, or fewer of them.`); break; }
              observe(`${r.results.length} result(s) for "${a.query}":\n\n`
                + r.results.map((x, i) => `[${i + 1}] ${x.title}${x.source ? `  (${x.source})` : ''}\n    ${x.url}\n    ${x.snippet}`).join('\n\n')
                + `\n\nUse dig on the ones worth reading properly — pass the address EXACTLY as listed here, never one you compose. A snippet is Google's summary, not the page.`);
              break;
            }
            case 'dig': {
              const r = await gg.readPage(page(), String(a.url || ''), { settle: Math.round(900 * pace) });
              /* A composed address that the site redirected elsewhere is named as such in the trail: the
                 master reads these lines back, and "read <unrelated thread>" would pass as evidence. */
              if (r.elsewhere) { jobsStore.step(job, 'blocked', `dig refused: not a real link — ${String(a.url || '').slice(0, 100)} landed on ${String(r.url).slice(0, 100)}`); observe(r.error); break; }
              if (r.error) { jobsStore.step(job, 'error', `dig: ${r.error}`); observe(r.error); break; }
              jobsStore.step(job, 'read', `read ${r.url} (${r.length} characters)`, { url: r.url });
              observe(`${r.title}\n${r.url}\n`
                + (r.description ? `\n${r.description}\n` : '')
                + (r.emails.length ? `\nEmail on the page: ${r.emails.join(', ')}` : '')
                + (r.phones.length ? `\nPhone on the page: ${r.phones.join(', ')}` : '')
                + `\n\n${r.text}`);
              break;
            }
            case 'collect': {
              const item = jobsStore.addResult(job, { title: a.title, fields: (a.fields && typeof a.fields === 'object') ? a.fields : {}, url: a.url || '', image: a.image || '', draft: a.draft || '' });
              if (item) { jobsStore.step(job, 'result', item.title, { url: item.url }); observe(`Saved "${item.title}". Keep going - collect each item as you find it, then finish.`); }
              else observe('Already had that one - skip it and collect the next.');
              break;
            }
            case 'save_lead': {
              /*
               * REFUSED, not quietly accepted.
               *
               * Being told in the prompt is not the same as doing it: the run that exposed this had
               * been told dates matter and saved a 2024 post anyway. Something older than the
               * cut-off is not a weak lead, it is a wrong one — the person has long since found
               * what they needed, and answering years-old posts is what makes an account look
               * automated to the humans reading it.
               */
              const posted = a.postedAt ? Date.parse(a.postedAt) : NaN;
              const ageDays = Number.isFinite(posted) ? (Date.now() - posted) / 86400000 : null;
              if (ageDays !== null && ageDays > MAX_LEAD_AGE_DAYS) {
                jobsStore.step(job, 'blocked', `skipped "${String(a.name || '').slice(0, 60)}" — that post is ${Math.round(ageDays / 30)} months old`);
                observe(`Not saved: that post is from ${a.postedAt}, about ${Math.round(ageDays / 30)} months ago. They have long since found what they were asking for. Look for recent posts instead — sort or scroll to the newest.`);
                break;
              }

              /*
               * REFUSED: a GROUP POST with no link. A whole run once saved 39 people straight from the
               * feed with no postUrl, and the reply step then wandered every group looking for posts it
               * had no address for. sweep hands back each post's link, so a group lead always has one to
               * pass — this is the backstop the prompt alone was not. Scoped to group leads on purpose:
               * a lead from a place with no post (a maps/business lead) legitimately has no link, and
               * refusing those would be wrong. See __tests__/agent.test.js.
               */
              const hasGroup = String(a.groupName || a.groupUrl || '').trim();
              const postLink = String(a.postUrl || a.url || '').trim();
              if (hasGroup && !postLink) {
                jobsStore.step(job, 'blocked', `skipped "${String(a.name || '').slice(0, 60)}" — a group post with no link`);
                observe('Not saved: you have the group but not the post\'s own link. sweep gives each post its link — pass it as postUrl so the reply step can open it. Save again with postUrl set, or move on.');
                break;
              }

              const lead = jobsStore.addLead(job, {
                name: String(a.name || '').slice(0, 200),
                url: String(a.postUrl || a.url || '').slice(0, 500),
                why: String(a.why || '').slice(0, 600),
                quote: String(a.postText || a.quote || '').slice(0, 1000),
                contact: String(a.contact || '').slice(0, 200),
                // The social shape: a person, what they wrote, and where. None of it exists for a
                // lead that came out of a places API, and all of it is what makes the reply land.
                platform: String(a.platform || 'facebook').slice(0, 40),
                profileUrl: String(a.profileUrl || '').slice(0, 500),
                groupName: String(a.groupName || '').slice(0, 250),
                groupUrl: String(a.groupUrl || '').slice(0, 500),
                postUrl: String(a.postUrl || a.url || '').slice(0, 500),
                postText: String(a.postText || a.quote || '').slice(0, 4000),
                postedAt: a.postedAt || null,
                city: String(a.city || '').slice(0, 120),
                phone: String(a.phone || '').slice(0, 60),
                email: String(a.email || '').slice(0, 250),
                website: String(a.website || '').slice(0, 500),
              });
              if (lead) {
                jobsStore.step(job, 'lead', `${lead.name} — ${lead.why}`, { url: lead.url });
                // Credited to wherever it was found, so next time starts there.
                if (memo.place) playbook.recordLead(lastSite || site || 'facebook', memo.place);
              }

              /*
               * Onward, the moment it is found — not batched at the end.
               *
               * A run is often forty minutes behind a login that took an afternoon to get, so the
               * far end being unreachable must cost that run nothing: the lead is already in the
               * job file either way, and the failure is said out loud rather than swallowed.
               */
              let sent = '';
              if (lead && sink) {
                try {
                  const r = await sink.send(lead);
                  // Remember it. Every later message to this person is recorded against this id,
                  // and the model is told it so it can pass it to act.
                  if (r.id) lead.leadId = r.id;
                  sent = r.created === false
                    ? ` (${sink.label} already had them, id ${r.id})`
                    : ` → ${sink.label} as lead [${r.id}]`;
                } catch (e) {
                  jobsStore.step(job, 'error', `could not send "${lead.name}" to ${sink.label}: ${e.message}`);
                  sent = ` (kept here — ${sink.label} did not accept it)`;
                }
              }

              observe(lead
                ? `Saved "${lead.name}"${sent}.${lead.postUrl ? '' : ' NOTE: you did not give a link to the post — go back, click the post date to get its permalink, and save it again with postUrl set. Without it nobody can open this lead.'} ${job.leads.length} lead(s) so far.`
                  + (lead.leadId ? ` Use leadId ${lead.leadId} when you act on them, so what you send is recorded.` : '')
                : 'Already saved — do not record the same person twice.');
              break;
            }
            case 'use_role': {
              /*
               * The agent correcting its own brief. Deliberately not gated on anything: a role that
               * could not escape itself would leave the wall exactly where it was, and the acts that
               * matter — anything other people can see — are approval-gated whatever role is worn.
               */
              observe(becomeRole(String(a.role || '').trim(), String(a.why || '').trim()));
              break;
            }
            case 'save_place': {
              /*
               * ONE BUSINESS FROM MAPS, whole. It rides the same lead sink as save_lead (the far end
               * reads job.leads and does not care which tool filled them), so everything downstream
               * — dedupe, the organ's poll, the pipeline — is unchanged. What is new is that the
               * record actually holds what the card said.
               */
              const cat = String(a.category || '').trim();
              const link = String(a.mapsUrl || a.url || '').trim();
              /*
               * REFUSED: a place with no category. The category is Maps' own word for what this
               * business IS, and it is the only check that the place is the kind that was asked for
               * — the walk that prompted this saved a parking garage for "garage" and nothing in the
               * record could have caught it. Being told in the prompt is not the same as doing it.
               */
              if (!cat) {
                jobsStore.step(job, 'blocked', `skipped "${String(a.name || '').slice(0, 60)}" — no category read off the card`);
                observe('Not saved: you did not give the category Maps prints under the name. That line is what proves this is the kind of business you were asked for. Open the place, read the category under its name, and save it again.');
                break;
              }
              if (!link) {
                jobsStore.step(job, 'blocked', `skipped "${String(a.name || '').slice(0, 60)}" — no link to the place`);
                observe('Not saved: no mapsUrl. Copy the address bar while the place is open (or use its Share link) and save again — without it nobody can open this business.');
                break;
              }
              const reviews = (Array.isArray(a.reviews) ? a.reviews : []).slice(0, 20).map((r) => ({
                author: String((r && r.author) || '').slice(0, 120),
                rating: Number.isFinite(Number(r && r.rating)) ? Number(r.rating) : null,
                when: String((r && r.when) || '').slice(0, 60),
                text: String((r && r.text) || '').slice(0, 1500),
                ownerReply: String((r && r.ownerReply) || '').slice(0, 1000) || null,
              })).filter((r) => r.text || r.rating !== null);
              const missing = (Array.isArray(a.missing) ? a.missing : []).slice(0, 12).map((m) => String(m || '').slice(0, 120)).filter(Boolean);
              const place = jobsStore.addLead(job, {
                kind: 'place',
                name: String(a.name || '').slice(0, 200),
                url: link.slice(0, 500),
                why: String(a.why || '').slice(0, 600),
                /* The quote a first line gets written from: the sharpest thing a customer said. */
                quote: (reviews.find((r) => r.rating !== null && r.rating <= 3) || reviews[0] || {}).text || '',
                category: cat.slice(0, 120),
                address: String(a.address || '').slice(0, 500),
                city: String(a.city || '').slice(0, 120),
                country: String(a.country || '').slice(0, 2).toUpperCase(),
                phone: String(a.phone || '').slice(0, 60),
                website: String(a.website || '').slice(0, 500),
                email: String(a.email || '').slice(0, 250),
                mapsUrl: link.slice(0, 500),
                postUrl: link.slice(0, 500),
                rating: Number.isFinite(Number(a.rating)) ? Number(a.rating) : null,
                ratingsCount: Number.isFinite(Number(a.ratingsCount)) ? Math.round(Number(a.ratingsCount)) : null,
                priceLevel: String(a.priceLevel || '').slice(0, 12),
                hours: String(a.hours || '').slice(0, 400),
                claimed: typeof a.claimed === 'boolean' ? a.claimed : null,
                attributes: (Array.isArray(a.attributes) ? a.attributes : []).slice(0, 20).map((x) => String(x || '').slice(0, 80)).filter(Boolean),
                missing,
                reviews,
                platform: 'google',
              });
              if (place) {
                const n = place.ratingsCount ? `${place.rating ?? '?'}★ of ${place.ratingsCount}` : (place.rating ? `${place.rating}★` : 'unrated');
                jobsStore.step(job, 'lead', `${place.name} (${place.category}) — ${n}, ${reviews.length} review(s)${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`, { url: place.url });
              }
              let sentPlace = '';
              if (place && sink) {
                try {
                  const r = await sink.send(place);
                  if (r.id) place.leadId = r.id;
                  sentPlace = r.created === false ? ` (${sink.label} already had them, id ${r.id})` : ` → ${sink.label}`;
                } catch (e) {
                  jobsStore.step(job, 'error', `could not send "${place.name}" to ${sink.label}: ${e.message}`);
                  sentPlace = ` (kept here — ${sink.label} did not accept it)`;
                }
              }
              observe(place
                ? `Saved "${place.name}" — ${place.category}${sentPlace}. ${reviews.length ? `${reviews.length} review(s) kept.` : 'NO REVIEWS KEPT — open the Reviews tab and read the newest and the lowest-rated ones; what customers complain about is the reason to approach them.'} ${job.leads.length} place(s) so far. Next place.`
                : 'Already saved — do not record the same business twice. Next place.');
              break;
            }
            case 'save_reply': {
              /* A client's answer on an offer we already sent — the inbox role's product. Deduped
                 by URL + text, so re-reading the same message twice does not double-report it. */
              const reply = jobsStore.addReply(job, {
                url: String(a.url || '').slice(0, 500),
                title: String(a.title || '').slice(0, 250),
                from: String(a.from || '').slice(0, 200),
                text: String(a.text || '').slice(0, 4000),
                status: String(a.status || 'message').slice(0, 40),
                at: a.at || null,
              });
              if (reply) jobsStore.step(job, 'reply', `${reply.from || 'client'} on "${reply.title || reply.url}": ${reply.text.slice(0, 80)}`, { url: reply.url });
              observe(reply
                ? `Saved reply on "${reply.title || reply.url}" (${reply.status}). ${job.replies.length} reply(ies) so far. Next brief.`
                : 'Already had that reply — skipped. Next brief.');
              break;
            }
            case 'act': {
              const el = elementAt(a.index);
              const label = (el?.text || el?.ariaLabel || `element ${a.index}`).trim().slice(0, 80);
              const kind = String(a.kind || 'other');
              const text = String(a.text || '');
              let proposedUrl = null;   // set only when the act parks at the gate; the page it was approved for

              // On our own app there is nobody to ask and nobody to protect — waiting here is how an
              // autonomous QA run deadlocks. Off it, every act is proposed exactly as before.
              const onOwnGround = ground.covers(page().url());
              let approved = settings.autoAct || onOwnGround;
              let toSend = text;
              // Quality gate on AUTO-SEND: never post a garbled draft to a real person unattended.
              // Flip it back to needing approval so a person sees the mess instead of the recipient.
              if (approved && settings.autoAct && text && looksGarbled(text)) {
                approved = false;
                jobsStore.step(job, 'held', `held a ${kind} for your review — the draft looked garbled, so auto-send skipped it`);
              }
              /* SAY SO IN THE TRAIL. An act that nobody approved must never read as one somebody
                 did — "what did it actually do, and who said it could" is the question this record
                 exists to answer, and silence here would make the two indistinguishable. */
              if (onOwnGround && !settings.autoAct) {
                jobsStore.step(job, 'own-ground',
                  `${kind} on "${label}" went ahead without asking — this is our own app at `
                  + `${ground.origin}, not somebody else's account`);
              }
              if (!approved) {
                const p = jobsStore.propose(job, { kind, index: Number(a.index), label, text, why: String(a.why || ''), url: page().url() });
                proposedUrl = p.url || page().url();
                /* WATCHER FOLLOW-UP DRAFT: if this act belongs to a watcher feed item, write the drafted
                   text straight onto that item NOW, while the job is alive — so a job prune or a pod roll
                   after this point can never lose the draft. This is the reliable path; the run-completion
                   write-back and the reconcile sweep are only backups. */
                if (job.feedWorkflowId && job.feedKey && text) {
                  /* WATCHER FOLLOW-UP DRAFT-ONLY. Write the drafted text onto the feed item now (while
                     the job is alive — a prune or a pod roll after this can't lose it), then STOP: the
                     owner approves it later in Results, so the flow must NOT sit parked at the gate
                     holding the one browser session — that blocks every other item's draft. */
                  try { require('./watcherFeed').mark(job.feedWorkflowId, job.feedKey, { draft: require('./humanize')(text), draftJobId: job.id, draftPid: p.pid }); }
                  catch (e) { /* best effort — the backups still cover it */ }
                  jobsStore.step(job, 'drafted', `drafted a ${kind} — saved to Results for your approval, not sent`);
                  observe(`Drafted the ${kind} and saved it for the owner to approve later in Results. Do NOT send it and do NOT ask again — you are finished with this conversation. Call finish now.`);
                  break;
                }
                jobsStore.step(job, 'ask', `waiting for you: ${kind}${text ? ` — "${text.slice(0, 160)}"` : ` on "${label}"`}`, { pid: p.pid });
                const decided = await awaitDecision(job, p.pid, signal, () => { try { session.lastUsed = Date.now(); } catch { /* session may be swapping */ } });
                approved = decided?.state === 'approved';
                toSend = decided?.text ?? text;
                if (!approved) {
                  jobsStore.step(job, 'skipped', `you skipped the ${kind}`);
                  observe(`The owner did not approve that ${kind}. Move on — do not ask again for the same person.`);
                  break;
                }
              }

              /*
               * THE PAGE MAY HAVE MOVED WHILE THE ACT WAITED AT THE GATE. A proposal can sit for
               * minutes; the element numbers the agent held are only good for the page they came
               * from. Live: a released [For Hire] post clicked [5] on a page that had rotated, and
               * "Post" was a link into r/wordchain. So a PARKED act fires only if the browser is still
               * on the proposal's page and the element at that number still carries the approved
               * label. Anything else is recorded, not clicked: re-asking costs a minute, an act on
               * the wrong page can cost an account. An act approved on the spot never waited, so it
               * is not checked.
               */
              const stale = proposedUrl ? (() => {
                try {
                  const now = String(page().url() || '');
                  const path = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
                  if (path(now) !== path(proposedUrl)) return `the page moved while the act waited (now ${now.slice(0, 90)})`;
                  const elNow = elementAt(a.index);
                  const labelNow = (elNow?.text || elNow?.ariaLabel || '').trim().slice(0, 80);
                  if (labelNow !== label) return `element [${a.index}] is now "${labelNow || 'nothing'}", not "${label}"`;
                  return null;
                } catch (e) { return 'the page could not be checked before the act: ' + String(e && e.message).slice(0, 80); }
              })() : null;
              if (stale) {
                jobsStore.step(job, 'blocked', `approved ${kind} NOT fired: ${stale}`, { url: page().url() });
                observe(`The owner approved the ${kind}, but ${stale}. Nothing was clicked. Call look, find "${label}" again on the right page, and ask again — the approval was for that page, not for whatever is under that number now.`);
                break;
              }

              if (toSend) await typeInto(a.index, toSend, true);
              else await clickIndex(a.index);
              resetClickLoop(); // an approved action is progress

              /*
               * CONFIRM IT BEFORE CALLING IT DONE. This step used to be written the moment the text
               * was typed, and typeInto ends with Enter — which submits a Facebook comment and, in
               * Reddit's composer, usually just makes a newline. Four Herald threads were reported
               * REPLIED with nothing on the page. An act that cannot be confirmed is recorded as
               * exactly that: never as sent, and never auto-retried, because posting a comment
               * twice is worse than not posting it once.
               */
              const landed = toSend ? await confirmPosted(page(), toSend) : null;
              if (landed === false) {
                jobsStore.step(job, 'unconfirmed',
                  `${kind} was typed but could not be found on the page afterwards — it may need its own Post/Comment button`,
                  { url: page().url() });
                pendingSend = toSend;
                observe(`You typed the ${kind} and pressed Enter, but the text is NOT on the page afterwards.`
                  + ' On this site Enter does not submit. THE TEXT IS STILL IN THE BOX — typing it again would'
                  + ' post it twice. Call look, find the control that SENDS what is in the box (it sits next to'
                  + ' the box, and this browser shows pages in the owner\'s own language, so it may read'
                  + ' "Verzenden", "Senden", "Envoyer", "Publicar" or just be an arrow rather than "Post" or'
                  + ' "Comment"), and click THAT. I will tell you the moment it lands.');
                break;
              }
              jobsStore.step(job, 'acted', `${kind}${toSend ? `: "${toSend.slice(0, 200)}"` : ` on "${label}"`}`, { url: page().url() });

              /*
               * SEAL THE ROUTE CARD AT THE ACT. This approved click IS the decisive act — the create,
               * the post. The request it fires is the one worth learning, so mark it now, before the
               * walk navigates on to find the new page's URL. Best-effort: only a Herald walk arms the
               * recorder, and a session without one simply learns nothing here.
               */
              if (learnsCards) { try { session?.recorder?.seal(); } catch { /* never fail an act over bookkeeping */ } }

              /*
               * WRITTEN DOWN WITHOUT BEING ASKED. Relying on the model to remember to log what it
               * just sent is relying on it at exactly the moment it is most pleased with itself —
               * and an unrecorded outbound message is worse than none, because the next sweep
               * reads the reply as an unprompted stranger.
               */
              let logged = '';
              if (convo && a.leadId) {
                try {
                  const r = await convo.touch({
                    leadId: a.leadId, direction: 'out',
                    channel: kind === 'message' ? 'dm' : (kind === 'reply' ? 'reply' : kind),
                    text: toSend || null, url: page().url(), platform: 'facebook',
                    approved: !settings.autoAct,
                  });
                  logged = ` Recorded against lead [${a.leadId}] — now "${r.stage}".`;
                } catch (e) {
                  jobsStore.step(job, 'error', `could not record that ${kind} against lead ${a.leadId}: ${e.message}`);
                }
              }
              observe(`Done: ${kind}.${logged} Now at ${page().url()}.`);
              // The long pause is the point: this is the rhythm that keeps an account healthy.
              await sleep(rand(PAUSE_WRITE, pace), signal);
              break;
            }
            case 'store_data': {
              // Models routinely hand structured output as a JSON STRING. Parse it, so the next step
              // can address its parts (storyboard.scenes must be a real array for a for-each to run).
              let value = a.value;
              if (typeof value === 'string') { const t = value.trim();
                if ((t[0] === '{' && t.endsWith('}')) || (t[0] === '[' && t.endsWith(']'))) { try { value = JSON.parse(t); } catch { /* not JSON — keep the string */ } } }
              const bag = jobsStore.storeData(job, a.key, value);
              const k = String(a.key || '').slice(0, 120);
              jobsStore.step(job, 'note', `stored "${k}" for the next step`);
              observe(`Saved "${k}" — a later step can use it. ${Object.keys(bag).length} item(s) stored so far.`);
              break;
            }
            case 'remember_conversation': {
              conversations.remember({ name: a.name, threadUrl: a.threadUrl });
              jobsStore.step(job, 'note', `now managing the chat with ${String(a.name || '').slice(0, 60)}`);
              observe('Marked as a conversation you manage — the reply watcher will follow up here, and only here.');
              break;
            }
            case 'managed_conversations': {
              const managed = conversations.all();
              jobsStore.step(job, 'note', `${managed.length} managed conversation(s)`);
              observe(managed.length
                ? `You manage these conversations — follow up ONLY with these people, and ignore anyone not on the list:\n${managed.map((c) => `- ${c.name}${c.threadUrl ? ` (${c.threadUrl})` : ''}`).join('\n')}`
                : 'You are not managing any conversations yet — there is nobody to follow up with. Finish with "none to follow up".');
              break;
            }
            default:
              observe(`There is no tool called "${call.name}".`);
          }
        } catch (e) {
          // One failed action is not a failed job — tell the model what broke and let it recover.
          jobsStore.step(job, 'error', `${call.name}: ${e.message}`);
          observe(`That failed: ${e.message}. Call look to see where you actually are, then try another way.`);
        }
      }

      if (job.status === 'running') await sleep(rand(PAUSE_READ, pace), signal);
    }
  } catch (e) {
    log.error?.(`[agent] ${job.id}: ${e.message}`);
    jobsStore.finish(job, 'failed', e.message);
  }

  if (!jobsStore.isOver(job)) jobsStore.finish(job, 'stopped', 'stopped');

  /*
   * LEARN THE CARD — but only from a walk that actually SUCCEEDED. A failed or stopped run distills
   * nothing: a card learned from a broken flow is worse than no card, because it would replay the
   * broken flow. Best-effort throughout: the whole mechanism is an optimisation on top of a working
   * browser, so a store that will not persist just means the next run walks the UI again.
   */
  if (learnsCards && session && session.recorder && session.recorder.armed) {
    try {
      /*
       * A card is worth keeping when the decisive act ACTUALLY HAPPENED — which is exactly what the
       * seal records. A clean "idle" finish still qualifies (a simple operate walk), but a setup walk
       * that created the page and then kept navigating to find its URL never reaches idle, yet it very
       * much did the act. So learn on `sealed OR idle`, and only discard a walk that neither sealed an
       * act nor finished cleanly — that one really did teach nothing.
       */
      const didAct = (() => { try { return !!session.recorder.sealed; } catch { return false; } })();
      if (didAct || job.status === 'idle') {
        const out = session.recorder.finish({ now: Date.now() });
        if (out && out.ok) {
          /*
           * PROMOTION BY OBSERVATION — the walk just did the act, so if the request it made matches
           * the card we already had, that card is confirmed without re-firing anything. Before this
           * the fresh card simply overwrote the old one at confidence 0, which is why no card was
           * ever trusted and the fast path never opened once in months of recording.
           */
          const prior = cardStore.get(out.card.origin, out.card.intent);
          const learned = routecards.learnFrom(prior, out.card, Date.now());
          cardStore.put(learned.card);
          jobsStore.step(job, 'note', `route card for ${out.card.intent}: ${learned.reason}`);
          log.info?.(`[agent] ${job.id}: route card ${learned.promoted ? 'CONFIRMED' : 'recorded'} for ${out.card.intent} — ${learned.reason}`);
        } else if (out && !out.ok) {
          jobsStore.step(job, 'note', `no route card learned this run: ${out.reason}`);
        }
      } else {
        session.recorder.discard();   // no act sealed and no clean finish — nothing to learn
      }
    } catch (e) { log.warn?.(`[agent] ${job.id}: route-card learning skipped: ${e.message}`); }
  }

  /* Close the search either way. One left saying "processing" forever is worse than one that says
     it failed, because nobody watching it knows whether to keep waiting. */
  if (sink) {
    try {
      await sink.close(job.status === 'failed');
      jobsStore.step(job, 'note', `${sink.label} search closed — ${job.leads.length} lead(s) sent`);
    } catch (e) {
      jobsStore.step(job, 'error', `could not close the ${sink.label} search: ${e.message}`);
    }
  }
  return job;
}

/**
 * HOW MANY MODEL KEYS ARE USABLE RIGHT NOW — for a status line, never the keys themselves.
 *
 * Live, both accounts hit their weekly allowance on the same afternoon and every walk stopped on
 * its third step. The keyring had done its job (it rotated, then reported "0 of 2 still usable")
 * but nothing on screen said so, so the tool simply looked broken.
 */
function keyState(settings) {
  try { return ringFor(settings || {}).state(); } catch { return { total: 0, usable: 0 }; }
}

module.exports = {
  keyState, run, TOOLS, cardStore, scriptRefusal, pickPath, describeProfiles, summariseCall, MAX_LEAD_AGE_DAYS, looksLikeComposer, HANDS_DOC: null, askWithRetry, PERMANENT, looksLikeWrite, systemPrompt, trimTranscript, WRITE_WORDS, ownGround, looksGarbled,
  confirmPosted, pageHasText, flatten, stripMarks, lettersOnly, readableText, loginWall };
