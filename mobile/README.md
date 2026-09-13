# GB Mobile — Ghost Browser on your own device

A prototype of Ghost Browser as a **native Android app** running a **real on-device Chromium WebView**.

## Why
A browser on a server/VPS is detectable as automated — datacentre IP, virtual display, DevTools control.
Running on the actual phone gives what a server can never fake: a **real residential IP**, a **real device
hardware fingerprint**, and **real touch input**. This is the first scaffold: an address bar + a full-screen
WebView that presents as ordinary mobile Chrome (the `; wv` marker is stripped from the user-agent, third-party
cookies are accepted so Cloudflare clearance persists).

## Try it (prebuilt debug APK)
Download **[`dist/app-debug.apk`](dist/app-debug.apk)** on your Android phone, allow "install from unknown
sources", install, open. It starts on the Rapyd sign-up page; type any URL in the bar to browse.

> Debug build, unsigned for the Play Store — fine for sideloading and testing.

## Build it yourself
Requires the Android SDK + JDK 17+.
```
./gradlew assembleDebug      # -> app/build/outputs/apk/debug/app-debug.apk
```

## Next (the agent-control layer)
This scaffold proves on-device browsing. The Ghost Browser control surface (evaluate JS, read the DOM as
numbered elements, act) plugs in via `WebView.evaluateJavascript` + a JS bridge — the same "perceive then act"
model as the server engine, but on real hardware.
