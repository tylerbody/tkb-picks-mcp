# v2.17.0: ESPN becomes the primary hit-rate source

Tests 873 -> 935. 13 mutations, all caught. No BDL code removed.

## Overwrite these eight files

```
src/services/espnClient.ts              epl + ucl added to ESPN_LEAGUE_PATHS
src/services/espnStatMap.ts             NEW  the label map + witness mechanism
src/services/espnPlayerResolution.ts    NEW  the SGO -> ESPN id bridge
src/services/espnHitRateAggregator.ts   NEW  the rate computation
src/tools/hitRate.ts                    dataSource "espn"; auto routes 5 sports
src/index.ts                            shared EspnClient; 2.16.0 -> 2.17.0
test/v2_17_0.test.ts                    NEW  62 tests
package.json                            2.17.0
```

Nothing to delete. No Render env var changes. ESPN needs no key.

## Verify after deploy

```
npm test     # expect 935 pass / 0 fail
```

Then live, and the first two are the ones that matter:

```
# 1. NBA off a prior season. The current season has no games yet; this should
#    still answer, from ESPN, at zero SGO entity cost.
tkb_get_player_hit_rate(sport:"nba", teamID:"LOS_ANGELES_LAKERS_NBA",
  playerID:"LUKA_DONCIC_1_NBA", playerName:"Luka Doncic",
  statID:"points", line:28.5, direction:"over")
  -> expect statSourceUsed "espn", espnAthleteId 3945274

# 2. THE COLLISION GUARD. Must REFUSE, not return a number.
tkb_get_player_hit_rate(sport:"nfl", teamID:"BUFFALO_BILLS_NFL",
  playerID:"JOSH_ALLEN_1_NFL", playerName:"Josh Allen",
  statID:"defense_sacks", line:0.5, direction:"over")
  -> expect a refusal naming "totalTackles" and the wrong shape

# 3. Soccer, and pass teamName for soccer (see below)
tkb_get_player_hit_rate(sport:"epl", teamID:"LIVERPOOL_FC_EPL",
  playerID:"ALEXANDER_ISAK_1_EPL", playerName:"Alexander Isak",
  teamName:"Liverpool", statID:"shots_onGoal", line:1.5, direction:"over")

# 4. A named refusal rather than an empty rate
tkb_get_player_hit_rate(sport:"nfl", ..., statID:"fieldGoals_made", ...)
  -> expect a refusal citing the measured kicker result

# 5. SGO is still reachable for a cross-check, and still spends entities
tkb_get_player_hit_rate(... dataSource:"sgo" ...)
```

## Two things to know when using it

**PASS `teamName` FOR SOCCER.** ESPN resolves teams by display name. Deriving
"buffalo bills" from `BUFFALO_BILLS_NFL` works; deriving "liverpool fc" from
`LIVERPOOL_FC_EPL` relies on the club-form strip to reach ESPN's "Liverpool".
Passing `teamName` skips the derivation. NFL, NBA and WNBA do not need it.

**SOCCER HAS NO MINUTES COLUMN**, on either the outfield or the goalkeeper shape.
`minutesPlayed` is a named refusal that says so. A 20-minute substitute
appearance is indistinguishable from a 90-minute start in a counted rate, so a
soccer rate cannot tell you whether the sample is even comparable game to game.
Keep reading the team news for soccer.

## Still outstanding, not in this build

- The NFL preseason date table from `preseason-discriminator-measured-2026-10-01.md`
  is now **unnecessary for any ESPN-routed sport**: ESPN labels season phase
  itself and `flattenGamelog` already excludes preseason. MLB still runs on SGO,
  but MLB was never exposed.
- `altLines` still fetches and discards, and still reports `altLinesIncluded: true`.
- The NHL season-label bug (a Sep 29 regular-season game reported as prior season).
- `includePriorSeason` is still on in the scheduled prompts and is still an ~8.7x
  SGO entity multiplier on the sports that remain on SGO.
