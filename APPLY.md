# TKB connector v2.19.1: `date` no longer hides games

Built on GitHub main at v2.19.0 (commit a5a30f2). 996/996 tests pass, tsc clean.

## Upload these (same paths, overwrite)
- package.json
- src/index.ts
- src/services/slateDay.ts   (NEW)
- src/tools/schedule.ts
- src/tools/gameLines.ts
- test/v2_19_1.test.ts       (NEW)

## Delete this on GitHub (third time asked; it fails a test)
- src/tools/debugInjuries.ts

## The bug
`date: "2026-10-28"` was read as a UTC day (00:00Z to 23:59Z). UTC midnight is
5 PM Pacific / 8 PM Eastern, so the tool:
- DROPPED every game starting 8 PM Eastern or later (NBA 10/28 showed 6 games and
  hid Spurs @ Jazz, Thunder @ Mavericks, Lakers @ Clippers; NHL showed 1 of the night's games)
- PULLED IN the previous night's late games (Blazers @ Lakers, 8 PM Pacific on 10/27)

## The fix
`date` now means the PACIFIC calendar day: local midnight to midnight, DST-correct
(23 or 25 hours on change days). Applies to tkb_get_schedule and tkb_get_game_lines.
The schedule response now includes a `window` field showing the exact UTC bounds used.

## Scheduled runs: NOT affected
Audited all 22 scheduled tasks on 2026-10-28. None passes `date=` to either tool.
Every run passes explicit startsAfter/startsBefore, which are passed through exactly
as before (a test pins this). The "no date given" defaults are unchanged too.
