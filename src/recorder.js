'use strict';
/**
 * recorder.js — the RECORD half of route cards, wired to a live session's traffic.
 *
 * A recorder is armed with the INTENT a walk is about to accomplish; it then collects the page's own
 * write-requests (via the pool's request hook) until the walk finishes, and hands them to distill().
 * Nothing new is sent — it is a passive listener on requests Chromium already makes — so recording is
 * free and cannot change what the browser does. It captures the request SHAPE only (method, url,
 * header names, body keys); routecards.shapeOf() is what strips values, so even the buffer here never
 * needs a raw token, and the cap bounds memory on a chatty page.
 *
 * One recorder per session, off by default: it captures only while an intent is armed, so an ordinary
 * research or reach run records nothing. Herald's setup/operate walks arm it; everything else ignores it.
 */

const routecards = require('./routecards');
const readcards = require('./readcards');

const MAX_BUFFER = 300;   // a page fires plenty; the act is near the end, and 300 writes is generous

function makeRecorder({ log = console } = {}) {
  let armed = null;        // { intent, origin, requests: [], sealIndex } while a walk is being recorded
  let dropped = 0;
  let reading = null;      // { intent, origin, reqs: [{method,url,headers,resourceType,status,json}] } while a READ walk is recorded

  return {
    get armed() { return !!armed || !!reading; },
    get armedRead() { return !!reading; },
    get intent() { return armed && armed.intent; },
    /** True once the walk's decisive act has been sealed — proof the act actually happened, which is
        what the agent learns on (a setup walk keeps navigating AFTER the create, so it never reaches a
        clean "idle"; the seal, not the terminal status, is the honest signal that a card is worth keeping). */
    get sealed() { return !!(armed && armed.sealIndex != null); },

    /** Begin recording a walk for one intent. A second arm replaces the first (the walk changed). */
    arm({ intent, origin = '' }) {
      if (!intent) return;
      armed = { intent, origin, requests: [], sealIndex: null };
      dropped = 0;
      log.info?.(`[recorder] armed for ${intent}${origin ? ' @ ' + origin : ''}`);
    },

    /** The pool calls this for every request the page makes. Cheap and total: filter, cap, keep shape. */
    observe(req) {
      if (reading && readcards.isReadCandidate(req) && (!reading.origin || routecards.originOf(req.url) === reading.origin)) {
        if (reading.reqs.length >= MAX_BUFFER) reading.reqs.shift();
        reading.reqs.push({ method: 'GET', url: req.url, headers: req.headers || {}, resourceType: req.resourceType, status: null, json: null });
      }
      if (!armed) return;
      if (!routecards.isLearnable(req)) return;
      if (armed.origin && routecards.originOf(req.url) !== armed.origin) return;
      if (armed.requests.length >= MAX_BUFFER) {
        dropped += 1; armed.requests.shift();                                   // keep the RECENT ones
        if (armed.sealIndex != null && armed.sealIndex > 0) armed.sealIndex -= 1;  // a drop shifts every index down one
      }
      // store only what a card needs; never the header/body VALUES beyond what shapeOf will keep
      armed.requests.push({ method: req.method, url: req.url, headers: req.headers || {}, postData: req.postData });
    },

    /*
     * SEAL THE ACT. Called the instant the agent executes the APPROVED decisive act (the create, the
     * post) — before the walk navigates on. It marks the slot the act's own request will land in, so
     * distill takes THAT request as the card, not the last write of the whole walk. Without this the
     * card is whatever navigation fired last (a search to find the new page's URL), which is exactly
     * the wrong request. The last seal wins: if a walk acts twice, the culmination is the intent.
     */
    seal() { if (armed) armed.sealIndex = armed.requests.length; },

    /** End the walk. Returns a distilled card proposal (or null/failure), and disarms. `now` is injected. */
    finish({ now = 0 } = {}) {
      if (!armed) return null;
      const { intent, origin, requests, sealIndex } = armed;
      if (dropped) log.info?.(`[recorder] ${intent}: buffer capped, dropped ${dropped} early request(s)`);
      armed = null;
      const out = routecards.distill({ intent, origin, requests, now, sealIndex });
      if (!out) { log.info?.(`[recorder] ${intent}: nothing learnable in the walk`); return null; }
      if (!out.ok) { log.info?.(`[recorder] ${intent}: ${out.reason}`); return out; }
      log.info?.(`[recorder] ${intent}: distilled a card (${out.card.method} ${out.card.url.slice(0, 60)})`);
      return out;
    },

    /*
     * READ WALKS. A read walk is recorded with the same passive listener, plus the answers: the
     * pool hands each JSON response to observeResponse, and finishRead matches them against the rows
     * the UI walk read (see readcards.js). Writes are not recorded in this mode and a read walk
     * never fires anything — it only listens to requests the page already made.
     */
    armRead({ intent, origin = '' }) {
      if (!intent) return;
      reading = { intent, origin, reqs: [] };
      log.info?.(`[recorder] armed to READ for ${intent}${origin ? ' @ ' + origin : ''}`);
    },
    observeResponse({ method = 'GET', url, status, body }) {
      if (!reading || !url) return;
      if (typeof body !== 'string' || body.length > readcards.MAX_JSON_BYTES) return;
      for (let i = reading.reqs.length - 1; i >= 0; i--) {
        const r = reading.reqs[i];
        if (r.url === url && r.json == null) {
          try { r.json = JSON.parse(body); r.status = status; } catch { /* not JSON: not a card */ }
          return;
        }
      }
    },
    finishRead({ uiRows, inputs = {}, now = 0 } = {}) {
      if (!reading) return null;
      const { intent, origin, reqs } = reading;
      reading = null;
      const out = readcards.distillRead({ intent, origin, candidates: reqs, uiRows, inputs, now });
      if (!out.ok) log.info?.(`[recorder] ${intent}: ${out.reason}`);
      else log.info?.(`[recorder] ${intent}: distilled a READ card (${out.card.url.slice(0, 70)}, ${Math.round(out.coverage * 100)}% of the UI rows)`);
      return out;
    },

    /** Abandon without distilling — a failed walk should not learn a card from a broken flow. */
    discard() { armed = null; reading = null; dropped = 0; },
  };
}

module.exports = { makeRecorder, MAX_BUFFER };
