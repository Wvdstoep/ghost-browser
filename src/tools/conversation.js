'use strict';
/**
 * tools/conversation.js — who we are talking to, and what was said.
 *
 * The pipeline lives in LeadFlow, not here. This browser is good at one thing no API is — reading
 * what people actually wrote on sites its owner is signed into — and deliberately bad at everything
 * after that: scoring, remembering who was contacted on Tuesday, deciding what a reply means. These
 * four tools are the window into that pipeline, and every one of them degrades the same way when the
 * far end is absent: it says so plainly rather than guessing, because an agent that invents a lead
 * list is worse than one that admits it has none.
 *
 * NOTE THE ONE ASYMMETRY. `record_reply` reports back what LeadFlow's own classifier decided rather
 * than judging the reply itself — the same classifier its email replies go through. An agent that
 * formed its own opinion here would sooner or later disagree with the pipeline about the same
 * person, and then nobody could say which one was right.
 */

const NOT_CONNECTED = 'Not connected to LeadFlow.';

module.exports = {
  /** Everyone we are waiting to hear back from, with what we said to them. */
  async waiting_on(ctx) {
    const convo = ctx.convo;
    if (!convo) { ctx.observe('This run is not connected to LeadFlow, so there is no list of who you are waiting on.'); return; }
    const r = await convo.awaiting();
    const list = r.leads || [];
    ctx.step('note', `${list.length} conversation(s) waiting on a reply`);
    ctx.observe(list.length
      ? `Waiting on a reply from:\n${list.map((l) =>
          `- [${l.id}] ${l.name}${l.groupName ? ` (in ${l.groupName})` : ''}\n`
          + `    their post: ${String(l.postText || '').slice(0, 200)}\n`
          + `    post link: ${l.postUrl || '(none)'}\n`
          + `    you said: ${l.said ? `"${String(l.said.text).slice(0, 200)}"` : '(nothing recorded)'}`
        ).join('\n')}\n\nMatch these names against the notifications page. Only open the ones that appear.`
      : 'Nobody is waiting on a reply. Nothing to check.');
  },

  /** Is this person one of ours? Answered from the pipeline, never from memory. */
  async whose_is_this(ctx, a) {
    const convo = ctx.convo;
    if (!convo) { ctx.observe(NOT_CONNECTED); return; }
    const r = await convo.match({ name: a.name, url: a.url, profileUrl: a.profileUrl });
    if (!r.lead) { ctx.observe('That is not one of your leads. Ignore it and move on.'); return; }
    ctx.step('note', `that is lead [${r.lead.id}] ${r.lead.name}`);
    ctx.observe(`Lead [${r.lead.id}] ${r.lead.name}, stage "${r.lead.stage}".\n`
      + `Their post: ${String(r.lead.postText || '').slice(0, 300)}\n`
      + `So far:\n${(r.recent || []).map((t) => `  ${t.direction === 'out' ? 'you' : 'them'}: ${String(t.text || '').slice(0, 200)}`).join('\n') || '  (nothing yet)'}`);
  },

  /** They answered. Record their words as they wrote them and let the pipeline judge. */
  async record_reply(ctx, a) {
    const convo = ctx.convo;
    if (!convo) { ctx.observe('Not connected to LeadFlow — nowhere to record that.'); return; }
    const r = await convo.touch({
      leadId: a.leadId, direction: 'in', channel: a.channel || 'reply',
      text: String(a.text || ''), url: a.url || null, platform: 'facebook',
    });
    ctx.step('lead', `reply from lead [${a.leadId}] — now "${r.stage}"${r.category ? ` (${r.category})` : ''}`);
    /* The category comes from LeadFlow's own classifier, the same one its email replies go through —
       so the agent is told what the pipeline decided rather than deciding it itself and disagreeing. */
    ctx.observe(`Recorded. They are now at stage "${r.stage}"`
      + (r.category ? `, read as "${r.category}"` : '')
      + (r.category === 'wants_call' ? ' — that is a prospect. Tell the owner rather than answering it yourself.' : '')
      + '.');
  },

  /** Everything said to and by one lead, so a reply can refer to what actually happened. */
  async conversation(ctx, a) {
    const convo = ctx.convo;
    if (!convo) { ctx.observe(NOT_CONNECTED); return; }
    const r = await convo.conversation(a.leadId);
    ctx.observe(`With ${r.lead.name} (stage "${r.lead.stage}"):\n`
      + (r.touches || []).map((t) => `  ${t.direction === 'out' ? 'you' : 'them'} [${t.channel}]: ${String(t.text || '').slice(0, 300)}`).join('\n'));
  },
};
