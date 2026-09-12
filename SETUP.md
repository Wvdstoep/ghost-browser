# Setting up Ghost Browser on your own VPS

By the end of this you will have a real Chromium running on a server, that you drive from a web
console or an HTTP API — and, if you want it, **leaving through your own home internet connection
instead of the datacentre's**, so the sites it visits see a normal residential address.

It takes about ten minutes.

---

## 1. What you need

- A Linux VPS (any provider, any size from ~1 GB RAM up — a browser is memory-hungry, give it room).
- **Docker** on it. That is the whole runtime: the image already contains Chromium, the Xvfb
  virtual display it needs, and Tailscale. You do not install those yourself.
- Optional, for the AI agent: an [Ollama](https://ollama.com) API key (cloud) or a self-hosted
  Ollama endpoint. You can skip this and use Ghost Browser purely as a scriptable browser.

---

## 2. Run it

Build the image from this repo and start it:

```bash
git clone https://github.com/Wvdstoep/ghost-browser.git
cd ghost-browser
docker build -t ghost-browser .

docker run -d --name ghost \
  -p 3000:3000 \
  -e API_KEYS="pick-a-long-secret:team" \
  -v ghost-profiles:/profiles \
  ghost-browser
```

Two things matter here:

- **`API_KEYS`** is required — the server refuses to start without it. A session costs real memory
  for its whole life, so there is no anonymous access. The format is `key:plan,key:plan`; `team` is
  the highest-concurrency plan.
- **The `/profiles` volume** is where everything durable lives — logins, cookies, saved flows,
  roles, the agent's model key. Mount it, or you lose all of that on every restart.

Open `http://YOUR_VPS_IP:3000`. The first visit creates the owner account. (Put it behind a reverse
proxy with TLS before you expose it to the internet — it holds live logins.)

---

## 3. Drive it

Three ways, all the same browser:

- **The console** — click into a session and use it by hand, or watch the agent work.
- **The HTTP API** — `POST /v1/sessions`, then `navigate`, `analyze`, `click`, `type`, `read`.
  Auth is `Authorization: Bearer <your key>`. See the [README](README.md) for the full surface.
- **The agent** — give it a goal and let it drive, through the same numbered Set-of-Mark view a
  person sees. Writes that a real person would notice (posting, following, messaging) go through an
  act-gate that shows you the exact text and waits for approval.

For the agent, open **Model** in the console and point it at Ollama (cloud key, or a self-hosted
`OLLAMA_URL`). The key is stored on the `/profiles` volume and never comes back out of the API.

---

## 4. The part that makes it different: leave through your home connection

A browser running in a datacentre has a datacentre IP, and a lot of sites treat that as a red flag —
sign-ups get extra scrutiny, some content is geo- or bot-gated. Ghost Browser can route a profile's
traffic **out through a device you own at home**, so the exit address is an ordinary residential one
in your own country.

It does this with [Tailscale](https://tailscale.com) (already in the image), using a home machine as
an *exit node*. Nothing about this is a fingerprint trick — it is just choosing where your own
traffic leaves the internet.

### 4a. Turn a home device into an exit node

On any machine at home that stays on — a spare laptop, a Raspberry Pi, your desktop:

```bash
# install tailscale (see tailscale.com/download), then:
sudo tailscale up --advertise-exit-node
```

Then in the [Tailscale admin console](https://login.tailscale.com/admin/machines), open that
machine's `...` menu and **approve it as an exit node** (Tailscale requires this once, on purpose).

### 4b. Connect Ghost Browser to your tailnet

1. Create an [auth key](https://login.tailscale.com/admin/settings/keys) in the Tailscale admin
   (a reusable one is convenient).
2. In the Ghost Browser console, open the **exit / network** panel and paste the auth key. The
   browser joins your tailnet as a device called `ghost-browser`.
3. Choose your **home device** as the exit node. From now on, sessions leave through your home
   connection by default. (A device only appears here if it is advertising itself as an exit node —
   step 4a.)

### 4c. Prove it worked

Point a session at an IP-echo service and check the address:

```bash
curl -s -H "Authorization: Bearer YOUR_KEY" -X POST http://YOUR_VPS_IP:3000/v1/sessions
# then navigate that session to https://ipinfo.io/json and read it —
# the "org" and "city" should be your home ISP, not your VPS provider.
```

Per-profile control: a profile can leave through the tailnet (the default once one is connected),
or be pinned to leave straight from the server (`direct`) when a residential exit is not wanted.

---

## 5. Keep it running (production)

- **Persist `/profiles`** on a real volume. It is the whole state of the thing.
- **One browser per container.** Sessions are heavy; scale out with more containers, not more
  sessions per container. Watch `GET /v1/capacity`.
- **Kubernetes:** a Helm chart is included under [`deploy/ghost-tool`](deploy/ghost-tool). It mints
  an API key on first install and re-uses it on upgrades, so the key is stable across rolls.

---

## 6. Environment reference

| Variable | Default | What it does |
|---|---|---|
| `API_KEYS` | *(required)* | `key:plan,key:plan` — who may open a browser, at what concurrency |
| `PROFILE_DIR` | `/profiles` | where logins, flows, roles and the model key are stored |
| `PORT` | `3000` | HTTP port |
| `MAX_CONTEXTS` | `8` | sessions per container before it stops accepting more |
| `IDLE_MS` | `300000` | close a session after this long idle |
| `SESSION_TTL_MS` | `7200000` | absolute session lifetime |
| `MEMORY_LIMIT_PCT` | `80` | drain and recycle the container at this cgroup-memory fraction |
| `OLLAMA_URL` | — | self-hosted Ollama endpoint for the agent |
| `OLLAMA_API_KEY` | — | Ollama Cloud key for the agent (or set it in the console) |
| `TAILSCALE_HOSTNAME` | `ghost-browser` | the name this browser joins your tailnet as |
| `HEADLESS` | `false` | keep it false — a headful Chromium on Xvfb is far less detectable |

---

## Troubleshooting

- **"refuses to start"** — you did not set `API_KEYS`. That is deliberate.
- **The exit node does not appear** — the home device is not advertising itself (step 4a) or has not
  been approved in the admin console (both are required, once).
- **A live view is black** — the session's page is a background tab or a nearly-blank bot wall; the
  screencast only paints on change. This is one of the rough edges where **UI help is very welcome** —
  see [CONTRIBUTING.md](CONTRIBUTING.md).
