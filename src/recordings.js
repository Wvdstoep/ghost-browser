/**
 * recordings.js — a finished PLATFORM recording, shaped so a page can be given it.
 *
 * WHY THIS IS ITS OWN FILE. It started life inside tools/files.js, which was wrong in a way the
 * tools registry test caught immediately: the exports of a tools module ARE the list of tools the
 * agent may call. A helper exported there becomes a tool named "recordingAsset", and a constant
 * becomes a "tool" that cannot even be run. So the capability lives here, and files.js requires it.
 *
 * WHY IT EXISTS AT ALL. start_recording/stop_recording put their clip in the fileAssets store, which
 * is what upload_file reads. The recorder the PLATFORM spawns writes somewhere else entirely —
 * /recordings/<id>/final.mp4, on its own volume — so a recording the owner could see in the console
 * (a 4-minute, 122 MB one) had no route into an editor at all. That was never a prompting problem:
 * there was no tool that could reach the bytes.
 */
const fs = require('fs');
const path = require('path');

/* Where the platform's recorder puts a finished recording. Its own volume, not the profile one. */
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/recordings';

/**
 * A finished recording as a file-asset-shaped object, or null.
 *
 * Null in three cases that all matter: the recording does not exist, it has not finished encoding
 * (the directory is there and final.mp4 is not), or the encode produced an empty file. Handing half
 * a video to an editor is worse than saying there is nothing to hand over.
 */
function recordingAsset(recordingId) {
  const id = String(recordingId || '').trim();
  if (!id || /[/\\]/.test(id) || id.includes('..')) return null;    // an id, never a path
  const file = path.join(RECORDINGS_DIR, id, 'final.mp4');
  let bytes = null;
  try { bytes = fs.readFileSync(file); } catch { return null; }
  if (!bytes || !bytes.length) return null;
  let name = id + '.mp4';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, id, 'recording.json'), 'utf8'));
    const t = String(meta.title || meta.name || '').trim();
    if (t) name = t.replace(/[^\w .-]+/g, '_').slice(0, 60) + '.mp4';
  } catch { /* a recording without readable metadata is still a recording */ }
  return { id, bytes, mime: 'video/mp4', name, kind: 'clip', source: 'recording' };
}

module.exports = { recordingAsset, RECORDINGS_DIR };
