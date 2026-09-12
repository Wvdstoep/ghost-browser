'use strict';
/**
 * tools/navigate.js — moving around a page without changing anything on it.
 *
 * These two are read-only by construction, which is why they carry no guard: scrolling and going
 * back cannot post, join or send. Everything that CAN is still gated in the loop, where the policy
 * belongs.
 *
 * Both end by telling the agent what to do next. That is not politeness — a tool that reports "done"
 * and stops leaves the model to guess whether the page changed, and the guess it makes is usually to
 * scroll again. "Call read or look to see what appeared" is what turns a scroll into progress.
 */

module.exports = {
  /**
   * A FEED IS EMPTY UNTIL YOU SCROLL. Facebook and LinkedIn load a screenful at a time, so what is
   * on screen at arrival is almost never all there is — the rhythm that actually finds things is
   * read, scroll, read, scroll.
   */
  async scroll(ctx, a) {
    const amount = Number(a.amount) || 700;
    const dy = a.direction === 'up' ? -amount : amount;
    await ctx.page().mouse.wheel(0, dy);
    // A real pause, paced like everything else: the next screenful has to load before it can be read.
    await ctx.sleep(900);
    ctx.step('scroll', `scrolled ${a.direction === 'up' ? 'up' : 'down'}`);
    ctx.observe(`Scrolled ${a.direction === 'up' ? 'up' : 'down'} ${amount}px. Call read or look to see what appeared.`);
  },

  /** Back to the previous page. Never fatal — a history with nowhere to go is not an error. */
  async back(ctx) {
    await ctx.page().goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await ctx.settle(600);
    ctx.step('open', `back to ${ctx.page().url()}`);
    ctx.observe(`Back at ${ctx.page().url()}. Call look.`);
  },

  /**
   * Report the URL you are on RIGHT NOW (and its title). The point is deriving an id from the path
   * instead of guessing it: a logged-in app puts the account's own id in the URL — a YouTube channel
   * is studio.youtube.com/channel/<ID>/… — so the way to build a link into that account is to OPEN the
   * app's home, read the id the redirect landed on with this, THEN construct the link. Guessing a path
   * segment ("/channel/customization/…") lands on an error page; reading the real id does not.
   */
  async current_url(ctx) {
    const page = ctx.page();
    let url = '', title = '';
    try { url = page.url(); } catch { /* detached */ }
    try { title = await page.title(); } catch { /* no title */ }
    const m = /\/channel\/([A-Za-z0-9_-]{6,})/.exec(url);
    ctx.step('note', `at ${url}`);
    ctx.observe(`You are at ${url}${title ? ` — "${title}"` : ''}.`
      + (m ? ` Your channel id is ${m[1]} — build links as https://studio.youtube.com/channel/${m[1]}/… (never guess the path segment).` : ' Read any id you need out of this path rather than guessing it.'));
  },
};
