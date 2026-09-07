# v2.8.7 - the spread grader was comparing a team's score to the handicap

No tools added or removed. Still **27**. One new service, one new test file, four files
changed. The fix is to a published-results path, which makes it the highest-consequence
bug this connector has carried: it decided what went out as a CASHED reply.

Everything below was measured live on 2026-09-07 against the deployed 2.8.6 build, not
read off the source.

---

## 1. A spread was graded against a team's own score

### What was measured

Mississippi State 62, UL Monroe 13 (eventID `rMHlsh9uyGQJHnyrq4eo`, 2026-09-05). Both
sides of the same spread, through `tkb_grade_slate`:

```
MSST -35.5, home  ->  WIN,  "actual 62"
ULM  +35.5, away  ->  WIN,  "actual 13"
```

**Both sides of one spread came back as wins.** UL Monroe lost by 49 and missed a
+35.5 by thirteen and a half points.

### The cause

For a spread the connector builds `points-<side>-game-sp-<side>`, so `statID` is
`points` and `statEntityID` is `home` or `away`. SGO's `score` is the value of that
statID for that entity, which is the team's own point total - 62 and 13 above. The
grader then compared it to the spread as though a spread were a threshold:

```ts
result = actual > lineUsed ? "WIN" : "LOSS";   // 62 vs -35.5,  13 vs 35.5
```

A spread is not a threshold. It is a handicap applied to a **margin**. Comparing a
team's point total against it is a category error that still returns a verdict.

### Why it looked plausible for so long

The failure is not random, which is what kept it alive. **Any home pick against a
negative line grades WIN automatically**, because a team's score is always greater than
a negative number. That is every home favourite, in every sport, regardless of what
happened in the game. On the away side the direction inverts, so the same board could
return one right answer and one wrong one and look merely noisy.

`claude/grading-accuracy-guardrails.md` had already recorded it as a known defect
requiring hand correction on every run, with confirmed flips on Rutgers -29.5, Wake
Forest -24.5, Yankees -1.5, White Sox +1.5, Dodgers -1.5, Rangers -1.5, Braves -1.5,
Orioles -1.5, Royals +1.5 and Ole Miss -6.5. Fifteen in all. Every one is this line.

Same family as the `p_k` batting/pitching collision (v2.0.1) and the reversed
newest-first array (v2.1.0): right values, wrong story, and no guardrail with anything
to fire on, because nothing in the data was malformed.

### The fix

**The spread branch no longer reads `odd.score` at all.** The margin is computed from
`teams.home.score` and `teams.away.score`, the same two fields the moneyline branch has
always used correctly. That removes the dependence on an ambiguous field rather than
reinterpreting it.

```
adjustedMargin = (pickedScore - opponentScore) + line
   > 0  WIN      = 0  PUSH      < 0  LOSS
```

Pushes now exist. The old comparison bucketed an exactly-covered whole number as a loss.

---

## 2. Grading against the feed's line was grading the result against itself

v2.8.3 established that `bookOverUnder` on a finalized event carries the last LIVE value
rather than the close, and correctly stopped reporting it as `closingLine`. It kept
using it to **grade** whenever no `postedLine` was supplied. That half was never
re-examined.

Same event, same call:

| Pick | Feed line used | Actual | Verdict returned |
|---|---|---|---|
| total over, no postedLine | **76.5** | 75 points | LOSS |
| spread home, no postedLine | **-48.5** | margin 49 | WIN |

The real pre-game total on that game was in the fifties and the real spread was around
-35. Look at what those two feed numbers are: **76.5 against a final of 75, and -48.5
against a final margin of 49.** On a settled event the feed's line has converged onto
the result and sits half a point away from it. Grading against it compares the result to
itself and then decides a real pick on that half point - the total above was a
comfortable OVER win reported as a loss.

**A line market with no `postedLine` is now refused.** `tkb_grade_pick` returns a
refusal; `tkb_grade_slate` returns `NEEDS_POSTED_LINE` and counts it as ungraded. It
does not fall back. The workflow doc has mandated passing `postedLine` since August;
this makes forgetting it loud instead of silent.

