# v2.8.9 - a wrong playerID was indistinguishable from an unposted market

No tools added or removed. Still **27**. One new service, six files touched.

---

## 1. The Caleb Williams case

### What was measured, 2026-09-13

Bears @ Panthers, eventID `Nw0i5lD1IafZ0HlX842y`. `tkb_get_players` with
`nameContains="Williams"` returns exactly one row:

```json
{ "playerID": "CHRIS_WILLIAMS_1_NFL", "name": "Caleb Williams", "teamID": "CHICAGO_BEARS_NFL" }
```

Right display name, wrong ID stem. Every lookup built on the obvious
`CALEB_WILLIAMS_1_NFL` returned:

> "No market found for this selection on this event."

while his passing line sat there at 229.5 (-112). A confident refusal, on a
quarterback with a posted market, found only because somebody happened to run
`tkb_get_players` with a name filter.

### What makes it worse than an ordinary miss

The ID format LOOKS derivable: `FIRST_LAST_1_LEAGUE`. It is right the large
majority of the time, which is exactly what makes it a trap. A pattern that works
often enough becomes a habit, and then it fails silently on the exceptions - which
land on the players most worth writing about, because a QB1 with a posted passing
line is not an obscure name.

Same family as the `p_k` batting/pitching collision (v2.0.1) and the
`visitor_team`/`away_team` split (v2.0.3): a plausible shape that is right until it
quietly is not.

### Why this is code and not a rule

"Never construct a playerID, always read it from `tkb_get_players`" is a correct
rule and it works only while someone remembers it.

Meanwhile the answer was already in the response. **`event.players` arrives on the
same fetch that produced the miss**, and it contains Caleb Williams under his real
key. The tool had the disproof in hand and did not look.

That is the same shape as the last three releases: the spread that ignored both team
scores (v2.8.7), the grader that ignored the status block and the schedule that
ignored its own cursor (v2.8.8). So it gets the same treatment. Look before refusing.

### The fix

`src/services/playerResolution.ts`, pure and exported. On a playerID miss it reads
the event's own roster and returns one of three answers, which are genuinely
different questions that were previously collapsed into one string:

| Situation | What it now says |
|---|---|
| The playerID IS on the event | The ID is correct and the MARKET is absent. A market gap, not a lookup failure. Retry nearer kickoff or use `tkb_get_prop_board`. |
| Not on the event, but someone shares the surname | Names the real playerID and display name. "Very likely a WRONG ID rather than a missing market." |
| Not on the event, nobody shares the surname | Reports how many players ARE attached, and distinguishes an empty roster (props not posted yet) from a genuine absence. |

Separating the first case from the second matters as much as the fix itself.
Collapsing them is how a correct ID gets doubted and a genuinely unposted market gets
retried forever.

**It reports and never substitutes.** No automatic swap to the candidate ID, for the
reason v2.8.2 took three consecutive releases to learn and v2.8.5 restated: a silent
correction that is itself wrong is worse than the error it replaces.

**Surname matching is exact on the token, never containment.** "Williams" must not
match "Williamson". That is the v2.8.5 Miami / Miami (OH) trade running the same
direction here: a false positive would point confidently at the wrong player, which
is the failure this file exists to prevent. Accent-insensitive, per the v2.4.0
Suárez case.

**Costs nothing.** The roster was already paid for on the fetch that missed.

### Wired into every site that can miss, not just the one that surfaced it

`odds.ts`, `lineMovement.ts`, `gradePicks.ts`, `gradeSlate.ts`.

Deliberately all four rather than the one where the bug was reported. v2.6.0 named
this repo's most repeated failure: *the fixes were correct, the audits were scoped to
the file the symptom appeared in.* `odds.ts` was the closest to right already, and
still stopped short:

> "...confirm the playerID is correct and that the player is on this event's roster
> (use tkb_get_players)."

It told the reader to go run the tool that had the answer, instead of running it.
`lineMovement.ts` did not even do that.

