# v2.9.0 - four leagues, a third participant model, and an end to the silent empty slate

Tools: **27 -> 28**. Sports: **6 -> 10**. Tests: **327 -> 411**, all passing.

Added: `cbb` (NCAAB), `epl`, `ucl`, `ufc`, and `tkb_check_league_access`.

This is the largest surface change since the tennis build, and most of the work was
not in the new leagues. It was in the two places where adding them broke an
assumption the rest of the connector had been holding quietly.

---

## 1. FIRST, THE ONE THAT WOULD HAVE BITTEN WITHOUT ANY NEW LEAGUE AT ALL

Measured live on the deployed 2.8.12 build, 2026-09-14:

```
tkb_get_schedule sport="atp"                 -> "No ATP games found ..."
tkb_get_schedule sport="atp"  Sep 1-13       -> 81 events, the whole US Open
```

The first message is produced by three completely different situations:

1. the calendar really is empty for that window (what it was - the US Open had ended)
2. this connector's own filters removed everything that came back
3. **the installed key cannot see that league at all**

It took three calls and a backwards probe into a past window to find out which.

**That third cause is not hypothetical on this account**, which swaps between a
ROOKIE key and a PRO key depending on the month. SGO gates LEAGUE ACCESS by plan,
not just rate limits: Amateur 8 leagues, Rookie 17, Pro 53, with their own leagues
doc saying "not all leagues may be available depending on your subscription plan."

So a league added on the pro key goes dark when the rookie key returns, and it goes
dark as *"no games found"* on a night with a full board. A silent wrong answer is
the one failure class this connector exists to refuse.

### What changed

`tkb_get_schedule`'s empty result now names all three causes. Where the cause is
KNOWN it says so as fact rather than as a possibility: if SGO returned events and
our filters removed them, the message says how many and stops listing alternatives.

`tkb_check_league_access` (new) probes every configured league in **both**
directions - the last 45 days and the next 21. **Looking backward is the
load-bearing half.** A forward window is empty for ordinary calendar reasons
constantly; a 45-day backward window is empty only if the league did not play or
cannot be seen. That single call would have answered the ATP question outright.

**What it will NOT do is assert that a key lacks entitlement.** SGO's behaviour for
an unentitled league has not been measured on this account, and an out-of-season
league looks identical from here. It reports both counts, states which plan each
league is documented under, and leaves the conclusion to a human holding the one
fact this connector does not have: which key is currently installed.

### Which new leagues survive a key swap

| league | plan it is NAMED on | survives rookie? |
|---|---|---|
| `NCAAB` | Amateur (free) | **yes** |
| `UEFA_CHAMPIONS_LEAGUE` | Amateur (free) | **yes** |
| `EPL` | Rookie | **yes** |
| `UFC` | named on NO plan's list | **unknown** |

Rookie discloses 17 leagues and names 10; Pro discloses 53 and names 12. UFC is in
neither list, so "probably Pro" is a guess and is recorded as one. One email to
api@sportsgameodds.com settles it.

---

## 2. COLLEGE BASKETBALL, AND WHY IT WENT FIRST

It opens in early November, which is precisely when the CFB board - the account's
biggest driver - runs out. Nightly slate, 350+ D1 teams, and the props it posts
(points, rebounds, assists, threes) are the ones the WNBA path already handles.

**Hit rates come from CollegeBasketballData, not BALLDONTLIE.** BDL gates NCAAB
`/player_stats` behind GOAT at $39.99/mo for that one sport - BDL's paid tiers do not
carry across sports. CBBD is free, same Bearer auth this repo already speaks for
CollegeFootballData, same organisation.

With no `CBBD_API_KEY` the CBB hit-rate path **REFUSES** rather than falling back.
That is the v2.7.0 rule restated: SGO carries college games but not college box
scores, so a fallback would report played games as DNPs, which is exactly what
produced a returning starter at a 0.2 play rate on the football side.

### CBBD IS NOT CFBD WITH THE WORDS CHANGED

Same organisation, genuinely different API, and the differences are the kind that
produce silent wrong numbers:

| | CollegeFootballData | CollegeBasketballData |
|---|---|---|
| shape | game → teams → categories → types → athletes | one row **per team per game** → players[] |
| stat values | STRINGS, some compound (`"24/35"`) | `number \| null`, never strings |
| grouping | flat name/value pairs | shooting and rebounding are **nested objects** |
| fetch unit | week number | **date range** (there is no `week` field) |
| dates | a SECOND request to `/games` | `startDate` on every row |
| a DNP | indistinguishable from a quiet game | **row is absent** (`minutes is not null`) |

Three of the most-posted college markets do not exist as top-level fields:

```
NOT threePointFieldGoalsMade   BUT  threePointFieldGoals.made
NOT rebounds as a number       BUT  rebounds.total
NOT offensiveRebounds          BUT  rebounds.offensive
```

A mapper reading `row.rebounds` as a number gets an OBJECT. Anything then coercing
it produces NaN, or worse a truthy value that survives a `!= null` check and lands
in a hit rate as garbage.

