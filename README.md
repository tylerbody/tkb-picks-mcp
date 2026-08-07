# TKB Picks MCP Server

Wraps SportsGameOdds (odds/schedule/stats) and BALLDONTLIE (injuries) into MCP tools for TKB Picks thread-building.

## This round: response-size optimization (root-cause fix for the earlier OOM crash)

**What changed:** Every tool that fetches odds now requests the EXACT `oddID`(s) it needs directly from SGO's API, instead of pulling the full event (which can contain 1000+ markets) and filtering client-side afterward. Confirmed via SGO's own FAQ and docs that request-level filtering (`oddIDs`, `playerID`, `bookmakerID` params) is the correct, intended way to keep responses small - this was the real root cause of the earlier out-of-memory crash, more than raw traffic volume.

**Files changed:**
- `sgoClient.ts` - added `bookmakerID` and `includeOpposingOdds` to the request params (bookmakerID is wired through; includeOpposingOdds is available for future use but not yet used by any tool)
- `odds.ts` - rewritten so `oddIDs` are built BEFORE the event lookup and passed on the very first request, even in the teamName-lookup case (since statID/entity/side are deterministic ahead of time, we never need to guess-then-filter)
- `yesNoProps.ts`, `periodOdds.ts` - same fix: the already-known `oddID` is now passed via the `oddIDs` param on the fetch instead of being filtered out of the full response after the fact
- `hitRateAggregator.ts`, `splitsAggregator.ts` - these never needed odds data at all (only `results` / `teams.score`), so they now pass a minimal single dummy `oddIDs` value to shrink the odds payload to near-zero instead of pulling the full odds object for every game in the lookback window

**New param:** `tkb_get_odds` now accepts optional `preferredBookmakers` (comma-separated, e.g. `"fanduel,draftkings"`) to control which book's price is returned, instead of whatever happened to come back first.

**Practical effect:** faster responses, and this should meaningfully reduce (likely eliminate) the memory pressure that caused the earlier "Ran out of memory (used over 512MB)" crashes - independent of the Render instance upgrade, which was a workaround for the same underlying issue. Nothing about the tool names, parameters (aside from the one addition), or how threads get built has changed - this is purely a request-efficiency fix.

## Tools (10)

- `tkb_get_schedule` - game schedule, date/team/conference filtering
- `tkb_get_odds` - moneyline/spread/total, or an individual player's over/under prop (now requests exact oddIDs directly)
- `tkb_get_player_hit_rate` - real recent-game-log hit-rate check (now requests minimal odds payload)
- `tkb_get_injuries` - structured injury status from BALLDONTLIE (team field confirmed fixed: `player.team.display_name`)
- `tkb_get_team_split` - home/road/opponent-specific record (now requests minimal odds payload)
- `tkb_get_team_record` - overall record from SGO's standings data
- `tkb_get_yes_no_prop` - milestone-style bets (now requests exact oddID directly)
- `tkb_get_period_odds` - period-specific lines (now requests exact oddID directly)
- `tkb_debug_raw_event` - dumps raw SGO event JSON
- `tkb_debug_raw_injuries` - dumps raw BALLDONTLIE injuries JSON

## Confirmed working / fixed across all prior rounds (still in effect)

- Start time field (`status.startsAt`)
- Schedule/odds teamName searches properly date-bounded
- Moneyline/spread odds correct with or without explicit `side`
- Hit-rate and team-split date bounding (no more stale/ancient data)
- BALLDONTLIE injuries team field (`player.team.display_name`)
- No `lineups` field exists on SGO events - starting pitcher confirmation is a permanent live-search requirement, not something this API can provide

## Still genuinely unverified

- Player `teamID` update speed after a real trade (though one real offseason trade - Semien to Mets - was confirmed correctly reflected)
- `includeOpposingOdds` behavior (added to client, not yet used by any tool - worth adopting in a future round to cut requests further for two-sided markets)

## Operational notes

**Render instance:** currently on Standard (2GB RAM). This round's fix targets the root cause of the earlier OOM crashes directly, so the bigger instance should now have even more headroom than before.

**MCP connector caching:** remove/re-add if new tools/behavior don't show up after redeploy.

**Start Command must be exactly `npm start`.**

## Deploy to Render

1. Upload this folder's contents to the GitHub repo (overwrite existing files)
2. Render auto-redeploys
3. Verify: `https://YOUR-SERVICE.onrender.com/health`
4. Remove/re-add the MCP connector if tools seem stale

## Adding NBA/NHL later

1. Get a BALLDONTLIE subscription for that sport
2. Add one entry to `SPORT_CONFIG` in `src/constants.ts`
3. Push to GitHub

## Local development

```bash
npm install
npm run build
SGO_API_KEY=xxx BDL_API_KEY=xxx npm start
```
