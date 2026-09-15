# Ghost Browser Desktop

Ghost Browser as a real desktop app — the same idea as GB Mobile, but on your laptop.
A real desktop Chromium on your real residential IP: desktop-only portals load **and**
Cloudflare passes (no mobile/UA mismatch). It joins the cluster as a drivable node
(same reverse channel and `/v1/*` commands as the phone, including `/v1/fetch`), with
isolated per-profile sessions, an on-device agent (your own Ollama/OpenAI-compatible
endpoint), your platform profiles, and the automations (flows) engine.

## Run from source
```
npm install
npm start
```

## Build a portable app (no signing, works without Developer Mode)
```
npx @electron/packager . GhostBrowserDesktop --platform=win32 --arch=x64 --out=dist --overwrite
```
Run `dist/GhostBrowserDesktop-win32-x64/GhostBrowserDesktop.exe`.

## Build a Windows installer (NSIS)
`npm run dist` (electron-builder). Requires Windows **Developer Mode** enabled (the
signer's cache extraction needs symlink privilege), or run the shell as Administrator.

## How it connects
Cluster tab → set your GB URL → Sign in (SSO) → open Ghost Browser from Tools → Connect.
The laptop registers with the backend device hub and shows up in `/v1/device/list`
alongside your phone; the backend drives whichever node you choose for a hunt.


## Drags that never hang

`/v1/drag` and the agent tool `drag_xy` run in the main process over CDP with drag-interception
(`Input.setInterceptDrags` + `Input.dispatchDragEvent`). Sending held-button mouse events through
`webview.sendInputEvent` made Chromium start a *native* drag-and-drop whenever the page asked for one
(HTML5 `draggable` - CapCut cards and clips): the browser process sat in an OS drag loop, the synthetic
mouse-up never ended it, and the node stopped answering until a human touched the mouse. With
interception the renderer's drag request comes back to us as `Input.dragIntercepted` and we finish it
with `dragEnter` / `dragOver` / `drop` at the target; canvas drags (no HTML5 DnD) just get the plain
mouse events. The result `{ok, dnd:true|false}` tells you which path ran.


## Importing media into CapCut = local upload, never a card drag

CapCut auto-adds a freshly imported LOCAL file straight to the timeline, so `/v1/upload_file`
(CDP `setFileInputFiles` on the general media input, `nth:2`) is the whole import - no drag. An
already-uploaded Uploads card, by contrast, cannot be automated onto the timeline at all: it is a
React pointer-drag with no HTML5 `draggable`, and neither synthetic click/hover/drag, nor a real
OS-mouse click, nor a real OS-mouse drag finalizes the drop (the OS drag even starts a native
browser drag loop an injected mouse-up cannot end - the drop zone highlights, nothing lands). Always
import the local file fresh. The node also has `/v1/hover` (real move-only, for hover-revealed
controls) but it does not rescue the card drop.
