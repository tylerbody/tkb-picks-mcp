# v2.10.4

Three defects, all found by measuring rather than by reading. Two produce a wrong
number. The third produces a short slate that looks complete, which is worse.

---

## C. `tkb_get_game_lines` silently shrank a slate addressed by date range

**The most dangerous of the three, so it is listed first.**

Both code paths attach the six team oddIDs plus `bookmakerID`. On the DATE RANGE path
SGO drops every event with nothing priced at those books, so the tool reported on a
subset and never knew it. The `withNothing` list, which exists precisely to catch
this, had nothing to put in it. The EVENTIDS path was never affected: SGO ignores
event-selection filters when `eventIDs` is supplied, so every id asked for comes back.

### Measured 2026-09-28, NHL opening week, 2026-10-06 to 2026-10-08

| Call | gameCount | Reality |
|---|---|---|
| date range | **4** | looked like a 4-game slate |
| same 12 eventIDs | **12** | 4 priced, 8 listed with `unpriced` arrays |

This is the exact failure the tool's own description promises to prevent: *"Games with
no priced team markets are listed explicitly rather than dropped, so a short board is
never mistaken for a short slate."* On the ranged path that promise did not hold.

Early-season NHL is when most of a slate is unpriced. A run on 10/06 would have seen
four games, reported four games, and never known it missed eight.

### The fix

Resolve the window to eventIDs first, then use the path that already reports gaps.

- Enumeration uses `narrowingOddID` and passes **no** `bookmakerID`. That is how
  `schedule.ts` gets a complete slate for the same window: the narrowing oddID raises
  the page cap without filtering on whether anything is priced, and omitting the book
  filter is what stops events being dropped.
- The resolved ids are then fetched in chunks of 20 through the existing eventIDs
  path, so the unpriced report and the missing-id report both work.
- `requestCount` now reports 2 (or more on a large slate) rather than 1.
- The missing-id message is branch-aware, because on this path the caller did not
  supply the ids and being told to "confirm these eventIDs" would be nonsense.

**Cost:** one extra ranged fetch. SGO bills per event object, so a 12-game window goes
from about 12 entities to about 24, against a 3,000,000/day allowance measured at
~1,200 used. Correctness is worth twice nothing.

---

## A. A dressed backup goalie graded as a confident 0 saves

A goalie's game log carries `shotsAgainst` and `goalsAgainst` and no `saves` field, so
saves are derived. A dressed backup's row carries zeros, and **both are defined**, so
the old condition produced a real-looking `saves: 0` for a goalie who never took the
ice.

That zero is worse than a missing value, because the discriminator that protects every
other market cannot see it. `lookupPlayerStat` separates a real absence from a missing
box score by asking whether the game carries player-keyed results for anyone on the
roster. A dressed backup HAS a row, so `player_absent` never fires, `gradePlayerProp`
takes the `kind: "value"` branch, and a real 0 grades out, silently crediting any
under.

### Measured 2026-09-28

Adin Hill, Saves over 21.5, Vegas 0-4 to Utah on 2026-03-20, eventID
`3jD7dD8JeuQ8KX9Wi6OV`:

```
result: LOSS   actualValue: 0   participationResolved: true   note: null
```

Only Hill was priced; Schmid had no Saves line. Zero saves in a game where the team
conceded four is not a result.

### The fix

```ts
if (shotsAgainst !== undefined && goalsAgainst !== undefined && shotsAgainst > 0) {
  stats.saves = shotsAgainst - goalsAgainst;
}
```

Leaving `saves` unset routes the caller to `stat_unsettled` rather than to a
fabricated zero. A goalie who genuinely faced zero shots has no measurable save total
either, so refusing is correct in both readings of the row and the tool never has to
guess which one it is looking at.

**This also fixes the hit-rate path.** A backup's fake 0 was a counted sample dragging
a goalie's save rate down, so a Saves screen was scoring against games he did not play.
A shutout still derives, because `shotsAgainst` is what gates it, not `goalsAgainst`.

---

## B. `tkb_get_line_movement` narrated a live price as a line move

Once a game is under way, `byBookmaker.<book>.odds` is the LIVE price; once it is over
it is the LAST-SEEN price, usually a late in-game number. Neither is the same market
as the open, so subtracting one from the other is not a line move. The open itself
stays trustworthy: it is read from a real book's open field.

### Measured 2026-09-28, both halves

| State | Open | "Current" | What the tool said |
|---|---|---|---|
| LIVE, Dodgers at Giants total, 6th inning | 8.5 at +104 (fanduel) | 3.5 at +124 | *"Opened at 8.5 and sits at 3.5 now, down 5."* |
| FINAL, Boston at Florida ML, 2-1 Florida | +120 (draftkings) | -20000 | a CLV number off that pair is nonsense |

The live 3.5 prices REMAINING runs. There was no 5-run market move.

This tool's description advertises building a "this line moved" post, so the sentence
is the product. *"This total has moved down 5"* is exactly the bullet a build subagent
would lift into a tweet.

### The fix

A started event gets the open and **no movement claim**. `lineMovement` goes null,
`movementDirection` says why, and the description explains what the current number
actually is. Two new structured fields, `currentPriceIsPostStart` and `eventIsFinal`,
so a caller does not have to parse prose. The pre-game path, the only one a build run
uses, is untouched.

`started` is read off the event where present and falls back to comparing `startsAt`
to now. An unparseable `startsAt` is treated as STARTED, matching the `eventStatus.ts`
cancelled-branch convention: the conservative reading is the one that refuses.

---

## Tests

`test/v2_10_4.test.ts`, 18 tests. Suite goes 597 to 615, all passing.

### Mutation tested

| Mutation | Result |
|---|---|
| Drop `shotsAgainst > 0` from the saves derivation | 1 of 18 fail |
| Disable the started-event guard in lineMovement | 3 of 18 fail |
| Revert gameLines to a single ranged fetch | 6 of 18 fail, plus a TS error |
| Restored | 18 of 18 pass, all three files byte-identical to shipped |

**Honest note on mutation A.** It kills only one test, and that test is a source-regex
wiring assertion rather than a behavioural one. The saves derivation is not exported,
so the arithmetic tests mirror the rule instead of calling it, and a mirror cannot
catch the source drifting away from it. The regex assertion is the real guard. If that
derivation is ever extracted into a pure exported function, replace the regex with a
direct call.

---

## Not changed

Pricing, book filtering, the block lists, the v2.10.2 same-book rule, and the v2.10.3
side-vocabulary guard are all untouched. The oddID construction is untouched, so the
unresolved `sp-ov` versus `sp-home` question in SGO's docs stays open rather than being
decided by a change made for another reason.
