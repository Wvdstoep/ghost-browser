/*
 * APPROVING A GIG OFFER MUST SEND IT.
 *
 * The bug: postGigOffer took `!!b.confirm`, so an ABSENT flag meant fill-and-stop. Neither the web
 * console (WebRepo.approveDraft) nor the desktop app (approveDraftD) has ever sent that flag, which
 * means the Approve button never once completed a gig offer. It filled useme's form, advanced to the
 * summary, verified its own price and body, and stopped one click short.
 *
 * What made it costly is that it LOOKED fine. The feed recorded posted:"summary", and only
 * "submitted" means sent — so an offer sat unsent while reading as delivered. Measured on a live
 * gig: 6400 PLN, 7 days, an 817-character body, parked at /offer/summary/ with the client never
 * seeing it, on a fresh gig that had only three competing offers.
 *
 * Read as source text because requiring server.js boots the app — the existing pattern for this file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

/* Just the approve route, so a `confirm` anywhere else in 4000 lines cannot make this pass. */
const route = (() => {
  const i = src.indexOf("app.post('/v1/watchers/:id/feed/approve'");
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, i + 3000);
})();

describe('approve = send, for a gig offer', () => {
  it('does not require a flag the UIs never send', () => {
    /* `!!b.confirm` is the bug itself: absent flag -> do not send. */
    expect(route).not.toMatch(/postGigOffer\([^)]*!!\s*b\.confirm/);
  });

  it('sends unless told explicitly not to', () => {
    expect(route).toContain('b.confirm !== false');
    expect(route).toMatch(/postGigOffer\([\s\S]*?days,\s*confirmSend\)/);
  });

  /* The escape hatch stays meaningful: confirm:false = fill and park for a look. */
  it('still honours an explicit refusal to send', () => {
    expect(route).toMatch(/confirm:false|confirm:\s*false|confirm\s*!==\s*false/);
  });

  /*
   * ONLY A SUBMITTED OFFER IS HANDLED. If "summary" ever marked an item handled, the feed would bury
   * an unsent offer out of sight — the same failure, made permanent.
   */
  it('never marks an item handled on anything but a real submission', () => {
    expect(route).toContain("handled: r.stage === 'submitted'");
  });
});
