# v2.10.1 - two defects in the NHL build, both found by running it

Testing the deployed v2.10.0 against live data. Both defects are mine, and one of them
is the exact pattern this repo keeps getting burned by.

---

## 1. The play rate tracked the LOOKBACK ARGUMENT, not the player

Same request twice, live, Frank Vatrano on 2026-09-24:

```
lookbackGames 10  ->  playRate 0.12,  flag IRREGULAR
lookbackGames 40  ->  playRate 0.49,  flag IRREGULAR
```

The numerator stops at `targetAppearances` by design. The denominator was the club's
**whole completed season**, 82 games. The two measured different spans, so the quotient
meant nothing, and every NHL hit rate came back saying

> Played 10 of 82 team games (12%) ... Check availability before posting.

no matter how durable the player was.

**Why that is worse than no flag**, in this repo's own words from v2.5.0, when the same
flag was crying wolf on Cam Schlittler: *"a flag that cries wolf on healthy starters
trains the reader to ignore it, and its whole value is the real catches."* A warning that
fires on everyone is indistinguishable from no warning, except that it also spends the
reader's attention.

### Fix

`countTeamGamesPlayed` takes an `onOrAfter` bound, and the denominator is now the club's
completed games inside the window the counted appearances actually span, starting at the
oldest counted appearance. "He played 10 of his team's last 11" is a fact about the
player; "10 of 82" was a fact about the argument.

The regression half is tested as deliberately as the fix: a player who really did play 5
of his club's last 20 still flags IRREGULAR.

---

## 2. A finished season reported as current form, with no warning

The same live call returned games dated November 2025 through April 2026, on 2026-09-24,
two weeks before the next season opens, with:

```
seasonWarning: null
currentSeasonGames: 40
priorSeasonGames: 0
```

**Every one of those fields was correct.** The NHL season year does not roll over until
October, so an April 2026 game really does belong to the season labelled 2025, which
really was the current season that day. And the answer was still useless: five-month-old
form from a season that had ended, presented as current, with nothing saying so.

### The guard already existed and this aggregator did not call it

`services/sampleRecency.ts` was built in v2.5.2 for exactly this failure, after a Chris
Bassitt screen presented ninety-six-day-old form as current with `seasonWarning: null`.
Its own header opens by naming the gap: season labelling cannot see a sample that is
stale *within* its season.

**All four other aggregators call `describeRecency`.** bdl, sgo, cfbd, cbbd. The NHL one
shipped without it.

That is the same class of miss as the v2.9.1 soccer period across ten call sites, the
v2.9.3 UFC message that landed in one file of two, and the v2.8.12 cross-check that sat
unreachable behind a gate nothing exercised. Writing a new aggregator and not applying
the guard its four siblings share is that pattern again, from the inside.

Hockey has the longest exposure to it of any sport here, because the June-to-October
offseason sits entirely inside one season year.

### Fix

`describeRecency` is called, its warning is merged into `sampleWarning`, and a sample
more than 60 days old additionally fires `seasonWarning` with the offseason case named
explicitly. That routing is deliberate: the contract thread-writers follow is *"if
seasonWarning is non-null, do NOT present the number as current-season form"*, and a
sample from a season that has ended needs exactly that treatment even when the label says
current.

---

## Tests

548 -> 562.

**The first mutation run exposed a hole in my own tests.** Breaking the aggregator's
`describeRecency` call failed nothing, because every recency assertion tested the helper
directly rather than the wiring. A guard is only wired in if something tests the wiring.
Six end-to-end tests against a stub feed were added, and then:

| mutation | failures |
| --- | --- |
| ignore the window bound (the v2.10.0 denominator) | 2 |
| measure recency from the epoch instead of asOf | 1 |
| drop staleness from `seasonWarning` | 1 |
| restore the full-season denominator | 1 |

---

## Also verified live on v2.10.0, working

- NHL reachable, 25 recent and 25 upcoming events on the pro key.
- Lines priced: Kings/Ducks moneyline, spread and total (5.5), which confirms the game
  total settles on `points` as `GAME_TOTAL_STAT` claims.
- Players resolve on a live game; the roster is thin in preseason, as expected.
- Grading: an `F (OT)` and an `F (SO)` game both graded correctly, so the overtime and
  shootout display strings match `displaySaysFinal`.
- The `hits` refusal fires with its reason and names the box-score route.
- Hit rate end to end: real playerId, real dates, `matchedFields: ["points"]` - the
  goals/points crossover is correct against live data.
- Team splits print the OT/SO convention caveat.
- The usage tool reports the NHL line, and showed 3 requests against 3 cache hits, so
  request coalescing is working.
- SGO key note: the installed key is now `tkbtyler@yahoo.com`, tier pro. Previously
  measured as `shock.father@yahoo.com`.
