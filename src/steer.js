/*
 * steer.js — POINTING THE TEACHER AT THE TOOLS THE SET IS SHORT OF.
 *
 * The collector writes prompts that ask for a hover, a tab switch, a dropdown - and the teacher
 * solves them with open, click and read instead, because those always work and it has no reason
 * to prefer the rarer tool. After two and a half thousand runs seven tools had no example at all.
 * Asking harder in the prompt does not help, and naming the tool in the GOAL would leak the answer
 * into the training example (a goal that says "use hover" teaches nothing but reading goals).
 *
 * So the steer goes where only the teacher reads it: its system message, beside the playbook. The
 * student's prompt is built by localPrompt.js from the goal and the role and never sees this line.
 * Only tools the walk's role actually has are named - a hint toward a refused tool is a wasted
 * step and a confused model.
 */
'use strict';

/** The sentence, or nothing. `allowed` is the role's tool set; a hint outside it is dropped. */
function steerFor(tools = [], allowed = null) {
  const names = [...new Set((tools || []).map((t) => String(t || '').trim()).filter(Boolean))]
    .filter((t) => !allowed || (allowed instanceof Set ? allowed.has(t) : Array.isArray(allowed) ? allowed.includes(t) : true))
    .slice(0, 4);
  if (!names.length) return '';
  return [
    'FOR THIS WALK',
    `Where the page allows it, use ${names.length === 1 ? 'this tool' : 'these tools'} at least once: ${names.join(', ')}.`,
    'They are what this walk exists to practise; prefer them over click, open or read when either would do the job.',
    'Never invent a reason to use one - a tool that does not fit the page is skipped, not forced.',
  ].join('\n');
}

/** The tool names out of the collector's aim lines ("hover (0)"). */
function toolsOfAim(aiming = []) {
  return (aiming || []).map((x) => String(x || '').split(' ')[0].trim()).filter(Boolean);
}

module.exports = { steerFor, toolsOfAim };
