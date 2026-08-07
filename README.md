# TKB Picks MCP Server

Wraps SportsGameOdds (odds/schedule/stats) and BALLDONTLIE (injuries) into MCP tools for Claude to use when building TKB Picks threads.

## Tools (10)

- `tkb_get_schedule` - game schedule
- `tkb_get_odds` - moneyline/spread/total/player prop
- `tkb_get_player_hit_rate` - recent-game-log hit-rate (now bounded to a real ~220-day trailing window)
- `tkb_get_injuries` - structured injury status from BALLDONTLIE (team field still buggy - see below)
- `tkb_get_team_split` - home/road/opponent-specific record (event-tallying)
- `tkb_get_team_record` - overall record from SGO's real standings data
- `tkb_get_yes_no_prop` - milestone-style bets
- `tkb_get_period_odds` - period-specific lines
- `tkb_debug_raw_event` - dumps raw SGO event JSON
- `tkb_debug_raw_injuries` - **NEW** dumps raw BALLDONTLIE injuries JSON

## ⚠️ Open bug: BALLDONTLIE injuries team field still "unknown" after 2 fix attempts

**Attempt 1** assumed `player.team` (nested) - wrong, produced "unknown" for every record.
**Attempt 2** assumed `team` as a sibling field on the record (based on BALLDONTLIE's docs example for their *stats* endpoint) - live-tested, still wrong, still "unknown".

Rather than guess a third time, added `tkb_debug_raw_injuries` (same pattern as the working SGO debug tool) to see the ACTUAL raw JSON shape for the injuries endpoint specifically, since it may genuinely differ from the stats endpoint shape shown in BALLDONTLIE's docs.

**Next step once deployed:** call `tkb_debug_raw_injuries` for MLB, find the real field path for team info in the actual response, and fix `src/tools/injuries.ts` + the `BDLInjury` type in `src/types.ts` to match. Do not guess again - use the debug tool's real output.

**Practical impact until fixed:** the `team` field on injury results is unreliable. Player-name search (`playerName` param) works correctly and returns accurate status/description/return-date - only the team-name filter and team display field are affected. When checking a specific team's injuries, search by individual player names (via web search or roster lookup) rather than trusting `teamName` filtering on this tool.

## Other fixes in this round

- New `tkb_get_team_record` tool using SGO's real standings data (confirmed via their OpenAPI spec)
- Confirmed (not just assumed) via SGO's official docs: `periodID: "game"`, oddID format, period codes `1h/2h/1q/2q/3q/4q`

## Previously fixed (still in effect)

- Debug tool crash (oversized payload) - capped
- Yes/No prop crash - same fix
- `tkb_get_odds`/`tkb_get_schedule` teamName search pulling entire history - both bounded
- `startTimeISO` "unknown" - fixed (`status.startsAt`)
- `tkb_get_odds` moneyline/spread broken without explicit `side` - fixed
- `tkb_get_player_hit_rate` / `tkb_get_team_split` pulling unbounded non-recent history - both bounded to ~220 days

## Still genuinely unverified

- Player `teamID` update speed after a real trade
- BALLDONTLIE injuries team field (see above - actively being debugged)

## Operational notes

**Render free tier cold starts:** check Logs tab to distinguish cold-start from a real crash.

**MCP connector caching:** remove/re-add if new tools don't show up after redeploy.

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
