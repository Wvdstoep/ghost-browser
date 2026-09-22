# Profiles and Roles — the profile's role IS the plugin

A profile is a login that lives on a volume. A role is a playbook: the method for a site, the tools it may use, and what it needs from a device. The two already belong together — work happens in a profile, and the method for that work is a role — but today that pairing is *derived, unstored and invisible*. The phone works out a profile's role by matching its name against role names (`roleForProfile` in `MainActivity.kt`), shows the answer as one read-only line in a Settings section, and offers no way to see what a role actually says before living with it. Nothing records the choice, so nothing can be changed, and a walk that loses the match runs as `general` — an agent with no playbook, working out CapCut from scratch. That happened twice.

This plan makes the pairing a real, managed, readable thing: **a profile carries a role the way a browser profile carries an extension.** You pick it, you read it first, you change it later, and when a task arrives an engine picks the right one with the profile's stored choice as its floor.

Status board (keep current; it is the hand-off between sessions):

| Phase | Name | State | Proof it is done |
|---|---|---|---|
| 1 | The choice is stored, not guessed | **DONE** (2026-09-22) — `defaultRole` on the profile record; `src/profileRole.js` is the one answer (chosen > site > none, with the source and a rotted choice reported), read by the settings door and by `startWalk`; `PUT /v1/profiles/:name/settings` refuses a role that does not exist and returns the valid ids; 22 tests | A profile named `work-video` with `defaultRole: capcut-video-editor` gets that role though no name matches; an unconfigured profile still gets its site specialist; a renamed role is reported as `missing` instead of degrading in silence |
| 2 | Profiles is its own surface | **DONE** (2026-09-22) — `shared/ProfilesScreen.kt`, a Profiles item in the nav on phone and desktop, one call (`GET /v1/profiles/overview`) instead of N+1, and the phone's local role map migrated up to the server on first load | Profiles opens in one tap from the main navigation on phone and desktop from one code path; each card shows whether a login is saved, its role and the role's source, which device holds it, how many automations run on it and where it exits; **pressing a profile still opens it in a new tab** |
| 3 | Read before you choose | **DONE** (2026-09-22) — the picker reads `GET /v1/agent/roles/:id`, which no longer drops `require` (the same projection bug that stopped the device gate firing) and now also writes the requirement in words (`src/requireWords.js`) and answers who can run it from the router itself | Open a profile, read a role in full including its whole playbook, see "This role needs a desktop browser it can drive directly, and must be able to click an exact point, drag something across the page and choose a file to upload" and which of your devices satisfies that, then set it |
| 3b | A method per device | **DONE** (2026-09-22) — `src/roleDevices.js`: a role may carry a `devices` section (`desktop`/`android`/`cluster`), each with its own requirement and its own method. Routing tries every variant, so the phone stops being excluded by omission; the hand-over carries the base playbook plus **only** the variant for the device that took the job | A role with a desktop and a phone method runs on whichever is connected; the desktop receives the desktop method and never the phone one; with neither connected the refusal names every way that was tried. 19 tests |
| 4 | Full management | **DONE** (2026-09-22) — create, rename, duplicate, sign out and delete, each refusing on the server while a session holds the profile (one shared `pool._refuseIfOpen`, the rule `removeProfile` learned first); `GET /v1/profiles/:name/automations` names what would stop working; `GET /v1/profiles` is behind `authed` now, having listed every logged-in identity to anyone. 18 tests | A second CapCut identity is created from the surface, gets the same role, and is signed into once by hand; a duplicate carries the timezone, exit and role but NOT the cookies; signing out keeps the settings; deleting says how many automations it breaks and asks twice |
| 5 | The engine picks the role | **DONE** (2026-09-22) — `src/roleEngine.js`: named > the profile's stored choice > an address in the goal > the profile's site > general, with the reason and the alternatives travelling with the answer into the log and back to the chat. A stored choice is deliberately NOT hijacked by a passing mention, and the engine says what the goal pointed at instead. 18 tests | A CapCut request in the chat with no role named gets `capcut-video-editor`; the log and the reply say which specialist and why; a goal mentioning another site names that alternative rather than switching silently; a generalist run says it is one |

## Principles

