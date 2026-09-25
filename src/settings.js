/**
 * settings.js — the console's own settings, kept off the platform.
 *
 * One file, on the same volume as the browser profiles, for the same reason they are there: this
 * image is meant to be liftable to anyone's cluster, so nothing it needs may live in the platform's
 * secret store. A restart, a redeploy or a move to another cluster keeps whatever was configured.
 *
 * THE API KEY NEVER COMES BACK OUT. Everything else round-trips to the UI so it can be edited; the
 * key is answered as "set" or "not set" with the last four characters, which is enough to recognise
 * which key it is and useless to anyone reading it over a shoulder.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.PROFILE_DIR || '/profiles', 'settings.json');

const DEFAULTS = {
  /*
   * Ollama's hosted service. Pointing this at a self-hosted Ollama works too — same API — which is
   * why it is a field rather than a constant: the whole design goal here is that the browser and
   * the model it uses are both the owner's choice, not the platform's.
   */
  llmHost: 'https://ollama.com',
  llmModel: 'gpt-oss:120b',
  /* A SECOND account, used only when the first is out of allowance for the period. One key meant
     one weekly limit took the browser, the builder and the master down together. */
  llmKeys: '',
  /* The model WE trained, served beside the teacher. Off until a person turns it on; the
     host is the Ollama sidecar in this pod, the model a tag `ollama create` made. */
  studentHost: 'http://127.0.0.1:11434',
  studentModel: '',
  studentMode: 'off',        // off | shadow | canary | primary
  studentShare: 10,          // canary: share of jobs the student drives, in percent
  /* THE MODEL MAP (platforms.js, autopilot.js): one served tag per scope - base, a platform, a
     role - filled in by promotion. Autopilot picks the most specific tag that has earned its
     stage; off, the mode above applies to the most specific tag there is. */
  studentModels: {},
  autopilot: true,
  /* WHERE ROUNDS RUN. One flow at a time, chosen by a person: the laptops that offered, or a
     card rented per round and destroyed after it. The key never leaves the server. */
  trainOn: 'laptop',         // laptop | gpu
  /* How long a laptop round may run. Three hours proves the chain the same afternoon; twelve
     is a night. The slice a round draws follows from it (about 110 turns an hour, seen thrice). */
  trainHours: 12,            // 3 | 6 | 12 | 24 - the length of one BATCH
  /* HOW THE MACHINES ARE USED, every machine on one batch of one scope, the shares merged:
       time  the round length is the batch's - two machines each run half of it, done in half the time
       work  every machine runs the full round length on its own share - twice the turns in the time */
  trainShare: 'time',
  /* A shadow trial for a round refused on score alone - off: refused is discarded (the owner's rule). */
  trialInShadow: false,
  /* Modal (a GPU node the hub starts by itself): the owner's token, the GPU, and whether the hub
     keeps a node up whenever there is something to learn. */
  modalTokenId: '',
  modalTokenSecret: '',
  modalGpu: 'T4',
  modalAuto: false,
  gpuProvider: 'runpod',
  gpuKey: '',
  gpuOwner: '',              // who saved the key - the rented machine reports as their device
  gpuHub: '',                // this cluster's public address, as the machine must reach it
  gpuType: 'NVIDIA GeForce RTX 4090',
  gpuCloud: 'COMMUNITY',     // COMMUNITY (cheaper) | SECURE
  gpuMaxHours: 2,            // the hard stop, whatever the round says
  llmKey: null,
  /*
   * WHETHER THE AGENT MAY ACT WITHOUT ASKING.
   *
   * Off, and it stays off unless someone deliberately changes it. Reading a page is reversible;
   * joining a group, commenting, messaging and following are not — they happen under the owner's
   * real name, on their real account, and there is no undo that unsends a notification. Facebook
   * also restricts accounts for exactly this pattern, and a wrong comment posted forty times is
   * how that happens.
   */
  autoAct: false,
  /*
   * ROUTE EVERYTHING THROUGH THE TAILNET when one is connected with an exit node.
   *
   * On, because a datacentre address is never what anybody wants and needing to remember it per
   * login means one day forgetting. A profile can still opt out; it just has to say so rather than
   * getting it by omission.
   */
  routeThroughTailnet: true,

  /* How long the agent may work before it has to stop and report. A runaway loop on someone's real
     account is the failure that matters, so there is always a ceiling. */
  maxSteps: 120,

  /*
   * ONE BROWSER FOR EVERYTHING.
   *
   * A "login" is a Chromium profile — one cookie jar. Separate profiles per site earn their keep
   * only when you need a distinct identity (a second account, a different exit country). For one
   * person using their own accounts, they were pure friction: the picker was a "what to open next"
   * control that drifted from the running session, so choosing LinkedIn while a Facebook session
   * ran read as "I chose LinkedIn and it went to Facebook".
   *
   * On, there is a single browser signed into every site, you navigate rather than switch, and the
   * agent is always signed in — which also removes its "switched to the wrong login" failure. The
   * jar is `browserProfile`; it is whichever one already holds the logins, presented simply as
   * "Browser".
   */
  singleBrowser: true,
  browserProfile: 'facebook',
  /*
   * WHICH GOOGLE ACCOUNT OWNS THE PROPERTY. A profile holding two Google accounts lands on an
   * account chooser, which is served from accounts.google.com and so reads as "signed out" — that is
   * how a signed-in profile produced a 31-minute stall and a "no access" verdict on Search Console.
   * Empty on purpose: a flow must never pick a Google account for the owner, because the wrong one
   * reads someone else's console and files the numbers as ours. Unset means report and stop.
   */
  googleAccountEmail: '',
};