---

## 3. The sign of a spread cannot be detected, so the arithmetic is shown instead

`postedLine` for a spread is signed from the picked side's perspective, exactly as
posted: `-6.5` lays it, `+6.5` takes it.

**There is deliberately no auto-detection of a dropped minus sign.** It is not
detectable - `6.5` is a valid line for a dog and an unsigned line for a favourite, and
as numbers they are identical. The feed cannot settle it either, for the reason in
section 2: its spread on a finalized event is the final margin and carries no
information about what the game actually closed at.

What is possible is making a wrong sign visible, which is the v2.1.0 principle: make the
wrong reading impossible rather than merely discouraged. Every spread grade now returns:

```
LOSS: UL Monroe +35.5: final 13-62 vs Mississippi State, so UL Monroe lost by 49.
Needed to lose by less than 35.5, or win outright. Margin -49 + 35.5 = -13.5 -> LOSS.
```

The final score, the margin, the requirement in plain English, and the arithmetic. A
bare `WIN` next to `actualValue: 41` is what let fifteen of these through; a sentence
that says "won by 3, needed to win by more than 6.5" does not survive being read.

`actualValue` on a spread is now the **margin**, not a team's score, and the response
says so in `actualValueMeaning`.

---

## 4. A zero on a player prop is now RESOLVED, not flagged

Settling the standing question about whether "a zero is unresolved until participation
is confirmed" belongs in the guardrails doc: it belongs in the code, because the grader
is where the mistake gets made.

A player who did not play and a player who played and recorded nothing are identical in
`odd.score`. Both are 0. The difference decides between a WIN on an under and a Void that
never had action.

The first pass at this flagged every zero and left the check to a human. **That is the
wrong trade at slate volume.** A warning that fires on every quiet night is a warning
nobody reads, which is precisely the v2.5.0 argument about the IRREGULAR flag firing on
Cam Schlittler: a false positive here is not a safe, conservative error, because it
trains the reader to ignore the flag and the flag's entire value is the real catches.

**So the grader answers the question instead, and flags only what it genuinely cannot
answer.**

### It does not invent a new discriminator

`lookupPlayerStat` in `hitRateAggregator.ts` already separates a real absence from a
missing box score from an unsettled stat, and it **derives that from the event rather
than assuming a shape**: it asks whether the game carries player-keyed results for
anyone on the event roster before concluding anything about one player. That distinction
was forced by the Dante Moore case, where twelve started games were reported as twelve
DNPs.

Grading needs exactly the same three-way answer, so it calls exactly the same function
rather than a second one that can drift from it. That is the whole lesson of section 1
applied before the fact instead of after.

| Lookup | Grader behaviour |
|---|---|
| `value` | He has a box-score line. The zero is real. Graded, **no flag**. |
| `player_absent` | Lines exist for his teammates and none for him. **VOID**, with the evidence stated. The pick had no action. |
| `stat_unsettled` | He played, this stat has not settled. Not a DNP and not a grade. |
| `no_box_score` | The provider has nothing for this game. **The only case that flags.** |

A `no_box_score` game with a non-zero settled value still grades clean, because a
non-zero value is self-evidencing: you cannot record two hits without appearing.

`tkb_grade_slate` gains a `VOID` result and counts voids separately in the slate
summary, matching the tracker's existing Void status.

**Mutation-tested:** letting `player_absent` fall through to an ordinary zero, which is
the old behaviour, fails 2 of the prop tests.

## 5. The math now lives in one tested file

`src/services/pickGrader.ts` - `gradeSpread`, `gradeOverUnder`, `gradeMoneyline`, the
refusal text, and the zero-participation warning. Exported and pure, no API client
anywhere near it.

The comparison previously sat inline in `gradePicks.ts` and inline again in
`gradeSlate.ts`, byte-identical, and both copies carried the same bug. That is this
repo's most repeated failure mode, named in v2.6.0: *the fixes were correct, the audits
were scoped to the file the symptom appeared in.* One implementation cannot drift from
itself.

