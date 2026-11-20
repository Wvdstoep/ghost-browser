'use strict';
/*
 * ONE THING, LISTED ONCE (2026-11-20). On Facebook browser_analyze listed one comment three or four times:
 * the comment's box, the box inside it, the link inside that, all with the same text. That costs tokens on
 * every page and makes the model guess which number is the real one. Elements with the same text whose
 * boxes sit inside one another are one thing: the one that takes clicks (a link, a button, a field) is
 * kept, else the innermost. Numbers never change: the kept elements keep their own index, so a click by
 * number means what it meant, and the full list stays with the session for that.
 */

const CLICKABLE_TAGS = /^(a|button|input|select|textarea|summary|label)$/i;
const CLICKABLE_ROLES = /^(button|link|menuitem|menuitemradio|menuitemcheckbox|tab|option|checkbox|radio|switch|combobox|textbox)$/i;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const textOf = (e) => norm(e.text || e.label || e.ariaLabel || '');
const hasBox = (e) => [e.left, e.top, e.width, e.height].every((v) => Number.isFinite(Number(v))) && e.width > 0 && e.height > 0;
const inside = (a, b, slack = 3) => a.left >= b.left - slack && a.top >= b.top - slack
  && a.left + a.width <= b.left + b.width + slack && a.top + a.height <= b.top + b.height + slack;
const clickable = (e) => !!(e.editable || CLICKABLE_TAGS.test(e.tag || '') || CLICKABLE_ROLES.test(e.role || ''));
/* A field, something ticked or holding a value is never folded into something else. */
const own = (e) => !!(e.editable || e.value || e.on || e.checked || /^(input|select|textarea)$/i.test(e.tag || ''));
const area = (e) => (hasBox(e) ? e.width * e.height : Infinity);

/* Which of two repeats stays: the clickable one, then the smaller box, then the earlier number. */
function better(a, b) {
  if (clickable(a) !== clickable(b)) return clickable(a) ? a : b;
  if (area(a) !== area(b)) return area(a) < area(b) ? a : b;
  return a.index <= b.index ? a : b;
}

/**
 * @param {Array<{index:number,text?:string,tag?:string,role?:string,href?:string,left?:number,top?:number,width?:number,height?:number}>} elements
 * @returns {{ kept: object[], merged: number[] }} merged = the indexes folded into a kept one
 */
function collapseRepeats(elements) {
  const list = Array.isArray(elements) ? elements : [];
  const groups = new Map();
  for (const e of list) {
    const t = textOf(e);
    if (t.length < 3 || own(e)) continue;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(e);
  }
  const drop = new Set();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // Repeats: boxes inside one another; without boxes (the page list), neighbours in the list.
    const alive = g.slice();
    for (let i = 0; i < alive.length; i += 1) {
      for (let j = i + 1; j < alive.length; j += 1) {
        const a = alive[i]; const b = alive[j];
        if (!a || !b || drop.has(a.index) || drop.has(b.index)) continue;
        if (a.href && b.href && a.href !== b.href) continue;   // two links that go to two places
        const same = hasBox(a) && hasBox(b) ? (inside(a, b) || inside(b, a)) : (!hasBox(a) && !hasBox(b) && Math.abs(a.index - b.index) === 1);
        if (!same) continue;
        const keep = better(a, b);
        drop.add(keep === a ? b.index : a.index);
      }
    }
  }
  return { kept: list.filter((e) => !drop.has(e.index)), merged: [...drop].sort((x, y) => x - y) };
}

/** A summary of "[n] …" lines without the lines of merged elements (other lines, a heading, stay). */
function dropSummaryLines(summary, merged) {
  if (!merged.length) return summary;
  const gone = new Set(merged.map(String));
  return String(summary || '').split('\n').filter((l) => { const m = /^\[(\d+)\]/.exec(l); return !m || !gone.has(m[1]); }).join('\n');
}

module.exports = { collapseRepeats, dropSummaryLines };
