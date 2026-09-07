# v2.6.4 — the board existed, the screener just would not print it

Two tools added, 19 to **21**. One typo fixed. No existing behaviour changed, no
tool removed or renamed, no parameter altered on anything that already shipped.

---

## 1. `tkb_get_prop_board` — every priced market, no hit-rate gate

### What was measured, 2026-08-27, CFB Week 0

`tkb_screen_props` on North Carolina @ TCU returned:

```
NOTHING CLEARED. Screened 43 priced markets across 17 players ... and none met
minSample 1 / minEdge 0 / minHitRate 0 / maxAmericanOdds -250.
```

Read that twice. It found **43 priced markets** and printed **zero rows**.

Dropping `minSample` to 0 changed nothing, which is the tell. The thresholds were
never the problem. No 2026 CFB game had been played, BALLDONTLIE gates NCAAF player
stats behind GOAT, so not one of those 43 markets had a computable hit rate, and
the screener will not rank what it cannot score.

The board had already been fetched, filtered to the four books, and counted. It was
discarded at the last step, and the tool reported that as an answer.

### Why the workaround was worse than it looked

Recovering the board by hand meant one `tkb_get_odds` call per player per market.
Ten calls surfaced 7 of the 43 markets on that one game. The remaining calls
returned "no market found", which is ambiguous between *this player has no props*
and *I guessed the wrong market* — and there is no way to tell which from the
response. Exhaustively, 23 markets across 63 players on the slate is roughly 1,450
calls, about 29 minutes against the 50-per-minute cap.

### The split

`tkb_screen_props` answers **"which of these should I bet"** and needs a hit rate
to do it.

`tkb_get_prop_board` answers **"what is actually on the board"** and needs nothing
but a price.

Only the first question is blocked by a missing rate engine. Conflating them meant
a rate-source outage looked identical to an empty market.

### Three deliberate differences from the screener

**Walks the FULL catalog.** `screenProps` builds `wanted` by dropping any market it
cannot compute a rate for: `NEVER_COUNTABLE` kills `fantasyScore` outright,
`UNCOUNTABLE_STATIDS` kills combos without a BDL derivation. Correct for a
screener, wrong for a board — those markets are real, priced and bettable, and the
only missing thing is a number this tool never offered. On the CFB catalog that
exclusion alone hides Fantasy Score.

**No player cap by default.** `screenProps` caps by sport because each extra player
costs roughly two throttled BDL requests against a 60-second ceiling. This tool
makes zero per-player requests, so there is no cost to justify a cap. `maxPlayers`
is still accepted and reports when it bites, following the v2.6.3 `ROSTER CLIPPED`
precedent.

**Over and under collapse onto one row**, which surfaces something two-row output
hides entirely. See below.

### SPLIT LINE, the thing this found immediately

Two markets on the same slate:

| Market | Over | Under | Gap |
|---|---|---|---|
| Jai'den Thomas rushing yards | 79.5 (DraftKings) | 76.5 (FanDuel) | 3 yards |
| Brady Kluse receiving yards | 39.5 (DraftKings) | 35.5 (FanDuel) | 4 yards |

The two sides are priced at **different numbers**. As separate rows that reads like
two ordinary props. As one row it is a flag: there is no single line to publish,
and the market is unformed enough that quoting either number alone misrepresents
it. The row carries `splitLine: true` and `line: null` rather than silently picking
one.

### Response size, and why this does not reproduce the OOM crashes

This walks the full odds map. `tools/players.ts` records an MLB game inside an hour
of first pitch at **1,180 markets** — the payload shape that got
`tkb_debug_raw_event` deleted in v2.0.0 as a quota footgun.

Four things bound it before `maxRows` is ever reached:

- `periodID` must be `game`, dropping every half, quarter, inning and set variant
- `includeAltLines` is already OFF by default in `SGOClient.getEvents`
- `bookmakerID` filters server-side, so most venues never serialise
- grouping halves the row count

`maxRows` is the backstop, and truncation is **reported**, never silent.

### Cost

One event fetch. **~1 entity per game.** A `screen_props` call on the same event is
~56.

---

## 2. `tkb_get_game_lines` — team markets across a whole slate

### The gap

Every thread this account posts carries exactly one team-level pick.
`tkb_get_odds` handles one game and one market type per call, so the team-level
picture for a five-game CFB Saturday costs **15 calls**, and a fifteen-game MLB
slate costs **45**.