### Tests

`test/pickGrader.test.ts`, **31 tests**, no network. Every case is a real measured event
or a real flipped pick, not a fixture: the UL Monroe +35.5 regression, the four runlines
from the guardrails doc, the home-favourite-that-does-not-cover shape of the Ole Miss
report, pushes on both sides, and the 16-1 Red Sox/Yankees total against both the true
line and the 17.5 artifact.

**The mirrored-line invariant** is the strongest of them: for a sweep of over a thousand
scoreline and line combinations, home at `-X` and away at `+X` must be exact opposites.
The old code returned WIN for both sides of the same spread, so this expresses the defect
as an impossibility rather than as a wrong number.

**Mutation-tested**, all three restored afterwards:

| Mutation | Result |
|---|---|
| Use the raw team score instead of the margin (the original bug) | **12 of 26 fail** |
| Flip the line sign (`margin - line`) | **7 of 26 fail** |
| Drop the PUSH branch | **3 of 26 fail** |

---

## 6. `npm test` has been red since v2.8.6, on a self-contradiction

Found while running the suite, unrelated to the grading work and worth its own section.

v2.8.6 added `OFFSHORE_BOOKS` and blocked Bovada, correctly - the price is real but a US
follower cannot legally place the bet, the same reasoning that separated Fliff from the
pick'em apps in v2.5.3. It shipped `test/v2_8_6.test.ts` asserting bovada **is** blocked.

`test/regression.test.ts:544`, written in v2.6.2, still asserted bovada is **not**
blocked. Two tests in one suite asserting opposite things about the same call.

So the deploy gate has been failing since v2.8.6 went out, on a failure everyone had a
reason to scroll past. That is worse than it looks: a suite with one known-red test is a
suite nobody reads, and the spread bug shipping into a red suite is exactly the scenario
`npm test` exists to prevent.

The v2.8.6 intent is the correct one. The v2.6.2 assertion is the stale half and is
corrected, with bovada pinned in its new category **in the same test** so the two halves
cannot drift apart again.

Suite is now **197 tests, 197 passing**.

---

## 7. The closing-line question now has a call that answers it

Sections 1 and 2 both refused rather than guessed, which is right, but "we refuse
because we do not know" has been carried forward untouched since v2.8.3 and restated in
v2.8.4 and v2.8.5. Three releases of carrying an open question is how it becomes
permanent by accident.

SGO's docs say the real open and close values live at
`odds.<oddID>.byBookmaker.<bookmakerID>.closeOverUnder`, and appear only when
`includeOpenCloseOdds=true` is requested. Nobody has looked, and per v2.8.1's lesson a
fix written from documentation alone is a guess wearing a citation.

`tkb_probe_event_fields` now takes an optional **`oddID`**. Given one, it fetches that
single odd with `includeOpenCloseOdds=true` and reports the odd's real field names, the
union of the keys inside every `byBookmaker` entry, and a sample of up to four books.

**Tool count is unchanged at 27.** This is a second mode on the diagnostic that already
exists for exactly this class of question, not a twenty-eighth tool.

It reports **what is there** rather than testing for what the docs predict. Checking
`"closeOverUnder" in book` and returning a boolean would render "SGO calls it something
else" as "the field is absent" - the same shape of mistake as v2.8.3's mismatch warning
firing on every prop, and as the v2.8.5 truncation lesson. The verdict distinguishes
four outcomes rather than collapsing them: resolved under `byBookmaker`, resolved but
top-level instead, partial (an open/close key exists but carries no line, which is
exactly what v2.8.3 saw with `openOdds`), and genuinely absent.

**Every one of those four is a result.** If it comes back partial or absent, the grader
refusal in section 2 and `tkb_get_line_movement`'s coverage note are both correct as
written and should be documented as permanent instead of being carried forward a fourth
time. If it resolves, two fixes become buildable at once and should ship together.

