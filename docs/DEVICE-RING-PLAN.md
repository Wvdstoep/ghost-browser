# The Device Ring — run Cloudflare-gated work on the device that holds the login

Some platforms (LinkedIn today) sit behind a Cloudflare managed challenge that a datacenter exit cannot pass: from the cluster every page redirect-loops. The device that is already signed in — the phone — has the login, the real browser fingerprint and a residential IP that Cloudflare trusts. So that work must run ON the device, with the device's own everything, and the cluster stays the brain (draft, standing, approve). This plan makes the device a reliable, first-class execution node and routes the right work to it, sensed not hardcoded.

Status board (keep current; it is the hand-off between sessions):

| Phase | Name | State | Proof it is done |
|---|---|---|---|
| 0 | Robust native presence | **DONE · proven** (2026-09-18) — backgrounded phone stayed online continuously; battery exemption + native ring + self-hosted watchdog, no Firebase | With the app in the foreground the phone stays online in the hub for 30+ min with no SSO cookie; killing the app shows it offline within a minute; no WebView needed for presence |
| 1 | Profile-targeted on-device commands | **DONE · proven** (2026-09-18) — read the logged-in LinkedIn feed in p_linkedin, past Cloudflare | A command names a profile; the phone runs navigate/perceive/type/click in THAT profile's browser and returns the result; LinkedIn opens signed-in in the p_linkedin profile |
| 2 | The on-device crawl | in progress — reader v1 reads post author + commenters + profile slugs; LinkedIn MOBILE-web comment DOM is inconsistent (comments do not always render), so stabilizing the read is the next work | A LinkedIn post/notification is read on the phone (its login, its IP, no Cloudflare loop), the thread returns to the cluster, and the cluster ingests → drafts → gates it exactly like Facebook |
| 3 | Real Cloudflare-wall detection | planned | A site that redirect-loops or shows a Cloudflare challenge from the cluster is auto-flagged needsDevice; the flag is data, not a hardcode; LinkedIn is detected, not listed |
| 4 | The scheduler dispatches to the ring | planned | A due LinkedIn watch runs its pass on the connected phone end to end; an approved reply to a gated platform posts from the phone; no device → clean waiting-device, never the cluster |
| 5 | The connection UX | planned | After one sign-in the app shows "connected as this device, stays signed in", auto-connects on launch, and per watch shows "runs on your phone / waiting for your device"; the old sign-in+connect ceremony is gone |

## Principles

1. **The device is the eyes and hands; the cluster is the brain.** The phone reads the page and performs the approved act with its own login, fingerprint and IP. Standing, drafting and the approve gate stay on the cluster, unchanged and platform-neutral. Nothing about the draft-and-approve flow moves.
2. **Presence rides the durable key, not a cookie or a WebView.** Registration and the command poll are native HTTP with the device key, kept alive by the foreground service. A WebView is only ever a place to run a page, never the thing that keeps the device connected.
3. **Never carry identity across machines.** No cookie sync for a gated platform. The phone uses the login that already lives in its own profile.
4. **The routing source is sensed.** A Cloudflare wall is detected from real page behaviour and recorded as data; the scheduler reads the data. A platform is never gated by a hardcoded name.
5. **Honest visibility.** The owner always sees whether the device is connected and where each watch runs. A gated platform with no device says so and never silently falls back to a path that loops.
6. **The cluster never runs a gated platform.** Not as a fallback, not "to try". A gated pass with no device waits.

## Phase 0 — Robust native presence

**Why.** Today the phone registers through a hidden WebView that fetches with the SSO cookie; when the app backgrounds the WebView is throttled and the poll stops, and when the cookie lapses registration 401s. The phone drops offline within ~40s and the hub cannot route to it.

**Build.** Move register / poll / result / log to a native loop in the foreground service (`GbService`), authenticated with the durable device key (`Authorization: Bearer`), independent of any WebView or cookie:
- `POST /v1/device/register` (bearer) on connect and on service start; re-register on the caps changing.
- `GET /v1/device/poll` (bearer) long-poll in a loop; each return (a command or a 204 after ~25s) refreshes lastSeen, so presence holds as long as the service runs.
- A command is handed to the UI layer to run on the right WebView (Phase 1), and the result posted to `POST /v1/device/result` (bearer).
- The foreground service is the keep-alive; the notification says "Ghost Browser connected". Killing the app ends the service and the phone goes offline within a minute — honest.
- Retire the `gb-control.js` WebView presence path (kept only if MULTI_PROFILE is unavailable). The server side already accepts the key on these routes.

