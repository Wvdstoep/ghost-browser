#!/usr/bin/env bash
# Ghost Browser — 30-second API tour.
# Start the server first (see ../SETUP.md), then:
#   API_KEYS="dev:team" ...   and   export GB_KEY=dev  before running this.
set -euo pipefail

GB="${GB_URL:-http://localhost:3000}"
KEY="${GB_KEY:?set GB_KEY to one of your API_KEYS}"
auth=(-H "Authorization: Bearer $KEY")

echo "→ opening a session"
SID=$(curl -s "${auth[@]}" -X POST "$GB/v1/sessions" | grep -oE '"sessionId":"[^"]+"' | cut -d'"' -f4)
echo "  session: $SID"

echo "→ navigating to news.ycombinator.com"
curl -s "${auth[@]}" -H 'content-type: application/json' \
  -X POST "$GB/v1/sessions/$SID/navigate" -d '{"url":"https://news.ycombinator.com"}' >/dev/null

echo "→ analyzing the page (Set-of-Mark: every element numbered)"
curl -s "${auth[@]}" "$GB/v1/sessions/$SID/analyze?screenshot=false" \
  | grep -oE '"elementCount":[0-9]+' || true

echo "→ clicking element 3"
curl -s "${auth[@]}" -H 'content-type: application/json' \
  -X POST "$GB/v1/sessions/$SID/click" -d '{"index":3}' | grep -oE '"url":"[^"]+"' || true

echo "→ closing the session"
curl -s "${auth[@]}" -X DELETE "$GB/v1/sessions/$SID" >/dev/null
echo "done."
