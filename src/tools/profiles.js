'use strict';
/**
 * tools/profiles.js — moving between the owner's stored logins.
 *
 * A profile is a whole browser context with its own cookies, so switching is not a setting change:
 * it is a different browser. That is why `use_profile` hands the new session back through
 * `ctx.setSession` rather than assuming anything — every helper in the loop reads the CURRENT page,
 * and a switch that updated only half of them would leave the agent driving the old browser while
 * the person watches the new one do nothing. That was a real bug, and this is where it was fixed.
 */

module.exports = {
  /** What logins exist. Read-only; it does not open any of them. */
  async list_profiles(ctx) {
    const list = ctx.describeProfiles(ctx.session());
    ctx.step('note', 'looked at the stored logins');
    ctx.observe(list ? `Logins:\n${list}` : 'There are no stored logins.');
  },

  /**
   * Snap Facebook back to the OWNER'S PERSONAL profile. Facebook stores "acting as a Page" in an
   * i_user cookie; while it is set the account IS that Page, and personal things — your groups above
   * all — are simply not there, which is why a scout on a Page finds an empty group list. Clearing
   * that cookie and reloading is the DETERMINISTIC switch back that clicking the account menu never
   * reliably is. Safe: it only changes which of the owner's own identities is active, nothing outward.
   */
  async use_my_profile(ctx) {
    const page = ctx.page();
    const context = page.context();
    let wasPage = false;
    try {
      const cookies = await context.cookies('https://www.facebook.com');
      wasPage = cookies.some((c) => c.name === 'i_user');
      if (wasPage) {
        // Filtered clear where the runtime supports it; otherwise clear all and re-add the rest.
        try { await context.clearCookies({ name: 'i_user' }); }
        catch { const keep = (await context.cookies()).filter((c) => c.name !== 'i_user'); await context.clearCookies(); await context.addCookies(keep); }
      }
    } catch (e) { /* reload anyway — worst case nothing changed */ }
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await ctx.settle(1200);
    ctx.step('note', wasPage ? 'switched Facebook back to your personal profile' : 'already on your personal profile');
    ctx.observe(wasPage
      ? 'Switched back to your PERSONAL profile — the Page actor was cleared. Call look; your groups are available now.'
      : 'Already on your personal profile (no Page was active). Call look.');
  },

  /** Move to another stored login, and make sure everyone knows — including whoever is watching. */
  async use_profile(ctx, a) {
    if (!ctx.switchProfile) { ctx.observe('Switching logins is not available in this run.'); return; }
    const want = String(a.profile || '').trim();
    ctx.step('note', `switching to the "${want}" login`);
    const next = await ctx.switchProfile(want);
    ctx.setSession(next);                 // every helper reads this through page()
    // Tell anyone watching, or they keep looking at a screencast of the browser it left.
    ctx.switchedSession({ sessionId: next.id, profile: next.profile });
    ctx.step('open', `now using "${next.profile}" — ${ctx.page().url()}`);
    ctx.observe(`Switched to "${next.profile}". You are at ${ctx.page().url()}. Call look.`);
  },
};
