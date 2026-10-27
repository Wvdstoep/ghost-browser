# Verified browser routines and request replay

The intent model supplies typed inputs. A reusable browser routine performs bounded mechanical work, reads the outcome, and returns structured results. Saving coordinates or the first query is not a reusable workflow.

## Google Maps lead search

The agent's google.maps role can call:

    maps_search({
      business: "dierenartsen",
      city: "Amsterdam",
      language: "nl",
      categoryTerms: ["dierenarts", "dierenkliniek"],
      limit: 10
    })

The first successful run registers the google.maps.search routine. Later runs reuse that contract with fresh inputs; the stored card contains no old businesses, city or results. This is an explicit deterministic adapter, not a claim that arbitrary clicks were automatically generalized.

The display language is explicit and applied to the search and every place link, so a browser configured in English can use Dutch category terms correctly. Each run searches again, opens individual business cards and reads name, category, address, phone and website when present. It saves only cards whose displayed category matches categoryTerms and whose address contains the requested city. Missing information is left missing. Pagination and output are bounded; complete means the requested count was reached, not that every business in a city was found. Partial results, consent, challenges, stale queries and unrecognized layouts are explicit outcomes. The Google optional-cookie page can be dismissed only through an unambiguous Reject all control on the Google consent domain. Challenges are not bypassed.

The adapter does not automatically read reviews or judge commercial suitability. Those are separate tasks when the goal requests them. Category terms come from the intent model and must reflect the user's meaning in the site's language.

## Request cards

A request card is a single action, not an entire multi-step task. Recording excludes navigation/telemetry and known GraphQL queries. GraphQL mutations retain operation identity separately from request shape. Captured body values and tokens are not copied into the card. The current caller must provide fresh action variables; mismatched operation identifiers and off-origin requests are refused. Unsupported dynamic session payloads fall back to UI execution rather than sending guessed or stale values.

The recorder seals before the decisive action. Repeated traffic alone never promotes a new card: the UI must positively confirm the action's effect. Existing cards without a readback specification remain on the UI path.

A workflow action can declare replayVerification:

    {
      "url": "/api/messages",
      "path": ["messages"],
      "match": { "field": "text", "slot": "message" },
      "completesTask": true
    }

This is a same-origin GET returning a JSON collection. The verifier counts matching records before and after the request and requires an increase. It never executes generated code. Site-specific endpoints that lack such a readback need another verified adapter; HTTP 200 is insufficient. Only mark completesTask when this one verified action fulfills the whole step. Request replay also honors the role's act capability and the workflow's auto-approval setting; otherwise the existing UI approval flow applies.

## Outcomes

- success: independent verification confirmed the intended new effect.
- login_required: the job stops, returns needsLogin and a sign-in report. A workflow ends as needs_login and does not launch dependent steps or the next for-each item. Run it again after signing in; no automatic write retry occurs.
- application_error / http_error: the agent receives the result and chooses the next step.
- unconfirmed / uncertain: the agent must inspect the current page before another write; this avoids blindly duplicating a possibly completed mutation.
- not_applicable: required inputs, live fields, origin or verification prerequisites are unavailable. No new request is sent; continue with the UI.

Facebook is intentionally not declared universally solved. Its opaque GraphQL/session fields, layout changes, questions and account checkpoints can require UI fallback and human sign-in. These cases must not be called successful merely because a request answered.

## Verification

Run npm test with the replay, Maps, recorder, workflow and agent suites, including __tests__/replay.e2e.test.js. The end-to-end suite uses real Chromium, a real HTTP fixture, the actual job runner and independent readback. It checks new payloads, rotated tokens, error/login responses, promotion, partial results, parameter changes and saved job leads.

scripts/replay-live-maps.cjs runs the two live searches (Rotterdam hairdressers then Amsterdam veterinarians). Run exploratory browser tests in a disposable container with CPU, memory and PID limits, not inside the production serving pod. Existing source assets in a release must be preserved; publish through canonical main and the normal deployment watcher.
