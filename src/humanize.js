/**
 * MAKE A DRAFT READ LIKE A PERSON TYPED IT.
 *
 * Model-written replies carry tells the owner spots at once and readers in a vibe-coding group spot
 * even faster: the "That's a solid workflow —" opener, em dashes as the universal joint, semicolons.
 * Strip them on the way onto the feed so what the owner sees (and posts) starts human. This is not a
 * rewrite — it removes the tells and leaves the words; lowercase starts are left alone on purpose,
 * that is how the owner actually types.
 */
const OPENER = /^(?:(?:that|this|it)(?:'s| is)|what)\s+(?:a|an)?\s*(?:really |very |super |pretty )?(?:solid|great|good|nice|smart|fair|excellent|strong|interesting|valid|important|thoughtful|key|crucial|legit)\s+[^,.!?;:—–-]{0,40}[,.!;:—–-]+\s*/i;
const OPENER2 = /^(?:absolutely|totally|exactly|love (?:this|that)|great (?:question|point|call)|good (?:question|point|call)|100%|spot on)[,.!;:—–-]+\s*/i;

function humanize(text) {
  let s = String(text || '').replace(/\r/g, '');
  s = s.replace(OPENER, '').replace(OPENER2, '');
  s = s.replace(/\s*[—–]\s*/g, ', ');                 // em / en dash → a comma, the way people type
  s = s.replace(/\s*;\s*/g, '. ');                    // semicolon → full stop
  s = s.replace(/,\s*,/g, ',').replace(/\.\s*\./g, '.').replace(/,\s*\./g, '.').replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/^[,.\s]+/, '');                      // never start on the punctuation an opener left behind
  return s.trim();
}

module.exports = humanize;
