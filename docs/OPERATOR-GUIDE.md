# Ghost Browser — Operator Guide

This is what an engineer knows before operating Ghost Browser (GB). Read it in full once; read the
section you need on every job. Everything here is reachable through the operator tools; nothing here
needs code.

## What GB is

A real browser running on the owner's cluster with the owner's logins, one **profile** per login
(e.g. `facebook`, `google`, `reddit`). One profile = one browser instance = one thing at a time. Three
kinds of things drive it:

- **Roles** — playbooks. A role has a name, a site, a tool list (from GB's own tool palette,
  `gb_tools`) and a prompt that says what to do and when to stop. Built-in roles cannot be edited;
  authored ones can (`gb_role_get` / `gb_role_update`; clone a built-in with `gb_role_save`).
- **Flows** — automations: a graph of steps. Node kinds: `trigger`, `agent` (a role driving a page,
  budgeted with maxSteps/maxPages), `check-login`, `fetch` (GET in the profile's session, no model),
  `script` (a read-only script run on the rendered page, no model), `extract` (regex over a fetch),
  `store`, `filter`, `branch`, `collect`, `verify` (open a page, look for text → `found`).
  Goals reference earlier outputs as `{{outKey.field}}` and the run's input as `{{input.field}}`.
  A run has steps with status/output/error; `verified` = every verify step found its text.
- **Watchers** — flows whose trigger is a schedule (`{type:"schedule", every:"minute", n:15}`) and
  that are `active`. The scheduler fires them unattended (also when the app is closed). Each watcher
  has a **feed** (deduped items with standing), a **config**, **health** (last pass in numbers) and
  optional **routes**.

## The approval gate

Nothing outward happens without the owner. An agent's `act` (reply, post, message) becomes a
**proposal** the owner approves in the app (Results / Approvals). Auto-send is never set by the
operator. A refused act is the owner's decision, not an obstacle. The one thing that posts is the
**poster**, and only after the owner tapped Approve.

## Watchers in detail

- **Feed** (`gb_watcher_feed`): items keyed by their stable ids (for Facebook: post_id + comment_id +
  reply_comment_id), so the same thread seen in English and Dutch is one item. Each item has
  `fields.status` (standing), `fields.why`, `draft`, `draftState` (`drafting` / `drafted` / `none` /
  `skipped-old` / `posting` / `post-failed` / `handled`), `handled`, `posted`.
- **Config** (`gb_watcher_config`, merged): `mode` (`posts` = post watcher, else role watcher),
  `meName` (the owner's display name — the post watcher's standing depends on it), `followUps`
  (`[{kinds:[...], flowId}]` — each item kind routed to its own follow-up flow; empty kinds = any),
  `maxAgeDays` (default 7: older threads are not drafted), `maxDraftsPerPass`, `reactionCounts`
  (a like by the owner counts as acknowledged), `hideAfterDays` (feed hides stale unhandled items),
  `postUrls`, `profile`.
- **Health** (`gb_watcher_health`): `running`, `sinceMinutes`, `stale` (active but no pass for
  45+ min), `lastPass {posts, messages, waiting, drafts, verified, corrected, errors}`.
- **One pass at a time.** All watchers share the profile's browser; while `gb_busy` lists a pass, the
  scheduler starts nothing else and the poster waits. Never start a run on top of a running pass.
- **Follow-ups** (role watchers): after a pass, each new item whose kind matches a route runs that
  flow with `input {url, title, said, feedKey, feedWorkflowId}`. The follow-up drafts in
  **draft-only mode**: the draft is written onto the feed item the moment it is proposed and the flow
  ends — nobody is parked at a gate; the owner approves later in Results.

## The post watcher (mode: "posts")

The post itself is the source of truth, not the notification. Per watched post, every pass:

1. **Crawl** (deterministic, no model): open the post page → expand every "view replies / more
   comments" control (one click per round, re-query after each: Facebook re-renders the list) → list
   the root comments. Then **each root comment's own page**, and for branches with replies **the
   newest reply's page** too (a reply-to-a-reply is rendered only there). Visible articles only
   (Facebook keeps a hidden duplicate copy). Nodes: `{id, cid, rid, isReply, author, replyTo,
   reactedByMe, text, when}` from the article's aria-label (`"Antwoord van <A> op het antwoord van
   <B> 3 uur geleden"` → author A, replyTo B; time suffix stripped).
2. **Standing** per branch: a message is the owner's to answer only if it is a root comment, a reply
   TO the owner, @mentions the owner, or the root author continuing their own thread after the owner
   answered. Others talking to each other = `side conversation` (hidden). `answered` = a LATER reply
   of the owner's TO that author; a like by the owner = `you reacted`. The owner's own = `you`.
3. **Verify before drafting**: every `waiting on you` item is re-read from its own deep link; if that
   page shows the owner's later reply, the deep link wins (`corrected` in health).
4. **Draft** (text only, no browser): one dedicated reply per waiting person, with the post and the
   whole branch as context, the owner's own recent replies as the voice sample, humanized (no em
   dashes, no "That's a solid…" openers), in the post's language.
5. **Cadence**: active post every pass, quiet (no activity 6h) hourly, dead (3 days) daily, jittered.

**Approve** (owner's tap) → the **poster** (code, not an agent): waits for any running pass, opens the
comment's deep link, finds the comment by id, presses its Reply, types the exact words, submits,
and marks the card handled only when the reply is *visible on the page with the owner's name* —
never typing twice. `post-failed` carries the reason; the owner can approve again.

Discovery: the watcher reads the owner's notifications page each pass for "commented on your post"
rows and adds those posts; `gb_watcher_posts` adds one by link.

## Facebook facts already learned (do not re-learn)

- Comment/reply articles: `[role=article]` with aria-label starting `Opmerking van` / `Antwoord van`
  (`Comment by` / `Reply by`). The label carries author AND reply target. Replies are flat under the
  root (`comment_id` = root, `reply_comment_id` = self).
- The post page lazy-renders replies; a comment's own page renders its branch; a reply's own page
  renders replies-to-replies. The first `[role=article]` on a permalink page can be a *suggested*
  post from the side column; the post body is a visible `[data-ad-preview="message"]` block ranked
  by "links to this post id → before the first comment → longest".
- "Volgen"/"Follow", "Topbijdrager", "Auteur" are badges, not text. The Like control reads
  "Verwijder Leuk" (aria-pressed) when the owner reacted.
- Notifications flip language between loads; never key on their text.
- The pool reaps a session that looks idle: long page work must touch the session (the crawl does).

## Debugging method (what the operator does)

1. Read the health line and the last pass numbers. `stale` → the scheduler is not firing (paused?
   busy forever?) — `gb_busy`, `gb_logs grep:"workflow-sched"`.
2. Read the feed: is the standing right? An item "waiting" the owner answered → probe its deep link
   (`gb_watcher_probe`) and compare; if the page shows the reply, the crawl missed it (expansion) —
   check the log line "expanded N control(s) … still closed".
3. Read the run/job trace (`gb_runs_recent`, `gb_job`): which step errored, what the agent saw,
   what it tried. A role that wandered = a sentence in its prompt; a step that hit its budget = the
   goal is too wide or the page needs a different move.
4. Look at the page (`gb_screenshot` of the profile; `gb_probe` as a fresh visitor) before naming
   the fix.
5. Change one thing, run, read the evidence, repeat. Write the lesson to memory.

## What needs code (report BLOCKED with evidence, do not work around)

A new page shape the crawler cannot read; a new platform; a poster that cannot find a control that
is visibly there; server errors in the log (`ERROR`); anything about deploys, sessions/pool, or the
scheduler itself.