**Proof.** App foreground: the phone stays `online` in `/v1/device/list` across a 30-minute watch; a scheduled LinkedIn watch finds it. App killed: offline within a minute.

## Phase 1 — Profile-targeted on-device commands

**Why.** A command runs on the phone's active tab today, in whatever profile is open. A LinkedIn read must run in the `p_linkedin` profile where the login lives. The user's point: it must switch itself to the profile the work needs.

**Build.** Commands carry a `profile`. The phone keeps a hidden per-profile WebView (the MULTI_PROFILE jars it already has) and runs `navigate / perceive / posts / click / type / scroll` in the named profile's view, not the visible tab, so a background pass never disturbs what the owner is looking at. The command surface (`/v1/navigate`, `/v1/perceive`, …) gains a `profile` field; the router (device hub `capableDevice`) already matches on the profile the device holds.

**Proof.** `perceive {profile:'p_linkedin', url:'/feed'}` returns the signed-in feed (greeted by name), while the visible tab is untouched.

## Phase 2 — The on-device crawl

**Why.** This is the actual LinkedIn watch: read the posts/notifications on the phone and hand the thread to the cluster.

**Build.** A thin on-device crawl: for each watched URL, the phone navigates in `p_linkedin`, expands and reads the comment tree with a LinkedIn-shaped `extractInPage` (mirroring the Facebook one), and returns a normalized tree `{nodes, postId, postAuthor, url}` to the cluster. The cluster's `ingest → verifyWaiting → draftAll` run unchanged (they are already platform-neutral once the `deepLink` and `people.remember` platform literals are parameterized). The poster, for a gated platform, likewise runs on the phone: open the comment, type the approved words, submit, prove it. The LinkedIn selectors live in one place, confirmed by walking the real page once.

**Proof.** A real LinkedIn thread the owner is in produces the same Results card, standing and draft shape as Facebook; approve posts it from the phone.

## Phase 3 — Real Cloudflare-wall detection

**Why.** The routing source must be sensed, not a hardcoded LinkedIn flag.

**Build.** When a cluster session hits a site and the load redirect-loops (`ERR_TOO_MANY_REDIRECTS`) or lands on a Cloudflare challenge (the interstitial markers), record `needsDevice` for that site as data (a learned flag on the site record), with a timestamp and the evidence. The scheduler and the poster read that flag. A site can also be cleared if it later loads clean from the cluster. LinkedIn becomes detected, not listed. The existing per-site `needsDevice` becomes the seed/override; detection fills the rest.

**Proof.** A fresh Cloudflare-gated site, never named in code, is flagged after one looping load from the cluster and thereafter routes to the device.

## Phase 4 — The scheduler dispatches to the ring

**Why.** Phase 0-3 give presence, on-device reads and detection; this wires the watch pass to them.

**Build.** When a needsDevice watch is due and `capableDevice` returns a device, the scheduler enqueues the on-device crawl to that device (via the command channel), collects the tree, and runs the cluster-side ingest/draft. An approved reply to a gated platform is posted on the device. No device → the waiting-device state already shipped. The cluster never runs the gated pass itself.

**Proof.** A due LinkedIn watch, phone connected, completes a pass end to end and a draft lands in Results; disconnect the phone and it cleanly waits.

## Phase 5 — The connection UX

**Why.** After one sign-in the app should look and behave connected, with no ceremony, and show where work runs.

**Build.** Settings shows "Connected as <device> — stays signed in" once enrolled, auto-connects on launch, and offers Sign out (revoke this device) rather than Sign in/Connect. Each watch shows "runs on your phone" or "waiting for your device — connect the app". The Device Hub shows this device and its state plainly.

**Proof.** A returning owner opens the app and is connected with no taps; a gated watch shows its device state at a glance.

## Out of scope, on purpose

- Bypassing a platform's sign-in or bot checks beyond using the owner's own logged-in device. The device IS the legitimate client.
- Running a gated platform on the cluster under any condition.
- Cross-device cookie sync for gated platforms.
