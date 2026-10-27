'use strict';
const { searchPlaces } = require('../sites/maps');
module.exports = {
  async maps_search(ctx, args) {
    const result = await searchPlaces(ctx.page(), args, { store: ctx.cardStore });
    ctx.storeData('mapsSearch', result);
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
    ctx.step('read', 'Maps ' + (result.mode || 'search') + ': ' + result.leads.length + ' verified place(s) for ' + result.input.business + ' in ' + result.input.city);
    ctx.observe(JSON.stringify(result) + '\nThese are fresh results for this request. Do not invent missing contacts or treat partial results as complete. Inspect blockers or rejected categories before continuing.');
  },
};
