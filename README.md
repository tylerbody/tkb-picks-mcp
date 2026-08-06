# TKB Picks MCP Server

Wraps SportsGameOdds (odds/schedule/stats) and BALLDONTLIE (injuries) into MCP tools for Claude to use when building TKB Picks threads.

## Tools

- `tkb_get_schedule` - game schedule, date/team/conference filtering
- `tkb_get_odds` - moneyline/spread/total, or an individual player's over/under prop
- `tkb_get_player_hit_rate` - real recent-game-log hit-rate check (not a fixed window)
- `tkb_get_injuries` - structured injury status from BALLDONTLIE
- `tkb_get_team_split` - home/road/opponent-specific win-loss records
- `tkb_get_yes_no_prop` - milestone-style bets (first TD, any home run, double-double, etc.)
- `tkb_get_period_odds` - period-specific lines (1st half, 1st 5 innings, quarters, etc.)
- `tkb_debug_raw_event` - diagnostic tool, dumps raw SGO event JSON (odds capped to first 5 markets - a single event can have 1000+ markets)

## Live-test status (confirmed against real SportsGameOdds/BALLDONTLIE data)

**Confirmed working correctly:**
- Schedule (with date), period odds, exact-eventID odds, injuries, Yes/No props
- oddID construction pattern - confirmed exactly correct against real SGO responses
- Start time field - fixed and confirmed correct: real field is `status.startsAt`, not `info.date`

**Definitively answered:**
- **No `lineups` field exists on SGO events.** Confirmed by inspecting a real event object - SGO doesn't expose probable/confirmed starting pitchers pre-game. Keep using web search for that.

**Fixed this round (verified via live testing):**
- `tkb_debug_raw_event` was hard-crashing on every call - a single event's `odds` object can contain 1000+ markets with full pricing, blowing past response size limits. Capped to a count + first 5 samples.
- `tkb_get_yes_no_prop` was crashing - same root cause as above, resolved by the same fix.
- `tkb_get_odds` teamName fallback (no eventID) was searching the entire season - added a date lower-bound.
- `startTimeISO` always returned "unknown" - fixed across `tkb_get_schedule` and `tkb_get_player_hit_rate`.
- **`tkb_get_schedule`'s `teamName`-only search (no date given) had NO date bound at all** - was returning multi-season history back to February 2024. Now defaults to a 45-day forward window from today when only `teamName` is given with no date.
- **`tkb_get_odds` with `marketType: "moneyline"` or `"spread"` and no explicit `side` was fundamentally broken** - it computed `entity` once outside the per-side loop instead of per-side, building invalid oddIDs like `points-all-game-ml-home` (should be `points-home-game-ml-home`). Confirmed via live test: entity always equals side exactly for moneyline/spread bet types. Fixed to compute entity correctly inside the loop, per side.

**Known data quality note (not fixable on our end):** SGO's own player records can have internal inconsistencies - e.g. one player's `firstName`/`lastName` fields didn't match their actual name in a live test. Existing roster/injury verification workflow (live web search cross-check) is still necessary.

**Still genuinely unverified:**
- Player `teamID` update speed after a real trade
- `periodID` for full-game stats in `results` (assumed `"game"` - couldn't confirm yet, test event was pre-game with empty `results: {}`)
- BALLDONTLIE injuries always show `team: "unknown"` - separate provider/bug, not yet diagnosed. Would need a raw BALLDONTLIE response inspected (no debug tool for BALLDONTLIE yet).

## Operational notes

**Render free tier cold starts:** if idle, the first request can be slow/fail while spinning up. Check Render's Logs tab to distinguish a cold-start hiccup (no error in logs) from a real crash (stack trace present).

**MCP connector tool list caching:** if new tools don't show up after a redeploy, remove and re-add the connector to force a clean refresh - this has been an intermittent issue during development.

**Start Command must be exactly `npm start`** - if it ever reverts to `npm install` only, the service will build successfully but immediately exit ("Application exited early") since nothing binds to a port.

## Deploy to Render

1. Push this folder's contents to the GitHub repo (upload via web UI is fine - drag the contents of this folder into the repo, not the folder itself)
2. Render should auto-redeploy if already connected
3. Verify: `https://YOUR-SERVICE.onrender.com/health` should return `{"status":"ok",...}`
4. If tools seem stale/missing, remove and re-add the MCP connector

## Adding NBA/NHL later

1. Get a BALLDONTLIE subscription for that sport (same key, new sport tier)
2. Add one entry to `SPORT_CONFIG` in `src/constants.ts`
3. Push to GitHub - Render auto-redeploys

## Local development

```bash
npm install
npm run build
SGO_API_KEY=xxx BDL_API_KEY=xxx npm start
```
