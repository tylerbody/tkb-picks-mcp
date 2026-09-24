# v2.10.2 - pricing integrity, and four guards that were never wired

One live observation started this: `tkb_get_line_movement` returned an opening price of
`-145` on an NHL event whose only two venues were Polymarket and Kalshi, while correctly
refusing the current price from the same event. That prompted a full audit.

589 tests, up from 562. Nine mutations, all caught.

---

## 1. The opening price bypassed every filter the current price passes

```
currentOdds:  null      correctly refused, prediction markets are blocked
openingOdds:  "-145"    came through anyway
bookmaker:    null      with no attribution
```

`lineMovement.ts` read `odd.openOdds ?? odd.openBookOdds` directly. Neither goes through
`extractPricedLine`, which is the only place the block list and the fair-odds refusal are
enforced. And `openBookOdds` is a **median across books**, which this repo's own rule says
is never publishable.

**This is the v2.8.3 bug a second time.** That release found the tool pricing against
"whichever venue SGO returned first". v2.8.6 fixed it by adding a bookmaker parameter, and
the fix reached the CURRENT price only.

Fix: new `extractOpeningFromBook()` in `oddsPricing.ts`. It reads the open from a named,
publishable book, prefers the same book the current price came from so both ends of a
movement claim are one venue, reports which book supplied it, and **never** falls back to
the median. A movement across two different books now says so in the description.

## 2. A consensus LINE was being stamped with a real book's name

`extractPricedLine` took the price from `byBookmaker.<book>.odds` but fell back to
`odd.bookSpread ?? odd.bookOverUnder` for the line. When a book quoted a price with no
number, the two halves came from different places under one book's name:

> `OVER 4.5 (-115, DraftKings)` where DraftKings' actual number was 5.5

A price and a line that disagree are worse than a missing line, because the missing line
is already refused and the mismatch is invisible to anyone reading the output. The line
now comes from the same book as the price or the market is refused.

## 3. `tkb_get_period_odds` had no bookmaker filter at all

The fourth call site of the v2.8.6 fix, missed at the time. It published `americanOdds`
and a `bookmaker` while sending no `bookmakerID`, so a first-half or first-5-innings price
came from whatever venue SGO listed first. Added `preferredBookmakers` with the shared
default, plus the rounded price the other price tools return.

Also in that tool: `statID` was hardcoded to `"points"` for every market, so a tennis set
total asked for the set SCORE and a UFC round total asked for points. It now uses
`gameTotalStatFor(sport)` for totals.

## 4. A live UFC or tennis total was monitored against the score sum

`readLiveStat` returned `home.score + away.score` for every sport, while `livePickOddID`
thirty lines below in the same file already asked `gameTotalStatFor(sport)`. So a rounds
total and a games total were both graded against a scoreboard.

**Worse here than in an odds tool**, because this tool prints CLEARED, which is read as
"safe to post as cashed". The three sports whose totals are not points now return null,
which the tool already handles as "cannot read live".

## 5. Hockey was falling through to the SGO hit-rate path

NHL passes both capability guards (`hitRates: true`, correctly - the NHL's own API serves
them), and no hockey stat is mapped in `bdlStatMap`, so every NHL candidate in
`tkb_screen_props` fell through "stat not mapped" into `getPlayerHitRate(sgo, ...)`.

That is the exact path `tools/hitRate.ts` refuses for hockey by name, for the reason
v2.7.0 established: SGO carries games but not player box scores, so empty games read as
DNPs. In the screener it is worse than in hitRate, because the screener **ranks** on the
number it computes, so a fabricated rate wins the board. Now refused, pointing at
`tkb_get_player_hit_rate`, which does use the NHL feed.

## 6. The cover-player opponent was wrong for months

```ts
ev.teams.home.teamID === playerID    // a TEAM id against a PLAYER id
```

Never equal, so the ternary always took its else branch and the opponent was
unconditionally the away team. For any away player that published his own club:
"3 HR on 09-12 vs Seattle Mariners", about a Mariner. Extracted as
`opponentNameFor(event, playerTeamID)`, exported and tested.

Same file: the recent-games fetch passed `limit: 10` then sliced the first ten, against a
feed `hitRateAggregator.ts` states is "confirmed NOT most-recent-first". So
`gamesPlayedLast10`, the play rate, the exclusion note and "most recent appearance" were
all computed over an arbitrary ten of a 45-day window. Now sorted by date first.

## 7. `tkb_scan_streaks` was the sixth counted-sample producer and the only one not
   calling `describeRecency`

All five hit-rate aggregators call it. This one writes the sentence most exposed to the
problem: "has cleared X in N straight games". Three games from May with a two-month hole
in front of them satisfy the count exactly and the sentence is false.

## 8. Weather read absent as calm and dry