---

## 2. The truncation flag was alarming on a filtered result

v2.8.8 added `truncated` to `tkb_get_schedule`. A seven-game team query came back
flagged, which is correct at the fetch layer and misleading to read: the 100-event
fetch really was capped before the `teamName` filter ran, but the seven games shown
are complete-looking and the note said games were "almost certainly" missing.

An alarming note on a result that looks fine is how a real warning gets tuned out,
which is the v2.5.0 argument about IRREGULAR firing on healthy starting pitchers.

The note now describes the FETCH rather than the LIST, and says which one the reader
is looking at:

```
INCOMPLETE FETCH: SGO capped the underlying request at 100 event(s) before any
filtering, and it does not report the true total. Your filters then reduced that to
what is listed. The games shown are real, but a game later in this window may have
been cut off before the filter ever saw it.
```

`eventsFetchedBeforeFilters` is added to the response so "the filter cut it" and "the
cap cut it" are distinguishable without re-running.

---

## 3. Tests

`test/playerResolution.test.ts`, **9 tests**, no network, built from the real Bears
roster rather than fixtures.

Load-bearing assertions:

- the guessed `CALEB_WILLIAMS_1_NFL` resolves to `CHRIS_WILLIAMS_1_NFL` by surname
- a CORRECT id on the event is diagnosed as a market gap, not an ID problem
- "Williams" does NOT match "Williamson"
- two players sharing a surname are BOTH reported, never guessed between
- the message states that it does not substitute

Suite is now **219 tests, 219 passing**.

**Mutation-tested**, all restored:

| Mutation | Result |
|---|---|
| Substring surname matching | 1 of 9 fails |
| Stop separating "ID wrong" from "market absent" | 1 of 9 fails |
| Auto-substitute the candidate | 1 of 9 fails |

---

## Files changed

```
src/services/playerResolution.ts   NEW
src/tools/odds.ts
src/tools/lineMovement.ts
src/tools/gradePicks.ts
src/tools/gradeSlate.ts
src/tools/schedule.ts
test/playerResolution.test.ts      NEW
src/index.ts                       SERVER_VERSION 2.8.9
package.json / package-lock.json
```

---

## Deploy

1. Commit, redeploy. `npm test` must read 219 passing first.
2. Do not confirm by reading `/health`; call a tool instead.

### Verify, control case FIRST

**Control - a correct playerID must still work unchanged.**

```
tkb_get_odds sport="nfl" eventID="Nw0i5lD1IafZ0HlX842y" marketType="player_prop"
             playerID="CHRIS_WILLIAMS_1_NFL" marketLabel="Passing Yards"
```

Must return the real line, around 229.5. **If this now errors, stop** - the
diagnosis path is intercepting successful lookups.

**Then the case this release exists for.**

```
tkb_get_odds sport="nfl" eventID="Nw0i5lD1IafZ0HlX842y" marketType="player_prop"
             playerID="CALEB_WILLIAMS_1_NFL" marketLabel="Passing Yards"
```

Must name `CHRIS_WILLIAMS_1_NFL` and "Caleb Williams" in the refusal, and must not
silently substitute it.

**Then the market-gap case.** Any player who IS on an event but has no line for the
requested market must be told the ID is correct and the market is absent.

---

## Still open, carried forward

- **A real closing line exists and is still not built on.** `closeOverUnder` and
  `openOverUnder` live under `byBookmaker.<book>`; top level carries
  `closeBookOverUnder` and `openBookOverUnder`. v2.8.3 missed it by looking for a
  top-level `closeOverUnder`, which does not exist. The NAMES are confirmed, the
  VALUES are not. Read the SAMPLE block from `tkb_probe_event_fields` on two events
  before building.
- **The four dead tool files**, `DEPLOY-CHECK.md`, the duplicated changelogs in the
  repo root and the stale root-level `index.ts` declaring 2.5.3.
- **CFBD usage is unobservable.** `getStats()` counts this process only.
