# TKB Picks MCP Server

Wraps SportsGameOdds (odds/schedule/stats) and BALLDONTLIE (injuries) into MCP tools for TKB Picks thread-building.

## Status: all major bugs found during testing are now fixed and CONFIRMED via live data

## Tools (10)

- `tkb_get_schedule` - game schedule, date/team/conference filtering
- `tkb_get_odds` - moneyline/spread/total/player prop
- `tkb_get_player_hit_rate` - recent-game-log hit-rate, CONFIRMED pulling real recent (not stale) data
- `tkb_get_injuries` - structured injury status, CONFIRMED team field now populates correctly, plus richer detail (type/side/comments)
- `tkb_get_team_split` - home/road/opponent-specific record
- `tkb_get_team_record` - overall record from SGO's standings data
- `tkb_get_yes_no_prop` - milestone-style bets
- `tkb_get_period_odds` - period-specific lines
- `tkb_debug_raw_event` - dumps raw SGO event JSON
- `tkb_debug_raw_injuries` - dumps raw BALLDONTLIE injuries JSON (the tool that finally solved the team-field bug below)

## The BALLDONTLIE team-field bug - finally solved, confirmed via live raw JSON

Took 3 attempts to get right:
1. Assumed `player.team.full_name` (nested) - wrong field name
2. Assumed `team.full_name` (sibling) based on BALLDONTLIE's docs example for a *different* endpoint - wrong location entirely
3. **Used the new debug tool to see the ACTUAL raw injuries response** - real answer: `player.team.display_name` (nested location was right the whole time, just the wrong field name - `display_name` not `full_name`)

**Bonus finding:** the raw response also includes much richer injury data than originally captured - `type` (e.g. "Lower Body"), `detail` (e.g. "Strain"), `side` (e.g. "Left"), and both `short_comment`/`long_comment` with real dated, sourced context. All of this is now captured in `NormalizedInjury` instead of being discarded.

**Confirmed via live test:** injuries tool now returns real team names correctly.

## Hit-rate date-bounding fix - confirmed via live test

Previously (before this round's fix) returned September 2024 games when asked for "recent" games in August 2026. Root cause: unbounded `finalized: true` queries with no date range, combined with the API's cursor pagination not being guaranteed chronological order.

**Confirmed via live test:** Michael Harris II's hit-rate check now returns real, correctly-dated games from July 27 - August 6, 2026, with correct opponents matching the real schedule (Marlins, Nationals, Mets).

## Infrastructure note: Render instance upgraded

The Free tier (512MB RAM) was hitting real OOM crashes ("Ran out of memory... over 512MB") under normal tool usage - not a code bug exactly, more that this API's payloads (a single MLB event can carry 1000+ odds markets) are memory-heavier than Free tier comfortably supports. Upgraded to Render's Standard tier (2GB RAM, $25/mo) to resolve this. If OOM issues ever recur even on Standard, the next step would be code-level memory optimization (trimming unused fields before holding results in memory) rather than a further instance upgrade.

## Previously fixed (all still in effect, confirmed via live testing across multiple rounds)

- Debug tool crash (oversized payload) - capped
- Yes/No prop crash - same fix
- `tkb_get_odds`/`tkb_get_schedule` teamName search pulling entire history - both bounded
- `startTimeISO` "unknown" - fixed (`status.startsAt`)
- `tkb_get_odds` moneyline/spread broken without explicit `side` - fixed
- No `lineups` field on SGO events - confirmed, starting pitcher info stays a web-search task

## Still genuinely unverified (lower priority, not blocking normal use)

- Player `teamID` update speed after a real trade - can only be tested against an actual live trade when one occurs

## Operational notes

**Render instance:** now on Standard (2GB RAM) - should comfortably handle normal usage including heavy calls (full event pulls, wide hit-rate lookbacks).

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
