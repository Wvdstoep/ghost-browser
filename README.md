# Ghost Browser

A real Chromium, driven by numbered annotations instead of CSS selectors, behind an HTTP API — with an AI agent, a workflow engine, and record/replay on top.

**→ [Set it up on your own VPS in ten minutes](SETUP.md)** — including routing the browser out through your own home connection so sites see a residential address.

## Why it looks like this

The trick it is built on is **Set-of-Mark**: before any decision, every interactive element on
screen gets a numbered box painted over it *in the live DOM*, the page is screenshotted, the boxes
are stripped off again, and the caller gets the annotated picture plus a numbered list. You then say
`click 3`.

That is the whole reason this works where selector-based automation does not. A selector breaks when
the site is redesigned; a numbered screenshot is redrawn from whatever is on screen right now. And a
language model is far better at looking at a picture than at parsing a DOM tree.

`src/inspector.js` is the marking code.

## What's here

- **Sessions** with real limits — one Chromium per pod, an isolated context (cookies + storage) per session.
- **Set-of-Mark analysis** — the numbered-annotation perception that makes clicks robust to redesigns.
- **navigate / click / type / read / run_script / click_text** over a plain HTTP API.
- **An AI agent** that drives the same browser through the same numbered view a person sees, with an
  act-gate that turns any public write (post, join, follow, message) into a proposal you approve.
- **A workflow engine** — compose named flows of typed nodes (trigger, agent, fetch, extract, script,
  store, filter, branch, collect, verify, check-login) with per-step budgets and outcome-as-data.
- **Route cards** — record a platform's own traffic once, distil it, and replay it: the browser
  learns a site's API from watching itself use it.
- **A session pool** with per-profile workers, and a built-in **Tailscale exit** so a profile can
  leave through a residential connection instead of the datacentre.
- **An SSRF guard**, key auth with per-plan concurrency, and a **console** to drive any of it by hand.

## The limits are the product

A browser session is not a request — it is a live process holding memory for its whole life. One
Chromium per pod with a **context** per session (isolated cookies and storage, shared process) is
the difference between roughly two sessions per pod and ten.

| Limit | Default | Env |
|---|---|---|
| Sessions per pod | 8 | `MAX_CONTEXTS` |
| Idle before close | 5 min | `IDLE_MS` |
| Absolute session TTL | 2 h | `SESSION_TTL_MS` |
| Drain at memory | 80% | `MEMORY_LIMIT_PCT` |

Memory is read from the **cgroup**, not from the host: in Kubernetes a 4 GB pod on a 64 GB node
would otherwise look like it had endless headroom right up until it was killed. When the ceiling is
crossed the pod stops accepting sessions, finishes what it has, and exits so it is replaced — on our
terms rather than the OOM killer's.

## The guard

`src/guard.js` is the most important file here. A browser anyone can point at any URL is a
server-side request forgery engine, and this one may run *inside* the cluster it would be attacking —
the metadata endpoint, the Kubernetes API, another tenant's service are all just URLs from in here.

Two bypasses it specifically closes: a public hostname that **resolves** to a private address (so
names are resolved and every returned address is checked), and a public URL that **redirects** to
one (so the landing URL is re-checked after navigation, and the page is blanked if it moved
somewhere it should not).

## API

```
POST   /v1/sessions                      → { sessionId, expiresAt, plan }
POST   /v1/sessions/:id/navigate         { url }
GET    /v1/sessions/:id/analyze          → { elements, summary, screenshot }
POST   /v1/sessions/:id/click            { index } | { text }
POST   /v1/sessions/:id/type             { index, text, submit }
GET    /v1/sessions/:id/content          → cleaned page text
GET    /v1/sessions/:id/screenshot       → image/jpeg
DELETE /v1/sessions/:id

GET    /v1/workflows                     → saved flows, enriched with outcomes
POST   /v1/workflows                     { name, nodes, edges }
POST   /v1/workflows/:id/run             → run a flow

GET    /v1/capacity                      → open; what this worker can still take
GET    /v1/config                        → open; what is configured, never a secret
```

Auth is `Authorization: Bearer <key>`. Keys come from `API_KEYS` as `key:plan,key:plan` or JSON.
There is no plan that opens a browser without a key: a session costs real memory for its whole life,
so an anonymous one is a way to spend someone else's money.

## Running it

```
npm install
API_KEYS=dev:solo npm start        # console at http://localhost:3000
npm test                           # vitest
```

It ships as its own image, because a shared runner has no browser and installing one at container
start would mean a ~300 MB download on every pod restart. The Dockerfile's Playwright tag must track
the `playwright` version in `package.json` — they are one thing.

## The agent

The console has a second half: an agent that drives the same browser, in the same logged-in session,
through the same numbered view the **Agent view** button shows a person. Every action it takes is
"the number of the thing I mean", which is checkable and replayable — there are no selectors to get
subtly wrong.

**What it needs before it can run.** A model, in *Model*: Ollama Cloud (host `https://ollama.com`
plus an API key) or a self-hosted Ollama (host only). The key lives on this browser's own volume
and never comes back out of the API. *Test* proves the settings work together before a job depends
on them.

### The line that matters

Reading is free. Commenting, joining, following, liking and messaging are not: they happen under a
real name and the notification has already reached a person. So they go through `act`, which shows
the exact text and waits. Approving with an edit is the normal case.

That is enforced twice. The prompt says so, and a guard checks the label of anything the agent tries
to click and turns a "Post" or "Join" into a proposal anyway.

*Let it act without asking* removes the first line and keeps the record. It is off by default and
should stay off until you have read a few of its drafts.

### Pacing

Deliberately slow: 1–3 seconds between reads, 7–16 after anything that writes. Not a fingerprinting
trick — a person does not open eleven posts in four seconds, and the accounts that get restricted
are the ones that do.

### Which operating system a profile says it is

A profile can be set to present as **Windows** or **macOS** (default: the truth). It goes through
CDP's `Emulation.setUserAgentOverride`, never a bare user-agent string, because Chrome states its
platform in three places — `navigator.userAgent`, `navigator.userAgentData` and the
`Sec-CH-UA-Platform` header — and only that call sets all three together. It does **not** make the
browser undetectable; canvas, fonts, WebGL, timing and TLS all still describe what this is. It
removes one specific mismatch, and applies to popups too.

## Contributing

Contributions are very welcome — **especially UI and design.** The console works, but it was built
by an engineer, not a designer, and it shows. If you can make it cleaner, clearer, or nicer to use,
please open an issue or a PR. See [CONTRIBUTING.md](CONTRIBUTING.md), and the issues tagged
`good first issue` and `ui`.

## License

[MIT](LICENSE).
