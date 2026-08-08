# TKB Picks MCP Server

Wraps SportsGameOdds, BALLDONTLIE, and weather.gov into MCP tools for TKB Picks thread-building.

## ⚠️ Real bug found and fixed via live test: precipitation chance was silently ignored

First live test of `tkb_get_game_weather` (Phillies, real 60% thunderstorm chance) returned `isNotable: false` - completely wrong, since 60% rain chance should clearly be flagged. Root cause: weather.gov's real API returns `probabilityOfPrecipitation` as an OBJECT (`{ unitCode: "wmoUnit:percent", value: 60 }`), not a plain number like assumed. The `precipProb >= 40` check was comparing against the whole object, which never evaluates true, so real rain risk was silently never triggering the "notable" flag.

**Fixed:** `WeatherPeriod.probabilityOfPrecipitation` type corrected to the real object shape, and the tool now extracts `.value` before comparing. Confirmed dome and retractable-roof logic both worked correctly on the same test pass - this bug was isolated to the precipitation check specifically.

**Practical impact:** any weather check run before this fix could have missed real rain risk. Not used in any posted thread yet (this was caught on first live test), so no correction needed to past content.

## Tools (11)

- `tkb_get_schedule`, `tkb_get_odds`, `tkb_get_player_hit_rate`, `tkb_get_injuries`, `tkb_get_team_split`, `tkb_get_team_record`, `tkb_get_yes_no_prop`, `tkb_get_period_odds` - all previously confirmed working
- `tkb_get_game_weather` - MLB stadium weather, dome/retractable-aware, precipitation bug now fixed
- `tkb_debug_raw_event`, `tkb_debug_raw_injuries` - diagnostic tools

## Weather tool behavior (confirmed via live test)

- **Dome stadiums** (Tropicana Field) -> `relevant: false`, no API call needed, confirmed working
- **Retractable-roof stadiums** (Rogers Centre, etc.) -> `relevant: "unconfirmed"`, flags need for live-search roof check, confirmed working
- **Outdoor stadiums** -> real forecast pulled, `isNotable` flag now correctly reflects wind/precip/temp thresholds after the bug fix above

## All prior fixes still in effect

- Response-size optimization (exact oddIDs/playerID/bookmakerID requested directly)
- Start time field, date-bounded searches, moneyline/spread odds correctness
- Hit-rate and team-split date bounding
- BALLDONTLIE injuries team field (`player.team.display_name`)
- No `lineups` field on SGO events - starting pitcher confirmation stays a live-search task

## Operational notes

**Render instance:** Standard tier (2GB RAM).

**No new environment variables** - weather.gov requires no key.

**MCP connector caching / mid-deploy timing:** if a newly added tool doesn't show up immediately after upload, the deploy may still be in progress - wait a moment and re-check rather than assuming the upload failed. Confirmed this was the cause of an earlier "tool not found" false alarm this session.

**Start Command must be exactly `npm start`.**

## Deploy to Render

1. Upload this folder's contents to the GitHub repo (overwrite existing files)
2. Render auto-redeploys
3. Verify: `https://YOUR-SERVICE.onrender.com/health`
4. Remove/re-add the MCP connector if tools seem stale

## Local development

```bash
npm install
npm run build
SGO_API_KEY=xxx BDL_API_KEY=xxx npm start
```