### Two places CBBD is better than the football path, and both are used

**Dates arrive attached.** The CFBD client needs a second endpoint purely to recover
dates, because `/games/players` returns a bare game id - the gap that let a season
warning go silent in v2.8.6 while every sample was prior-season. CBBD puts
`startDate` on every box-score row, so that guardrail cannot go blind.

**A DNP is a real DNP.** CBBD filters its player array on `minutes is not null`, so
absence proves he did not play. The CFB availability flag has to report UNKNOWN
because CFBD lists a player only where he recorded a stat. Here the flag is honest,
and the CBB screen skips the SGO availability probe entirely rather than spending
requests to re-derive something already known, less reliably.

### The v2.8.6 bug, pre-empted rather than repeated

On the football side, `teamName: params.teamID` handed `COLORADO_NCAAF` to a matcher
comparing against CFBD's `"Colorado"`. Exact match, never equal, every CFB hit rate
returned NO SAMPLE - silently, for several releases, because an empty CFB sample
looks ordinary in the opening weeks.

SGO writes `PURDUE_NCAAB`. So `deriveCbbdTeamName` and the report-the-name-searched
behaviour both ship from day one instead of after the same outage.

**The November problem is stated, not papered over.** For the first three weeks
every sample is tiny or prior-season, and a prior-season college basketball sample
is weaker than a prior-season NFL one - rosters turn over far harder. The honest
output in November is "not enough games yet", and the `minCurrentSeasonGames` floor
from v2.8.12 is there for exactly this.

---

## 3. SOCCER: TWO TRAPS, EACH OF WHICH SHIPS A CONFIDENT WRONG ANSWER

EPL and UCL are two rows rather than two builds - identical market conventions. They
do NOT share IDs: SGO defines teams and players per league, so Salah is
`MOHAMED_SALAH_1_EPL` in the league and a different id in the Champions League.
Never cache a soccer player id across competitions.

### Trap one: a level score is a RESULT, not a push

`gradeMoneyline` returns PUSH on equal scores. That is correct for every sport this
connector graded before - a level final either cannot happen or means no action. In
soccer it is the most common single scoreline in the sport.

A 1-1 draw fed to the old grader returned **PUSH**, logging a lost pick as no
action. Same class as the v2.8.7 spread bug: correct arithmetic, wrong question.

`gradeSoccerMoneyline` now handles it, and splits on a distinction books do not
label:

- **Three-way (`ml3way`)** is unambiguous and graded: a draw is a **LOSS** for a team
  selection and a **WIN** for the draw itself.
- **Two-way (`ml`) on a drawn match is REFUSED.** Books sell two different products
  at that price - Draw No Bet, where a draw is a PUSH, and draw-excluded, where it is
  a LOSS. SGO does not say which its `ml` betTypeID carries for soccer, and the
  difference is the whole stake. The refusal names both and asks for a human read.

`marketType: "moneyline_3way"` and `side: "draw"` are new on both graders, and
`NEEDS_MANUAL_REVIEW` is a new slate result. The three-way DRAW side is priced on
the game-wide `all` entity, per SGO's own rows (`points-all-<period>-ml3way-draw`).

### Trap two: soccer match lines are NOT on the `game` period

SGO's EPL page, verbatim: *"the full-match moneyline is `points-home-reg-ml-home`,
while player props stay on `game`."*

One event, two periods, split by MARKET KIND. And the failure is quiet rather than
loud: a soccer moneyline requested with `game` does not error, it returns no market,
which every tool downstream reports as "odds are not posted yet" - inviting a retry
that can never succeed.

`matchLinePeriodFor(sport)` now decides this, and every match-line path routes
through it: `tkb_get_odds`, `tkb_get_game_lines`, `tkb_get_line_movement`,
`tkb_monitor_live_picks`, and both graders. No tool builds a soccer match line by
hand.

**Goals are `points`.** SGO's soccer stat list has `goals+assists` but no bare
`goals` statID at all. Anything built against a `goals` string matches nothing.

**Hit rates are FALSE for both**, and it is a subscription fact rather than a missing
product: BDL publishes `/epl/v2/player_match_stats` and gates it behind GOAT for that
sport. The free Fantasy Premier League API would serve EPL (not UCL) per-gameweek
stats and is the obvious next step - it is a new client rather than a config row, and
was deliberately not half-built.

---

## 4. UFC BROKE A BOOLEAN, AND THE BOOLEAN WAS THE PROBLEM

`isIndividualSport` conflated two independent questions that tennis happened to
answer the same way:

1. do competitors occupy the home/away slots, or a roster?
2. do player-level props exist?

Tennis says slots + no props. Team sports say roster + props. **A fighter says slots
AND props** - SGO's UFC page states both that "the home and away slots on an event
hold the two fighters rather than teams" and that "fighter-level props carry the
fighter's ID in that slot instead of `all`".