`probabilityOfPrecipitation?.value ?? 0` on a field the provider types `number | null`, so
"the forecast does not state a chance" published as `precipitationChance: 0`, and
`isNotable` said conditions were fine. `parseWindSpeedMph` returned 0 for an unparseable
string, and 0 mph is dead calm. Both now return null, unknown inputs are excluded from the
notability test and named in a `dataNote`.

Also added a `periodCaveat`: this tool takes the FIRST NWS period and accepts no game
time, so a 7pm game checked at 9am is described by the daytime forecast. `periodName` was
in the payload; nothing said why it mattered.

## 9. Two unguarded `event.teams` sites that could take down a whole slate

The v2.9.7 sweep applied `readMatchTeams` to nine files. It missed four, because the list
was **enumerated rather than re-grepped** - the same mistake that release was written
about. Now guarded:

- `gameLines.ts:153` - mapped over every event, so one bad event threw out of `rows.map`
  and returned "Cannot read properties of undefined" for all fifteen games
- `splitsAggregator.ts:143` - reachable, because `getOpponentSplit` filters on
  `e.teams?.away?.teamID` and admits an event with an away side and no home side
- `odds.ts:350` and `lineMovement.ts:255` - reached on every successful response for an
  arbitrary caller-supplied eventID

## 10. Dead files that had already drifted

- **`src/services/constants.ts`** deleted: a byte-identical dead copy of
  `src/constants.ts` with zero importers. **I created it twice**, both times with a
  mutation-test restore of the form `cp /tmp/bak/*.ts src/services/` where the backup
  also held `constants.ts`. Worth knowing because the same command will do it again.
- **`index.ts`** in the repo root moved to `archive/`: the pre-refactor entry point,
  carrying `SERVER_VERSION = "2.5.3"` against the live 2.10.x, never compiled
  (`rootDir: src`). A file that looks like the entry point and is five releases stale is
  a debugging session waiting to happen.

## 11. The probe hid the one thing it exists to show

`tkb_probe_event_fields` printed the raw per-book values in its text output only. A client
that renders `structuredContent` when both are present never saw them, so the probe
reported which KEYS exist and hid the VALUES. Answering "are Kalshi and Polymarket quoting
American odds or probabilities" took five probes and a detour through another tool,
because of that. `sampledBooks` is now in the structured payload, with the
never-publish warning travelling alongside the data.

**The answer, for the record: American odds.** SGO normalises every venue, so a Polymarket
`-145` and a DraftKings `-145` are indistinguishable by shape. That is precisely why the
block list matters and why finding 1 mattered.

---

## Tests

562 -> 589. New `test/v2_10_2.test.ts`.

| mutation | failures |
| --- | --- |
| restore the consensus-line fallback | 1 |
| allow blocked venues as an opening source | 4 |
| skip the block check on the preferred book | 1 |
| restore the `openBookOdds` median fallback | 1 |
| restore `openBookOdds` at the lineMovement call site | 2 |
| drop the sport check from `readLiveStat` | 2 |
| make the opponent always the away team | 2 |
| suppress the streak staleWarning | 1 |

**Three of those mutations initially survived**, and each one taught the same lesson this
release is about. `readLiveStat` and `opponentNameFor` were covered only by assertions on
the tables and helpers they consult, so both were exported and tested at the seam. And the
first streak test matched `/STALE/` anywhere in the response, which passed even with
`staleWarning` forced to null, because the nested `recency.warning` string also contains
"STALE SAMPLE" - a test that read as though it covered a mutation and did not.

---

## Audited and found clean

Worth recording so the coverage is known: `extractPricedLine` has no other bypass (the
remaining `fairOdds` reads are presence flags in refusal messages); all five aggregators
call `describeRecency`; six of seven price tools default to `DEFAULT_BOOKMAKERS` and pass
it through; every date-ordered path sorts by real dates with undated rows last; the
per-sport tables are exhaustive over `SportKey`.

## Known and NOT fixed

- **Per-sport source routing is duplicated** between `hitRate.ts` and `screenProps.ts`,
  and they had already disagreed - that disagreement was finding 5. It belongs in a table.
- **`futures.ts` and `teamRecord.ts` are never registered** in `index.ts`. Both carry live
  bugs that fire the moment either is wired up: futures publishes a price with no
  bookmaker filter, and teamRecord reproduces verbatim the `null-0` record bug
  `standingsNormalizer.ts` exists to fix.
- `tools/standings.ts` re-implements `parseRecord` instead of importing it.
- Four tools still return `americanOdds` with no rounded form (`odds.ts`,
  `yesNoProps.ts`, plus the two unregistered ones).
- The NHL splits convention note is attached to the home/road branch only, so a
  `splitType: "opponent"` result carries no caveat.
- `tkb_screen_props` measured at 49s on one MLB run.
- `CBBD_API_KEY` is still unset on Render.
