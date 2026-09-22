# Profiles and Roles — the profile's role IS the plugin

A profile is a login that lives on a volume. A role is a playbook: the method for a site, the tools it may use, and what it needs from a device. The two already belong together — work happens in a profile, and the method for that work is a role — but today that pairing is *derived, unstored and invisible*. The phone works out a profile's role by matching its name against role names (`roleForProfile` in `MainActivity.kt`), shows the answer as one read-only line in a Settings section, and offers no way to see what a role actually says before living with it. Nothing records the choice, so nothing can be changed, and a walk that loses the match runs as `general` — an agent with no playbook, working out CapCut from scratch. That happened twice.

This plan makes the pairing a real, managed, readable thing: **a profile carries a role the way a browser profile carries an extension.** You pick it, you read it first, you change it later, and when a task arrives an engine picks the right one with the profile's stored choice as its floor.

Status board (keep current; it is the hand-off between sessions):

| Phase | Name | State | Proof it is done |
|---|---|---|---|
| 1 | The choice is stored, not guessed | **DONE** (2026-09-22) — `defaultRole` on the profile record; `src/profileRole.js` is the one answer (chosen > site > none, with the source and a rotted choice reported), read by the settings door and by `startWalk`; `PUT /v1/profiles/:name/settings` refuses a role that does not exist and returns the valid ids; 22 tests | A profile named `work-video` with `defaultRole: capcut-video-editor` gets that role though no name matches; an unconfigured profile still gets its site specialist; a renamed role is reported as `missing` instead of degrading in silence |
| 2 | Profiles is its own surface | planned | Profiles opens from the main navigation, not from inside Settings, on phone, desktop and web from the same `shared/` code; every profile shows login state, its role, which device holds it and what runs on it; **clicking a profile still opens it in a new tab** |
| 3 | Read before you choose | planned | The role picker shows, for each role, its full playbook text, its site, its tools and its device requirement — before selection, in the picker, not after saving |
| 4 | Full management | planned | Create, rename, duplicate and delete a profile; set its site, note, exit and timezone; see and clear its login; see which automations use it — all from the Profiles surface, no Settings detour |
| 5 | The engine picks the role | planned | A task arriving with no role named gets the right specialist from the profile, the addresses in the goal and the roles' own `site`/`require` — the choice is shown, its reason is shown, and a person can override it before it runs |

## Principles

1. **The role that knows the work is the one place that says what the work needs.** A role already carries its site, its playbook and its `require` (`{click_xy, drag, upload_file}` for `capcut-video-editor`). Requirements, tools and device routing are read off the role. Never a second list to keep in step.
2. **Stored beats derived.** A name match is a guess that works until someone renames something. The choice is a field on the profile, and the name match becomes the *suggestion* the picker starts from.
3. **You may read it before you live with it.** A role is a page of instructions that will act under your account. Choosing one blind is how the wrong specialist gets picked and nobody can tell why.
4. **Deriving stays as the fallback, never as the mechanism.** With no stored choice, the site match still applies — a profile someone never configured should still get its specialist rather than `general`.
5. **The engine always shows its work.** "Using `capcut-video-editor` because this profile's site is capcut.com" is the sentence that was missing both times this went wrong. Every automatic pick is visible and overridable before it runs.
6. **Do not lose what works.** Clicking a profile opens it in a new tab. That is the one part of the current UI that is right, and it survives every phase here.

## What exists today, verified

Worth writing down, because two sessions were spent rediscovering it:

- **Roles are real data with full playbooks.** `/profiles/roles/*.json` via `src/userRoles.js`. `GET /v1/agent/roles` lists them and `GET /v1/agent/roles/:id` returns one in full — *the read-before-you-choose door is already open*; nothing reads it. `roles.list()` now carries `require` (it silently dropped it, which is why the device gate never fired).
- **The profile record is a validated shape.** `src/profiles.js` holds `timezone, locale, proxy, userAgent, blockPasskeys, site, note, presentAs`, written through `normalize()` so only understood fields land. There is **no** role field. `PUT /v1/profiles/:name/settings` is the write door.
- **The cluster already adopts a profile's role for a walk.** In `startWalk` (commit `6737b15`), a walk with no role, or with `general`, takes the role whose `siteKey` matches the profile's — and sends that role's playbook ahead of the goal. That is the engine's first crude rule, and Phase 5 grows it rather than replacing it.
- **`siteKey()` folds the names.** `p_capcut`, `capcut.com` and `www.capcut.com` all key to `capcut`. This is the join between a profile and its roles.
- **`deviceNeedForProfile(profile)`** already reads a requirement out of the roles belonging to that profile's site — so a walk in a profile knows it needs a pointer even when no role was named.

## Phase 1 — The choice is stored, not guessed

**Why.** `roleForProfile` matches names. Rename the role, or name the profile anything a person would actually name it, and the pairing is gone with no error and no trace — the agent quietly becomes a generalist. There is nowhere to record "this profile uses this role", so there is nothing to manage in Phase 2 and nothing for the engine to stand on in Phase 5.

