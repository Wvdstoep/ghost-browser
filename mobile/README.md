# GB Mobile — Ghost Browser on your own device

Ghost Browser as a **native Android app** running a **real on-device Chromium WebView**. Because it
runs on your real phone — real residential IP, real device fingerprint, real touch — it walks straight
through walls a server can't (proven: it passes **Cloudflare Turnstile** where the hosted server loops).

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

## Try it (prebuilt debug APK)
Download **[`dist/app-debug.apk`](dist/app-debug.apk)** on Android, allow "install from unknown sources",
install, open. Type any URL in the bar, or open **⚙** to run the agent / connect to the cluster.
Debug build, unsigned — fine for sideloading.

## Build it yourself
Needs the Android SDK + JDK 17+:
```
./gradlew assembleDebug   # -> app/build/outputs/apk/debug/app-debug.apk
```

## What's next
Embed Tailscale (`tsnet`/gomobile) so joining the tailnet is one tap inside the app; a live-view stream
for the console; and a laptop sibling that drives real desktop Chrome over CDP behind the same API.
