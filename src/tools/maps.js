'use strict';
const { searchPlaces, canReuseMapsCard } = require('../sites/maps');
module.exports = {
  async maps_search(ctx, args) {
    const reused = canReuseMapsCard(ctx.cardStore?.get('https://www.google.com', 'routine.google.maps.search.v1'));
    ctx.storeData('execution', { mode: reused ? 'Replaying saved routine' : 'Recording browser routine', reason: 'Maps reads current results with fresh inputs; no LLM is used for individual browser steps.', verified: false });
    const started = Date.now();
    let result;
    try { result = await searchPlaces(ctx.page(), args, { store: ctx.cardStore }); }
    catch (error) {
      ctx.storeData('execution', { mode: 'Routine failed', reason: String(error.message || error), verified: false, durationMs: Date.now() - started });
      throw error;
    }
    ctx.storeData('execution', { mode: result.kind === 'login_required' ? 'Login required' : result.kind !== 'success' ? 'Routine blocked' : result.mode === 'replay' ? 'Saved routine reused' : result.recordingSaved ? 'Routine captured' : 'Browser routine completed',
      recording: 'https://www.google.com | routine.google.maps.search.v1', reason: result.reason || (result.kind !== 'success' ? 'Browser stopped: ' + result.kind + '. Inspect the browser before continuing.' : result.complete ? 'Fresh category and city verified; requested lead count reached.' : 'Partial results; requested lead count not reached.'), verified: result.kind === 'success', count: result.leads.length, durationMs: Date.now() - started,
      input: result.input.business + ' in ' + result.input.city });
    ctx.storeData('mapsSearch', result);
    if (result.mode === 'record' && result.kind === 'success') ctx.storeData('capture', {
      recording: 'https://www.google.com | routine.google.maps.search.v1', saved: !!result.recordingSaved, ready: !!result.recordingSaved,
      state: result.recordingSaved ? 'saved' : 'failed', reason: result.recordingSaved ? 'Built-in Maps routine saved with fresh input slots.' : 'Recording storage failed; no recording was saved.' });
    if (result.kind === 'login_required') {
      ctx.stopForLogin('Google Maps needs you to sign in. Sign in in this browser, then run the task again.');
      return;
    }
    for (const row of result.leads) {
      const lead = ctx.addLead(row);
      if (lead && ctx.sink) {
        try { await ctx.sink.send(lead); } catch { ctx.step('error', 'Lead retained locally; the lead destination did not accept it.'); }
      }
    }
    ctx.step('read', 'Maps ' + (result.kind !== 'success' ? 'blocked' : result.mode === 'replay' ? 'SAVED ROUTINE REUSED (built-in adapter)' : 'ROUTINE CAPTURED (built-in adapter)') + ': ' + result.leads.length + ' verified place(s) for ' + result.input.business + ' in ' + result.input.city);
    ctx.observe(JSON.stringify(result) + '\nThese are fresh results for this request. Do not invent missing contacts or treat partial results as complete. Inspect blockers or rejected categories before continuing.');
  },
};
