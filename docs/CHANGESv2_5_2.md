# v2.5.2 — combination props, countable on SportsGameOdds

One file changed beyond v2.5.1 (`services/hitRateAggregator.ts`), plus the version bump.
No tools added, removed, or renamed. `screenProps.ts` needs no change.

---

## The claim that turned out to be wrong

`UNCOUNTABLE_STATIDS` in `screenProps.ts` blocks combination markets with this reasoning:

> SGO exposes one value per statID in an event's results object, with no way to add
> components together, so a "Points + Rebounds" line has no countable source.

The first half is true. The second half is not. SGO cannot add them; **this code can.**

## What was measured

Forced to the SGO path, same player, same 30 events:

| statID | result |
|---|---|
| `points` | real values on all 9 games she appeared in |
| `points+rebounds+assists` | null on all 30, **including those same 9** |

But every component is present on those same events under the same playerID:

| Date | Points | Rebounds | Assists | Sum |
|---|---|---|---|---|
| 8/16 | 19 | 6 | 2 | 27 |
| 8/13 | 20 | 9 | 2 | 31 |
| 8/09 | 17 | 8 | 3 | 28 |
| 8/08 | 22 | 6 | 3 | 31 |
| 8/07 | 21 | 8 | 6 | 35 |
| 8/02 | 18 | 8 | 7 | 33 |
| 7/31 | 16 | 5 | 2 | 23 |
| 7/29 | 15 | 6 | 3 | 24 |
| 7/22 | 24 | 10 | 1 | 35 |

That is an exact count, not an approximation. Collier OVER 30.5 Pts+Reb+Ast reads 5 of 9.

## The change

`extractPlayerStat` now falls back to a component sum when the composite key is absent.
A direct value always wins if SGO ever starts settling these.

```
"points+rebounds+assists": [["points"], ["rebounds"], ["assists"]]
"batting_hits+runs+rbi":   [["batting_hits"], ["batting_runs", "points"], ["batting_RBI"]]
```

Each component is a CANDIDATE ARRAY, the same defensive pattern as `bdlStatMap.ts`. MLB runs
scored were confirmed live to sit under `points` (SGO's winner-determining stat, which in
baseball is runs) with Trent Grisham returning 1/0/0/1/0/3, but `batting_runs` is tried first
in case the feed ever exposes the explicit name.

Covered: all five WNBA/NBA combos, both MLB combos, both NFL/CFB yardage combos.

## Two safety properties, both deliberate

**A missing component returns null, never a partial sum.** A half-computed combo is exactly
the "fully populated, plausible, completely wrong" failure this connector exists to prevent.
null routes the game to the DNP branch, excluding it from the sample rather than
under-counting it.

**Zeros are real, and that is why this is safe.** SGO stores a genuine `0` rather than
omitting the key, verified on Courtney Williams (0 points, 7/22) and Grisham (0 runs on three
dates). Had zeros been omitted, every summed line would have silently dropped a player's
quiet games and inflated the rate. This was checked before the feature was written, not after.

## Logic verified before shipping

Nine cases, all passing: the two real Collier games above, an all-zero line summing to 0
rather than dropping out, a missing component returning null, a DNP returning null, MLB
resolving through the `points` fallback, MLB preferring `batting_runs` when present, a direct
composite value taking precedence, and an unmapped composite (`fantasyScore`) staying null.

## Why this matters beyond variety

For **WNBA and NCAAF this is the only way to get combos at all**, because BALLDONTLIE gates
player stats behind GOAT for those two sports (see v2.5.1). For MLB it is a fallback, since
the BDL path already derives them at ALL-STAR.

It also happens to open the market where this account's tracker shows its best MLB
performance by a wide margin: Hits+Runs+RBIs ran 26 bets at 61.5% and +27.8% ROI, against
Total Bases at 206 bets, 36.9% and -27.1% ROI.

## Known stale comment, harmless

The `UNCOUNTABLE_STATIDS` block comment in `screenProps.ts` still describes combos as
BDL-only. It is now inaccurate but has no runtime effect: the gate already lets combos
through whenever `bdlStatMap` has a mapping, which is true for every combo listed above.
Left untouched to keep this diff to one file. Worth correcting on the next pass.

## Deploy and verify

1. `/health` must report **2.5.2**.
2. `tkb_get_player_hit_rate` on a WNBA player with `statID="points+rebounds+assists"`,
   `dataSource="sgo"`. It should return a real counted rate instead of NO SAMPLE.
3. Cross-check one game by hand against the components, which is how the table above was
   built.
4. Run a WNBA `tkb_screen_props` and confirm combo markets now appear among the candidates.
5. Run an MLB screen and confirm nothing regressed - MLB combos already came from BDL, so
   that path should be unchanged.
