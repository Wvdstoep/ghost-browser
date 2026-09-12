/**
 * THE CONFIRMATION WAS READING THE COMMENT BOX.
 *
 * A LinkedIn article said "No comments, yet." and Herald said REPLIED. The job trail is unambiguous:
 * act() typed the comment, confirmPosted said the words were on the page, `acted` was written, and the
 * page had grown by about the length of the reply — because the reply was sitting in LinkedIn's
 * comment box, which is a contenteditable div, and document.body.innerText includes it.
 *
 * MY OWN DEFENCE WAS WRONG. The check took a slice from the MIDDLE of the text specifically so that a
 * draft still in the composer would not match. That assumed a composer holds a PREFIX of what you are
 * typing. It holds the WHOLE thing, so the middle matched perfectly and the trick defended nothing.
 *
 * The real distinction is not where in the text but where on the PAGE: a posted comment is in the
 * document, a typed one is inside an editable box.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readableText, lettersOnly, confirmPosted, loginWall } from '../src/agent.js';

const REPLY = 'The thing none of these lists ever mention: the gap between demo and production is a '
  + 'deployment problem, not a builder problem. That last 30% is where people spend months.';

/* The article page, exactly as the walk left it: the reply typed into the box, nothing posted. */
const linkedInPage = ({ posted = false, typed = false } = {}) => new JSDOM(`
  <body>
    <article><h1>3 Best Lovable.dev Alternatives Worth Trying in 2025</h1>
      <p>Lovable has earned its spot as an easy-to-use AI app builder.</p></article>
    <section class="comments">
      <h2>Comments</h2>
      ${posted ? `<div class="comment"><span>Wesley Stoep</span><p>${REPLY}</p></div>` : '<p>No comments, yet.</p>'}
      <div class="composer">
        <div role="textbox" contenteditable="true">${typed ? REPLY : ''}</div>
      </div>
    </section>
    <script>var tracking = "${REPLY}";</script>
  </body>`).window.document;

/* readableText is injected into the page, so it is called with document/Node in scope. */
const runIn = (doc) => {
  const g = globalThis.document;
  globalThis.document = doc;
  try { return readableText(); } finally { globalThis.document = g; }
};

describe('the page as a reader sees it', () => {
  it('does not see a reply that is only sitting in the comment box', () => {
    const text = lettersOnly(runIn(linkedInPage({ posted: false, typed: true })));
    expect(text).toContain(lettersOnly('No comments, yet'));
    expect(text).not.toContain(lettersOnly(REPLY));
  });

  it('does see one that actually posted', () => {
    expect(lettersOnly(runIn(linkedInPage({ posted: true })))).toContain(lettersOnly(REPLY));
  });

  /* The case that matters most: both at once. Posted, and the box still holds a copy. */
  it('and sees it when it posted even though the box still holds it', () => {
    expect(lettersOnly(runIn(linkedInPage({ posted: true, typed: true })))).toContain(lettersOnly(REPLY));
  });

  it('leaves out script and style, which are in the DOM and on nobody\'s screen', () => {
    const doc = new JSDOM('<body><p>visible</p><script>var x = "secret sauce";</script>'
      + '<style>.a{content:"hidden words"}</style></body>').window.document;
    const text = runIn(doc);
    expect(text).toContain('visible');
    expect(text).not.toContain('secret sauce');
    expect(text).not.toContain('hidden words');
  });

  it('and a plain textarea or input, which is the same mistake in older markup', () => {
    const doc = new JSDOM(`<body><p>on the page</p><textarea>${REPLY}</textarea>`
      + `<input value="${REPLY}"></body>`).window.document;
    expect(lettersOnly(runIn(doc))).not.toContain(lettersOnly(REPLY));
  });

  /* Injected code must never throw: a failure here reads as "nothing on the page". */
  it('never throws, whatever it is handed', () => {
    expect(() => runIn(new JSDOM('<body></body>').window.document)).not.toThrow();
    expect(runIn({ body: null })).toBe('');
  });
});

describe('confirmPosted, against the page that caused this', () => {
  const page = (doc) => ({ evaluate: async () => runIn(doc) });

  it('a reply only in the composer is NOT confirmed', async () => {
    expect(await confirmPosted(page(linkedInPage({ typed: true })), REPLY, [0])).toBe(false);
  });

  it('a reply on the thread is confirmed', async () => {
    expect(await confirmPosted(page(linkedInPage({ posted: true })), REPLY, [0])).toBe(true);
  });

  /* Unknown is not the same as no: too short to identify means do not guess either way. */
  it('says nothing either way about text too short to identify', async () => {
    expect(await confirmPosted(page(linkedInPage({ posted: true })), 'thanks!', [0])).toBe(null);
  });

  it('and a page it cannot read is unknown, not a false negative', async () => {
    const broken = { evaluate: async () => { throw new Error('detached'); } };
    expect(await confirmPosted(broken, REPLY, [0])).toBe(null);
  });
});

/*
 * IS THIS A LOGIN WALL? Answered structurally, so it holds in any language — and it has to, because
 * this browser shows every page in the owner's own. Four of the nine platforms the desk replies on
 * need a login merely to READ, and a signed-out profile there made a reply that was never attempted
 * look 'unconfirmed', which is the one outcome that is never retried.
 */
describe('a login wall, recognised without reading a word of it', () => {
  const runIn = (doc, href) => {
    const g = globalThis.document, l = globalThis.location;
    globalThis.document = doc;
    globalThis.location = new URL(href || 'https://www.linkedin.com/feed/');
    try { return loginWall(); } finally { globalThis.document = g; globalThis.location = l; }
  };
  const dom = (html) => new JSDOM('<body>' + html + '</body>').window.document;

  /* Nothing but a sign-in asks for a password. This is the signal that needs no language at all. */
  it('a password field is a wall, whatever the page says', () => {
    expect(runIn(dom('<form><input type="email"><input type="password"></form>'))).toBe(true);
    expect(runIn(dom('<p>Aanmelden bij LinkedIn</p><input type="password">'))).toBe(true);
  });

  /* Indie Hackers signs in through Google, and Google asks for the email first — no password yet. */
  it('and so is the address, which catches the ones that ask for an email first', () => {
    expect(runIn(dom('<p>Sign in</p>'), 'https://accounts.google.com/v3/signin/identifier')).toBe(true);
    expect(runIn(dom('<p>x</p>'), 'https://www.linkedin.com/uas/login')).toBe(true);
    expect(runIn(dom('<p>x</p>'), 'https://www.reddit.com/login/')).toBe(true);
    expect(runIn(dom('<p>x</p>'), 'https://www.linkedin.com/authwall')).toBe(true);
  });

  /* Claiming a wall where there is none would stop the desk replying anywhere. */
  it('an ordinary thread is not a wall', () => {
    expect(runIn(dom('<article><h1>3 Best Lovable.dev Alternatives</h1></article><input type="text">'),
      'https://www.linkedin.com/pulse/3-best-lovabledev-alternatives/')).toBe(false);
    expect(runIn(dom('<p>comments</p>'), 'https://news.ycombinator.com/item?id=49575201')).toBe(false);
  });

  /* A word inside a path is not a path segment: /r/loginhelp is a subreddit, not a sign-in. */
  it('and a page that merely mentions logging in is not one either', () => {
    expect(runIn(dom('<p>How I fixed my login flow</p>'), 'https://www.reddit.com/r/loginhelp/comments/1/')).toBe(false);
  });

  it('never throws, and unknown is not a wall', () => {
    expect(() => runIn(dom(''), 'https://example.com/')).not.toThrow();
  });
});
