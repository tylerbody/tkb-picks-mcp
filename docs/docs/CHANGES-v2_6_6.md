# v2.6.6 — four bugs, three of them found by running the new tools once

No tools added or removed. Still **24**. Two fixes in code that predates this
release and two in code that shipped hours ago.

Every one of these was found by the live verification pass on v2.6.5 rather than
by review. That is the argument for the verification pass.

---

## 1. `"null-0"` was being returned as a team record

**Found the first time `tkb_get_standings` ran against NCAAF.** All 17 ACC rows
came back with:

```json
"overallRecord": "null-0"
```

`standingsNormalizer.ts` composed the record with:

```ts
s.wins !== undefined && s.losses !== undefined ? `${s.wins}-${s.losses}` : undefined
```

BDL's NCAAF standings return `wins: null` before a season starts, not `undefined`.
`null !== undefined` is **true**, so the guard passed and the template interpolated
the null.

**This is not cosmetic.** It is a fully populated, plausible-shaped, completely
wrong value, and unlike a missing field it would have printed the literal word
"null" into a published thread. Same family as the `p_k` batting/pitching
collision and the year-stale hit-rate window: nothing malformed, no guardrail
fires, output is confidently wrong.

The rest of that file already used `firstDefined()`, which rejects null correctly.
This one call site hand-rolled its own check and got it wrong, which is precisely
the argument for having the helper.

Fixed with a `composeRecord()` that requires both halves to be real numbers.
`wins`, `losses` and `ties` are now declared `number | null` rather than merely
optional, so the type says what the provider actually does.

---

## 2. A THIRD road-record naming variant

`roadRecord` came back null on every CFB row while `homeRecord` populated fine.

`standingsNormalizer.ts` checks `road_record` (NFL) and `road` (MLB). Its own
header comment documents that split and states the lesson:

> Rather than branch on sport (which breaks again the moment NBA or NHL is added
> with a third naming convention), every known alias is checked in order.

NCAAF then arrived with **`away_record`**. The third naming convention the comment
predicted, for the same value.

The failure was silent in the worst way: a null road record is indistinguishable
from "this sport does not report one". Nothing errored. The column was just empty
on every CFB team, forever.

Fixed by adding `away_record` and `away` to the alias chain, which is a one-line
change precisely because the file was structured for it. A fourth variant will be
one line too.

---

## 3. "25 team(s) moved from last week" on a preseason poll

`tkb_get_rankings` counted any `trend` value other than `"-"` as movement. A
preseason poll returns **`"NR"`** for all 25 teams, because there is no previous
week. So the very first run reported that all 25 teams had moved, on a poll where
nothing had moved because nothing had been played.

Now `"NR"` and `""` join `"-"` as non-moves, and an all-NR poll is detected and
labelled outright:

> Every team is marked NR (no previous poll), so this is the PRESEASON poll -
> these are expectations, not results. Every record is 0-0.

That last clause matters for this account specifically. A preseason ranking is an
expectation, and writing it into a thread as though it were earned is the same
category error as citing last season's form as current.

---

## 4. "not serialisable" where the answer was "absent"

`tkb_probe_event_fields` reported the missing `lineups` field as
`not serialisable`, because `JSON.stringify(undefined)` returns `undefined` and
the catch-all fired.

On a tool whose entire job is distinguishing ABSENT from PRESENT-BUT-EMPTY, that
wording reads like the probe failed rather than like the field is not there. Now
`undefined` and `null` get their own explicit messages.

---

## The lineups question is settled

Recorded here because it closes a genuinely open item and it went the way that
requires no further work.

`tkb_probe_event_fields` on an upcoming MLB game, 2026-08-27:

```
eventID, info, leagueID, links, odds, players, results, sportID, status, teams, type
```

Eleven top-level keys. **No `lineups`.** The note in `src/types.ts` is CONFIRMED
and SGO's schema browser is what is wrong. The mandatory per-game, per-date
starting-pitcher web search stands exactly as written.

Worth recording: the randomly chosen probe game was Dodgers at Braves, and its
roster contains `CHRIS_SALE_1_MLB` — the pitcher whose rotation shuffle caused the
published error that created the rule. The rule survived a test against the game
that motivated it.

Two undeclared fields also turned up and are worth a later look: a `links` object
carrying bookmaker deeplinks, and a `status` object with 18 keys including
`cancelled`, `ended`, `delayed`, `inBreak` and `currentPeriodID`, where `types.ts`
declares eight. Not acted on here, since neither is needed yet and guessing at
field meanings is how this connector has been burned before.

---

## Tests

**5 new, suite now 91.** Both normalizer bugs are pinned with the REAL rows that
exposed them, not invented fixtures.

**Mutation-tested:**

| Mutation | Result |
|---|---|
| Restore the `!== undefined` null guard | 1 test fails |
| Drop the `away_record` alias | 2 tests fail |

Also covered: NFL and MLB naming still winning over the new alias, and explicit
numeric `home_wins`/`road_losses` still taking precedence over parsed strings, so
the fix cannot regress the sports that already worked.

---

## Deploy

`tsconfig.json` unchanged and deliberately not included.

1. Copy `src/`, `test/`, `docs/`, `README.md`, `package.json`.
2. `npm test`. **91 passing.**
3. Commit, redeploy.
4. `node scripts/verify-deploy.mjs --expect 2.6.6`

Then one check, which is the whole point of the release:

5. `tkb_get_standings sport="cfb" conference="ACC"`. Every row should show
   `overallRecord: null` rather than `"null-0"`, and `roadRecord` should be
   populated rather than null.

---

## A note on checking `/health`

During v2.6.5 verification, `/health` reported 2.6.4 with 21 tools while the
deployed server was already serving all 24 new tools correctly. The response was
cached, and appending a cache-busting query string did not help because the
fetcher stripped it before the request went out.

**The authoritative check is behavioural: call a tool that only exists in the new
build.** `/health` is a convenience, and it was designed to carry `toolCount` and
`tools` precisely so a stale version string could be caught — but it cannot defend
against its own response being cached upstream. That is worth remembering the next
time a deploy looks like it did not land.
