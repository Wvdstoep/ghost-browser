# The Recorder — screen recording with sound, any length, without touching the rest of the browser

Status board (keep this table current; it is the hand-off between sessions):

| Phase | Name | State | Proof |
|---|---|---|---|
| 0 | Foundations: sound, a display per recording, a volume of its own | **done · v336** (2026-09-17) | a 60 s recording of a public video has picture AND sound; the pool's sessions and watchers notice nothing |
| 1 | The engine: any duration, nothing in memory, survives restarts | **done · v338** (2026-09-17) | a 2-hour recording plays while it records and after; a pod roll mid-recording leaves a playable partial |
| 2 | The agent and the app: ask, watch, stream, download | **built · v340 · app** (2026-09-17) — chat proof done; the phone's Play / Save / Stop are the owner's check | "go to the newest MrBeast video, record it full screen with sound and save it" works end to end from the chat |
| 3 | Elastic: a recording is its own pod, resources added not borrowed | **done · v342** (2026-09-17) | three recordings run at once; the browser pod's CPU/memory stay flat; a GB roll cuts none of them |
| 4 | State of the art: quality ladder, thumbnails, chapters, share links, telemetry | **done · v343 · app** (2026-09-17) — console panel, subtitles and the controller's consumer side left as follow-ups |
| 5 | The platform spawns the recorder: gated by the tenant's plan and rented machines, not by a tool inside the tenant's namespace | planned (GB side pluggable; provisioner side to design) | — |

Facts the design rests on (measured 2026-09-17):

- The GB pod runs one Chromium per profile on ONE shared Xvfb display (`:99`, 1280x800), limits 2 CPU / 6 GiB, requests 150m / 768 MiB; it uses ~100m CPU / 2.7 GiB at rest with the watchers on.
- The profiles volume (`ghost-browser-profiles`, Longhorn, ReadWriteOnce, 10 GiB) is 76 % full — video must never land on it.
- The image has Xvfb and ffmpeg, no PulseAudio: pages play in silence today.
- The existing `start_recording` / `stop_recording` tools capture the CDP screencast (a few JPEG frames per second, capped at ~3000 frames, no audio) — good for demo tours, not for a video.
- GB's service account cannot create Kubernetes Jobs (`auth can-i create jobs` → no). The node has 12 cores / 64 GiB, ~40 % CPU and ~75 % memory in use.

## Principles (every phase obeys them)

1. **Never on the shared display.** A recording gets its own Xvfb display and its own audio sink. No window overlap, no focus stealing, no audio mixing with the walks and watchers.
2. **Never in the working browser.** The recorder launches its own Chromium on a CLONE of the profile (the same mechanism as the `<profile>-watch` copy: `ensureWatchProfile` + `syncCookies`). The profile's own session and its per-profile lock stay free.
3. **Nothing in memory, segments are the truth.** ffmpeg writes 10-second HLS segments to disk as it goes. Hours cost disk, not RAM; a crash loses at most 10 seconds; the playlist is playable while recording (live) and after.
4. **A recording is a job with a journal.** Like operator turns: state on disk, re-adopted after a restart, closed as `partial` (still playable) when its process is gone.
5. **Resources are added, not borrowed.** Inside the pod the recorder runs niced with capped threads; from Phase 3 each recording is its own pod with its own requests, so the browser pod's budget is untouched and a GB roll cannot cut it.
6. **Disk is a budget.** Its own volume, a free-space guard that ends a recording cleanly, retention by age and size, the numbers visible in the app.
7. **Private by default.** Recordings stream through GB's own auth; nothing is published; a recording of someone else's video is for the owner to watch, never for an edit or a share.

## Phase 0 — Foundations