**Build.**
- `defaultRole: ''` in `profiles.js` `DEFAULTS`, and in `normalize()` as a safe slug (same character class as a role id, length-capped). Shape only — `profiles.js` must not learn about the role store.
- The server verifies it *names a real role* on `PUT /v1/profiles/:name/settings` and refuses with the list of valid ids otherwise. A wrong role is worse than none: it acts confidently under the wrong method.
- `roleForProfile` becomes: stored `defaultRole` → else the `siteKey` match → else `general`, and it reports **which of the three** it used. The derived path stays (Principle 4) and becomes visible instead of invisible.
- `GET /v1/profiles/:name/settings` returns `defaultRole` plus `suggestedRole` (the site match) so a UI can show "not set — suggestion: capcut-video-editor".

**Proof.** A profile named `work-video` with `defaultRole: capcut-video-editor` gets that role, though nothing about the names matches. Renaming the role to `capcut-editor-v2` makes the pairing *fail loudly* on the next save rather than silently degrade. Tests: stored wins over derived; derived still applies when unset; a nonexistent role is refused; the source of the choice is reported.

## Phase 2 — Profiles is its own surface

**Why.** The owner's words: it is hidden, in Settings, with no management. A profile is not a preference — it is a logged-in identity that automations act through. It belongs in the navigation beside the browser, not three taps into a settings list.

**Build.** A `Profiles` screen in `shared/` so phone, desktop and web render the same thing (the `commonMain` Compose UI that already serves all three). Per profile, one card:
- name, site, the login state, and the role it uses, with the role's source ("chosen" / "matched by site" / "none");
- which device holds this login (the ring already knows) and what runs on it (watchers, flows);
- primary action **open in a new tab** — unchanged;
- secondary actions leading into Phase 3 (change role) and Phase 4 (manage).

Anno-2026 treatment: one card per identity, state readable at a glance without opening anything, and the destructive actions behind a deliberate step.

**Proof.** Profiles opens in one tap from the main navigation on all three surfaces from one code path. Clicking a profile still opens it in a new tab. The Settings section becomes a link to it, not a second implementation.

## Phase 3 — Read before you choose

**Why.** A role is a page of instructions that will act under your account. The picker must show what it says *before* it is chosen — the owner's exact requirement, and the only way to tell a correct role from a plausible one.

**Build.** A role picker over `GET /v1/agent/roles`, and on selecting a candidate, `GET /v1/agent/roles/:id` for the full record shown in place:
- the whole playbook text, scrollable, not a summary — it is the method, and its traps are the valuable part (a caption that overflows a 9:16 frame; "Add heading" doing nothing while a text clip is selected; an export that is not a file until its last Download is pressed);
- its `site`, so the match to this profile is visible;
- its tools, and its `require` rendered as plain words: "needs a device that can click a point, drag, and upload a file — your desktop can, the cluster cannot";
- whether any device currently connected satisfies it, answered from the ring.
Then **Set as this profile's role**, which writes Phase 1's field. The list grows by itself as roles are added; nothing here enumerates role names.

**Proof.** From the Profiles surface: open a profile, read `capcut-video-editor` in full including its device requirement, see that the desktop satisfies it and the cluster does not, set it, and see it on the card with source "chosen".

## Phase 4 — Full management

**Why.** Everything a person needs to do with a logged-in identity is currently scattered or missing, so the answer to "which account is this and what is it doing" is a code read.

**Build.** On the Profiles surface: create, rename, duplicate (settings without cookies — a second account on the same site), delete with a real confirmation naming what is lost; edit site, note, exit and timezone (the existing settings door, in context rather than in a settings app); see the login state and clear cookies without deleting the profile; and the read-only list of what uses it — watchers, flows, scheduled passes — so deleting one is an informed act.

**Proof.** A second CapCut identity is created, given the same role, logged into by hand once, and picked up by the ring — without touching Settings or the API.

## Phase 5 — The engine picks the role

**Why.** The stored default answers "what does this profile usually do". It does not answer "what does *this task* need", which is the question when a request arrives in chat with no role named — the case that ran on the cluster as `general` and died after 70 steps.

**Build.** One function, `roleForTask({goal, profile, deviceCaps})`, in ascending confidence, each step visible:
1. an explicitly named role — always wins, never second-guessed;
2. the profile's stored `defaultRole`;
3. the addresses in the goal, matched to roles by `siteKey` (the `ringGate` precedent: what the goal names is stronger evidence than what the profile usually is — a goal naming capcut.com in the `google` profile wants the CapCut specialist);
4. the site match on the profile (today's rule);
5. `general`, and say so plainly, as a fallback rather than a silent default.
Then fold the chosen role's `require` with `deviceNeedForProfile` — as `startWalk` already does — and route, refusing with the reason when no device satisfies it. The decision and its reason travel with the job and appear in the chat before the work starts, overridable there.

**Proof.** "Make a viral short from that recording" in the phone's chat, with no role named, is handed to the desktop as `capcut-video-editor` with the playbook ahead of the goal; the chat says which role and why before it starts; naming a different role overrides it; and with no capable device connected the answer is a refusal with the reason, never an attempt on the cluster.

## Trap notes

- **`roles.list()` projections drop fields.** `require` was dropped by the projection and the device gate never fired — the code looked right and the data was thin. Any new field must be carried through `getRole`, `listRoles` and `save`.
- **Check the data, not the code.** Three wrong answers in a row came from grepping source instead of reading `/profiles/roles/` and `/profiles/workflows/`. A parse that prints nothing is a broken parse, not an empty store.
- **There are three doors into a run**, and a rule added to one is not on the others: the workflow route, `startWalk` (the phone's chat), and the device hand-over. Phase 5's picker belongs where all three can call it.