Untested against live data in this build, deliberately - the deployed server is 2.8.6
and the mode does not exist there yet. It is one call after deploy.

---

## Files changed

```
src/services/pickGrader.ts     NEW
src/tools/eventProbe.ts        (closing-line probe mode)
src/tools/gradePicks.ts
src/tools/gradeSlate.ts
test/pickGrader.test.ts        NEW
test/regression.test.ts        (the bovada contradiction)
src/index.ts                   SERVER_VERSION 2.8.7
package.json                   2.8.7
```

Both version strings are already bumped in this build. They have drifted four times
before; they have not drifted here.

---

## Deploy

1. Commit and let Render redeploy. `npm test` must read 197 passing first.
2. Do **not** confirm by reading `/health`. Per v2.6.6 it reported 2.6.4 with 21 tools
   while the server was correctly serving 24, because the response was cached upstream.

### Verify, control case FIRST

The v2.8.2 rule: verifying only the cases you expect to fail is how v2.8.1 passed its own
checklist while broken for an entire league. Here the control matters more than usual,
because moneylines and props were never wrong and must not move.

**Control 1 - a moneyline must be unchanged.**

```
tkb_grade_pick sport="cfb" eventID="rMHlsh9uyGQJHnyrq4eo" marketType="moneyline" side="home"
```

WIN. If this moves, stop.

**Control 2 - a total with a postedLine must be unchanged.**

```
tkb_grade_pick sport="cfb" eventID="rMHlsh9uyGQJHnyrq4eo" marketType="total"
               side="over" postedLine=55.5
```

WIN on 75 actual points, exactly as 2.8.6 returned it.

**Then the case this release exists for.**

```
tkb_grade_pick sport="cfb" eventID="rMHlsh9uyGQJHnyrq4eo" marketType="spread"
               side="away" postedLine=35.5
```

Must return **LOSS**, margin -49, with the full explanation line. On 2.8.6 this returned
WIN. Then run the same event with `side="home" postedLine=-35.5` and confirm **WIN**.
Both directions on one game, opposite answers - that pair is the proof.

**Then the refusal.**

```
tkb_grade_pick sport="cfb" eventID="rMHlsh9uyGQJHnyrq4eo" marketType="total" side="over"
```

Must refuse for having no postedLine, and name the 76.5 measurement. On 2.8.6 it
returned LOSS.

**Then the one call that settles the oldest open item.**

```
tkb_probe_event_fields sport="cfb" eventID="rMHlsh9uyGQJHnyrq4eo"
                       oddID="points-all-game-ou-over"
```

Read the VERDICT line. Whichever of the four it returns, it closes a question that has
been carried forward through four releases, and it should be written down as settled
rather than left open again.

---

## Still open, carried forward

- **`tkb_get_line_movement` is half-broken**, and is still not fixed here. `openOdds`
  resolves, `openOverUnder` and `openSpread` do not, so it returns an opening price with
  no opening number. It also accepts no `preferredBookmakers` and priced a test off
  BetOnline, which v2.8.6 has since blocked as offshore - so that call would now fail
  differently than it did when the problem was recorded. The repair is deliberately held
  until the section 7 probe has been run, because it and the grader's closing-line
  refusal are the same question and should be answered once and fixed together.
- **The four dead tool files** (`debugEvent.ts`, `debugInjuries.ts`, `futures.ts`,
  `teamRecord.ts`) are still in `src/tools/`, nine releases after v2.6.0 archived them
  with an instruction to delete. `DEPLOY-CHECK.md` is still present and still tells the
  reader `/health` should report 2.0.3.
- **The cumulative 2.8.x changelogs** still need collapsing, and `docs/` now also
  duplicates several changelogs that sit loose in the repo root alongside a stale
  root-level `index.ts` declaring 2.5.3. That file is a live hazard: copying it over
  `src/index.ts` would silently revert the server by eleven releases.
- **CFBD usage is unobservable.** `getStats()` counts this process only and Render cold
  starts reset it.
