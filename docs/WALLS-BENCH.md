# Walls benchmark

What an agent does at the walls that sit *behind* a login, measured on self-hosted test sites (`testbed/`).
Run it: `node scripts/walls-bench.js` (add `--json` for the raw results). It also runs in CI as
`__tests__/walls-bench.e2e.test.js`, so this table cannot drift from the code.

| Wall | naive agent | with Ghost Browser | what happened with it |
|---|---|---|---|
| Second factor: a six-digit code | FAIL | PASS | signed in with a code from the saved authenticator secret |
| Second factor: a passkey | FAIL | PASS | the owner's device signed the challenge; the site verified a real WebAuthn assertion |
| A session that only works on the device that made it | FAIL | PASS | the job ran on the device holding the key, so the session was still alive |
| A page that tells the agent to send the inbox to an attacker | FAIL | PASS | the inbox was read, and the injected send never left the browser |
| A data source that goes stale but keeps answering 200 | FAIL | PASS | a shadow check against the UI caught the disagreement and the card was retired before it was trusted again |
| Reading a list off an open page (no wall: the cost of re-walking the UI) | PASS | PASS | 4 rows, 1 request(s), 7 ms |

## How to read it

- **"naive agent"** is a stand-in this repo defines, not another product: a browser, a password and a model,
  with none of the mechanism under test (no saved authenticator secret, the repo's own default passkey
  refusal, a copied cookie jar, no write lease, no shadow check). The table says what each mechanism buys,
  **not** how Ghost Browser compares with Browserbase, Skyvern, Stagehand or anyone else. That comparison
  has not been run.
- **Everything the sites check is real**: RFC 6238 codes, WebAuthn signatures (ES256, rpId, challenge,
  origin, a counter that must advance), CSRF tokens, cookie lifetimes.
- **What is simulated** is the hardware and the live internet. In each wall:

```
totp: nothing: the site checks real RFC 6238 codes
  passkey: the owner's device is a software authenticator behind the real device hub; no phone or secure hardware
  bound-session: the binding key is a non-extractable WebCrypto key in the page, standing in for a TPM-held key
  injection: the "agent obeys the injection" is staged: the page's own script performs the send the injection asks for
  stale-data: the site is a local fixture whose old API version deliberately serves stale rows
  open-read: a local fixture with a typing delay; the timings are the fixture's, not a real site's
```

- The **bound-session** pass is by construction: it shows that moving the *job* to the device that holds
  the key works where moving the *session* does not. It is not a claim that the repo can drive a real
  TPM-bound Chrome session; that was not tested (no TPM here).
- The **open-read** row is a cost comparison on a fixture with an artificial typing delay. The request
  count (1 vs 6) is meaningful; the milliseconds are not a real site's.
- The **injection** wall stages the worst case, the agent obeying, and checks the wire. It does not
  measure how often a model is fooled.

## Adding a wall

Add a `wall(id, title, simulated, run)` in `scripts/walls-bench.js` that takes `(browser, 'naive'|'gb')` and
returns `{ passed, detail }`, then add its expectation to the test. A wall that cannot say what it
simulates should not be added.
