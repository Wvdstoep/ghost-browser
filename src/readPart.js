'use strict';
/*
 * A PAGE IN PARTS, AND WHAT IT HIDES (2026-11-20). A read on Facebook seemed cut off at ~2,250 characters:
 * the page itself held no more, because a long post is folded behind "See more" until it is clicked. The
 * answer says when a site folds text, and a long page comes in parts (offset, maxChars) that say truncated
 * and where the next part starts, instead of one block cut at 200,000.
 */
const FOLDED = /(^|[\s.…])(see more|show more|read more|meer weergeven|meer lezen|lees meer|zobacz więcej|pokaż więcej|czytaj więcej|mehr anzeigen|weiterlesen)(?=\s|$|[.…)])/i;
const DEFAULT_MAX = 60000;

function readPart(body, q = {}) {
  const all = String((body && body.content) || '');
  const offset = Math.max(0, Math.min(all.length, parseInt(q.offset, 10) || 0));
  const max = Math.max(500, Math.min(200000, parseInt(q.maxChars, 10) || DEFAULT_MAX));
  const content = all.slice(offset, offset + max);
  const more = offset + max < all.length;
  return { ...body, chars: all.length, offset, content,
    ...(more ? { truncated: true, nextOffset: offset + max } : {}),
    ...(FOLDED.test(all) ? { folded: true, hint: 'This page folds some text away ("See more" or the like). Click that link (browser_click with its text) and read again for the whole text.' } : {}) };
}

module.exports = { readPart, FOLDED, DEFAULT_MAX };
