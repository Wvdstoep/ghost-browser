'use strict';
/**
 * tools/records.js — the things a run produces, and the two ways it ends.
 *
 * Each of these writes one typed row to the job. What makes them worth grouping is that they share
 * a discipline the loop has learned the hard way: a row is refused for a NAMED reason and the agent
 * is told what to do instead. "Not saved" on its own sends it to try the identical thing again;
 * "that brief is 40 days old — sort by newest and stay there" sends it somewhere useful.
 *
 * They also disagree with each other on purpose, and that disagreement is the interesting part.
 * A gig older than a month is refused, because a filled brief wastes a proposal. An OPPORTUNITY is
 * never refused for age, because a pain posted fourteen months ago AND again last week is the
 * strongest signal there is — it RECURS. Applying the lead rule to market evidence is exactly the
 * mistake that once made a hunt file its findings as prose with dates contradicting its own claims.
 */

const diagnosticsModule = require('../diagnostics');

module.exports = {
  /** A freelance brief worth bidding on. Old briefs are filled briefs. */
  async save_gig(ctx, a) {
    const posted = a.postedAt ? Date.parse(a.postedAt) : NaN;
    const ageDays = Number.isFinite(posted) ? (Date.now() - posted) / 86400000 : null;
    if (ageDays !== null && ageDays > 30) {
      ctx.step('blocked', `skipped "${String(a.title || '').slice(0, 60)}" — posted ${Math.round(ageDays)} days ago; that brief is filled by now`);
      ctx.observe(`Not saved: that brief is ${Math.round(ageDays)} days old — someone else already has it. Sort by newest and stay there.`);
      return;
    }
    const gig = ctx.addGig({
      title: String(a.title || '').slice(0, 250),
      url: String(a.url || '').slice(0, 500),
      platform: String(a.platform || ctx.site || '').slice(0, 40),
      budget: String(a.budget || 'not stated').slice(0, 120),
      deadline: String(a.deadline || '').slice(0, 120),
      brief: String(a.brief || '').slice(0, 4000),
      fit: String(a.fit || '').slice(0, 800),
      client: String(a.client || '').slice(0, 200),
      postedAt: a.postedAt || null,
    });
    if (gig) ctx.step('gig', `${gig.title} · ${gig.budget}`, { url: gig.url });
    ctx.observe(gig
      ? `Saved gig "${gig.title}". ${ctx.counts().gigs} gig(s) so far. Back to the list — next brief.`
      : 'Already saved — that brief is recorded. Move to the next one.');
  },

  /**
   * One day's numbers off an analytics page. Deduped per day in the store, so re-reading the same
   * page never doubles a day. Numbers only: a page showing nothing yields no call, never a guess.
   */
  async save_reach(ctx, a) {
    const row = ctx.addReach({
      day: String(a.day || '').slice(0, 10),
      impressions: Math.max(0, Math.round(Number(a.impressions) || 0)),
      clicks: Math.max(0, Math.round(Number(a.clicks) || 0)),
      note: String(a.note || '').slice(0, 200),
    });
    if (row) ctx.step('reach', `${row.day}: ${row.impressions} impressions · ${row.clicks} clicks${row.note ? ' (' + row.note + ')' : ''}`);
    ctx.observe(row
      ? `Recorded ${row.day}. Continue with the next day the page shows, or finish.`
      : 'That day was already recorded — move on.');
  },

  /**
   * One keyword off a Google keyword tool, STRUCTURED — deduped per term so re-reading never doubles.
   * The research that shapes the pages that get indexed: only what a tool showed, never a guess.
   */
  async save_keywords(ctx, a) {
    const row = ctx.addKeywords({
      keyword: String(a.keyword || '').slice(0, 200),
      volume: String(a.volume || '').slice(0, 60),
      competition: String(a.competition || '').slice(0, 60),
      intent: String(a.intent || '').slice(0, 120),
      note: String(a.note || '').slice(0, 200),
    });
    if (row) ctx.step('keyword', `${row.keyword}${row.volume ? ' · ' + row.volume : ''}${row.intent ? ' · ' + row.intent : ''}`);
    ctx.observe(row
      ? `Recorded "${row.keyword}". Continue with the next term the tool shows, or finish.`
      : 'That keyword was already recorded — move on.');
  },

  /**
   * One row off the Search Console Performance page — a term the app already ranks for, measured.
   * Deduped per term so re-reading never doubles. Only what the table shows, never a guess.
   */
  async save_search(ctx, a) {
    const row = ctx.addSearch({
      query: String(a.query || '').slice(0, 300),
      impressions: Math.max(0, Math.round(Number(a.impressions) || 0)),
      clicks: Math.max(0, Math.round(Number(a.clicks) || 0)),
      position: Math.round((Number(a.position) || 0) * 10) / 10,
    });
    if (row) ctx.step('search', `${row.query}: ${row.impressions} impr · ${row.clicks} clicks · pos ${row.position}`);
    ctx.observe(row
      ? `Recorded "${row.query}". Continue with the next row the Performance table shows, or finish.`
      : 'That term was already recorded — move on.');
  },

  /**
   * ONE THING SEEN IN SEARCH CONSOLE THAT IS NOT A NUMBER.
   *
   * Performance is the only tab the old reader knew, and on a property that went live yesterday it
   * reports nought clicks and one impression — true, and useless. The actionable half of that console
   * is elsewhere: an unread message from Google, how many pages it has indexed and the reasons it
   * refused the rest, whether the sitemap was fetched, and whether a manual action exists — which
   * would make every number on the Performance page irrelevant.
   *
   * Recorded one at a time so a walk that is stopped halfway still delivers what it read.
   */
  async save_gsc_health(ctx, a) {
    const r = ctx.addGscHealth({ kind: a.kind, label: a.label, value: a.value, detail: a.detail });
    if (r) ctx.step('note', `Search Console — ${r.kind}: ${r.label}${r.value ? ` = ${r.value}` : ''}`);
    ctx.observe(r
      ? `Recorded (${r.kind}). Carry on with the next tab the goal lists; do not re-read this one.`
      : 'Nothing recorded — either it had no kind, or that exact finding is already down. Move to the next tab.');
  },

  /**
   * The Search Console verification token, copied exactly off Google's HTML-tag screen. The master
   * plants it into the app's env and redeploys, then a verify walk confirms ownership.
   */
  async save_gsc_token(ctx, a) {
    const t = ctx.addGscToken(a.token);
    if (t) ctx.step('note', `Recorded the Search Console verification token (${t.slice(0, 8)}…). Now finish — the platform plants it and verifies.`);
    ctx.observe(t
      ? 'Token recorded. You do NOT need to verify now — finish; the platform plants it into the app and a later step verifies.'
      : 'No token read — make sure you chose the HTML-tag method and copied the whole content value.');
  },

  /**
   * The hunt's product, STRUCTURED — the fix for a run that found real threads and then described
   * them in prose. It had no opportunity tool, reached for save_lead, and was correctly refused by a
   * recency guard built for OUTREACH; the findings then arrived as a story whose recency claims
   * contradicted its own dates.
   *
   * Nothing is rejected for age here. What IS required is the link, so every claim can be checked,
   * and the date is carried through exactly as the page gave it for the master to weigh.
   */
  async save_opportunity(ctx, a) {
    const evidence = (Array.isArray(a.evidence) ? a.evidence : [])
      .filter((e) => e && String(e.url || '').trim())
      .slice(0, 8)
      .map((e) => ({
        url: String(e.url).trim().slice(0, 500),
        title: String(e.title || '').slice(0, 250),
        postedAt: String(e.postedAt || '').slice(0, 40),
        quote: String(e.quote || '').slice(0, 600),
      }));
    if (!evidence.length) {
      ctx.observe('Not saved: an opportunity needs at least one real thread link as evidence. Go back to a thread you actually read and save it with its url and the date the page shows.');
      return;
    }
    const undated = evidence.filter((e) => !e.postedAt).length;
    const row = ctx.addOpportunity({
      name: String(a.name || '').slice(0, 120),
      idea: String(a.idea || '').slice(0, 1200),
      pain: String(a.pain || '').slice(0, 800),
      price_hint: String(a.price_hint || '').slice(0, 120),
      evidence,
    });
    if (row) ctx.step('opportunity', `${row.name} — ${evidence.length} thread(s)${undated ? ', ' + undated + ' undated' : ''}`);
    ctx.observe(row
      ? `Saved "${row.name}" with ${evidence.length} thread(s)${undated ? ` — ${undated} had no date; add the page's date if you can see it` : ''}. Keep mining, or finish when you have the strongest few.`
      : 'That opportunity was already saved — look for a different pain, or finish.');
  },

  /*
   * THE SIGNAL THAT WAS THERE ALL ALONG. QA reported "0 things to click" fifty times on an app whose
   * console said `GET /api/… 401 (Unauthorized)` and whose address bar was bouncing between / and
   * /login faster than a form could be filled in. It had no way to perceive either, so it could not
   * describe the bug — and the fixer it fed spent 1.37M tokens on the wrong layer.
   *
   * This tool is in QA's list ONLY. These buffers hold whatever a page logs, which on a site the
   * owner is signed into can include tokens, ids and personal data. QA drives our OWN freshly built
   * apps, where that risk does not exist and the signal is the entire point.
   */
  async diagnostics(ctx) {
    const d = diagnosticsModule.dump(ctx.session());
    const firstLine = String(d.summary || '').split('\n')[0].slice(0, 160);
    ctx.step('read', 'diagnostics: ' + firstLine);
    const parts = ['WHAT THE BROWSER SAW:', d.summary];
    /* A loop makes every other observation meaningless — nothing renders and nothing is clickable —
       so it is named as THE failure rather than left for the agent to infer from symptoms. */
    if (d.loop) {
      parts.push('', 'Because the page is looping, look/click/type CANNOT work — report THIS as the failure and stop retrying.');
    }
    if (d.network.length) {
      parts.push('', 'Recent failed requests:', ...d.network.map((n) => `  ${n.at}  ${n.status}  ${n.url}`));
    }
    if (d.navigations.length) {
      parts.push('', 'Where the page went:', ...d.navigations.map((n) => `  ${n.at}  ${n.url}`));
    }
    ctx.observe(parts.join('\n'));
  },

  /** Thinking out loud. It costs a step and buys a readable trail, which is usually worth it. */
  async note(ctx, a) {
    ctx.step('think', String(a.text || ''));
    ctx.observe('Noted. Carry on.');
  },

  /** Not an ending: it stops working and waits, holding everything it has read. */
  async finish(ctx, a) {
    ctx.finish(String(a.summary || 'finished'));
  },
};
