# The Recorder — screen recording with sound, any length, without touching the rest of the browser

Status board (keep this table current; it is the hand-off between sessions):

| Phase | Name | State | Proof |
|---|---|---|---|
| 0 | Foundations: sound, a display per recording, a volume of its own | **done · v336** (2026-09-17) | a 60 s recording of a public video has picture AND sound; the pool's sessions and watchers notice nothing |
| 1 | The engine: any duration, nothing in memory, survives restarts | building (engine + page + routes; proof pending) | a 2-hour recording plays while it records and after; a pod roll mid-recording leaves a playable partial |
| 2 | The agent and the app: ask, watch, stream, download | planned | "go to the newest MrBeast video, record it full screen with sound and save it" works end to end from the chat |
| 3 | Elastic: a recording is its own pod, resources added not borrowed | planned | three recordings run at once; the browser pod's CPU/memory stay flat; a GB roll cuts none of them |
| 4 | State of the art: quality ladder, thumbnails, chapters, share links, telemetry | planned | — |

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

## Phase 2 — The agent and the app

- **Tools.** `record_start { url?, profile, until, maxMinutes?, quality? }` (url omitted = the walk's current page), `record_status { id }`, `record_stop { id }`. The recording OUTLIVES the turn: the card says so.
- **Prompt recipe.** "Record X": (1) a read-only `gb_walk` finds the exact video URL (newest on a channel = the channel's Videos tab, first item), (2) `record_start` with that URL and `until: 'video-ends'`, (3) answer at once with the recording card — do not wait for the end. If the owner names a length, `until: 'duration'`.
- **App.** A `RecordingCard` in the answer and a Recordings section in Settings → Downloads: state ("recording · 12:33 · 340 MB", "done · 1:02:10 · 1.9 GB", "partial"), Play (streams the HLS playlist: Android `MediaPlayer`/Media3 plays m3u8 natively; desktop via the system player or an embedded view), Download (the mp4 endpoint, streamed to Downloads with progress — never through the 40 MB base64 path), Stop, Delete. Polling every 5 s while one is recording.
- **Nightly.** Retention: keep 14 days or 30 GiB, oldest `done` first, never a running one; the nightly report lists what it removed.
- **E2E.** From the chat: "go to the newest MrBeast video, record it in full screen with sound and save it so I can watch it later". Passes when: the walk finds the video, the card appears within a minute, Play streams while it records, the recording ends when the video ends, the mp4 downloads and plays on the phone.

## Phase 3 — Elastic: the recorder as its own pod

- **Packaging.** The same GB image with `MODE=recorder`: the entrypoint runs `src/recorder-main.js` (one recording from env/args), no server, no pool.
- **Handoff.** GB creates a Kubernetes Job per recording (`ghost-browser-rec-<id>`, labels `gb/recording=<id>`), requests `1 CPU / 1.5 GiB`, limits `2 CPU / 3 GiB`, `ttlSecondsAfterFinished`. The recorder pushes segments and its journal to GB over HTTP (`PUT /v1/recordings/:id/segments/:n`, bearer from a per-recording token in the Job env) — no shared volume needed, the profile clone's cookies arrive the same way (`pending-cookies`). GB serves and stores exactly as in Phase 1.
- **RBAC.** A Role in `pod-mavicpro-fan` (jobs: create/get/list/delete; pods: get/list; pods/log: get) bound to GB's service account, in gitops next to the deployment.
- **Scheduler in code.** Before creating a Job read node capacity (metrics API); queue when free CPU < 2 or memory < 3 GiB; N concurrent recordings max (setting); on GB restart re-adopt Jobs by label. Fallback: when Jobs cannot be created (RBAC missing, quota) the Phase 1 in-pod path runs — the owner is told which one is used.
- **Capacity hook.** Queued recordings older than X minutes are a demand signal to the platform's capacity controller (rent-a-node), so more work means more machine — a code path, not a raised limit.
- **Proof.** Three recordings at once; `kubectl top` on the browser pod stays within ±100m CPU / ±200 MiB of rest; `kubectl rollout restart deploy/ghost-browser` during a recording, the recording finishes intact.

## Phase 4 — State of the art

- Quality ladder (720p30 default, 1080p30, 1080p60), audio bitrate, a thumbnail and a sprite strip per recording, chapters from scene cuts, optional subtitles through the platform's whisper service.
- Share link with expiry that streams through GB (private by default, owner's own content only for anything that leaves the account).
- A Recordings panel in the console; per-recording telemetry (CPU, memory, disk, dropped frames); a disk-space alert in the app.

## Out of scope, on purpose

- Recording protected (DRM) streams — Netflix, Disney+ and the like render black by design.
- Publishing or editing recordings of other people's videos.
- Bypassing a platform's sign-in or bot checks to record — the recorder uses the owner's own logged-in profile and the residential exit, nothing more.
