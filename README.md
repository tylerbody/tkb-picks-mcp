# TKB Picks MCP Server

Wraps SportsGameOdds (odds/schedule/stats) and BALLDONTLIE (injuries) into MCP tools for Claude to use when building TKB Picks threads.

## Tools (9)

- `tkb_get_schedule` - game schedule, date/team/conference filtering
- `tkb_get_odds` - moneyline/spread/total, or an individual player's over/under prop
- `tkb_get_player_hit_rate` - real recent-game-log hit-rate check
- `tkb_get_injuries` - structured injury status from BALLDONTLIE
- `tkb_get_team_split` - home/road/opponent-specific win-loss records (computed from event tallying)
- `tkb_get_team_record` - **NEW** overall team record from SGO's real standings data (fast, no tallying)
- `tkb_get_yes_no_prop` - milestone-style bets
- `tkb_get_period_odds` - period-specific lines
- `tkb_debug_raw_event` - diagnostic tool, dumps raw SGO event JSON

## This round's fixes (batched, from real API documentation - SGO's OpenAPI spec + BALLDONTLIE's official docs)

**1. BALLDONTLIE injuries `team: "unknown"` bug - fixed.**
Root cause confirmed via BALLDONTLIE's own docs example (their stats endpoint response shape): `team` is a SIBLING field on the record, not nested inside `player`. Original code assumed `player.team`, which was always undefined. Fixed to check the sibling `team` field first, falling back to the nested path in case the injuries endpoint differs from stats (not independently confirmed for injuries specifically - flag if `team: "unknown"` still appears after this fix, since that would mean the injuries endpoint has a genuinely different shape).

**2. New `tkb_get_team_record` tool.**
SGO's official OpenAPI spec confirms teams have a real `standings` object (`wins`, `losses`, `record`, `last5`, `streak`) directly available via `/teams` - no need to fetch and tally every event ourselves for a simple overall record. Added as a new, separate tool rather than rewriting the existing (now-working) `tkb_get_team_split`, to avoid risking a working tool for an enhancement. Use `tkb_get_team_record` for "what's their record," `tkb_get_team_split` for home/road/opponent-specific splits (standings doesn't break those out).

**3. Confirmed correct (no code change needed, but now certain rather than assumed):**
- `periodID: "game"` for full-game stats - confirmed directly from SGO's OpenAPI spec example
- oddID format `{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}` - confirmed
- Period codes `1h`, `2h`, `1q`, `2q`, `3q`, `4q` - confirmed via SGO's official AI context doc (previously only `1ix5` was independently confirmed)

## Previously fixed (still in effect, from earlier rounds)

- Debug tool crash (oversized odds payload) - capped to first 5 markets
- Yes/No prop crash - same root cause, same fix
- `tkb_get_odds`/`tkb_get_schedule` teamName search pulling entire history instead of recent/upcoming - both now bounded
- `startTimeISO` "unknown" - fixed, real field is `status.startsAt`
- `tkb_get_odds` moneyline/spread broken without explicit `side` - entity/side computation fixed
- `tkb_get_player_hit_rate` / `tkb_get_team_split` pulling unbounded non-recent history - both now bounded to a ~220-day trailing window

## Still genuinely unverified

- Player `teamID` update speed after a real trade - can only be tested live against an actual trade
- Whether the `team` sibling-field fix (item 1 above) is fully correct for the injuries endpoint specifically, vs. only confirmed for stats

## Operational notes

**Render free tier cold starts:** first request after idle can be slow/fail. Check Logs tab to distinguish cold-start from a real crash.

**MCP connector caching:** if new tools/behavior don't show up after redeploy, remove and re-add the connector.

**Start Command must be exactly `npm start`.**

## Deploy to Render

1. Upload this folder's contents to the GitHub repo (overwrite existing files)
2. Render auto-redeploys if connected
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
