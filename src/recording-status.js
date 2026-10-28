'use strict';
const { planFor } = require('./routecards');
function recordingView(card) {
  const routine = card.kind === 'browser-routine';
  const eligible = routine ? card.routine === 'google.maps.search' && card.routineVersion === 1 && !!card.lastVerified && !card.quarantined : planFor(card).mode === 'fast' && !!card.verification;
  return {
    id: card.origin + ' | ' + card.intent, origin: card.origin, intent: card.intent, method: card.method, quarantined: !!card.quarantined,
    kind: routine ? 'Built-in browser routine' : 'Captured request',
    status: card.quarantined ? 'Quarantined' : eligible ? 'Ready for compatible runs' : 'Needs verification',
    reason: routine && !eligible && !card.quarantined ? 'Routine version is unsupported or has no verified capture; use the browser to capture the current contract.' : card.quarantined ? 'A previous attempt failed; browser inspection is required.' : routine ? 'Reuses the Maps adapter with new inputs; this is not a learned click recording.' : !card.verification ? 'No independent outcome verifier is configured.' : planFor(card).reason,
    eligible, confidence: card.confidence || 0, lastVerified: card.lastVerified || 0, lastVerifiedLabel: card.lastVerified ? new Date(card.lastVerified).toISOString() : 'Never',
    uses: card.uses || 0, lastUsed: card.lastUsed || 0, fails: card.fails || 0,
    inputKeys: card.inputKeys || Object.keys(card.slots || {}),
  };
}
module.exports = { recordingView };
