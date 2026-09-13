# v2.8.12 - the CFB roster cap comes off, and a stuck game gets a second opinion

No tools added or removed. Still **27**. Two behavioural changes, both from live
measurement on the 2026-09-12 and 2026-09-13 slates.

Tests: **305 -> 327**, all passing.

---

## 1. CFB was screening 18 players out of a 49-player board

`DEFAULT_MAX_PLAYERS.cfb` was **18**, and `maxPlayers` was capped at 30 by the schema
so a caller could not raise it past that even deliberately.

The cut is on **SGO's response order**, which is not a quality order. It is not the
top 18 props, it is the first 18 SGO happened to serialise. On a measured CFB event
the board carried **49 distinct players**, so 31 of them were never looked at, and
nothing in the output said so.

The reason the cap existed was quota fear. That fear was measured and is wrong:

| | 18 players | 30 players |
|---|---|---|
| SGO entities billed | **1** | **1** |
| CFBD requests | **0** | **0** |

SGO bills per **event object**, and the event is fetched once regardless of how many
players are then read out of it. CFBD bills per **week**, and weeks are cached
permanently after the first fetch. Screening more players off an event already in
hand costs **nothing** on either meter.

What it does cost is **latency**, which is a real cost but a visible one, so the
response now carries `screenDurationMs` instead of a quiet cap.

**Changed:**

- `DEFAULT_MAX_PLAYERS.cfb`: 18 -> **80**
- `maxPlayers` schema: `.max(30)` -> **`.max(80)`**, so the default is reachable
- `screenDurationMs` added to the response

The schema ceiling and the per-sport default are now tested against each other
(`test/toolWiring.test.ts`). Raising one and not the other would have made the new
default unreachable for any caller who passed the value explicitly, which is the
quietest possible version of this bug.

---

## 2. `minCurrentSeasonGames` - an OPT-IN floor, not a new filter

A screened player can show a strong rate built entirely from **last season**. In
September that is most of the board, and the existing prior-season warning says so
but does not let the caller act on it in one step.

`minCurrentSeasonGames` (default **0**, i.e. off) drops players below a floor of
counted games **this** season. `currentSeasonGames` and `priorSeasonGames` are now on
every screened row whether the floor is used or not, and `droppedByCurrentSeasonFloor`
plus a line in the text output say how many went and how to get them back.

Default off is deliberate. This repo's standing rule is **warnings, not filters** -
a screen that silently removes players is the same failure as a cap that silently
removes them. This is a knob the caller turns, and it announces itself when turned.

The filter runs **before** the sort, not after, so the returned list is the top N of
what survived rather than the survivors of the top N.

---

## 3. A game SGO has not caught up with is not the same as a game in progress

v2.8.8 made the graders refuse anything SGO would not affirmatively call final.
That was right and stays right. What it was not is **finished**.

`assessFinality` has three outcomes and only one of them is a real dead end:

| verdict | what it means | cross-checkable? |
|---|---|---|
| cancelled | affirmative: no result exists | **no** |
| affirmatively live | affirmative: the game is running | **no** |
| status unknown/absent | we could not tell | **yes** |

That third row is an **SGO ingest lag**, and it lasts minutes. During it, a genuinely
finished game is refused, and the user re-runs the grader, and re-runs it again. The
refusal is correct and the experience is bad, and those are different problems.

BALLDONTLIE has the same game, on a key with **no monthly object cap** (this is the
same economics that moved hit rates there in the first place). One request per stuck
event is close to free.

### Three conditions, all required

1. **Both teams match**, home to home and away to away, on a normalised name compare.
   Whole names only, never containment, and **an abbreviation is not a name**: "MIA"
   is one string and three teams. This is the v2.8.5 lesson applied to a new feed.
2. **BDL affirmatively says final.** Anchored matching, same as `displaySaysFinal`.
   BDL's exact per-sport status vocabulary has **not** been measured on this account,
   so the code is written to be **useless rather than wrong** on a string it does not
   recognise: unknown resolves nothing.
3. **The scores agree exactly.** This is the guard that makes it safe. If SGO is
   merely lagging its status field it already has the final score, so the two agree.
   If they disagree, at least one feed is mid-ingest and grading either is a coin
   flip, so the refusal stands and **both scores are printed**.

### What it will never do

- overturn `cancelled` or a live status. Affirmative information is not negotiable.
- **supply a score.** Grading reads SGO's scores, always. This is a finality check,
  not a score source. Two feeds' numbers are not interchangeable, and mixing them
  produces a result that is internally inconsistent with the event it cites.
- fail a grade. Every failure path - 404, timeout, no client, no date, no match -
  degrades to "could not confirm" and returns the original refusal untouched. A
  cross-check that could break grading would be worse than no cross-check.

A grade that the second source made possible **says so on the result**, in
`tkb_grade_pick` and on every row in `tkb_grade_slate`. A grade that contradicts
SGO's own status field must never look like an ordinary one.

Cost: one BDL request **per stuck event**, never per pick. A slate SGO has already
settled spends nothing.

---

## 4. Testing

`reconcileFinalityWithBDL` is pure and takes the rows the caller already fetched, so
all nine of its cases are assertable without a network. `crossCheckFinality` wraps the
fetch behind a structural interface, so the 404, the no-client and the
one-request-two-dates cases are assertable too.

But **the pure part is not the part that broke last time.** v2.8.9 shipped a correct
function into an unreachable branch. So the wiring is asserted separately, through
the fake-server harness: that a stuck event grades and discloses the second source,
that a **live** event is never cross-checked and spends no request, that
`tkb_grade_slate` asks once per event rather than once per pick, that a disagreement
leaves the refusal standing, and that a BDL outage cannot fail a grade.

Mutation-tested, eight mutations, eight killed:

| mutation | caught by |
|---|---|
| BDL status always reads final | the non-final status sweep |
| one matched team is enough | the orientation and half-match cases |
| drop the score-agreement guard | the disagreement case |
| query only the event's own UTC day | the two-dates assertion |
| remove the unknown-only gate | the live-game no-request assertion |
| cross-check always resolves | the disagreement and outage cases |
| drop the provenance notice | the "SECOND SOURCE" assertion |
| never cross-check in gradeSlate | the slate case |

One mutation survives and is recorded rather than hidden: adding `abbreviation` to
the list of names a BDL team may match on is not caught, because no realistic event
has an SGO long name that equals a BDL abbreviation. It is an equivalent mutation
here, not a coverage hole, but it is written down because the next person to widen
that list should know the suite will not stop them.
