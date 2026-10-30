# TKB Picks MCP v2.20.3: label fix + Retry-After

Upload these 14 files to GitHub main at the same paths (Add file > Upload files, drag the folders in), commit, and let Render redeploy. Nothing to delete, no env var changes.

## Changed files
- package.json (version 2.20.3)
- src/index.ts (SERVER_VERSION 2.20.3)
- src/services/marketCatalog.ts (labels, aliases, findMarketByLabel)
- src/services/statAliases.ts (resolver reads aliases)
- src/services/sgoClient.ts (Retry-After on 429)
- src/tools/odds.ts, lineMovement.ts, yesNoProps.ts, gradePicks.ts, gradeSlate.ts, liveMonitor.ts (label lookup via findMarketByLabel)
- test/v2_10_9.test.ts, test/v2_14_0.test.ts (updated to new labels)
- test/v2_20_3.test.ts (new)

## What changed
1. SGO's `points` stat is now labelled like a bet:
   - NBA, NCAAB, WNBA, NFL, NCAAF: "Points" (was "Score")
   - MLB: "Runs" (was "Score")
   - "Score" still works everywhere as an alias, so old picks, registries and run briefs keep grading.
   - NHL unchanged: "Points" = goals+assists, "Goals" = points.
2. A 429 with a short Retry-After (15s or less) is waited out and retried once. Longer waits, no header, or a second 429 error out with the wait SGO asked for.

## Scheduled runs
No brief changes needed. Tool names and inputs are the same. Output lines will now say "Points"/"Runs" instead of "Score".

Tests: 1044/1044 pass. 6/6 mutations caught.