1. **The role that knows the work is the one place that says what the work needs.** A role already carries its site, its playbook and its `require` (`{click_xy, drag, upload_file}` for `capcut-video-editor`). Requirements, tools and device routing are read off the role. Never a second list to keep in step.
2. **Stored beats derived.** A name match is a guess that works until someone renames something. The choice is a field on the profile, and the name match becomes the *suggestion* the picker starts from.
3. **You may read it before you live with it.** A role is a page of instructions that will act under your account. Choosing one blind is how the wrong specialist gets picked and nobody can tell why.
4. **Deriving stays as the fallback, never as the mechanism.** With no stored choice, the site match still applies — a profile someone never configured should still get its specialist rather than `general`.
5. **The engine always shows its work.** "Using `capcut-video-editor` because this profile's site is capcut.com" is the sentence that was missing both times this went wrong. Every automatic pick is visible and overridable before it runs.
6. **Do not lose what works.** Clicking a profile opens it in a new tab. That is the one part of the current UI that is right, and it survives every phase here.
7. **One requirement is two statements squashed together.** What the WORK needs and how THIS KIND of machine does it are different facts. Keeping them apart is what stops a role being desktop-only by omission, and it is why a role may state a method per device.
8. **A device is told only the method that applies to it.** "Drag the clip onto the timeline" and "long-press the clip, then drag with your finger" are both correct and only one is correct here. Sending both is how an agent starts guessing.
9. **Never claim what nothing has checked.** A profile shows "login saved", not "signed in": a profile is a cookie jar, and whether the site still accepts that cookie is only knowable by opening it. The same rule put the requirement wording on the server and left an untaught capability printed as its own name rather than described.

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

## Phase 3b — A method per device

**Why.** A role stated ONE requirement, and that quietly decided which machine could ever run it. `capcut-video-editor` asks for a desktop browser it can drag in, so a phone was excluded *by omission* rather than by anything anyone decided — even where a phone could do the same work by long-pressing and dragging with a finger. And a single playbook cannot hold both methods without contradicting itself, so an agent handed the whole thing has to work out which half applies to the machine it is standing on. That is guessing, and guessing is what cost seventy steps on a video editor.

**Build.** `src/roleDevices.js`. A role may carry `devices`, keyed by the device kinds the ring itself knows:

```json
"devices": {
  "desktop": { "require": { "cdp": true, "features": ["drag", "upload_file"] },
               "method": "Drag the clip from the library onto the timeline." },
  "android": { "require": { "mobileApp": true, "features": ["native_tap"] },
               "method": "Long-press the clip, then drag it down with your finger." }
}
```

- a variant's `platform` comes from its KEY and is never read from its body, because a contradiction there would route phone work to a desktop;
- an empty stanza is dropped rather than becoming a requirement nobody wrote (`{"desktop":{}}` used to narrow a role to desktop-only);
- device variants are tried BEFORE the role's general requirement, which stays as a last resort so nothing that works today changes;
- the hand-over sends the base playbook plus that one variant's method, headed "ON THIS DEVICE (your desktop) — this is the method that applies here, and the only one";
- a refusal names every way that was tried, per device, instead of a bare "no device".

**What still needs filling in.** The schema is live and `capcut-video-editor` has not been given a phone method, deliberately: a phone was tested against CapCut and could not do it, so writing one would be fiction. The method text per device is knowledge from the tested flow, not something to invent.

**Proof.** A role with a desktop and a phone method runs on whichever is connected; the desktop gets the desktop method and never the phone one; with neither connected the refusal names both. 19 tests, including the empty-stanza narrowing and a router that throws instead of answering.

## Phase 4 — Full management

**Why.** Everything a person needs to do with a logged-in identity is currently scattered or missing, so the answer to "which account is this and what is it doing" is a code read.

**Build.** On the Profiles surface: create, rename, duplicate (settings without cookies — a second account on the same site), delete with a real confirmation naming what is lost; edit site, note, exit and timezone (the existing settings door, in context rather than in a settings app); see the login state and clear cookies without deleting the profile; and the read-only list of what uses it — watchers, flows, scheduled passes — so deleting one is an informed act.

**Proof.** A second CapCut identity is created, given the same role, logged into by hand once, and picked up by the ring — without touching Settings or the API.

## Phase 4 — Full management

**Why.** Everything a person needs to do with a logged-in identity was missing or scattered, so "which account is this and what is it doing" was a code read. A profile only came into existence the first time a session opened one, and the only way to be rid of a bad login was to delete the profile — taking its timezone, its exit and its role with it.

