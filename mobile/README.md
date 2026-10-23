# GB Mobile — Ghost Browser on your own device

Ghost Browser as a **native Android app** running a **real on-device Chromium WebView**. Because it
runs on your real phone — real residential IP, real device fingerprint, real touch — it walks straight
through walls a server can't (proven: it passes **Cloudflare Turnstile** where the hosted server loops).

> **v0.71** — Scan history now opens as a compact results navigator. The overview shows result counts, open ports, web responses or findings, and scopes. Search by host, port, title, or finding; narrow by scope and result type; move through 20 results per page; tap one row to inspect its evidence in a focused sheet. The same layout serves range discoveries, on-device scans, and local watcher results.

Range discovery also has a two-screen protection workflow: configure the scan, then review a searchable evidence inbox. Each observed host can be marked reviewed or dismissed; review state persists across scan runs. A reviewed record can open an editable responsible-disclosure email draft in the phone's email app. Ghost Browser never sends the email itself.

When web identification is enabled, the phone requests `/` on an open web port and saves HTTP status, server headers, and page title. For HTTPS hosts it also checks that host's `/.well-known/security.txt` for a vulnerability-reporting email. A suggested contact appears only when HTTPS certificate and hostname validation succeeds, the file is current, and any Canonical field matches the fetched URL. No redirects are followed. Most IP-hosted sites have domain-only certificates, so manual contact entry remains available.

The web-identification switch is off by default and applies only to the selected /24–/32 range. It does not run every recon starter prompt or assert a vulnerability. Results stay on the phone unless cluster sharing is separately enabled. The draft requires an explicit review action and a valid recipient; no bulk contact harvesting or automatic email sending occurs.

The scan service does not generate an Internet-wide address sequence or bundle third-party networks as presets. If Android ends the service, reopening Range discovery marks the stale run paused; tap Resume to continue. Connection-rate settings count TCP attempts, so a host checked on several ports consumes several attempts.

Choose Ghost Browser as your default under Android **Settings → Apps → Default apps → Browser app**.
Visited-link suggestions stay on the phone, separate for each profile; use **⋮ → Clear visited links**
to erase the current profile's suggestions.
The home-screen widget picker offers a search shortcut and a watcher summary. The watcher widget shows
the last data fetched by the app and its sync time; tap it to open and refresh Watchers. The header's
**⋮ → Developer tools** opens page Console, Elements, Sources, Network, Performance, and Memory views.
Android WebView only exposes page-visible resource timings and optional JavaScript heap data, so its
Network and Memory views are more limited than desktop Chrome DevTools.

Two ways to drive it, sharing one browser (tap the header's **⋮ → Settings** to open the panel):

## 1. Standalone — on-device agent (your Ollama key, no cluster)
Give it your Ollama-compatible endpoint + key + model and a task; the app runs the full
**perceive → think → act** loop on the device:
1. Open **⋮ → Settings → On-device agent**.
2. **Endpoint** — e.g. `https://your-ollama-host/v1` (OpenAI-compatible `/v1/chat/completions`).
3. **API key**, **model** (e.g. `glm-4`), then a **Task** ("go to bugcrowd and list the top bug bounty programs").
4. **▶ Run** — watch each step in the Activity log; **■ Stop** any time.

It perceives the page as a numbered list of interactive elements (set-of-mark), asks your model for one
action, performs it in the real WebView, and repeats — the same model as the server engine, on real hardware.

## 2. Cluster — let the hosted backend drive this device
Turn the phone into a Ghost Browser node your platform can drive for a hunt:
1. Open **⋮ → Settings → Cluster → Connect to cluster**. The app exposes the **GB API** on `:8471` and shows a device token.
2. Join the device to your **tailnet** (Tailscale) so the cluster can reach it; browsing still exits over the
   device's own connection (real IP).
3. The backend calls the same GB API it uses for a server GB — `/v1/navigate`, `/v1/analyze`, `/v1/click`,
   `/v1/type`, `/v1/content`, `/v1/screenshot` — authenticated with the device token (`Authorization: Bearer <token>`).

So control travels the tailnet; browsing travels the device.

## Try it (development APK)
Download the checked-in [v0.71 debug APK](dist/app-debug.apk). It was built from the source in this
repository after the Android build, app unit tests, shared desktop tests, and desktop compilation passed.
SHA-256: `a2823710eec9cc4681ce1adca3934b9a2a104fd4520522dc06f42f9993d0070b`.

This is a debuggable build signed with an Android debug key. Use a test account only. There is no
signed production release build yet. The [Android workflow](https://github.com/Wvdstoep/ghost-browser/actions/workflows/android.yml)
also produces a `ghost-browser-debug-apk` artifact for each successful commit; its build-machine
debug signature can differ from the checked-in file.

## Build it yourself
Needs the Android SDK + JDK 17+:
```
./gradlew assembleDebug   # -> app/build/outputs/apk/debug/app-debug.apk
```

On Windows, run `gradlew.bat :app:assembleDebug` from this directory. GitHub Actions also builds the
debug APK and runs shared desktop tests on pushes to `main`, pull requests, and manual dispatches.
Download the `ghost-browser-debug-apk` artifact from the corresponding Actions run. A production
release requires a separately configured release signing key and release process.

The Windows Compose installer is built locally with `gradlew.bat :desktop:packageMsi :desktop:packageExe`.
Version 1.0.30 keeps the desktop installer out of GitHub because of its size. The desktop uses the
same header-menu navigation as Android, and **Developer tools** opens Chromium's native DevTools
for the active tab. The Windows browser engine still uses one shared cookie store across its tabs;
Android's isolated profile containers are not yet implemented on Windows.

Phone platform logins stay on the phone unless you turn on **Share login with cluster** for that
platform on the Profiles page. Sharing copies session cookies to the cluster. Android's WebView cookie API does
not expose the original scope or HttpOnly flags, so only enable sharing for accounts you choose to
share. You can also sign in separately in the hosted cluster profile.

## What's next
Embed Tailscale (`tsnet`/gomobile) so joining the tailnet is one tap inside the app; a live-view stream
for the console; and a laptop sibling that drives real desktop Chrome over CDP behind the same API.
