# v2.16.0 apply notes: running on SportsGameOdds alone

## Overwrite these six files

```
src/index.ts                      BDL no longer fatal; conditional client; boot warning
src/services/bdlUnavailable.ts    NEW
src/tools/hitRate.ts              one up-front refusal for explicit dataSource="bdl"
test/v2_16_0.test.ts              NEW, 22 tests
test/v2_15_0.test.ts              fixes a brittle version pin I shipped yesterday
package.json                      2.15.0 -> 2.16.0
```

Nothing to delete this time. No BDL code is removed anywhere.

## Then, in Render

Leave `BDL_API_KEY` alone until this build is deployed and verified. Once it is
live you can delete the env var, and the connector keeps running.

Order matters: deploying this FIRST is what makes removing the key safe.

## Verify after deploy

```
npm test     # expect 873 pass / 0 fail
```

Then, with the key still set, confirm nothing regressed:

```
tkb_get_api_usage          -> header reports 2.16.0
tkb_get_injuries(nfl)      -> still returns the live feed
tkb_get_player_hit_rate    -> still statSourceUsed "sgo"
```

After you remove `BDL_API_KEY` and it redeploys, confirm the new behaviour:

```
tkb_get_player_hit_rate(... no dataSource ...)   -> WORKS, statSourceUsed "sgo"
tkb_get_injuries(nfl)                            -> refuses, naming BDL_API_KEY
tkb_get_standings(nfl)                           -> refuses, naming BDL_API_KEY
```

The Render logs should carry one `WARN: BDL_API_KEY is not set` line at boot
listing exactly what refuses.

## What you lose, in one place

| tool | after cancelling |
| --- | --- |
| `tkb_get_injuries` | REFUSES. No substitute exists; SGO publishes no injury feed. |
| `tkb_get_standings` | REFUSES. `teamRecord.ts` is written and unregistered if you want an SGO version. |
| `tkb_get_rankings` | REFUSES. CFB AP poll. CFBD's API has `/rankings` and you already hold that key. |
| `tkb_scan_streaks` | REFUSES per player, scan still returns with reasons. |
| `tkb_verify_roster` | REFUSES. `tkb_get_players` already gives teamID per event. |
| `tkb_debug_bdl_stats` | REFUSES. Diagnostic only. |
| `tkb_get_player_hit_rate` with `dataSource:"bdl"` | REFUSES, and points at `"sgo"`. |

Everything else is untouched: hit rates (SGO default since v2.14.0), odds, props,
period odds, game lines, schedules, grading, weather, ESPN research, devig.

## Reimplementing BDL later

Set `BDL_API_KEY` in Render. That is the whole procedure. The client, the
aggregators, the stat maps and all twelve BDL routes still ship byte-for-byte;
`index.ts` constructs the real client on the next boot. There is no code change
to undo, which is the point: the subscription decision and the code are decoupled.
