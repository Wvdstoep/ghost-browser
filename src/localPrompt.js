/*
 * localPrompt.js — THE PROMPT THE SMALL MODEL SEES, WRITTEN ONCE.
 *
 * This is the single most load-bearing file in the fine-tune, because of a failure that does not
 * announce itself: if the prompt used to BUILD the training set differs from the prompt used to
 * SERVE the model, every measurement flatters and the live model underperforms its own evaluation
 * for reasons nobody can find. The first set built for this pipeline had a hundred-character system
 * prompt with no tool catalogue in it at all, while the live agent sends the full catalogue. A
 * model trained that way has to memorise the tool list in its weights, and then meets a prompt at
 * serving that it never saw in training.
 *
 * So: one function, called from both sides. Changing the prompt means rebuilding the set, and that
 * is the correct and visible consequence.
 *
 * WHY THE CATALOGUE IS IN THE PROMPT AND NOT IN THE WEIGHTS.
 * Tools get added to Ghost Browser regularly. If the tool list lives in the weights, every new tool
 * needs a training round before it can ever be chosen. In the prompt, a tool added this afternoon is
 * available this afternoon, and the fine-tune is left to carry the thing it is actually good at:
 * WHICH tool, and WHEN.
 *
 * WHY THE ENTRIES ARE SHORT.
 * The live catalogue's descriptions are paragraphs — deliberately, because the cloud model reads
 * them once per call and they are worth the tokens there. Here they are paid on every training
 * example, and the prompt length sets the training time directly: the full text roughly triples the
 * prompt and therefore the hours. The behaviour is learnt from the examples, not from the prose;
 * what the catalogue must still do is let an UNSEEN tool be chosen sensibly, and a name, its
 * arguments and one clipped line of purpose are enough for that.
 */
'use strict';

/** How much of a tool's description survives. One clause: enough to tell an unseen tool apart. */
const PURPOSE = 90;

/** First sentence or clause, tidied — descriptions open with what the tool is for. */
function purposeOf(desc) {
  const s = String(desc || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  /* A short description that is already one sentence is the summary — return it whole. Missing this
     case cost every brief tool its last word: "Go to a web address." has no whitespace after its
     full stop, so the sentence search failed, and the word-boundary trim below then chopped a
     string it had never truncated, leaving "Go to a web". */
  if (s.length <= PURPOSE) return s.replace(/\.$/, '');

  /* Cut at the first sentence end, but only if one arrives early enough to be a summary rather than
     the whole paragraph. Otherwise clip, then drop the word the clip cut in half. */
  const stop = s.search(/[.:—]\s/);
  if (stop > 0 && stop <= PURPOSE) return s.slice(0, stop).trim();
  return s.slice(0, PURPOSE).replace(/\s+\S*$/, '').trim();
}

/** `click(index, why?)` — required arguments bare, optional ones marked. */
function signatureOf(fn) {
  const params = (fn && fn.parameters) || {};
  const props = params.properties || {};
  const required = new Set(params.required || []);
  const names = Object.keys(props);
  if (!names.length) return `${fn.name}()`;
  /* Required first, so the shape the model must produce reads left to right. */
  const ordered = [...names.filter((n) => required.has(n)), ...names.filter((n) => !required.has(n))];
  return `${fn.name}(${ordered.map((n) => (required.has(n) ? n : `${n}?`)).join(', ')})`;
}

/**
 * The catalogue as the model sees it.
 *
 * Duplicate names are collapsed keeping the LAST declaration, because that is what the live agent
 * does: the handlers are merged with Object.assign and the later one wins. A catalogue that lists a
 * tool whose described behaviour is not the behaviour that runs is worse than a shorter catalogue —
 * it is exactly the defect that made an entire tool dead code for months.
 */
function catalogue(tools) {
  const byName = new Map();
  for (const t of tools || []) {
    const fn = t && (t.function || t);
    if (!fn || !fn.name) continue;
    byName.set(fn.name, fn);
  }
  return [...byName.values()]
    .map((fn) => {
      const p = purposeOf(fn.description);
      return p ? `${signatureOf(fn)} — ${p}` : signatureOf(fn);
    })
    .join('\n');
}

/**
 * The system message: who the model is, what it may call, and the shape of the answer.
 *
 * The playbook text for the role goes here too rather than into the adapter. Playbooks are edited by
 * hand and change between rounds; behaviour that lives in the prompt can be corrected this
 * afternoon, while behaviour baked into an adapter waits for a night of training.
 */
function systemFor({ role = 'general', site = '', tools = [], playbook = '' } = {}) {
  const who = `You are Ghost Browser working as ${role}${site ? ` in the ${site} profile` : ''}.`;
  const lines = [
    who,
    '',
    'You act inside a real browser that is already signed in. You see a page by calling look, which',
    'numbers everything clickable; you act by those numbers, and they are only valid until the page',
    'changes. When you are not sure what is on screen, look again.',
    '',
    'TOOLS',
    catalogue(tools),
    '',
    'Answer with exactly one JSON object and nothing else:',
    '{"tool":"<name>","args":{...}}',
  ];
  if (playbook) lines.push('', 'FOR THIS ROLE', String(playbook).trim());
  return lines.join('\n');
}

/**
 * The user message: the goal, and what has actually been seen.
 *
 * The numbered list from the most recent look is included in full when it is there — it is the only
 * thing that makes an index-bearing call learnable rather than a guess. Earlier looks are reduced to
 * their one-line summary, because stale numbers are not merely useless, they are the stale-index
 * mistake written into the training data.
 */
function userFor({ goal = '', observed = [] } = {}) {
  const rows = observed || [];
  const lastMarksAt = (() => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i] && rows[i].marks) return i;
    return -1;
  })();

  /*
   * The page itself, on the most recent observation that has one - the same rule as the marks
   * and for the same reason: the latest state is what the decision is about, and a stale page
   * beside a fresh one is worse than none. Marks win where both exist; they are the page for a
   * click, and a look step records only marks.
   */
  const lastContentAt = (() => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i] && rows[i].content) return i;
    return -1;
  })();
  const seen = rows.map((o, i) => {
    if (i === lastMarksAt) return `- ${o.kind}: ${o.text}\n${o.marks}`;
    if (i === lastContentAt && i > lastMarksAt) return `- ${o.kind}: ${o.text}\n${o.content}`;
    return `- ${o.kind}: ${o.text}`;
  });

  return `GOAL: ${goal}\n\nSEEN SO FAR:\n${seen.join('\n') || '- nothing yet'}`;
}

module.exports = { systemFor, userFor, catalogue, signatureOf, purposeOf, PURPOSE };
