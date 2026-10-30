# TKB connector v2.20.2: slate tools no longer hide games

Built on GitHub main at v2.20.1 (commit 96b4680). 1034/1034 tests pass, 5/5 mutations caught.

## Upload (same paths, overwrite)
package.json
src/index.ts
src/services/sgoClient.ts
src/services/slateEvents.ts   (NEW)
src/tools/gameLines.ts
src/tools/schedule.ts
src/tools/screenSlate.ts
test/v2_10_4.test.ts
test/v2_20_2.test.ts          (NEW)

## Delete on GitHub
src/tools/debugInjuries.ts   (still there; it is the one failing test)

## The bug (measured 2026-10-30)
SGO returned 24 NCAAB events for Nov 1-12. ESPN's Division I board for Nov 2 lists
games SGO never returned (Grambling @ Northern Illinois, App State @ Merrimack,
Winthrop @ Queens, UTEP @ Northern Kentucky); the owner counts 77. Every date-range
fetch sent ONE moneyline oddID filter to keep payloads small, on an unmeasured
belief that the filter cannot hide events. Games with no moneyline posted yet are
the likely casualties.

## The fix
- tkb_get_schedule, tkb_get_game_lines (date ranges) and tkb_screen_slate enumerate
  the slate twice, with and without the filter, and merge by eventID. The unfiltered
  pass is paged and stripped of odds page by page, so memory stays bounded.
- tkb_get_schedule reports `enumeration` {withOddFilter, withoutOddFilter,
  foundOnlyWithoutFilter} and a NOTE when games were found only without the filter.
  The first live call measures whether the filter was the cause.
- Team and player names are cleaned at the SGO client: tabs, newlines and double
  spaces collapse to one space ("Notre Dame of Maryland<TAB>Gators" was live).

## After deploy, test
tkb_get_schedule sport=cbb startsAfter=2026-10-31T07:00:00Z startsBefore=2026-11-12T08:00:00Z
and read `enumeration.foundOnlyWithoutFilter`. If it is still 24 total, SGO itself has not
loaded the games yet and the cause is upstream, not the filter.

## Cost
One extra ranged request per slate call (SGO bills per event object, so roughly double
the entities for that call: ~24 to ~150 for a CBB night against a 3,000,000/day cap).
