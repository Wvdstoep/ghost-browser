# Ghost Browser — where the frontier is, and where it is still open

Date: 2026-10-07. Method: repo read (see earlier audit) + web searches. "Not found" below means *I did not find it in a handful of searches*, not that it does not exist. Treat every "open" item as a hypothesis to check before building.

## Status (2026-10-07, after the build session)

Built, pushed and tested end to end in a real Chromium. "Simulated" says what stood in for hardware.

| Idea | Where | Tested how | Simulated / not covered |
|---|---|---|---|
| Read cards, verified against the UI walk | `src/readcards.js`, `readcardRoutes.js`, `/v1/sessions/:id/readcard/*` | Real Chromium: baseline UI walk vs card replay, decoy endpoint, renamed field refused, re-learn; mutation-checked | Run on a **local fixture**, not a live site (this sandbox's network blocks public hosts). **Not wired into the agent loop or workflow engine**; usable via HTTP and MCP |
| Shadow verification | `src/cardshadow.js` | A card that answers 200 with the right shape but stale data passes its own check and is caught by the shadow check | Fixture API versioning stands in for a real site change |
| Wire-level write gate | `src/lease.js`, `/v1/sessions/:id/lease` | Obeyed prompt injection, form/beacon/XHR against a cookie-only endpoint, scoped lease with use limits, mid-session revoke, expiry; mutation-checked | Does not see GET side effects or WebSocket frames; a service worker already controlling a page keeps doing so until reload. **Taint tracking was not built** |
| Passkey answered by the owner's device | `src/authrelay.js`, `src/ringauth.js`, `scripts/ring-node-ref.js` | Page → relay → real device hub → node → real WebAuthn verification by the site; decline, timeout and no-device all fail safe | The "device" is a software authenticator. **No phone/laptop app implements the contract yet** (`POST /v1/webauthn`, feature `webauthn`); the mobile/desktop apps were not touched |
| Device-bound sessions | `src/boundSessions.js`, `sessionVault.js` | Header announcement detected, host routed to the device ring, vault stops saving/restoring its cookies; a copied jar dies at its TTL while the original browser keeps its session | Binding key is WebCrypto in the page, not a TPM. Header names follow the DBSC proposal and were **not** checked against a live deployment |
| MCP server | `src/mcp.js`, `POST /mcp` | Protocol core, stdio against a stand-in, `/mcp` on the real server (a real browser session refused an IPv6-mapped metadata address through MCP) | Not tried with a real MCP client app |
| WebMCP | `src/webmcp.js` | Tools registered via `navigator.modelContext` and `document.modelContext` found and called; a writing tool is blocked by the lease | The spec is moving and this Chromium has no native implementation, so only the capture path was exercised |
| Walls benchmark | `scripts/walls-bench.js`, `docs/WALLS-BENCH.md` | Runs in CI | "Naive" is a stand-in; no comparison with other products |
| SSRF fix | `src/guard.js` | 40 tests, every IPv6 spelling that used to bypass it | none |

Not done: encrypting the cookie vault and TOTP secrets at rest; removing query-string tokens; splitting
`server.js`; the live no-login run (needs the host allowed); real-hardware tests of passkeys and DBSC.

Correction: I earlier suggested `shadow.js` hinted at card shadow-verification. It is the model-training
ledger and unrelated; `src/cardshadow.js` is new.

## 0. Correction to my first audit

I called route cards (learn a site's internal API from its own traffic, replay in the logged-in session) a rare idea. It is not. It is now a crowded category:

- HAR → generated API client: [reverse-api-engineer](https://github.com/kalil0321/reverse-api-engineer), [Integuru](https://www.integuru.com/blog/reverse-engineer-website-private-api), Unbrowse (shared "skills" learned from browsing).
- Record once, replay cheaply, fall back to the LLM and re-learn on breakage: Stagehand action caching with self-healing, Skyvern code caching, "explore then compile" with intent metadata ([sources](https://www.mintlify.com/browserbase/stagehand/best-practices/deterministic-agents), [Skyvern](https://skyvern.com/docs/developers/features/code-caching)).

What Ghost Browser has beyond that: cards store *where* a token lives, never the value; a replay that is not read back and verified counts as a failure; failing cards are quarantined. That is good engineering, but it is a refinement, not a new category. Do not market it as the headline.

## 1. The ground is moving under the "persist the cookie jar" model

Everything in `sessionVault.js` assumes a session is a set of cookies that can be written to disk and put back. That is exactly what **Device Bound Session Credentials** break. Chrome 146 on Windows binds session cookies to a TPM-held key; servers require proof of possession to refresh short-lived cookies; a copied cookie is useless ([coverage](https://www.bleepingcomputer.com/news/security/google-chrome-adds-session-cookie-theft-protection-for-all-users/)). macOS (Secure Enclave) follows. Once Google, Microsoft and large SaaS adopt it:

- cookie snapshots and restore, cookie export/import, "log in on a laptop, run on the cluster" all stop working for those sites;
- a datacentre pod has no TPM, so it can never hold such a session.

This is the single most important strategic fact for the project, and nothing in the repo anticipates it.

## 2. Ideas that look open (ranked by how much I believe in them)

### A. "The session never leaves the device" — make the device ring the architecture, not a workaround
Today the ring is sold as "pass Cloudflare from a real phone". Reframe: the login (and its device-bound key) lives only on the owner's real device; the cluster sends *intents* and receives *results*; credentials and cookies are never exported. That survives DBSC, passkeys and attestation, and it is the opposite of a stealth pitch. Concretely: ring nodes run the route-card replay locally (the card travels, the session does not), and a node reports "session bound / session alive" instead of a cookie list.
Status: I found no agent browser built around device-bound sessions. Risk: DBSC adoption may stay thin for years; Chrome binds the key to the Chrome profile, so the node must drive the user's real Chrome profile, not a fresh JCEF/WebView.

### B. A wire-level write gate, derived from the cards
The act-gate today sits at the tool level: the model proposes a post, a human approves. A prompt-injected page can still talk the model into a different tool call. Route cards already know which requests are mutating (method + URL template). Enforce the gate at the network layer instead: a **capability lease** — signed, scoped, expiring ("this profile, read-only, 20 minutes", or "may POST only to the reply endpoint, with this body") — enforced by intercepting requests (CDP `Fetch.requestPaused`) so a write that is not covered by the lease cannot leave the browser regardless of what the model decided. Add taint tracking: text that came from a page cannot become a write parameter without passing the gate.
Status: capability-based agent security and taint ideas exist in research and in a few agent frameworks; I did not find them enforced at the browser's network layer for logged-in sessions. Medium confidence it is open.

### C. Shadow-verified cards (contract testing for scraped APIs)
Cards decay silently: the API changes, the replay still returns 200 with different meaning. Periodically run the UI path and the card path on the same intent, in a read-only mode, and diff the results. A card earns trust by agreeing with the ground-truth UI path, loses it when drift appears, and the diff is the repair signal. `shadow.js` hints at part of this; I did not read it closely enough to say how far it goes.
Status: self-healing on *failure* is common; *proactive differential verification* I did not find.

### D. Be a good citizen where the web is building lanes: WebMCP + signed identity
- **WebMCP** (Google/Microsoft, W3C community group) lets a page register callable tools; recent sources say the surface moved from `navigator.modelContext` to `document.modelContext` in July 2026 ([overview](https://www.zuplo.com/blog/what-is-webmcp)). Consume it when a page offers it, ahead of numbered boxes and route cards. Invert it too: publish learned cards *as* WebMCP tools in the page, so any agent in any browser benefits.
- **Web Bot Auth / signed agent identity** ([overview](https://dev.to/webdecoy/ai-agent-authentication-in-2026-web-bot-auth-ard-oauth-247)): sign requests so a site can recognise and allow the agent. This is the opposite direction from stealth, and it is where the industry is heading. Sites that block anonymous bots will increasingly admit signed ones.
Status: standards in motion, not novel, but cheap to adopt early and it hedges the stealth bet.

### E. A public "walls" benchmark
Agent benchmarks measure tasks on open sites. I found none that measure success *behind* logins, MFA, Turnstile-style walls, DBSC and passkey prompts, using self-hosted fake SaaS fixtures. The repo already has the raw material (`siteWalls.js` learned data, per-site playbooks, 146 tests). A reproducible wall suite would give the project something nobody else owns and a way to prove (or disprove) its own claims.
Status: not found. Cheap to start, valuable because it also steers your own training loop.

### F. Passkey and MFA as relays to the owner's own device
Instead of refusing WebAuthn (current behaviour) or faking it, route the prompt to a ring node the owner holds, so the owner's real authenticator answers and the cluster never touches a key. Same principle as A, applied to second factors; it also replaces storing TOTP secrets next to the logins, which is the weakest link I found.
Status: speculative; needs the node to be the browser, or a hybrid-transport bridge.

## 3. Things I would not build, despite looking novel

- More stealth (canvas/WebGL spoofing, mouse curves). It is an arms race against attestation and device binding that the defender wins, it carries terms-of-service and account-loss risk for users, and it is the part of the project that is least defensible.
- A marketplace of shared route cards without a trust model. Unbrowse already points there; shared cards from strangers are an injection vector into other people's logged-in sessions.
- More ML-training machinery inside this repo. It is the largest code mass and has the least to do with the browser.

## 4. Suggested order

1. Fix the SSRF IPv6 bypass (known bug; prerequisite for anything).
2. MCP server + WebMCP consumption (table stakes, small).
3. Wire-level lease/write gate (B) — builds on cards you already have.
4. Walls benchmark (E) — gives every later claim evidence.
5. Device-bound-session design spike (A, F) — decide before DBSC adoption forces it.
