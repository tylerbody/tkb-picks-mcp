# TKB Picks MCP Server

Wraps SportsGameOdds (odds/schedule/stats) and BALLDONTLIE (injuries) into MCP tools for Claude to use when building TKB Picks threads.

## Tools

- `tkb_get_schedule` - game schedule, date/team/conference filtering
- `tkb_get_odds` - moneyline/spread/total, or an individual player's over/under prop (exact market construction, not fuzzy matching)
- `tkb_get_player_hit_rate` - real recent-game-log hit-rate check (not a fixed window)
- `tkb_get_injuries` - structured injury status from BALLDONTLIE
- `tkb_get_team_split` - home/road/opponent-specific win-loss records
- `tkb_get_yes_no_prop` - milestone-style bets (first TD, any home run, double-double, pitching win, etc.)
- `tkb_get_period_odds` - period-specific lines (1st half, 1st 5 innings, quarters, etc.)
- `tkb_debug_raw_event` - TEMPORARY diagnostic tool, dumps raw SGO event JSON (odds section capped to first 5 markets to avoid oversized responses). Remove once schema is confirmed.

## Live test findings (as of this build)

**Confirmed working:**
- Schedule pulls, live game status, scores - real data confirmed
- Period odds construction - 1st 5 innings moneyline confirmed correct against a real price
- Full-game odds with an exact `eventID` - confirmed correct
- Injuries tool - confirmed working, pulled 214 real live BALLDONTLIE records

**Fixed in this build:**
1. **`tkb_get_odds` teamName fallback searched the entire season** instead of just today/upcoming - added an explicit `startsAfter` date bound so it can't surface old finished games again. (Root cause of `finalized: false` not being sufficient on its own is not fully confirmed - this fix is a belt-and-suspenders bound, not a diagnosed root cause fix.)
2. **`tkb_debug_raw_event` was hard-failing on every call** - root cause: no size cap on the `odds` object, which can contain hundreds of markets with full per-bookmaker pricing, likely blowing past a response size limit. Fixed by capping the odds section to a count + first 5 markets. Also added defensive JSON.stringify error handling and fuller error messages.

**Still broken, needs the debug tool's next real output to fix properly:**
3. **`startTimeISO` always returns "unknown"** - the assumed field path (`event.info?.date`) is wrong. Now that the debug tool works, run it against a real event and find the actual field, then fix in `src/tools/schedule.ts`.
4. **`tkb_get_yes_no_prop` threw a hard error** on "Any Score" (MLB) - likely the assumed oddID pattern for team/game-wide Yes/No markets doesn't match reality. Confirm via `tkb_debug_raw_event`'s odds sample and fix the oddID construction in `src/tools/yesNoProps.ts` or `src/services/oddIdBuilder.ts`.
5. **BALLDONTLIE injuries always show `team: "unknown"`** - the assumed field path (`i.player.team?.full_name`) doesn't match BALLDONTLIE's real response shape for this endpoint. Needs inspecting a raw BALLDONTLIE injuries response (no debug tool for this yet - consider adding one, or log the raw shape temporarily) and fixing in `src/tools/injuries.ts`.

**Still unverified (not yet tested):**
6. `lineups` field on SGO events - probable starting pitchers?
7. Player `teamID` update speed after a trade
8. `periodID` for full-game stats (assumed `"game"`)
9. BALLDONTLIE path convention for sports other than the one tested
10. CFB conference/Top-25 filtering
11. Period codes beyond 1st_5_innings

## Operational note: Render free tier cold starts

If the service has been idle, the first request after a while can be slow or intermittently fail while it spins back up. If a tool call fails right after a period of inactivity, try again once before assuming it's a real bug - check Render's Logs tab for actual error output to tell the difference between "cold start hiccup" (no error in logs) and "real crash" (stack trace in logs).

## Deploy to Render

### 1. Push to GitHub

Unzip this package, then from inside the folder:

```bash
git init
git add .
git commit -m "Fix debug tool response size, add date bound to odds teamName search"
git remote add origin https://github.com/YOUR_USERNAME/tkb-picks-mcp-server.git
git branch -M main
git push -u origin main
```

If pushing to an existing repo that's out of sync, either force-push (`git push -f origin main`, if you're sure the remote history doesn't matter) or delete and recreate the GitHub repo, then upload this folder's contents fresh via GitHub's web upload (drag the *contents* of this folder, not the folder itself).

### 2. Render

Same service settings as before:
- **Runtime**: Node
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start`
- **Environment variables**: `SGO_API_KEY`, `BDL_API_KEY` (same values as before)

Render will auto-redeploy on push if already connected to this repo.

### 3. Re-verify

- `https://YOUR-SERVICE.onrender.com/health` should return `{"status":"ok",...}`
- If you removed/re-added the MCP connector before, you may need to do that again after this deploy to force a clean tool-list refresh.

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
