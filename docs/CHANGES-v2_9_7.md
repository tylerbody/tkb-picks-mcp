# v2.9.7 - two defects from live use, both about refusing badly

Reported 2026-09-17, both found by using the connector rather than by reading it.

---

## 1. An unplayed match was being filed as a VOID

`tkb_grade_pick` returned this for a WTA match that had not started:

```
result: "VOID"
eventID: "YTzyDTwE4oBWSmdN3LNT"
statusLabel: "DNP"
reason: "This event is marked CANCELLED ..."
```

Marta Kostyuk vs Taylor Townsend, scheduled `2026-09-16T23:00:00.000Z`. An agent
caught it and overrode the verdict to NOT_FINAL by hand. Nothing in the connector
would have.

### What was actually happening

SGO really does set `cancelled: true` on that event, so the cancelled branch added
in v2.9.5 was firing exactly as written. The branch was still wrong, because it
never asked WHEN. It read a flag and published a terminal verdict.

### Why this is not a small mistake

VOID and NOT_FINAL are not two shades of the same answer:

| verdict | meaning | what happens if it is wrong |
| --- | --- | --- |
| `VOID` | settled, no action | the pick is filed. Nothing re-opens it. A match that then plays is permanently mis-recorded, silently. |
| `NOT_FINAL` | ask again later | one re-grade. |

A void is terminal and a hold is not, so the costs of being wrong are nowhere near
equal, and the tie goes to holding.

A cancellation flag on an event BEFORE its own start time is exactly the shape a
provisional feed state takes: a postponement, a re-draw, a walkover entered early,
a status a book later reverses. This connector cannot tell those from a real
cancellation, so it now says so instead of guessing.

### The fix

`assessFinality` computes `hasStarted` once, at the top, and the cancelled branch
now consults it:

- `cancelled: true` AND the scheduled start has NOT passed -> `final: false`, the
  `cancelled` flag deliberately withheld (that flag is what drives VOID downstream),
  `crossCheckable: false`, and a reason that says to hold it, says why a void would
  not correct itself, and names the condition for retrying: after the scheduled
  start time.
- `cancelled: true` AND the start has passed -> unchanged. Still a void. A match
  that should have begun and did not is a genuine cancellation.
- `cancelled: true` and NO `startsAt` at all -> still a void. Guessing "not started"
  from a missing field would hold every startsAt-less cancellation forever.

The observed status label is preserved, so `DNP` still reports as `DNP`.

---

## 2. `tkb_get_players` threw "Cannot read properties of undefined"

That is not a message, it is a stack trace wearing one. It names no cause, no
event and no fix, and it arrived mid-game while someone was trying to grade a prop,
which is the moment a readable refusal is worth the most.

### What the audit found, which was worse than the report

The reported call did not reproduce on live MLB. What reproduced was the
assumption underneath it: **22 unguarded reads of `event.teams.home.*` or
`event.teams.away.*` across 9 files**, every one of which throws a bare TypeError
the moment SGO returns an event that is not shaped like a match.

And SGO has such events. This repo already wrote it down, in `src/types.ts`, on
the Event type: `type` is "'match' for games. Futures/outright markets use a
different type." A league-winner market has twenty participants and no matchup at
all. The knowledge was in a comment; the guard was nowhere.

### The fix

New `src/services/eventShape.ts`, one shared guard rather than nine local checks:

- `readMatchTeams(event)` - pure, never throws, returns both sides or a reason that
  names the eventID, reports `event.type`, and distinguishes "this is a futures
  market, not a game" from "SGO returned a malformed match". Those need different
  responses from the reader and look identical from a TypeError.
- `isReadableMatch(event)` - the aggregator form. One bad row in a 100-game history
  costs that row, not the whole scan.

Applied at all nine call sites: `players.ts`, `propBoard.ts`, `screenProps.ts`,
`coverPlayer.ts`, `gradePicks.ts`, `gradeSlate.ts`, `liveMonitor.ts`,
`hitRateAggregator.ts`, `splitsAggregator.ts`.

Team names fall back through name, then id, then a literal, never `undefined`,
because these strings are user-facing and "undefined @ undefined" is its own bug.

The helper is generic over the side shape so that `liveMonitor`'s pure
`readLiveStat` can keep its narrow structural parameter instead of widening its
reach or casting away the checking the helper exists to provide.

### Why shared rather than local

This codebase has now been burned four times in one week by fixing the file where
a symptom appeared and not the other eight that share the assumption: the soccer
period across ten call sites (v2.9.1), the postedLine guard (v2.9.2), the UFC
empty-board message (v2.9.3), the empty-string status gate (v2.9.6). The lesson is
not "check harder next time". A shared assumption needs a shared guard.

---

## Tests

461 -> 481, all passing. New file `test/v2_9_7.test.ts`.

Mutation-tested, four mutations, all caught:

| mutation | failures |
| --- | --- |
| drop the `hasStarted` guard on the cancelled branch | 4 |
| let the hold branch report `cancelled: true` anyway | 1 |
| treat an unknown `startsAt` as "not started" | 5 |
| drop the half-formed-match guard in `readMatchTeams` | 2 |

The regression half is covered as deliberately as the fix: a cancelled match whose
start time HAS passed must still reach the tracker as a void, and a finalized game
must not be swallowed by the new branch.