**Build.** On the Profiles surface: **Add** (a profile born on purpose, with its site, because the site is what matches it to the roles that know that site); **Rename** (keeps the login and every setting); **Duplicate** (a second identity on the same site: timezone, exit and role come across, cookies deliberately do not, and the note does not either because it described the original); **Sign out** (removes the cookie stores and keeps the identity — offered first and plainly, because it is almost always what "delete" was being used for); **Delete** (says how many automations run in this profile and will stop working, then asks a second time).

Server side: `POST /v1/profiles`, `POST /v1/profiles/:name/rename`, `.../duplicate`, `.../clear-login`, and `GET /v1/profiles/:name/automations`. All five share one refusal — `pool._refuseIfOpen` — because renaming, duplicating and clearing are the same act on the same directory that `removeProfile` already knew must not happen under a running Chromium: the browser goes on writing into a folder that no longer exists and the failure surfaces minutes later somewhere unrelated. The refusal names the way out, and the surface shows it verbatim rather than pretending the action worked.

**Found on the way.** `GET /v1/profiles` had no `authed` on it, so it named every logged-in identity on the install — account names and customer ids — to anyone who asked. Closed; the console reaches it same-origin with its SSO cookie and `authed` takes a cookie as readily as a key, so nothing lost access.

**Why a duplicate must not copy cookies.** Two profiles believing they are the same account is the fastest way to get both locked out: one session token arriving from two browsers is exactly what a risk engine is looking for. So a duplicate inherits the settings, and somebody signs into it once by hand — the same rule as everywhere else here.

**Proof.** 18 tests, including each operation refusing while a session holds the profile, a duplicate leaving the original untouched, and signing out keeping the timezone, exit and role.

## Phase 5 — The engine picks the role

**Why.** The stored default answers "what does this profile usually do". It does not answer "what does *this task* need", which is the question when a request arrives in chat with no role named — the case that ran on the cluster as `general` and died after 70 steps.

**Build.** One function, `roleForTask({goal, profile, deviceCaps})`, in ascending confidence, each step visible:
1. an explicitly named role — always wins, never second-guessed;
2. the profile's stored `defaultRole`;
3. the addresses in the goal, matched to roles by `siteKey` (the `ringGate` precedent: what the goal names is stronger evidence than what the profile usually is — a goal naming capcut.com in the `google` profile wants the CapCut specialist);
4. the site match on the profile (today's rule);
5. `general`, and say so plainly, as a fallback rather than a silent default.
Then choose the role's variant a real device can satisfy (Phase 3b) and route, refusing with every way that was tried when none can. The decision and its reason travel with the job and appear in the chat before the work starts, overridable there.

**The one ordering decision worth arguing about: `chosen` before `goal`.** The other way round reads better — "a goal naming capcut.com wants the CapCut specialist" — and it is how a task-first engine naturally works. It is also how a role gets hijacked by a passing mention: *"make the short, then post the link on facebook.com"* would swap the video editor for a reply desk, and the person who deliberately set this profile's role would have no idea why. So a deliberate human choice outranks a string found in a sentence — and the alternative is never swallowed: the answer names the role it would otherwise have picked, so the correction is one word instead of an investigation.

**Proof.** "Make a viral short from that recording" in the phone's chat, with no role named, is handed to the desktop as `capcut-video-editor` with the playbook ahead of the goal; the chat says which role and why before it starts; naming a different role overrides it; and with no capable device connected the answer is a refusal with the reason, never an attempt on the cluster.

## What is left

All five phases are shipped. What remains is data, not code: `capcut-video-editor` has no phone method in its `devices` section, deliberately — a phone was tested against CapCut and could not do it, so writing one would be fiction. The per-device method text is knowledge from the tested flow.

## Trap notes

- **`roles.list()` projections drop fields.** `require` was dropped by the projection and the device gate never fired — the code looked right and the data was thin. Any new field must be carried through `getRole`, `listRoles` and `save`.
- **Check the data, not the code.** Three wrong answers in a row came from grepping source instead of reading `/profiles/roles/` and `/profiles/workflows/`. A parse that prints nothing is a broken parse, not an empty store.
- **There are three doors into a run**, and a rule added to one is not on the others: the workflow route, `startWalk` (the phone's chat), and the device hand-over. Phase 5's picker belongs where all three can call it.