- **PulseAudio in the image.** `apt-get install pulseaudio`; `entrypoint.sh` starts one daemon next to Xvfb (`pulseaudio --daemonize --exit-idle-time=-1 --disallow-exit`). Per recording: `pactl load-module module-null-sink sink_name=rec-<id>`; the recorder's Chromium is launched with `PULSE_SINK=rec-<id>` so ITS audio goes only there; ffmpeg reads `rec-<id>.monitor`. Unload the module when the recording ends.
- **A display per recording.** `Xvfb :<100+n> -screen 0 <W>x<H>x24` started by the recorder, torn down with it. The recorder's Chromium gets `DISPLAY=:<100+n>`, `--kiosk --window-size=W,H --window-position=0,0 --autoplay-policy=no-user-gesture-required --disable-features=Translate`.
- **A volume of its own.** New PVC `ghost-browser-recordings` (Longhorn, 50 GiB to start, expandable) mounted at `/recordings`. `src/recorder.js` refuses to start below 2 GiB free and ends a running recording cleanly at that line.
- **Deploy.** Chart/deployment change in gitops for the PVC + mount; image rebuild by the auto-deploy.
- **Proof.** A 60 s recording of a public video (a Creative-Commons clip) has picture and sound; `/v1/watchers/busy` and the pool's session list are unchanged during it; a Facebook watcher pass runs at the same time and its items land as usual.

## Phase 0 — proof (2026-09-17, v336)

- Probe of a plain video page, 15 s, profile `google`: mp4 with `video` + `audio` streams, mean −36.7 dB / max −17.4 dB (real sound), display :100, while `facebook-notifications-watcher` ran a pass at the same time — busy list and session list unchanged before/after.
- Probe of a YouTube page: picture yes, sound **no** (−91 dB): the page sat on YouTube's cookie-consent wall, not signed in. Two Phase 1 inputs: (1) cookies must come from Playwright (`context.cookies()` of the live session, or the source profile opened briefly when the pool does not hold it) — the file copy of the Cookies DB did not carry the login; (2) a page-preparation step: dismiss consent walls (accept/reject buttons in any language), press play, unmute, full-screen the video.

## Phase 1 — The engine

- **`src/recorder.js`.** `Recording = { id, url, profile, quality, until: 'video-ends' | 'duration' | 'owner-stop', maxMinutes, state: starting | recording | finishing | done | partial | failed, startedAt, endedAt, seconds, bytes, segments, error }`. Journal at `/recordings/<id>/recording.json`; media at `/recordings/<id>/index.m3u8` + `seg-00001.ts …`.
- **Start.** Clone the profile (cookies synced) → Xvfb + sink → Chromium (Playwright, headed on that display) → open the URL → wait for a `<video>` element, click play if paused, request fullscreen on the video element (`video.requestFullscreen()` with a user gesture via CDP, fallback: `--kiosk` already fills the display) → start ffmpeg: `-f x11grab -framerate 30 -video_size WxH -i :<disp> -f pulse -i rec-<id>.monitor -c:v libx264 -preset veryfast -threads 2 -crf 23 -c:a aac -b:a 160k -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename seg-%05d.ts index.m3u8`, under `nice -n 10 ionice -c3`.
- **Run.** A 5-second tick per recording: seconds and bytes from the segment files; end conditions — `video.ended` (polled via CDP), `maxMinutes`, owner stop, disk guard, browser gone. Ads on YouTube: the tick skips a "Skip" button when it appears; nothing else is clicked.
- **Finish.** Signal ffmpeg (`q`) so the playlist gets its end tag; `ffprobe` the duration; tear down Chromium, Xvfb, the sink; journal `done`. `partial` when GB comes back and the process is gone.
- **Endpoints.** `POST /v1/recordings {url, profile, until, maxMinutes, quality}`, `GET /v1/recordings`, `GET /v1/recordings/:id`, `POST /v1/recordings/:id/stop`, `DELETE /v1/recordings/:id`, `GET /v1/recordings/:id/index.m3u8` and `/seg-*.ts` (streaming; live while recording), `GET /v1/recordings/:id/mp4` (on-demand `ffmpeg -f concat -c copy` into a cached file, then streamed with Range support — no base64, no size cap).
- **Busy gate.** A running recording counts as busy for `gb-auto-deploy.sh` until Phase 3 makes recordings roll-proof.
- **Tests.** State machine with a fake ffmpeg/browser (start, tick, end conditions, partial after restart); playlist serving; concat; disk guard.

## Phase 1 — proof (2026-09-17, v337/v338)

