# v2.10.8

Catalog drift repaired where it was measured, period props reachable for the first time,
and the empty-board path no longer hides the difference between two opposite problems.

---

## 1. Catalog drift, and it was much smaller than the NFL board implied

The v2.10.7 `coverage.statIDsNotInCatalog` field did its job. A sweep of 13 boards across
every sport found:

| Sport | Missing statIDs |
|---|---|
| **MLB** | **none.** 1,299 odds, perfectly aligned |
| **WNBA** | **none**, on two separate events |
| NFL | 8 |
| CFB | 1 (`yards`) |
| NHL | 1 (`minutesPlayed`) |
| EPL | 1 (`cornerKicks`) |

### Added

| statID | Label | Evidence |
|---|---|---|
| `receiving_targets` | Receiving Targets | 20 odds, the largest gap anywhere |
| `passing_interceptions` | **Interceptions Thrown** | 6 odds |
| `punting_numPunts` | Punts | 6 odds |
| `punting_puntsInside20` | Punts Inside 20 | 2 odds |
| `fieldGoals_longestMade` | Longest Field Goal Made | 2 odds |
| `minutesPlayed` (NHL) | Time On Ice | 4 odds |

`receiving_targets` is the one that matters most: targets is a pure volume market, and
gate G3 in draft 10933588 demands a volume claim as bullet one on every prop.

**The label on `passing_interceptions` is deliberate.** `defense_interceptions` already
owns "Interceptions" in the same block. Calling both "Interceptions" would make the
`markets` filter ambiguous and the grader wrong, which is exactly the failure documented
in `claude/market-label-contract.md`. There are now tests asserting no sport has duplicate
labels OR duplicate statIDs.

CFB gets the same football entries on shared-namespace grounds, the precedent this file
already sets for basketball. The CFB boards in the sweep were FanDuel-only with 18 to 21
rows, so their drift is understated rather than absent. A market no book posts returns
nothing, which costs nothing.

### Deliberately NOT added, and the reasons are the point

| statID | Why not |
|---|---|
| `yards` | Bare and unprefixed, 4 odds, identical on NFL and CFB. Could be a team total or untyped player yardage. Cataloguing it would be guessing at a meaning, which is how the label crisis started. Probe the raw oddID first. |
| `largestLead` | A team or game market. This catalog is player props only. |
| `rushing_yardsPerAttempt` | A RATE, not a count. Grading needs a denominator (attempts); every consumer here assumes a countable value. Real work, not a one-line add. |
| `cornerKicks` | Entity unresolved. Usually a team total, though some books price player corners taken. Bucket ordering weakly suggests a player entity, which is inference, not evidence. |

### Visibility is not screenability

Adding a statID here puts the market on the board, which is what it was missing. It does
**not** guarantee a hit rate or a grade. NFL rates run through the generic SGO results
path, which is statID-agnostic but unverified for these specific fields, and BDL's stat
map covers only `mlb` and `wnba`. **Each of these needs a hit-rate spot check before it
goes on any pick whitelist.** On the board they are strictly better visible than invisible.

---

## 2. Period props are reachable

New `period` parameter, defaulting to `full_game`, which is what the board always returned
and the only thing it could return. It maps through the same `PERIOD_CODES` table every
oddID builder uses, so the connector has one period vocabulary rather than two that can
drift. An unknown key is refused **by name**, because a silent empty board would be
indistinguishable from "this period has no markets".

Period codes measured as actually carrying odds, 2026-09-28:

| Sport | Codes |
|---|---|
| NFL | 1h, 2h, 1q, 2q, 3q, 4q |
| CFB, WNBA | 1h, 1q, 2q, 3q, 4q |
| MLB | 1i through 9i, 1h, 1ix3, 1ix5, 1ix7 |
| NHL | 1p, 2p, 3p, reg |
| EPL | 1h, 2h, reg |

On the Eagles at Bears board, 386 of 1,718 odds were period markets: 1h 120, 1q 114, then
46 each for 2q, 3q, 4q and 14 for 2h. All of it was unreachable before this.

---

## 3. The empty board now says why, which un-blinds UCL

The empty-roster early return fired before any coverage was computed, so a board with no
attached players returned no diagnostics at all.

**Measured on two UCL fixtures including PSG at Manchester City:** `pricedRowCount: 0`,
`unpricedMarketCount: 0`, and no coverage block, while EPL fixtures the same week returned
`seenOdds` in the 600s. A UCL league-mapping gap was **indistinguishable from "books have
not posted yet"**, which are opposite problems needing opposite responses.

That path now reports `oddsOnEvent` and `playerKeyedOdds` plus a diagnosis that separates
three cases:

- **zero odds at all** means a coverage or mapping question, not a timing one, because
  team markets post long before player props
- **odds present, none player-keyed** is the documented tennis and UFC shape, where
  competitors occupy the participant slots
- **player-keyed odds with an empty players object** is a genuine retry

---

## Still open

**Yes/no markets are NOT on the board yet, and the reason is measured.** Verified on
Saquon Barkley, FanDuel, Eagles at Bears: yn `Any Touchdown` = -115, a real anytime-TD
price, against OU `Touchdowns` over 1.5 = +550, a real 2+ TD price. Both correct, and
anytime TD is reachable ONLY through the yn market. But NHL contradicts itself on the same
comparison: FanDuel yn `Anytime Goalscorer` = **+700** while FanDuel's own OU `Goals`
under 0.5 = -170, implying about +140 for the yes. Same book, same event, same question,
five times apart.

So yn reliability is per sport and cannot be assumed. Putting yn on the board needs a
consistency check that cross-references each yn price against the equivalent OU market at
the 0.5 line and flags a contradiction rather than publishing it. That is the next build.

---

## Tests

`test/v2_10_8.test.ts`, 17 tests. Suite 649 to 666, all passing.

| Mutation | Result |
|---|---|
| Rename Interceptions Thrown to Interceptions (label collision) | 2 of 17 fail |
| Hardwire the period filter back to `game` | 3 of 17 fail |
| Accept an unknown period silently | 1 of 17 fail |
| Drop the empty-board diagnosis | 1 of 17 fail |
| Add back an excluded statID (`largestLead`) | 1 of 17 fail |
| Restored | 17 of 17 pass, both files byte-identical |
