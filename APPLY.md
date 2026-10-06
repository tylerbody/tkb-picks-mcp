# v2.18.0: preseason is accessible, explicitly

Six files. Suite 942 -> 961. Twelve mutations, all caught. Default behaviour unchanged.

```
src/services/espnHitRateAggregator.ts   seasonPhase, row tagging, minutes, warning
src/tools/hitRate.ts                    seasonPhase input + a gate before every branch
src/types.ts                            seasonPhase + minutes on GameLogEntry (optional)
src/index.ts                            2.17.2 -> 2.18.0
test/v2_18_0.test.ts                    NEW, 19 tests
package.json                            2.18.0
```

## How to use it

New input on `tkb_get_player_hit_rate`:

| seasonPhase | counts |
| --- | --- |
| `regular` (default) | regular season only. Exactly the old behaviour. |
| `preseason` | ONLY this season's preseason games |
| `both` | both, every row tagged, and the warning states the split |

NBA, NFL and WNBA only. Every other sport is refused by name.

## Verify after deploy

```
npm test     # expect 961 pass / 0 fail
```

```
tkb_get_player_hit_rate(sport:"nba", teamID:"LOS_ANGELES_LAKERS_NBA",
  playerID:"LUKA_DONCIC_1_NBA", playerName:"Luka Doncic",
  statID:"points", line:20.5, direction:"over", seasonPhase:"preseason")
```

Expect `statSourceUsed: "espn"`, `seasonPhase: "preseason"`, at least one row
tagged `"preseason"` with `minutes: 16`, and a warning starting
`PRESEASON GAMES COUNTED`.

Then confirm the guard: the same call with `sport:"nhl"` must return
`reason: "season_phase_unsupported"`, not a regular-season rate.