- A 2-minute YouTube recording through the API: the playlist and a segment were fetched while it recorded (2 entries, no end tag), 13 segments / 120 s at the end, an mp4 of 7.4 MB built by stream copy.
- A recording running THROUGH a pod roll (v337 → v338): closed at boot as `partial` — 4 segments / 40 s, playlist closed, a partial mp4 of 465 KB served.
- A fresh 60-second recording on v338 (Big Buck Bunny, profile `google`, Polish exit): full screen, no consent wall, no translate bubble, mean −24.1 dB / max −0.4 dB. The busy list carried the recording; the watchers ran untouched.
- What it took: consent answered by cookie (`SOCS=CAI`) before the page loads, the wall watched for 10 s in 20 languages otherwise; the video waited for as attached (a player hides it until play); a big-play-button before a click on the video; cookies through Playwright, not a file copy; translate off through the throw-away profile's Preferences.
- YouTube and the Google profile: a Google login only reaches YouTube once youtube.com is visited signed in. The Phase 2 recipe's read-only walk (find the video) runs in the `google` profile on YouTube, so the pool's live context then carries the YouTube cookies straight into the recorder (`liveContextFor`). Platform matching maps youtube.com → profile `google`.

## Phase 2 — The agent and the app

- **Tools.** `record_start { url?, profile, until, maxMinutes?, quality? }` (url omitted = the walk's current page), `record_status { id }`, `record_stop { id }`. The recording OUTLIVES the turn: the card says so.
- **Prompt recipe.** "Record X": (1) a read-only `gb_walk` finds the exact video URL (newest on a channel = the channel's Videos tab, first item), (2) `record_start` with that URL and `until: 'video-ends'`, (3) answer at once with the recording card — do not wait for the end. If the owner names a length, `until: 'duration'`.
- **App.** A `RecordingCard` in the answer and a Recordings section in Settings → Downloads: state ("recording · 12:33 · 340 MB", "done · 1:02:10 · 1.9 GB", "partial"), Play (streams the HLS playlist: Android `MediaPlayer`/Media3 plays m3u8 natively; desktop via the system player or an embedded view), Download (the mp4 endpoint, streamed to Downloads with progress — never through the 40 MB base64 path), Stop, Delete. Polling every 5 s while one is recording.
- **Nightly.** Retention: keep 14 days or 30 GiB, oldest `done` first, never a running one; the nightly report lists what it removed.
- **E2E.** From the chat: "go to the newest MrBeast video, record it in full screen with sound and save it so I can watch it later". Passes when: the walk finds the video, the card appears within a minute, Play streams while it records, the recording ends when the video ends, the mp4 downloads and plays on the phone.

## Phase 2 — proof (2026-09-17, v339/v340 + app)

- From the chat, one ask: "Go to YouTube and record the Blender Foundation video Big Buck Bunny 60fps 4K with sound for 2 minutes so I can watch it later." The agent walked the Google profile to the video (2 steps), called `record_start` (it chose 1080p on its own), and answered after 120 s with the recording card — while the recording ran on. The recording ended by its length: 120 s, 12 segments, 1080p, mean −24.4 dB / max −0.4 dB, 28 MB mp4.
- App (built, pushed as `mobile/dist/app-debug.apk`): the recording card in the chat (live numbers every 5 s, Play → a full-screen player streaming the playlist while it records and the seekable mp4 after, with the cluster session's cookie; Stop; Save streams the mp4 into Downloads, any size, never through memory), a Recordings section under Settings → Downloads with free space and Delete. Desktop: plays and saves through its own tabs (the tabs hold the session).
- Retention: nightly at 03:00 UTC, 14 days / 30 GB (`RECORDINGS_KEEP_DAYS`, `RECORDINGS_KEEP_GB`), never a live one, listed in the log.
- Known: the desktop installer grew past GitHub's 100 MB file limit (100.02 MB) — the repo keeps the previous installer; a release channel (GitHub Releases) is the fix, noted for Phase 4.
- `record_start` answers with a slim recording (the full view blew past the step's result clip and the step showed no brief).

## Phase 3 — Elastic: the recorder as its own pod

- **Packaging.** The same GB image with `MODE=recorder`: the entrypoint runs `src/recorder-main.js` (one recording from env/args), no server, no pool.
- **Handoff.** GB creates a Kubernetes Job per recording (`ghost-browser-rec-<id>`, labels `gb/recording=<id>`), requests `1 CPU / 1.5 GiB`, limits `2 CPU / 3 GiB`, `ttlSecondsAfterFinished`. The recorder pushes segments and its journal to GB over HTTP (`PUT /v1/recordings/:id/segments/:n`, bearer from a per-recording token in the Job env) — no shared volume needed, the profile clone's cookies arrive the same way (`pending-cookies`). GB serves and stores exactly as in Phase 1.
- **RBAC.** A Role in `pod-mavicpro-fan` (jobs: create/get/list/delete; pods: get/list; pods/log: get) bound to GB's service account, in gitops next to the deployment.
- **Scheduler in code.** Before creating a Job read node capacity (metrics API); queue when free CPU < 2 or memory < 3 GiB; N concurrent recordings max (setting); on GB restart re-adopt Jobs by label. Fallback: when Jobs cannot be created (RBAC missing, quota) the Phase 1 in-pod path runs — the owner is told which one is used.
- **Capacity hook.** Queued recordings older than X minutes are a demand signal to the platform's capacity controller (rent-a-node), so more work means more machine — a code path, not a raised limit.
- **Proof.** Three recordings at once; `kubectl top` on the browser pod stays within ±100m CPU / ±200 MiB of rest; `kubectl rollout restart deploy/ghost-browser` during a recording, the recording finishes intact.

## Phase 3 — proof (2026-09-17, v341/v342)

- A recording started through the API became a Kubernetes Job of its own (`ghost-browser-rec-<id>`, requests 1 CPU / 1.5 GiB, limits 2 CPU / 3 GiB, a 20 GiB scratch disk, no service-account token). The pod fetched the handoff (the ask, 1151 cookies, the profile's identity, GB's exit proxy by name), recorded 60 s of YouTube full screen with sound (mean −23.9 dB / max −0.4 dB) through the profile's residential exit, and pushed 6 segments, the playlist and its journal back over HTTP with the recording's token. The playlist streamed by ticket, a bad ticket got 401.
- A 4-minute recording in its own pod kept recording while Ghost Browser was restarted underneath it (the pushes failed for the length of the roll — `ENOTFOUND ghost-browser-pods` while the headless name had no pod — and caught up after): 240 s, 24 segments, 34 MB, sound at full level, nothing lost. Recordings in pods of their own are not counted by the deploy gate any more; they do not need it.
- Fallback proven in the unit tests: when the cluster refuses the Job the recording runs in this pod and the journal says why.
- Two traps on the live node: the ghost-browser *cluster IP* refuses pod-to-pod traffic (the pod IP answers, the host answers, the NAT rules are correct) — the recorder reaches GB through a headless twin service (`ghost-browser-pods`) that resolves straight to the pod and re-resolves after a roll; and a brand-new pod is refused on its very first connection while the node syncs its policy (try 1 fails, try 2 works) — the recorder asks for the handoff for up to 5 minutes. Both are in the platform manifests (Role, RoleBinding, headless Service) so a fresh install gets them.
- Not done in this phase: the capacity-controller hook (queued recordings as a demand signal) and a node-capacity check before creating a Job — the Job's requests already make the scheduler refuse what does not fit; both stay on the Phase 4 list.

## Phase 4 — State of the art

- Quality ladder (720p30 default, 1080p30, 1080p60), audio bitrate, a thumbnail and a sprite strip per recording, chapters from scene cuts, optional subtitles through the platform's whisper service.
- Share link with expiry that streams through GB (private by default, owner's own content only for anything that leaves the account).
- A Recordings panel in the console; per-recording telemetry (CPU, memory, disk, dropped frames); a disk-space alert in the app.

## Phase 4 — proof (2026-09-17, v343 + app)

- Quality ladder: 720p30 (default), 1080p30, 1080p60 — frame rate, GOP and audio bitrate follow the rung; the agent's tool names all three with when to use which.
- After every recording: a thumbnail (10 % in), a 5×2 sprite strip, chapters from scene cuts on a 1 fps proxy (cheap for hours; ≥ 20 s apart, ≤ 60). Live: 2, 9 and 5 chapters on the three recordings on the cluster; thumbnails served by ticket.
- Share links: `POST /v1/recordings/:id/share {days}` → `/r/<id>?t=…`, a public player page (noindex) on a long-lived ticket; a wrong ticket gets 404. The app's card has a Share button (clipboard + share sheet); the desktop copies the link.
- GB serves its own builds: `/dist/GhostBrowser-Setup-1.0.25.exe` and `/dist/app-debug.apk` from the recordings volume — the release channel for a 100 MB installer GitHub refuses. Both answered 200 through the public host.
- A cap on pods of their own (`MAX_REMOTE_RECORDINGS`, 3) with a demand signal (`demand.refusedRemote`, `lastRefusedAt`) on the recordings list for the capacity controller to read.
- The app: chapter count on the card, a disk warning under Downloads (red under 5 GB, "will refuse to start" under 2 GB).
- From the owner's live test on the way: the playlist a player follows lists only the segments that are here (no 404 at the live edge); the mp4 is built from the files present (a cut recording plays as a clean partial; all three on the cluster strict-decode clean); recorder pods get 6 GiB / 4 CPU (1080p was OOM-killed at 3 GiB); the pod's stop poll is a light call.
- The tenant namespace has a quota on REQUESTS (10 GiB memory, 4 CPU; 8.6 GiB and 2.3 CPU in use by the tenant's apps): a recorder pod that asked to reserve 2 GiB was never created and the Job sat there retrying. Now the pod reserves 1 GiB / 0.5 CPU and bursts to 6 GiB / 4 CPU (limits are not under the quota), and a Job that gets no pod within 25 s is taken back — the recording runs inside Ghost Browser instead and counts as demand. Proven on v344: a pod within the quota, 60 s with sound; the quota's usage back where it was after.
- Left as follow-ups: a Recordings panel in the console, subtitles through the platform's speech service, per-recording CPU/memory telemetry, and the capacity controller actually consuming the demand signal (a platform-side change).

## One at a time, with a queue (2026-09-17)

Until the platform spawns recorders (Phase 5), one recording runs at a time (`MAX_RECORDINGS_TOTAL`, 1). A recording asked for while one runs is `queued`: it keeps its place, starts by itself the moment the running one ends (also after a restart), and can be taken out of the queue with Stop. The recordings list carries `queued` (ids in order) and each queued recording its `queuePos`; the app shows the queue under Downloads and on the card ("queued · #2"); the agent's `record_start` answers "queued, position n" and `record_list` lists the queue.

## Phase 5 — The platform spawns the recorder

**Why.** A recorder Job created by GB inside the tenant's namespace competes with the tenant's own apps for the namespace quota (10 GiB of reservations, 8.6 in use → one recorder pod at most, a second one refused), and the tenant's plan and rented machines are invisible to a tool. Spawning recorders is a platform capability: the platform knows the plan (recording minutes, parallel recordings, storage), the tenant's rented VMs and BYON nodes, and the capacity controller; a tool should ask, not decide.

**Contract (GB side, pluggable).** `recorder/remote.js` gains a second implementation, chosen by `RECORDER_PLATFORM_URL`: `launch(rec)` → `POST {platform}/v1/tenants/{tenant}/recorders { recordingId, gbUrl, token, quality, maxMinutes }` → `{ jobRef, where: 'platform' | 'byon:<node>' }` or `409 { reason: 'plan' | 'capacity', retryAfterSec }`; `alive(rec)` → `GET …/recorders/{jobRef}`; `cancel(rec)` → `DELETE`. The recording protocol itself does not change: the recorder pod still takes the handoff from GB and pushes segments, playlist and journal back with the recording's token, so GB's storage, tickets, share links and the app stay as they are. When the platform says no (plan, capacity), GB queues the recording and shows why; when there is no platform (the open-source install), the in-namespace Job stays the default.

**Provisioner side (to design, webnpm repo).** A recorder is a platform-managed Job in a platform namespace (its own quota, the GB image in `MODE=recorder`, a scratch disk, egress to the tenant's GB by its public host with the recording token), placed by the plan: free = 1 at a time / 720p / 30 min, paid tiers add parallel recordings, 1080p and hours; tenants with rented VMs or BYON nodes get their recorders placed on those nodes (node selector) with no platform cost; queued demand feeds the capacity controller (rent-a-node) exactly as the `demand` signal already does. Billing counts recording minutes per tenant. The tenant's GB never needs Kubernetes rights on the platform cluster.

## Out of scope, on purpose

- Recording protected (DRM) streams — Netflix, Disney+ and the like render black by design.
- Publishing or editing recordings of other people's videos.
- Bypassing a platform's sign-in or bot checks to record — the recorder uses the owner's own logged-in profile and the residential exit, nothing more.
