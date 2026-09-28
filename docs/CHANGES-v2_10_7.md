# v2.10.7

The prop board was never "every prop in this game", and it reported exactly one of the
five reasons why. This release does not change which props are eligible. It raises the
cap, makes it sport-aware, makes alt lines reachable, and makes every dropped odd
visible and attributable.

## The five filters, and which one the board used to admit to

| # | Filter | Previously reported? |
|---|---|---|
| 1 | `maxRows` default 80 | yes, via `truncated` |
| 2 | `betType` must be `ou`, so all yes/no markets are gone | **no** |
| 3 | `period` must be `game`, so halves, quarters, hockey periods and first-N-innings are gone | **no** |
| 4 | `statID` must be in the hand-maintained `OU_PROP_MARKETS` | **no** |
| 5 | `includeAltLines` was never passed, so only main lines existed | **no** |

### 1. The row cap was quietly returning half a game

Measured 2026-09-28, Philadelphia at Chicago, eventID `iVXqTw1LGEj0TGVxDgTs`: **142 rows
built, 70 returned, and every returned row was a Bears player.** The truncation cut
follows SGO's response order rather than anything meaningful, so one team's board filled
the whole window and a thread builder had no way to know.

`maxRows` is now optional. Omit it and the cap comes from the sport:

| Sport | Default |
|---|---|
| NFL, MLB | 400 |
| CFB, NHL | 300 |
| everything else | 150 |

The hard ceiling goes from 250 to 600. Sized off measured built-row counts (MLB 254, NFL
142 for one team, NHL 102), deliberately well above a full board rather than near it,
since the cap exists to stop an unbounded payload and nothing else.

### 5. Alt lines are reachable for the first time

New `includeAltLines` flag, passed through to the event fetch. A book posts a main
receiving-yards number plus a ladder of alts; with this off, which it always was, the
board showed only the main line and the ladder was permanently invisible. Off by default
for payload size, which is a real OOM risk this connector has hit before, but reachable
now rather than absent.

### 2, 3 and 4 are now counted and named

Every board carries a `coverage` block:

```
coverage: {
  seenOdds, rowsBuilt, rowsReturned,
  dropped: { notOverUnder, nonGamePeriod, notInCatalog,
             teamOrUnknownEntity, unparsableOddID },
  nonGamePeriodsSeen: { "1h": 12, "2h": 9, ... },
  statIDsNotInCatalog: { "passing_interceptions_thrown": 4, ... },
  note: "..."
}
```

`seenOdds` is the denominator: every odd SGO returned. Each bucket names why those odds
never became rows, and two of them name the specifics rather than just counting:

- **`nonGamePeriodsSeen`** identifies which period markets exist, so a real half or
  hockey-period market is discoverable instead of silently absent.
- **`statIDsNotInCatalog`** is a catalog-drift detector. When the books price a market
  `OU_PROP_MARKETS` does not list, the statID is named. That is the same failure class as
  the label crisis in `claude/market-label-contract.md`, now visible on every pull
  without needing a `/markets` call.

Also fixed: the tool docstring still advertised a four-book default and `maxRows` 80,
both stale.

## What is still missing, stated plainly

The board remains **over/under, full-game, catalog-only**. Yes/no milestone markets
(anytime scorer, first scorer, double-double) are still reachable only one player at a
time through `tkb_get_yes_no_prop`, and NHL's yes/no prices are still unverified: +106 at
BetRivers against +700 at FanDuel on the same market, where FanDuel's own over/under
implied about +170. Putting yes/no markets on the board is the next build and it is
blocked on verifying that mapping.

The difference is that the board now says so, per pull, with counts.

## Tests

`test/v2_10_7.test.ts`, 14 tests. Suite 635 to 649, all passing.

| Mutation | Result |
|---|---|
| Revert to a flat 80 default | 1 of 14 fail |
| Stop passing `includeAltLines` | 2 of 14 fail |
| Stop naming dropped statIDs | 1 of 14 fail |
| Stop counting non-game periods | 2 of 14 fail |
| Restored | 14 of 14 pass, file byte-identical |

One test asserts the buckets plus the eligible sides equal `seenOdds`, so a future filter
added without a counter fails the arithmetic rather than quietly widening the blind spot.
