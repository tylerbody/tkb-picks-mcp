# TKB connector v2.20.1: fixes from the v2.20.0 live test

Built on GitHub main at v2.20.0 (commit 466849d). 1028/1028 tests pass, 4/4 mutations caught.

## Upload (same paths, overwrite)
package.json
src/index.ts
src/services/seasonBoundary.ts
src/tools/rankings.ts
src/tools/screenSlate.ts
src/tools/splits.ts
src/tools/standings.ts
test/v2_20_1.test.ts   (NEW)

## Delete on GitHub
src/tools/debugInjuries.ts   (still there; it is the one failing test)

## What changed
1. tkb_screen_slate: a game whose players are attached but have no props priced at your
   books now says "NO PROPS PRICED AT YOUR BOOKS YET" instead of "screened, 0 of 0".
2. Season warnings name PRIOR seasons only. They read "7 from prior season(s) (2026, 2025)",
   listing the current season as a prior one. Counts were always right.
3. Tool descriptions the scheduled runs read: tkb_get_rankings and tkb_get_team_split now
   name ESPN (not BALLDONTLIE) as their source, and tkb_get_standings no longer says a CFB
   conference is required (a teamName works too).

No tool names or inputs changed. Scheduled runs need nothing new.
