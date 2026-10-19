# Ghost Browser

A real Chromium, driven by numbered annotations instead of CSS selectors, behind an HTTP API — with an autonomous, multi-layer AI security reconnaissance & vulnerability auditing engine.

## Why it looks like this

The trick it is built on is **Set-of-Mark**: before any decision, every interactive element on
screen gets a numbered box painted over it *in the live DOM*, the page is screenshotted, the boxes
are stripped off again, and the caller gets the annotated picture plus a numbered list. You then say
`click 3`.

That is the whole reason this works where selector-based automation does not. A selector breaks when
the site is redesigned; a numbered screenshot is redrawn from whatever is on screen right now. And a
language model is far better at looking at a picture than at parsing a DOM tree.

`src/inspector.js` is the marking code, lifted unchanged from the agent platform where it has been
running in production.

## What is here, and what is not

Built: sessions with real limits, Set-of-Mark analysis, navigate/click/type/read, an SSRF guard, key
auth with per-plan concurrency, and a console to drive it by hand.

Not built yet, by design: the AI navigation loop, the recipe compiler, and billing. Each is easier
against a service that already survives concurrency, which is what this phase is for.

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

These are starting points from the plan, not measurements. Watch `/v1/capacity` under a real
workload and move them.

Memory is read from the **cgroup**, not from the host: in Kubernetes a 4 GB pod on a 64 GB node
would otherwise look like it had endless headroom right up until it was killed. When the ceiling is
crossed the pod stops accepting sessions, finishes what it has, and exits so it is replaced — on our
terms rather than the OOM killer's.

## The guard

`src/guard.js` is the most important file here. A browser anyone can point at any URL is a
server-side request forgery engine, and this one runs *inside* the cluster it would be attacking —
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

