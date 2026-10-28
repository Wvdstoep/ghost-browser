'use strict';
const text = (v, max = 1800) => String(v || '').slice(0, max);
function captureStatus(capture) {
  if (!capture) return null;
  if (capture.saved === true) return { label: capture.ready ? 'Recording saved · ready for reuse' : 'Recording saved · needs verification',
    text: [text(capture.recording, 400), text(capture.reason)].filter(Boolean).join('\n') };
  if (capture.state === 'failed') return { label: 'Recording not saved', text: text(capture.reason) };
  return null;
}
function executionStatus(job) {
  if (!job) return null;
  const e = job.data?.execution || job.execution;
  const c = job.data?.capture || job.capture;
  const saved = captureStatus(c);
  if (!e?.mode) return saved;
  let label;
  switch (e.mode) {
    case 'Replaying saved routine': label = 'Replaying saved routine…'; break;
    case 'Replaying recorded request': label = 'Replaying recorded request…'; break;
    case 'Recording browser routine': label = 'Recording browser routine…'; break;
    case 'Saved routine reused': label = e.verified === true ? 'Replay succeeded · saved routine' : 'Replay not verified'; break;
    case 'Recorded request replay': label = e.verified === true ? 'Replay succeeded · recorded request' : 'Replay not verified'; break;
    case 'Routine captured': label = saved?.label || 'Browser routine finished · recording not confirmed'; break;
    case 'Browser routine completed': label = saved?.label || 'Browser routine completed'; break;
    case 'Browser walk': label = saved?.label || (c?.state === 'recording' ? 'Recording browser walk…' : 'Browser walk'); break;
    case 'Replay fallback': label = 'Replay fallback · inspecting browser'; break;
    case 'Login required': label = 'Login required · job paused'; break;
    case 'Routine blocked': label = 'Browser routine blocked'; break;
    case 'Routine failed': label = 'Browser routine failed'; break;
    default: label = text(e.mode, 120);
  }
  return { label, text: [text(e.input, 400), text(e.reason), e.recording ? 'Recording: ' + text(e.recording, 400) : '',
    e.verified === true ? 'Outcome verified against the current page.' : '', saved?.text || ''].filter(Boolean).join('\n') };
}
module.exports = { executionStatus, captureStatus };
