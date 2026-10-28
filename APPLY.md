# TKB connector v2.20.0: BALLDONTLIE replaced, run-report fixes

Built on GitHub main at v2.19.1 (commit 00e1c65). 1023/1023 tests pass, tsc clean,
21 of 21 mutations caught.

## Upload (same paths, overwrite)
package.json
src/index.ts
src/services/cfbdClient.ts
src/services/cfbdRecords.ts        (NEW)
src/services/espnInjuries.ts
src/services/espnRankings.ts       (NEW)
src/services/espnRosterIndex.ts    (NEW)
src/services/espnStandings.ts      (NEW)
src/services/statAliases.ts        (NEW)
src/tools/coverPlayer.ts
src/tools/hitRate.ts
src/tools/injuries.ts
src/tools/propBoard.ts
src/tools/rankings.ts
src/tools/screenProps.ts
src/tools/screenSlate.ts           (NEW tool: tkb_screen_slate)
src/tools/splits.ts
src/tools/standings.ts
src/tools/verifyRoster.ts
test/v2_16_0.test.ts
test/v2_19_0.test.ts
test/v2_20_0.test.ts               (NEW)

## Delete on GitHub
src/tools/debugInjuries.ts   (still there; it fails a test)

## Render
Optional but recommended: delete the BDL_API_KEY environment variable. BDL is cancelled;
with the key gone every BDL path is skipped cleanly instead of returning 401s.
CFBD_API_KEY must stay set (CFB standings and CFB roster checks now use it).

## What changed
1. Injuries: MLB moved to ESPN. Freshness = newest entry. Every answer lists team coverage;
   teams missing from ESPN's league feed are checked per team (ESPN_LISTS_ZERO /
   MISSING_FROM_FEED / UNCONFIRMED).
2. tkb_verify_roster: ESPN league roster index (cached 6h) for NBA/NFL/NHL/MLB/WNBA/EPL/UCL,
   CFBD player search for CFB, batch mode (players: up to 40).
3. tkb_get_standings + tkb_get_team_split: ESPN standings for pro leagues, CFBD /records for CFB.
4. tkb_get_rankings: ESPN AP Top 25.
5. tkb_get_prop_board compact=true.
6. New tkb_screen_slate: screens every game on a date in one call.
7. tkb_get_player_hit_rate: statID aliases ("receptions" -> receiving_receptions).
8. tkb_get_cover_player: injury gate now reads ESPN (it was silently empty since BDL ended).
9. tkb_screen_props: MLB no longer tries BDL on every prop.

## Still BDL-only (next release)
tkb_scan_streaks, tkb_debug_bdl_stats, and grading's second-source finality check
(every sport except NHL).

## Scheduled runs
Nothing breaks: tool names and inputs are unchanged. Paste RUN-BRIEF.txt near the top
of each pick run so they USE the new options (batch roster check, compact board,
slate screen, injury coverage).
