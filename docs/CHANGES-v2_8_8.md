# v2.8.8 - the grader settled a game that was still being played

No tools added or removed. Still **27**. Six files changed, one new service, one new
test file.

Both fixes came from reproducing the reports live against the deployed 2.8.7 build,
not from review. One of them turned out to be considerably larger than reported.

---

## 1. `finalized: true` is a REQUEST, not a guarantee

### What was measured, 2026-09-12

Pittsburgh @ UCF, eventID `sGMmL4WzMWVl5eoshB7N`, same connector, same minute:

```
tkb_get_schedule  ->  status "4th", Pittsburgh 12 UCF 7, in progress
tkb_grade_pick    ->  "final 12-7", Pittsburgh -3.5 a confident WIN
```

The game was still being played. One UCF score flips that pick.

### The cause

Both graders fetch with `finalized: true` and then trust that what comes back is
finished. SGO returned an in-progress game anyway and nothing downstream looked at
the status block that was sitting right there on the event, which
`tkb_get_schedule` reads correctly off the same object.

The grader was violating its own documented contract. Its description promised
*"NOT_FINAL for any event SGO has not finalized"* and *"unfinished events return
NOT_FINAL, never a guess."*

### This is not only a grading bug

**Seven call sites pass `finalized: true`**: `gradePicks`, `gradeSlate`,
`screenProps`, `coverPlayer`, `splitsAggregator` (twice) and `hitRateAggregator`.
Every one treats what comes back as a completed game.

So the same leak does more than mis-grade a pick. A live game reaching
`hitRateAggregator` contributes a **partial stat line as though it were a finished
one**: a pitcher three innings into a start counts as a completed outing with three
strikeouts. That would be invisible, because a low number in a game log reads as a
bad night rather than an unfinished one. Same family as the `p_k` collision and the
year-stale window: right values, wrong story.

The original report scoped this to the grader. It was worth reproducing before
fixing, because the fix belongs somewhere else.

### The fix: two thresholds, deliberately different

`src/services/eventStatus.ts`, pure and exported.

**`isAffirmativelyLive` runs at the CLIENT layer**, inside `getAllEvents` whenever
`finalized: true` is requested. It drops only events the feed says are in progress.
An unrecognised or absent status is **kept**. Silently shrinking every hit-rate
sample because of a status string this code does not recognise would be a worse
failure than the leak being fixed.

Fixed there rather than in each caller for the reason v1.2.0 put the history cache
in `getAllEvents` and v2.6.0 put coalescing there: one change every caller inherits
beats six that have to be remembered.

**`assessFinality` runs at the GRADER layer** and requires the feed to affirmatively
say the game is over. **Unknown is not final.** The asymmetry is the whole point:
grading a live game publishes a wrong result, while refusing a finished one costs a
retry. Those are not comparable errors, so they do not get comparable thresholds.

A refused pick names the status and points at `tkb_monitor_live_picks`, which is the
tool for a running game and enforces the over/under asymmetry a grader cannot.

Status matching is anchored, never containment. "F" and "F (OT)" are finals; "4th",
"HT" and "First Half" are not. v2.8.5 learned that lesson when "Miami" contained
"Miami (OH)"; a loose match on "F" would settle a game at halftime.

### Verified that the graders can actually see status

Checked before shipping rather than assumed, because a gate this strict would refuse
everything if the field were absent. `tkb_probe_event_fields` on an oddIDs-filtered
fetch, the same shape the graders use, reports `status` as an 18-key object carrying
`started`, `completed`, `cancelled`, `ended`, `live` and `displayShort`. The filter
shapes odds, bookmakers and players; it does not strip status.

---

## 2. `tkb_get_schedule` silently truncated a full Saturday at 25 games

### What was measured, 2026-09-12

`tier="fbs"`, window 00:00Z to next-day 12:00Z:

```
count: 25, ordered by kickoff, stopping at the 23:00Z games
```

Same query narrowed to 22:30Z onward returned **15 more games** the first call never
mentioned. `count: 25` reads like an answer.

### The cause, from SGO's own docs

> "If you're making a request to the `/events` endpoint, the max-limit varies from
> 25-100 depending on the query. Factors affecting this include: If the query
> filters for specific fields (ex: `oddIDs`)..."
>
> "The limit applied is the smaller value between the `limit` parameter you supplied
> and the max-limit for the endpoint."

The schedule fetch asked for 100 and passed **no `oddIDs`**, so it got the low end of
that range. The request was also pulling the entire odds map for every game on the
slate, which a schedule never reads.

### Three changes, because one is not enough

**A trivial `oddIDs` filter on the fetch.** Per SGO's docs this raises the max-limit,
and it stops hundreds of markets per game being serialised for a tool that only
wants names and kickoff times. `tkb_probe_event_fields` already uses the same trick
for the same reason. Per SGO's docs the filter shapes odds, bookmakers and players
only and does not decide which events come back, so no game can be hidden by it.

**Defensive cursor extraction.** The client read exactly `page.nextCursor`. v2.0.3
stated the rule while fixing this in BDL: *"pagination stopping silently after page
1 is indistinguishable from 'there was only one page'."* v2.8.4 hit the identical
bug again eight releases later in `searchPlayers`. The SGO client never got that
treatment, so it now reads the cursor from every known location.

**A `truncated` flag, which is the actual fix.** The failure was not that games were
missing, it was that nothing said so. The only way to notice was to already know a
game was absent. `tkb_get_schedule` now returns `truncated: true` and a note telling
the caller to split the window and combine, and the empty-result branch distinguishes
"nothing on" from "your filters ran against a truncated page".

