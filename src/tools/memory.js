'use strict';
/**
 * tools/memory.js — what the agent learns about the person it acts for.
 *
 * Everything it writes goes out under a real name, so it has to know how that person actually
 * writes: their trade, their turns of phrase, the length of their sentences. These three tools are
 * how it records that, and they are grouped because they share one store (`me`) and one job — a
 * reply that reads more polished than the owner's own writing is as wrong as one that reads worse.
 */

const me = require('../me');

module.exports = {
  /** One fact about the owner: their trade, their city, whatever it just learned. */
  async remember_about_me(ctx, a) {
    me.remember(a.label, a.value, a.source);
    ctx.step('learned', `${a.label}: ${String(a.value).slice(0, 200)}`);
    ctx.observe('Written down.');
  },

  /** A real sentence they wrote, kept as a sample of their voice. */
  async save_my_writing(ctx, a) {
    const sample = me.addSample(a.text, a.where);
    if (sample) ctx.step('learned', `kept something they wrote: "${sample.text.slice(0, 160)}"`);
    /* Saying WHY it was refused matters: "too short or already saved" sends the agent to find a
       different sample, while a bare "no" sends it to try the same one again. */
    ctx.observe(sample
      ? `Kept it (${me.summary().sampleCount} samples now).`
      : 'Too short or already saved — find a different one.');
  },

  /** The description of how they write, in the agent's own words. */
  async describe_my_voice(ctx, a) {
    me.setStyle(a.style);
    ctx.step('learned', `how they write: ${String(a.style).slice(0, 300)}`);
    ctx.observe('Saved as how they write.');
  },
};