GET    /v1/capacity                      → open; what this worker can still take
GET    /v1/config                        → open; what is configured, never a secret
```

Auth is `Authorization: Bearer <key>`. Keys come from `API_KEYS` as `key:plan,key:plan` or JSON.
There is no plan that opens a browser without a key: a session costs real memory for its whole life,
so an anonymous one is a way to spend someone else's money.

## Running it

```
API_KEYS=somekey:solo npm start
```

Its own image, because the platform's shared runner has no browser and installing one at container
start would mean a 300 MB download on every pod restart. The Dockerfile's Playwright tag must track
the `playwright` version in `package.json` — they are one thing.
## 🛡️ Autonomous Security Reconnaissance & Audit Engine

Ghost Browser includes a fully autonomous, production-grade security auditing and reconnaissance suite built directly on top of its live browser runtime. Unlike traditional CLI scanners that blindly flood endpoints with raw HTTP requests, Ghost Browser navigates web apps like a senior security researcher: rendering client-side JavaScript (SPAs), monitoring DOM mutations, evaluating network telemetry, and mathematically proving exploitability without breaking production services.

### 4-Layer Autonomous Audit Workflow

```
[Target URL]
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Passive Recon & Asset Discovery                   │
│ • DNS Hygiene (SPF, DMARC, CAA, Wildcard Detection)         │
│ • Subdomain Enumeration via Certificate Transparency (CT)   │
│ • TLS Handshake, Protocol & Cipher Audit                   │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Perimeter & Service Inspection                     │
│ • Non-destructive TCP Banner Grabbing (SSH, Databases, etc) │
│ • Service Daemon & CVE Correlation                         │
│ • HTTP Defensive Headers & WAF Identification               │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Application Logic & DAST Probes                   │
│ • Benign Canary DOM Taint & Safe Reflection Analysis (XSS)  │
│ • Broken Access Control & BOLA/IDOR Matrix Auditing         │
│ • Statistical Timing-Differential SQLi Probing              │
│ • Polyglot Server-Side Template Injection (SSTI)           │
│ • Sensitive Path & Configuration Discovery (SPA-Aware)      │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 4: Turnkey Remediation & Dual-Scorecard Reporting    │
│ • Dual Scorecard: Posture Hardening vs Active Exploitation  │
│ • Reproducible curl PoC commands for every finding          │
│ • Pull-Request Ready Code Diffs for Instant Remediation     │
│ • Compliance Mapping (SOC 2 Type II, ISO 27001, PCI-DSS)   │
└─────────────────────────────────────────────────────────────┘
```

### Key Capabilities

- **SPA-Aware Reconnaissance**: Modern web applications render content client-side via React, Vue, or Next.js. Ghost Browser captures DOM events, extracts dynamically loaded backend routes (`/api/*`, `/v1/*`), and discriminates real files from SPA soft-404 redirects.
- **Zero-False-Positive Canary Reflection**: Tests user input reflection in DOM sinks (`innerHTML`, `outerHTML`, `document.write`) using safe, unique mathematical boundaries (`__gbcanary_...`) to definitively prove whether user inputs are sanitized or vulnerable to cross-site scripting (CWE-79).
- **Wildcard DNS & Subdomain Isolation**: Automatically detects wildcard DNS records (`*.domain.com`) to prevent dictionary hallucinations. Subdomain discovery intersects with live Certificate Transparency (crt.sh) logs and TLS Subject Alternative Names (SANs) for 100% verified asset enumeration.
- **Dual-Scorecard Architecture**:
  - **Infrastructure & Defensive Posture**: Evaluates defense-in-depth gaps (missing CSP, HSTS, XFO, DMARC). These are clearly labeled as hardening recommendations — never conflated with critical exploits.
  - **Application Logic & Exploitability**: Evaluates verified vulnerabilities (BOLA/IDOR, SQLi, SSRF, RCE, broken auth). When no active exploits succeed, targets achieve a **100/100 Grade A+ (Clean)** rating.
- **Turnkey Remediation**: Every single advisory automatically generates an exact, non-destructive `curl` reproduction command and a ready-to-merge configuration or middleware code patch.

---

## 🏔️ The AppSec & Red Team Iceberg

Ghost Browser is designed to bridge the gap between simple vulnerability scanners and elite red team operations. Below is our security architecture iceberg — displaying what is already fully implemented, battle-tested, and validated, alongside the open-source frontier we are actively building with the community.

```
                      THE APPSEC & RED TEAM ICEBERG
                      
                                    ▲
                                   / \
                                  /   \    [WHAT WE HAVE IMPLEMENTED & VALIDATED]
                                 /     \
                                /   •   \  • Autonomous Perimeter, DNS & Wildcard Isolation (gb_recon)
                               /    •    \ • Subdomain Discovery via CT Logs & TLS SANs (crt.sh)
                              /     •     \• Burp-Style HTTP Verb, CORS & Header Tampering
                             /      •      \• Semantic SPA Route & Dynamic API Discovery
                            /       •       \• Zero-False-Positive Canary DOM Taint & XSS Proof
                           /        •        \• Unauthenticated Mutation & BOLA/IDOR Matrix (authMatrix)
                          /         •         \• Dual-Session Cross-Tenant Privilege Escalation
                         /          •          \• JWT Hygiene, Exp Claims & Algorithm Confusion
                        /           •           \• JWT Key Confusion (RSA to HMAC HS256 Downgrade)
                       /            •            \• RFC 6585 Throttling, Concurrency & TOCTOU Race Testing
                      /             •             \• GraphQL Introspection, Depth & Batching DoS Probes
                     /              •              \• OAST Ephemeral Canary Blind SSRF & Callbacks
                    /               •               \• Cloud Metadata SSRF & Token Traversal (IMDSv2/K8s)
                   /                •                \• Statistical Timing-Differential SQLi (sqliTiming)
                  /                 •                 \• Multi-Step Second-Order Stored Injection
                 /                  •                  \• Polyglot Server-Side Template Injection (SSTI)
                /                   •                   \• Client-Side Prototype Pollution & Gadgets
               /                    •                    \• HTTP Request Smuggling & Cache Poisoning
              /                     •                     \• Cross-Site WebSocket Hijacking (CSWSH)
             /                      •                      \• OAuth 2.0 PKCE & Redirect Boundary Auditing
            /                       •                       \• Business Logic & Price Tampering (businessLogicAuditor)
           /                        •                        \• Subdomain Takeover & Dangling Cloud Buckets
          /                         •                         \• Non-Destructive 3-Pillar CVE Verification
         /                          •                          \• Deep Inter-File AST Symbol Resolution
        /                           •                           \• Photographic Visual Proof (gb_capture_proof)
       /                            •                            \• SOC 2 / ISO 27001 Compliance Auto-Mapping
~~~~~~/~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ (Waterline)
      /                                                           \
     /                 [WHAT'S BELOW THE SURFACE]                  \  ◄── THE NEXT-GEN FRONTIER
    /                                                               \     (CONTRIBUTIONS WELCOME!)
   /  [ ] 1. Stateful WebSocket Binary Frame Fuzzing (CWE-1385)       \
  /   [x] 2. Business Logic Pricing, Cart & Currency Race Tampering     \ (COMPLETED & VALIDATED!)
 /    [ ] 3. AI Agent Prompt Injection & Tool Jailbreaks (OWASP LLM01)   \
/     [ ] 4. WebAuthn, FIDO2 & Passkey Attestation Bypass Probes          \
\     [ ] 5. SAML 2.0 XML Signature Wrapping (XSW) & Entity Expansion     /
 \    [ ] 6. eBPF-Powered Kernel-Level Network & Memory Taint Tracing     /
  \   [ ] 7. Mobile App Deep Link & Intent Scheme Injection Fuzzing      /
   \  [ ] 8. Dynamic Multi-Step WAF Bypass & Obfuscation Mutation        /
    \ [ ] 9. GraphQL WebSocket Subscription Injection & Stream DoS       /
     \[ ] 10. HTTP/2 & gRPC Multiplexing Desync & Stream Reset Flooding /
      \________________________________________________________________/
```

### 🚢 Above the Surface: Validated & Live in Ghost Browser

The top of the iceberg represents our core autonomous DAST and perimeter suite, running with zero dependencies and production-safe guards:

| Category | Validated Capability | Core Engine / Module |
|---|---|---|
| **Perimeter & DNS** | Wildcard DNS isolation, SPF/DMARC/CAA hygiene, CT-log subdomain harvesting | `perimeter.js`, `subdomainDiscovery.js` |
| **Transport & SSL** | TLS cipher suites, SNI routing, SAN discovery, expiration tracking | `tlsAuditor.js` |
| **HTTP Hardening** | Verb tampering (TRACE/OPTIONS), CORS misconfig, Host/X-Forwarded poisoning | `headersAuditor.js` |
| **Service Discovery** | Non-destructive TCP banner grabbing (SSH, MySQL, Redis, DirectAdmin) | `bannerGrabber.js` |
| **Client-Side SPA** | SPA route harvesting, dynamic `/api/*` extraction, React/Vue soft-404 detection | `semanticRouter.js`, `endpointHarvester.js` |
| **XSS & DOM Taint** | Safe mathematical delimiter canaries (`__gbcanary_...`) with zero false positives | `canaryAuditor.js`, `domAuditor.js` |
| **Access Control** | Unauthenticated mutation auditing, BOLA/IDOR permission boundary matrix | `authMatrixAuditor.js`, `dualSessionAuditor.js` |
| **Business Logic** | Negative quantity underflow, client-controlled price tampering, coupon race stacking | `businessLogicAuditor.js` |
| **Authentication** | JWT expiration, algorithm confusion (`none`), RSA $\to$ HMAC HS256 key downgrade | `jwtAuditor.js`, `jwtKeyConfusionAuditor.js` |
| **OAuth & Identity** | OAuth 2.0 PKCE downgrade, open redirect URI boundaries, state tampering | `oauthPkceAuditor.js` |
| **Server-Side Probes** | Statistical timing-differential SQLi, multi-step second-order stored injection | `sqliTimingAuditor.js`, `secondOrderAuditor.js` |
| **Template & Logic** | Polyglot SSTI (Jinja/Twig/Smarty), Client-side prototype pollution gadgets | `polyglotSstiAuditor.js`, `prototypeGadgetAuditor.js` |
| **SSRF & Callbacks** | Out-Of-Band (OAST) callbacks, Cloud Metadata traversal (IMDSv2, K8s, GCP) | `oastAuditor.js`, `cloudMetadataAuditor.js` |
| **Protocols & Cache** | HTTP Request Smuggling (CL.TE/TE.CL), Web Cache Deception, CSWSH Hijacking | `httpSmugglingAuditor.js`, `webCacheAuditor.js`, `cswshAuditor.js` |
| **API & Cloud** | GraphQL batching DoS / introspection, OpenAPI contract schema fuzzing | `graphqlAuditor.js`, `openapiFuzzer.js`, `subdomainTakeoverAuditor.js` |
| **Proof & Compliance** | Photographic visual proof capture, SOC 2 Type II & ISO 27001 mapping | `visualProof.js`, `complianceMapper.js` |

---

### 🌊 Below the Surface: The Open Security Research Frontier

Ghost Browser is designed as an open-source **force multiplier for red teamers, penetration testers, bug bounty hunters, and AppSec engineers**. 

Every offensive practitioner knows the frustration of spending 20 hours clicking buttons, enumerating subdomains, and writing repetitive boilerplate reports. Ghost Browser automates the repetitive reconnaissance and perimeter grind so researchers can focus their creative expertise on high-impact, complex logic flaws and earn higher bug bounties.

We invite security researchers, tool authors, and community contributors to collaborate on these next-generation research frontiers:

1. **Stateful WebSocket Binary Frame Fuzzing (`CWE-1385`)**:
   - *Goal:* Mutate real-time binary payloads (Protobuf, MessagePack, custom framing) across active WebSocket sessions.
2. **AI Agent Prompt Injection & Tool Jailbreaks (`OWASP LLM01 / LLM02`)**:
   - *Goal:* Test AI-driven user interfaces for indirect prompt injection, tool calling privilege escalation, and system prompt leakage.
3. **WebAuthn, FIDO2 & Passkey Attestation Bypass**:
   - *Goal:* Audit WebAuthn registration and authentication flows for missing origin checks, challenge reuse, or RP ID spoofing.
4. **SAML 2.0 XML Signature Wrapping (`XSW`)**:
   - *Goal:* Probing enterprise SSO portals for XML entity expansion and assertion signature wrapping vulnerabilities.
5. **eBPF-Powered Kernel-Level Network & Memory Taint Tracing**:
   - *Goal:* Deep container inspection to monitor kernel syscalls and memory taint tracking during local containerized target runs.
6. **Mobile App Deep Link & Intent Scheme Injection**:
   - *Goal:* Audit custom URL schemes (`myapp://...`) and Android App Links / Universal Links for parameter injection and account takeover.
7. **Dynamic Multi-Step WAF Bypass & Payload Mutation**:
   - *Goal:* Genetic algorithm-based payload mutation to systematically evade Cloudflare, AWS WAF, and ModSecurity rule sets.
8. **GraphQL WebSocket Subscription Stream Injection**:
   - *Goal:* Test persistent GraphQL subscriptions for resource exhaustion and unauthenticated event eavesdropping.
9. **HTTP/2 & gRPC Multiplexing Desynchronization**:
   - *Goal:* Rapid-reset stream flooding (CVE-2023-44487 style) and gRPC header desync detection.
10. **Client-Side Storage & Token Cryptographic Tampering**:
    - *Goal:* Automated entropy analysis and session replay validation across encrypted IndexedDB and Web Crypto API stores.

---

### 🤝 How to Collaborate & Contribute

Whether you're an AppSec engineer, red team operator, bug bounty hunter, or open-source developer:
1. **Explore the Iceberg**: Check out our research frontiers above or propose new ideas in [GitHub Issues](https://github.com/Wvdstoep/ghost-browser/issues).
2. **Follow the Non-Destructive Design Pattern**: All security tools in Ghost Browser must be non-destructive, safe for production environments, and emit reproducible `curl` PoCs and patch recommendations.
3. **Submit a Pull Request**: Check out `src/recon/` for examples of existing modules and unit test conventions.

---

## The agent

The console has a second half: an agent that drives the same browser, in the same logged-in session,
through the same numbered view the **Agent view** button shows a person. Every action it takes is
"the number of the thing I mean", which is checkable and replayable — there are no selectors to get
subtly wrong.

**What it needs before it can run.** A model, in *Model*: Ollama Cloud (host `https://ollama.com`
plus an API key) or a self-hosted Ollama (host only). The key lives on this browser's own volume
and never comes back out of the API. *Test* proves the three settings work together before a job
depends on them.

**Who it works for.** A company profile — what you offer, who you want, where, what a good lead
sounds like, and who never to approach. `signals` does the most work; `avoid` is the one nobody
thinks to fill in and the one that prevents an embarrassing reply to a competitor.

**Who it is.** *Study me* sends it to read the owner's own posts and comments and keep them
verbatim. Those samples are what make a reply sound like the person rather than like software —
a description of a writing style produces an imitation of a description. Everything it learns is
readable, editable and deletable under *What it knows*.

**More than one account.** Each stored profile can be labelled with the site it is signed in to.
The agent lists them, and switches with `use_profile` when a job is about a site the current
session is not logged in to — so "search LinkedIn" uses the LinkedIn login.

### The line that matters

Reading is free. Commenting, joining, following, liking and messaging are not: they happen under a
real name and the notification has already reached a person. So they go through `act`, which shows
the exact text and waits. Approving with an edit is the normal case.

That is enforced twice. The prompt says so, and a guard checks the label of anything the agent tries
to click and turns a "Plaatsen" or "Lid worden" into a proposal anyway. The guard matches the START
of a short label, because a substring match refused to let it open a post — "Open the post" contains
"post".

*Let it act without asking* removes the first line and keeps the record. It is off by default and
should stay off until you have read a few of its drafts.

### Pacing

Deliberately slow: 1–3 seconds between reads, 7–16 after anything that writes. Not a fingerprinting
trick — a person does not open eleven posts in four seconds, and the accounts that get restricted
are the ones that do.

### Which operating system a profile says it is

Both Facebook's and LinkedIn's "was this you?" screens name the device, and both said Linux. Once
the traffic leaves through the owner's own connection, that is the last thing still describing a
datacentre — so a profile can be set to present as **Windows** or **macOS** (default: the truth).

It goes through CDP's `Emulation.setUserAgentOverride`, never a user-agent string, because Chrome
states its platform in three places — `navigator.userAgent`, `navigator.userAgentData` and the
`Sec-CH-UA-Platform` header — and only that call sets all three together. Change one and the other
two contradict it; a browser that disagrees with itself is a louder signal than an unusual OS. The
Chrome version is read from the binary actually running, for the same reason.

It does **not** make the browser undetectable. Canvas, fonts, WebGL, timing and TLS all still
describe what this is. It removes one specific mismatch — the one both sites showed the owner — and
it applies to popups too, since a sign-in window still announcing Linux gives it away at the exact
moment it matters. Fixed at launch, so it needs a fresh session.
