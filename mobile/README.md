# GB Mobile — Ghost Browser on your own device

Ghost Browser as a **native Android app** running a **real on-device Chromium WebView**. Because it
runs on your real phone — real residential IP, real device fingerprint, real touch — it walks straight
through walls a server can't (proven: it passes **Cloudflare Turnstile** where the hosted server loops).

> **v0.55** — Material 3 interface, isolated browser profiles, and per-platform approval before sharing a phone login with the cluster.

Two ways to drive it, sharing one browser (tap **⚙** to open the panel):

## 1. Standalone — on-device agent (your Ollama key, no cluster)
Give it your Ollama-compatible endpoint + key + model and a task; the app runs the full
**perceive → think → act** loop on the device:
1. Open **⚙ → On-device agent**.
2. **Endpoint** — e.g. `https://your-ollama-host/v1` (OpenAI-compatible `/v1/chat/completions`).
3. **API key**, **model** (e.g. `glm-4`), then a **Task** ("go to bugcrowd and list the top bug bounty programs").
4. **▶ Run** — watch each step in the Activity log; **■ Stop** any time.

It perceives the page as a numbered list of interactive elements (set-of-mark), asks your model for one
action, performs it in the real WebView, and repeats — the same model as the server engine, on real hardware.

## 2. Cluster — let the hosted backend drive this device
Turn the phone into a Ghost Browser node your platform can drive for a hunt:
1. Open **⚙ → Cluster → Connect to cluster**. The app exposes the **GB API** on `:8471` and shows a device token.
2. Join the device to your **tailnet** (Tailscale) so the cluster can reach it; browsing still exits over the
   device's own connection (real IP).
3. The backend calls the same GB API it uses for a server GB — `/v1/navigate`, `/v1/analyze`, `/v1/click`,
   `/v1/type`, `/v1/content`, `/v1/screenshot` — authenticated with the device token (`Authorization: Bearer <token>`).

So control travels the tailnet; browsing travels the device.

## Try it (development APK)
Download the checked-in [v0.55 debug APK](dist/app-debug.apk). It was built from commit `8adcf28`
after the Android build, consent test, shared desktop tests, and desktop compilation passed.
SHA-256: `15b068579541cf55529b64197eee76b8a16324e36d79373358a78e27f7065e61`.

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

Phone platform logins stay on the phone unless you turn on **Share this login with cluster** for that
platform in Settings. Sharing copies session cookies to the cluster. Android's WebView cookie API does
not expose the original scope or HttpOnly flags, so only enable sharing for accounts you choose to
share. You can also sign in separately in the hosted cluster profile.

## What's next
Embed Tailscale (`tsnet`/gomobile) so joining the tailnet is one tap inside the app; a live-view stream
for the console; and a laptop sibling that drives real desktop Chrome over CDP behind the same API.
