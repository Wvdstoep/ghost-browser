# Contributing to Ghost Browser

Thanks for being here. Contributions are genuinely welcome — bug fixes, new tools, docs, and
**especially UI and design.** The console is functional but was built by an engineer, not a
designer; if you can make it clearer or nicer to use, that is some of the most valuable work you
could do here. Look for issues tagged `ui` and `good first issue`.

## Running it locally

```
npm install
API_KEYS=dev:solo npm start     # console at http://localhost:3000
npm test                        # vitest
```

The first run downloads a matching Chromium via Playwright. The Dockerfile's Playwright image tag
and the `playwright` version in `package.json` must move together — they are one thing.

## What makes a good PR

- **Keep it focused.** One change per PR is easier to review and to ship.
- **Add or update a test.** Tests live in `__tests__/` and run under vitest. If you fix a bug, add
  the test that would have caught it; if you add a branch, cover it.
- **Match the surrounding style.** Read the file you are changing and write code that looks like it.
- **Explain the "why"** in the PR description, not just the "what".

## How your change reaches production

This repository is the **single source of truth**. Ghost Browser runs a hosted platform, and that
platform builds its image from this repo's `main`. A merged PR is not a change that sits on a shelf —
it is built and rolled out. That is the point of open-sourcing it, and it is also why:

- **Every PR is reviewed before merge.** Nothing is auto-merged.
- **Tests must pass.** A change that ships to a live browser fleet is held to that bar.

## Security

Ghost Browser can be pointed at any URL and runs inside real infrastructure, so `src/guard.js`
(the SSRF guard) and the act-gate are load-bearing. If you find a security issue, please report it
privately by opening a minimal issue asking for a contact rather than posting details publicly.
Never weaken the guard or the act-gate to make something else easier without saying so explicitly in
the PR.