Same shape as the v2.6.3 roster clip and the v2.8.4 search truncation: a clipped
result looks completely healthy.

---

## 3. Not fixed here, because it is not ours

Mississippi State @ Minnesota read `"4th"` while the game was genuinely over at
38-13, then corrected itself to `"F"` minutes later. That is SGO's ingest lagging
the whistle, and the connector is relaying it faithfully.

Nothing in this repo can fix it, and it is now **harmless rather than dangerous**:
under section 1 a lagging status makes the grader refuse and ask for a retry, which
is the safe direction. The refusal text says so, so a reader who sees it on a game
they watched end knows to wait rather than to go hunting.

---

## 4. A correction to the record

The v2.8.7 notes claimed **fifteen confirmed spread flips**. That number was
inflated. Re-checking, NC State, Boston College and Missouri were reported as "raw
team score echoed" when 73, 7 and 17 were in fact the correct margins. A reviewer
primed to look for the bug read three correct answers as instances of it.

The genuinely broken cases were Wisconsin +20.5 (actualValue 13, its own score,
true margin 28) and Ole Miss -6.5 (actualValue 41, its own score, true margin 3),
plus the runlines already listed. The bug was real, reproduced on demand, and is
fixed. The count was not.

Recorded rather than quietly edited, for the same reason v2.8.4 recorded its own
retraction: a wrong number that shaped a decision should be as findable as the fix.

---

## 5. Tests

`test/eventStatus.test.ts`, **13 tests**, no network. Every status string is one
observed in a single live CFB Saturday response: "F", "F (OT)", "1st", "2nd", "3rd",
"4th", "HT". None are invented.

The load-bearing assertions:

- a 4th-quarter game is NOT final, and the refusal names `tkb_monitor_live_picks`
- **unknown is not final**, stated as its own test, because that asymmetry is a
  decision rather than an implementation detail
- the client guard KEEPS an unknown status while the grader REFUSES it, asserted
  side by side so the two thresholds cannot quietly converge
- "First Half" does not settle a game

Suite is now **210 tests, 210 passing**.

Also extended the out-of-repo end-to-end harness to drive the real compiled tool
handlers against the live Pittsburgh @ UCF event shape: `tkb_grade_pick` and
`tkb_grade_slate` both refuse it, and it counts as zero settled picks. **23/23.**

**Mutation-tested**, all restored afterwards:

| Mutation | Result |
|---|---|
| Treat unknown as final (the original bug) | fails |
| Containment matching on the status string | 1 of 13 fails |
| Make the client guard as strict as the grader | 3 of 13 fail |

---

## Files changed

```
src/services/eventStatus.ts    NEW
src/services/sgoClient.ts      live filter, cursor hardening, truncation flag
src/tools/gradePicks.ts        finality gate
src/tools/gradeSlate.ts        finality gate, NOT_FINAL in the summary
src/tools/schedule.ts          oddIDs filter, truncated flag
test/eventStatus.test.ts       NEW
src/index.ts                   SERVER_VERSION 2.8.8
package.json / package-lock.json
```

---

## Deploy

1. Commit, let Render redeploy. `npm test` must read 210 passing first.
2. Do not confirm by reading `/health`. Per v2.6.6 it once reported 2.6.4 with 21
   tools while the server was correctly serving 24.

### Verify, control case FIRST

The v2.8.2 rule. Here the control matters more than usual, because a finality gate
that is too strict refuses everything and that failure looks like a dead connector.

**Control 1 - a finished game must still grade.**

```
tkb_grade_pick sport="cfb" eventID="<a game that has ended>" marketType="spread"
               side="home" postedLine="<real line>"
```

Must return a normal WIN or LOSS with the explanation line. **If this returns
NOT_FINAL on a game that plainly ended, stop** - either the status block is not
reaching the grader or the match is too strict, and every grade is now blocked.

**Control 2 - a full slate still grades.** Run `tkb_grade_slate` over yesterday's
finished picks and confirm the record matches what it produced before.

**Then the case this release exists for.** During a live game:

```
tkb_grade_pick sport="cfb" eventID="<a game in progress>" marketType="spread"
               side="home" postedLine="-3.5"
```

Must return NOT_FINAL naming the period, not a verdict.

**Then the truncation.**

```
tkb_get_schedule sport="cfb" tier="fbs"
                 startsAfter="<Saturday 00:00Z>" startsBefore="<Sunday 12:00Z>"
```

Should now return well past 25 games. If it still stops at a round number, the
response will carry `truncated: true`, which is the point: partial is now visible
either way.

---

## Still open, carried forward

- **A real closing line EXISTS and is still not built on.** The v2.8.7 probe found
  `closeOverUnder` and `openOverUnder` under `byBookmaker.<book>`, plus
  `closeBookOverUnder` and `openBookOverUnder` at the top level. v2.8.3 missed it
  because it looked for a top-level `closeOverUnder`, which genuinely does not
  exist. The key NAMES are confirmed; the VALUES are not, and a field that exists
  while carrying the wrong number is exactly the trap that produced the 17.5. Read
  the SAMPLE block from that probe on two events before building. If they hold, the
  graders can stop refusing a missing postedLine and `tkb_get_line_movement` can
  finally report an opening number.
- **The four dead tool files** and `DEPLOY-CHECK.md` are still present, and `docs/`
  still duplicates several changelogs that also sit loose in the repo root beside a
  stale root-level `index.ts` declaring 2.5.3. That file would revert the server by
  twelve releases if it were ever copied over `src/index.ts`.
- **CFBD usage is unobservable.** `getStats()` counts this process only.
