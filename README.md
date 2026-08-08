# TKB Picks MCP Server

Wraps SportsGameOdds (odds/schedule/stats), BALLDONTLIE (injuries), and weather.gov (MLB stadium weather) into MCP tools for TKB Picks thread-building.

## New this round: MLB stadium weather (`tkb_get_game_weather`)

**No env variable needed.** weather.gov is a free, public US government API - authentication is just a `User-Agent` string (hardcoded in `weatherClient.ts`), not a secret key, so nothing needs to be added to Render.

**How it works:**
1. `src/data/mlbStadiums.ts` - static table of all 30 MLB stadiums (coordinates + roof type: outdoor/dome/retractable). Team -> home stadium is a fixed relationship, so this never needs a dynamic lookup.
2. `src/services/weatherClient.ts` - two-step weather.gov lookup: `/points/{lat},{lon}` resolves to a forecast URL, then that URL returns real forecast periods (temp, wind, precip chance).
3. `src/tools/weather.ts` - the tool itself, which is deliberately conservative about what it calls "relevant":
   - **Dome stadiums** (e.g. Tropicana Field) -> always returns `relevant: false`, weather is never a factor, don't even bother checking further
   - **Retractable-roof stadiums** (Rogers Centre, Daikin Park, loanDepot park, American Family Field, Chase Field) -> returns `relevant: "unconfirmed"` with a note to verify roof status via live search, since same-day open/closed decisions aren't knowable from any API
   - **Outdoor stadiums** -> real forecast returned, plus an `isNotable` flag (true only if wind ≥12mph, precip chance ≥40%, or temp ≥95°F/≤40°F) - ordinary/mild conditions return `isNotable: false` and should NOT be mentioned in a thread, per the standing style rule that weather only gets called out when it's a real factor

**Usage in thread-building:** call this once per game (pass the home team's teamID) before writing the opener. If `relevant: false` or `isNotable: false`, skip weather entirely - don't force a mention. Only use it in reasoning/opener when `isNotable: true`, or when a retractable-roof check confirms the roof is open and conditions are notable.

**Known limitation:** stadium locations in the table reflect standard/primary venues - if a team is playing at a temporary home (renovation, relocation, disaster displacement), this table could be stale. Spot-check if something seems off, same discipline as roster/injury verification elsewhere in this connector.

## Tools (11)

- `tkb_get_schedule` - game schedule, date/team/conference filtering
- `tkb_get_odds` - moneyline/spread/total, or player prop (requests exact oddIDs directly, optional `preferredBookmakers`)
- `tkb_get_player_hit_rate` - real recent-game-log hit-rate check
- `tkb_get_injuries` - structured injury status from BALLDONTLIE
- `tkb_get_team_split` - home/road/opponent-specific record
- `tkb_get_team_record` - overall record from SGO's standings data
- `tkb_get_yes_no_prop` - milestone-style bets
- `tkb_get_period_odds` - period-specific lines
- `tkb_get_game_weather` - **NEW** MLB stadium weather, dome/retractable-aware
- `tkb_debug_raw_event` - dumps raw SGO event JSON
- `tkb_debug_raw_injuries` - dumps raw BALLDONTLIE injuries JSON

## Confirmed working / fixed across all prior rounds (still in effect)

- Response-size optimization: all odds tools now request exact oddIDs/playerID/bookmakerID directly instead of fetching full events and filtering client-side (root-cause fix for the earlier OOM crash)
- Start time field, schedule/odds teamName date-bounding, moneyline/spread odds with or without explicit side
- Hit-rate and team-split date bounding (no stale/ancient data)
- BALLDONTLIE injuries team field (`player.team.display_name`)
- No `lineups` field on SGO events - starting pitcher confirmation is a permanent live-search requirement

## Still genuinely unverified

- Player `teamID` update speed after a real trade (one real offseason trade confirmed correctly reflected)
- Retractable-roof status can never be confirmed by this connector alone - always requires a live-search cross-check when the tool flags `relevant: "unconfirmed"`

## Future prospecting (not yet built)

- Pitcher-vs-specific-opponent historical record (extension of existing splits logic, applied to individual pitchers rather than teams)
- Weather for other sports (NFL/CFB are also outdoor-relevant; not yet scoped)

## Operational notes

**Render instance:** Standard tier (2GB RAM).

**No new environment variables this round** - weather.gov requires no key.

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
