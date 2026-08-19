# v2.5.4 — pitcher staleness false positive, and a version string that cannot drift

Five files touched, all small. No tools added, removed or renamed. No new parameters.

---

## 1. The staleness flag was crying wolf on healthy starting pitchers

**Caught in live testing of v2.5.3, within an hour of it going out.** Roki Sasaki tripped
`sampleIsStale: true` on "only 4 of 10 counted games fall in the last 30 days". His starts:

```
8/14, 8/08, 7/31, 7/24, 7/17, 7/09 ...
```

Every six days. That is a pitcher on completely normal rest, not a stale sample.

**The design gap.** v2.5.3 gave starting pitchers widened tolerances for `maxGapDays` (30) and
`maxDaysSinceMostRecent` (14), but left `recentWindowDays` at the position-player default of 30.
A starter makes ten starts across roughly sixty days by definition, so "at least half the sample
inside 30 days" is arithmetically impossible for a healthy rotation arm with a ten-start sample.
The ratio test stayed structurally unfair to the exact players the other two thresholds had just
been widened for.

**The fix.** `recentWindowDays: 45` for starting pitchers.

**Why this is worth a patch release rather than waiting.** Precisely the argument v2.5.0 made
when the IRREGULAR flag was firing on Cam Schlittler: a false positive here is not a safe,
conservative error. It trains the reader to ignore the flag, and the flag's entire value is the
real catches. Two of those turned up in the same test run:

- **Chris Bassitt**, 1 of 6 counted starts in the window, 72-day hole, 96-day span
- **Brittney Sykes**, 8 of 8 hit rate and the top prop on the WNBA board, having played
  1 of the last 9 team games with seven of her eight counted games from June

Sykes is the one that matters. On v2.5.2 she was the most attractive prop in the game with
nothing warning against her. IRREGULAR and STALE both fired, catching different halves of the
same trap.

**Verified against six cases, including the two real ones above:**

| Case | thresholds | flagged | correct |
|---|---|---|---|
| Sasaki, 10 starts every ~6 days | pitcher | clean | yes, was the false positive |
| Bassitt, 1 in window + 72-day hole | pitcher | STALE | yes |
| Starter shelved 25 days ago | pitcher | STALE | yes, caught by daysSinceMostRecent |
| Collier, 9 straight since returning | position | clean | yes |
| Sykes, 1 of 8 + 63-day hole | position | STALE | yes |
| Grisham, everyday player | position | clean | yes |

Position-player behaviour is unchanged. Only the pitcher branch moved.

## 2. Thresholds centralised

The pitcher threshold object was written out at three call sites in v2.5.3
(`hitRateAggregator`, `bdlHitRateAggregator`, `screenProps`). It is now a single exported
constant, `STARTING_PITCHER_THRESHOLDS`.

Not tidiness. The version string in `index.ts` was written out twice and the two copies drifted
*within a single build* (see below). Three copies of a threshold object would drift the same
way, and a stale threshold in one of three paths is far harder to notice than a stale version
number.

## 3. `/health` version can no longer drift from the real build

**This one cost a full debugging cycle.** In v2.5.3, `buildServer()` reported 2.5.3 while the
`/health` response still said 2.5.2, because the bump edit matched the line ending in a comma
and missed the one that does not. Since `/health` is the ONLY cheap signal for which build is
live, a stale string there is worse than no version at all: a correct deploy looked like a
failed one, and time went into checking commit hashes and branches for a problem that did not
exist.

`DEPLOYCHECK.md` records the identical failure across 2.0.1 to 2.0.3, where `/health` reported
2.0.0 for three builds and testing was ambiguous. Same bug, second time.

Now declared once as `SERVER_VERSION` and referenced in both places.

**Lesson worth keeping:** the version string is a claim about the build, not evidence of it. The
authoritative test is behavioural. v2.5.3 was ultimately confirmed live by running a hit rate on
a known-stale player and seeing STALE SAMPLE appear, which no amount of version-string reading
could have settled.

## Deploy

**Copy the whole `src/` folder.** The manifest, so nothing is missed:

```
src/index.ts
src/tools/screenProps.ts
src/services/sampleRecency.ts
src/services/hitRateAggregator.ts
src/services/bdlHitRateAggregator.ts
src/services/bdlClient.ts
src/services/oddsPricing.ts
```

Then verify:

1. `/health` reports **2.5.4**. This time it will actually be true.
2. Run an MLB screen with `preferredBookmakers="draftkings,fanduel,betmgm,caesars"` on a game
   with a scheduled starter. The pitcher props should come back `sampleIsStale: false` unless
   the arm has genuinely missed time.
3. Confirm a position player returning from a layoff still flags STALE.

## Still open

- **The MLB availability probe may not cover bench players.** Ben Rortvedt returned
  `availabilityFlag: "OK"` with the BDL disclaimer note, meaning the probe found nothing for
  him, despite 0 runs in 9 straight games as a backup catcher - exactly the profile IRREGULAR
  exists to catch. Unconfirmed, and worth a dedicated look rather than a guessed fix.
- The nightly prompts still do not pass `preferredBookmakers`.
- The `UNCOUNTABLE_STATIDS` comment in `screenProps.ts` remains stale since v2.5.2, no runtime
  effect.
