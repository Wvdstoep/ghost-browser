# Examples

Small, runnable proofs that Ghost Browser does what the README says. Start the server first — see [../SETUP.md](../SETUP.md).

## `quickstart.sh` — the API in 30 seconds

Open a session, navigate, see the page as numbered elements (Set-of-Mark), click one, close.

```bash
export GB_KEY=dev          # one of your API_KEYS
bash quickstart.sh
```

## `read-github-issues.flow.json` — Ghost Browser operating GitHub

A workflow that reads a repository's **open issues through a real, logged-in GitHub session**, using a `script` node — **no model calls and no writes**. By default it points at this very repository, so it reads Ghost Browser's own issue tracker: the tool inspecting itself.

First, sign into GitHub once by hand in the console on a profile named `github` (that's the whole point — you log in, the browser keeps the session). Then import and run the flow:

```bash
# import the flow
curl -s -H "Authorization: Bearer $GB_KEY" -H 'content-type: application/json' \
  -X POST http://localhost:3000/v1/workflows \
  --data-binary @read-github-issues.flow.json

# run it (use the id returned above)
curl -s -H "Authorization: Bearer $GB_KEY" -X POST \
  http://localhost:3000/v1/workflows/<id>/run
```

Sample output (the `read` step returns structured data):

```json
[
  { "number": 1, "title": "Console live view renders black on static pages" },
  { "number": 2, "title": "Redesign the console — a cleaner, more modern look" },
  { "number": 3, "title": "Make the console usable on smaller screens" }
]
```

Point it at any repo by changing the `url` on the `read` and `check` nodes.

### Where to take it next

This flow only *reads*. To make Ghost Browser **act** on GitHub — open an issue, comment, review — give the agent a goal instead of a script; the act-gate will show you the exact text and wait for your approval before anything is posted. That is the same mechanism that lets it operate any logged-in site safely.
