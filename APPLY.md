# v2.17.1 hotfix: seasonYear was labelled from ESPN's param, not the game's date

Found on YOUR live v2.17.0 deploy, in the first NBA call. Four files.

```
src/services/espnHitRateAggregator.ts   the fix + espnRowSeasonYear()
src/index.ts                            2.17.0 -> 2.17.1
test/v2_17_0.test.ts                    +5 tests (67 in this file, 940 total)
package.json                            2.17.1
```

## What was wrong

Luka Doncic, games dated March and April 2026, fetched under ESPN `season=2026`:

```
log[].seasonYear:     2026          <- WRONG
seasonsRepresented:   [2025]
seasonWarning:        "EVERY game ... from a PRIOR season (2025)"
```

Two conventions in one response, disagreeing about the same games. `types.ts`
defines `seasonYear` as "the year the season STARTED". ESPN's param is the END
year for NBA and NHL and the START year for NFL, so I was echoing a provider
parameter into a field with a different contract.

NFL happened to be correct by coincidence (ESPN's NFL param already is the start
year). NBA was off by one on every row, and soccer rows carried no seasonYear at
all because the soccer convention is unmeasured and the param is omitted.

The prose was right and the per-row label was wrong, which is the worse half: a
reader scanning the log sees 2026 beside an April date and reads the sample as
current.

This is the NHL season-label bug from
`preseason-scope-corrected-and-nhl-season-label-bug.md`, which I wrote up four
days ago, reproduced by me from the same cause: a season label derived from
something other than the game's date.

## The fix

`seasonYear` now comes from `seasonForDate(sport, date)`, the repo's single copy
of that rule, which every other aggregator already keys on. Rows and the summary
agree by construction, for every sport and every param convention.

The test asserts the INVARIANT rather than any particular number: every row's
`seasonYear` must appear in `seasonsRepresented`. Mutation-verified by reverting
to the old line, which fails it.

## Verify

```
npm test     # expect 940 pass / 0 fail
```

Then re-run the NBA call. `log[0].seasonYear` should read **2025** on an April
2026 game, and should match `seasonsRepresented`.