It matters more than usual right now: in early-season CFB and any WNBA market
there is no computable hit rate, so a team market is frequently the only
defensible pick available, and it was the hardest thing in the connector to
survey.

### Cost

SGO bills per event object, and this attaches at most six oddIDs to each event. A
five-game slate is about **five entities**. One `screen_props` call is 56.
Surveying every team line on a slate is close to the cheapest thing this connector
can do.

### Two fetch paths, both already proven here rather than invented

- Explicit `eventIDs`: one fetch each, the `gradePicks` pattern
- A date range: **one** ranged fetch with the oddIDs filter, the pattern `odds.ts`
  already uses on its `teamName` path

Passing several IDs as one comma-separated `eventIDs` value may well work in a
single request, but it is **not confirmed against a live response**, and this
connector has already been bitten by sending a parameter SGO quietly ignored
(`includeOpposingOdds`, corrected 8 Aug 2026). Not assumed. Worth one live test,
and if it holds the eventIDs path collapses to a single request.

Games with no priced team markets are **listed**, not dropped, so a short board is
never mistaken for a short slate.

---

## 3. Tests

**14 new, suite now 77.** `parseOddID` and `buildBoardRows` are exported and pure,
per the v2.6.1 rule that logic changing which data reaches the user is correctness
logic and cannot live inside a function needing an API client.

Every case is real data from the 2026-08-27 board, including both split lines
above. That matters: a hand-written split-line fixture would probably have varied
only the price, which is the common case and not the one that breaks anything.

**Mutation-tested, and the first attempt exposed a toothless test.**

| Mutation | Result |
|---|---|
| Never flag a split line | 2 tests fail |
| Drop one-sided markets | 4 tests fail |
| Take `parts[0]` as the statID | **passed 13/13 — caught nothing** |

That third one is worth recording. The combo test asserted
`batting_hits+runs+rbi` survives parsing, and it does — but combos join with `+`,
not `-`, so `parts[0]` returns the identical answer. Every statID in the catalog
today is hyphen-free, so the test proved a property of the current catalog rather
than of the parser.

Fixed by adding a case with a genuinely hyphenated statID, which is the only thing
that makes slicing from the right load-bearing rather than stylistic. That
mutation now fails 1 test.

A test that cannot fail is worse than no test, because it reports confidence it
has not earned.

---

## 4. Two small fixes

**A duplicated sentence in `screenProps.ts`.** The memory-discipline comment read
"That is one bounded object for one event, which is one bounded object for one
event." Cosmetic, but that block is the explanation of why this tool does not
reproduce the OOM crashes, and a garbled explanation gets skipped.

**The empty-board message now points somewhere.** When `screen_props` clears
nothing it now names `tkb_get_prop_board` and explains when an empty screen means
*no value* versus *no rate source*. Without that, the CFB Week 0 result reads as
"there is nothing here", which was false.

---

## Deploy

`tsconfig.json` is unchanged and deliberately **not** included. Keep yours.

1. Copy `src/`, `test/`, `docs/`, `README.md` and `package.json` over the repo.
2. `npm test` locally. **77 passing** before you push.
3. Commit, let Render redeploy.
4. `node scripts/verify-deploy.mjs --expect 2.6.4`

`/health` reports `toolCount` off a live server, so it should now say **21** with
`tkb_get_prop_board` and `tkb_get_game_lines` in the `tools` array. The deploy
script already compares that against `tools/list` with no hardcoded count, so it
validates the new total without being edited.

Then the two things only live data can answer:

5. `tkb_get_prop_board` on the TCU event. It should return roughly **43 markets**,
   which is the number `screen_props` reported and refused to print. If it comes
   back materially short, the period or catalog filter is dropping something.
6. `tkb_get_game_lines` across Saturday's five CFB games in one call, then
   `tkb_get_api_usage` before and after. Expect an entity delta near **5**.

Step 5 is the real proof. The count is already known from the screener's own
output, so this is a comparison against a measured number rather than a guess.

---

## Still open, carried forward

- **Batched `eventIDs`** in `tkb_get_game_lines` is one fetch per event because
  comma-separated IDs are unverified. One live test settles it.
- **Period codes** remain unverified for halves and quarters; only `1ix5` was ever
  confirmed. With CFB live this is cheap to settle.
- **The MLB availability probe may not cover bench players** (the Ben Rortvedt case
  from v2.5.4). Still unconfirmed.
- **A market scorecard** feeding published results back into screening remains the
  highest-value remaining item.