function read() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function write(input = {}) {
  const cur = read();
  const out = { ...cur };
  if (typeof input.llmHost === 'string' && /^https?:\/\/[^\s]+$/.test(input.llmHost.trim())) {
    out.llmHost = input.llmHost.trim().replace(/\/+$/, '');
  }
  if (typeof input.llmModel === 'string' && input.llmModel.trim()) out.llmModel = input.llmModel.trim().slice(0, 120);
  if (typeof input.llmKeys === 'string') out.llmKeys = input.llmKeys.trim().slice(0, 2000);
  if (typeof input.studentHost === 'string' && /^https?:\/\/[^\s]+$/.test(input.studentHost.trim())) out.studentHost = input.studentHost.trim().replace(/\/+$/, '');
  if (typeof input.studentModel === 'string') out.studentModel = input.studentModel.trim().slice(0, 120);
  if (['off', 'shadow', 'canary', 'primary'].includes(input.studentMode)) out.studentMode = input.studentMode;
  if (Number.isFinite(Number(input.studentShare))) out.studentShare = Math.max(1, Math.min(100, Math.round(Number(input.studentShare))));
  if (input.studentModels && typeof input.studentModels === 'object' && !Array.isArray(input.studentModels)) {
    out.studentModels = Object.fromEntries(Object.entries(input.studentModels)
      .filter(([k, v]) => typeof v === 'string' && v.trim() && /^(base|platform:[a-z0-9-]+|role:[a-z0-9._-]+)$/.test(String(k)))
      .map(([k, v]) => [String(k), v.trim().slice(0, 120)]));
  }
  if (typeof input.autopilot === 'boolean') out.autopilot = input.autopilot;
  if (['laptop', 'gpu'].includes(input.trainOn)) out.trainOn = input.trainOn;
  if ([3, 6, 12, 24].includes(Number(input.trainHours))) out.trainHours = Number(input.trainHours);
  if (['time', 'work'].includes(input.trainShare)) out.trainShare = input.trainShare;
  if (typeof input.trialInShadow === 'boolean') out.trialInShadow = input.trialInShadow;
  if (typeof input.modalTokenId === 'string') out.modalTokenId = input.modalTokenId.trim().slice(0, 120);
  if (typeof input.modalTokenSecret === 'string') out.modalTokenSecret = input.modalTokenSecret.trim().slice(0, 200);
  if (['T4', 'L4', 'A10G', 'A100'].includes(input.modalGpu)) out.modalGpu = input.modalGpu;
  if (typeof input.modalAuto === 'boolean') out.modalAuto = input.modalAuto;
  if (typeof input.gpuKey === 'string') out.gpuKey = input.gpuKey.trim().slice(0, 200);
  if (typeof input.gpuOwner === 'string') out.gpuOwner = input.gpuOwner.trim().slice(0, 120);
  if (typeof input.gpuHub === 'string' && /^https?:\/\/[^\s]+$/.test(input.gpuHub.trim())) out.gpuHub = input.gpuHub.trim().replace(/\/+$/, '');
  if (typeof input.gpuType === 'string' && input.gpuType.trim()) out.gpuType = input.gpuType.trim().slice(0, 80);
  if (['COMMUNITY', 'SECURE'].includes(input.gpuCloud)) out.gpuCloud = input.gpuCloud;
  if (Number.isFinite(Number(input.gpuMaxHours))) out.gpuMaxHours = Math.max(0.25, Math.min(12, Number(input.gpuMaxHours)));
  // An empty string means "clear it"; undefined means "leave it alone". Those are different asks and
  // collapsing them would make the key impossible to remove.
  if (input.llmKey === null || input.llmKey === '') out.llmKey = null;
  else if (typeof input.llmKey === 'string' && input.llmKey.trim()) out.llmKey = input.llmKey.trim();
  if (typeof input.autoAct === 'boolean') out.autoAct = input.autoAct;
  if (typeof input.routeThroughTailnet === 'boolean') out.routeThroughTailnet = input.routeThroughTailnet;
  if (typeof input.singleBrowser === 'boolean') out.singleBrowser = input.singleBrowser;
  if (typeof input.browserProfile === 'string' && input.browserProfile.trim()) {
    out.browserProfile = input.browserProfile.trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
  }
  if (Number.isFinite(input.maxSteps)) out.maxSteps = Math.max(5, Math.min(300, Math.round(input.maxSteps)));

  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

/** What the UI may see. */
function redacted() {
  const s = read();
  return {
    ...s,
    llmKey: undefined,
    /* The backups are keys too. The spread above carried them to every screen that asked. */
    llmKeys: undefined,
    gpuKey: undefined,
    gpuKeySet: !!s.gpuKey,
    gpuKeyHint: s.gpuKey ? `…${String(s.gpuKey).slice(-4)}` : null,
    keySet: !!s.llmKey,
    // Whether a backup account exists — never the key itself, same rule as the first.
    keys2Set: !!(s.llmKeys && String(s.llmKeys).trim()),
    // Enough to tell two keys apart, not enough to be one.
    keyHint: s.llmKey ? `…${String(s.llmKey).slice(-4)}` : null,
    /* The backups too, so a person can tell on the screen which account is which. */
    keys2Hint: String(s.llmKeys || "").split(",").map((k) => k.trim()).filter(Boolean).map((k) => `…${k.slice(-4)}`).join(", ") || null,
  };
}

module.exports = { read, write, redacted, DEFAULTS, FILE };
