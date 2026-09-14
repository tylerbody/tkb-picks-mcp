# v2.9.1 - the narrowing oddID was also a filter, and it was hiding two whole leagues

No tools added or removed. Still **28**. One bug, ten call sites, found by running
v2.9.0 against the live board within minutes of deploying it.

Tests: **411 -> 415**.

---

## What happened

v2.9.0 shipped with the soccer period split handled: match lines on `reg`, player
props on `game`, routed through `matchLinePeriodFor(sport)` in every tool that READS
a market. Then the first live check of the new league probe said this:

```
EPL   recent 0   upcoming 0   -> nothing either direction
UCL   recent 0   upcoming 0   -> nothing either direction
```

and `tkb_get_schedule sport="epl"` returned an empty slate on a week the Premier
League was playing.

The new empty-result message did its job and named the third possible cause - a key
that cannot see the league - so the next step was to check it directly:

```
tkb_get_odds sport="epl" marketType="moneyline" teamName="Arsenal"
  -> Brighton & Hove Albion vs Arsenal
     points-home-reg-ml-home   +270   fanduel
     points-away-reg-ml-away   -340   fanduel
```

**The league was entitled, in season, and priced.** One tool could see it and ten
could not.

---

## The cause

Ten call sites pass a single throwaway oddID to SGO for one reason: without it SGO
attaches every market on the event, and a response that should be kilobytes becomes
megabytes. v1.2.0 added it to fix a real out-of-memory crash. Every one of them used
the same literal:

```ts
oddIDs: "points-home-game-ml-home"
```

**That parameter is not only a size hint. It is a FILTER.** SGO returns only events
that carry the requested market. Soccer match lines are on `reg`, so no soccer event
carries `points-home-game-ml-home`, so every one of those calls returned zero events.

Affected: `tkb_get_schedule`, `tkb_get_players`, `tkb_screen_props`,
`tkb_get_cover_player`, `tkb_monitor_live_picks`, `tkb_probe_event_fields`,
`tkb_check_league_access`, plus `hitRateAggregator` and `splitsAggregator` (twice).

---

## Why v2.9.0 missed it, which is the part worth keeping

This repo has recorded the same failure before, in v2.6.0: *"the fixes were correct,
the audits were scoped to the file the symptom appeared in."*

v2.9.0 fixed the period wherever a market is LOOKED UP, because that is where a
period obviously matters. It did not audit the places where an oddID is used merely
to make a response smaller, because **a narrowing parameter does not look like a
market lookup**. It looks like a performance detail.

Worse, the failure was silent in the most misleading way available: the new
league-access probe, built in the same release specifically to distinguish "empty
calendar" from "key cannot see this league", used the hard-coded string too. So it
reported two working leagues as possibly unentitled. A diagnostic tool was
confidently producing the exact wrong diagnosis.

---

## The fix

One exported function, in `services/oddIdBuilder.ts`:

```ts
export function narrowingOddID(sport: SportKey): string
```

It builds the same string through `matchLinePeriodFor`, so it returns
`points-home-game-ml-home` for the eight sports that were already right and
`points-home-reg-ml-home` for EPL and UCL. All ten call sites now use it. The next
sport whose full-event period is not `game` is a row in one table, not another
ten-site audit.

---

## Testing

Four new cases, including one that reads the source tree and **fails if any file
under `src/` hard-codes the old literal again**. That is deliberate: the reason this
survived a release is that a copy of the string in a file nobody thinks of as a
market lookup is invisible to a behavioural test. A unit test asserting
`narrowingOddID("epl") === "points-home-reg-ml-home"` would keep passing while one
call site quietly kept its literal.

Mutation-tested, two mutations, two killed:

| mutation | caught by |
|---|---|
| `narrowingOddID` reverted to always `game` | the EPL/UCL assertions |
| one call site keeps the old literal | the source-tree scan |

---

## Still open after this

`UEFA_CHAMPIONS_LEAGUE` returned no events even through `tkb_get_odds`. That is NOT
the same bug - the odds path was always building `reg` correctly - and it is now the
one remaining unknown. It is plausibly just the calendar (league phase fixtures not
yet in the window) and it is worth re-running `tkb_check_league_access` once this is
deployed, since the probe itself was lying before.

CONFIRMED WORKING on the pro key, from the same probe run: **UFC is reachable** - 25
fights in the last 45 days and 16 upcoming, with real cards
(`UFC 331: Van vs. Pantoja 2`), venues and fighter names. That closes the open
question from the v2.9.0 scope: UFC is not a pro-only unknown on this account, it
works today.
