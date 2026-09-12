'use strict';
/**
 * tools/ — one module per tool, instead of one function per everything.
 *
 * WHAT THIS IS UNDOING. `run()` in agent.js grew to 970 lines — 62% of the file — around a 28-case
 * switch with every tool's body inlined. Each addition was reasonable on its own; together they made
 * one function nobody can hold in their head, where the step budget, the write guard, the approval
 * gate, the loop breaker and the bodies of all 28 tools are interleaved. Every feature still to come
 * lands in that switch: authored roles change the tool set, schedules change the approval path,
 * evidence capture hooks the act and error paths. Splitting it is cheap now and compounds later.
 *
 * WHAT STAYS IN THE LOOP, deliberately: the guards. `looksLikeWrite`, the own-origin check, the
 * approval gate and the step budget are POLICY — they decide whether a tool may run at all — and
 * policy that lives next to the thing it governs is policy that can be edited away by accident.
 * A tool here does its job and trusts that it was allowed to.
 *
 * THE SEAM. A tool is `async (ctx, args) => void`, and the loop consults this registry FIRST,
 * falling through to the remaining switch for anything not yet moved. That is what makes the split
 * incremental and verifiable: every group can be extracted, tested and shipped on its own, instead
 * of one 636-line rewrite that is either entirely right or silently wrong.
 */

const memory = require('./memory');
const profiles = require('./profiles');
const conversation = require('./conversation');
const records = require('./records');
const navigate = require('./navigate');
const perceive = require('./perceive');
const images = require('./images');
const files = require('./files');
const record = require('./record');
const knowledge = require('./knowledge');
const craft = require('./craft');

/** name → handler. Anything absent is still handled by the switch in agent.js. */
const REGISTRY = Object.assign({}, memory, profiles, conversation, records, navigate, perceive, images, files, record, knowledge, craft);

/** Is this tool one of the extracted ones? */
const has = (name) => Object.prototype.hasOwnProperty.call(REGISTRY, name);

/** Run it. The caller has already journalled the call and applied every guard. */
const run = (name, ctx, args) => REGISTRY[name](ctx, args);

module.exports = { REGISTRY, has, run };