One boolean cannot express that. Forcing it would have meant either losing fighter
props or claiming UFC has rosters. `PARTICIPANT_MODEL` replaces it with three cases
(`roster` / `participant_slots` / `fighters`), declared as its own exhaustive table
so the next sport is a row plus a compiler error rather than an audit.

**Whether `event.players` is populated on a UFC event is UNVERIFIED.** The docs are
in tension and this connector does not guess at provider shapes, so `tkb_get_players`
returns a UFC-specific answer that names both possibilities and points at the one
place the truth is visible: the oddID keys on the board. "Retry closer to kickoff"
would have been actively wrong if the answer is permanent.

**Hit rates are false.** BDL's `/mma/v1/fight_stats` is GOAT-only for MMA and the
free alternative is scraping ufcstats.com, which is infrastructure this repo does not
have. The refusal says so and says to write from researched fight history instead.

Also worth knowing: `DAYS_PER_TEAM_GAME.ufc` is **120**, deliberately absurd in that
table, because it makes plain why a counted UFC hit rate is refused rather than
computed. A "last 10" window reaches back three years, across weight classes, camps
and layoffs. Even with a stat source, UFC would need a different design than a
rolling date window.

**Method-of-victory markets are catalogued but not gradeable.** `wonBy_knockout`,
`wonBy_submission` and `wonBy_decision` can be PULLED and posted; settling them needs
a method, which a UFC event does not carry in the fields this repo reads. Inferring
"won inside the distance" from a rounds figure is exactly the guess this connector
refuses.

---

## 5. THINGS DELIBERATELY NOT BUILT, AND WHY

Each of these is an absence with a reason, so nobody re-derives it later:

- **The UFC "opening rounds" grouped market.** SGO's page refers to it in prose and
  never prints its periodID, and no documented code has that shape. Guessing one
  (`1rx2`? `1rx3`?) produces silent empty results.
- **`eo` (even/odd) markets.** The betTypeID is documented; its sideIDs are not. The
  strings `even` and `odd` appear nowhere readable.
- **Soccer `et` / `ps` periods.** Real documented codes, present in `PERIOD_CODES`,
  but no tool offers them because nothing in the docs binds markets to them and
  league play never reaches them. They matter for UCL knockout ties.
- **NCAAB quarters.** College basketball plays halves. Offering quarters would return
  an empty result that reads like a missing line rather than a period this sport does
  not play.

One doc contradiction is recorded rather than silently resolved: SGO's **glossary**
writes half and quarter codes reversed as `h1`/`q1`, while the markets table, the
odds page, the cheat sheet and both league pages write `1h`/`1q`. Four sources to
one, and the four include the machine-readable table. If half markets ever come back
empty across several sports at once, that is the first thing to retest.

---

## 6. TESTING

**327 -> 411.** Four new files plus additions to the wiring sweep.

The compiler already forces every `Record<SportKey, ...>` table to be filled - that
error is the feature, and adding four sports produced six of them. What the compiler
does NOT check is whether what went in those rows is coherent: an empty catalog, a
period the sport does not play, or a capability flag contradicting the catalog all
compile perfectly. `test/sportExpansion.test.ts` covers that gap, and asserts among
other things that every declared period resolves to a real SGO code, that a sport
claiming `playerProps` has a non-empty catalog, and that soccer never references a
`goals` statID.

`tkb_check_league_access` joins all three wiring sweeps (happy path, all-clients-
throw, empty event), and the fake CBBD client matches the REAL response shape -
per-team rows with nested players - because a fake that flattened it would pass while
production failed.

Mutation-tested, eight mutations, **eight killed**:

| mutation | caught by |
|---|---|
| draw selection inverted | the three-way draw cases |
| three-way draw graded PUSH | the WIN/LOSS assertions |
| two-way draw silently graded LOSS | the refusal case |
| soccer loses its `reg` period | the oddID and routing tests |
| `regulation` aliased to `game` | the period-code assertions |
| a null CBBD field read as 0 | the null-is-not-zero case |
| `rebounds` read flat instead of nested | the nested-path cases |
| an ambiguous player resolved anyway | the refuse-on-ambiguity case |

One earlier version of a test in this release was itself wrong and is worth
recording: it asserted every refusal message exceeded 40 characters, and failed on
`"Weather is not a factor for WNBA."` - which is short because it is complete. The
assertion now checks that a refusal names its sport and is not a bare "not
supported", which is what was actually meant.

---

## 7. DEPLOY

New environment variable: **`CBBD_API_KEY`**.

It is a SEPARATE key from `CFBD_API_KEY`, issued free at
collegebasketballdata.com/key. What the two DO share is the monthly call quota, which
is tied to the account rather than the sport - so November and early December, when
both seasons are live at once, is the one stretch where CFB usage can exhaust CBB.

Without it the server boots normally, every other tool works, and CBB hit rates
refuse. `tkb_get_api_usage` now reports CBBD alongside CFBD, and reports
**X-CallLimit-Remaining first**, because that number comes from the provider and the
in-process counters reset on every Render cold start.
