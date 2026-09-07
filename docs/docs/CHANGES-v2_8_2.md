# v2.7.0 — a coverage gap was being reported as a playing-time risk, and CFB gets a real rate source

One tool added (**25**). Two bugs fixed, both of the same family this repo keeps
finding: fully populated, plausible-shaped, confidently wrong output that no
guardrail fires on.

Everything here was found by running the live connector on 2026-08-31 while scoping
CFB player props, not by review.

---

## 1. Missing data was being counted as missed games

### What it returned

`tkb_get_player_hit_rate` on Dante Moore, Oregon's returning starting quarterback,
with the window widened to reach the 2025 season:

```
playRate: 0.2
flag: "IRREGULAR"
"appeared in only 3 of the last 15 team games (12 DNPs)"
```

**He started all fifteen.** Maddux Madsen came back the same way: `playRate 0.07`,
"1 of the last 14 team games (13 DNPs)", on a quarterback who started the season.

### The cause

`extractPlayerStat` returned `number | null`, and the aggregator counted every
`null` as a DNP. But a null was already three different things:

| What happened | What it meant | Counted as |
|---|---|---|
| `results.game` has no player entries at all | provider has no box score | DNP |
| box score lists others, not this player | a real absence | DNP |
| player is listed, this stat is unsettled | he played | DNP |

Only the middle row is a DNP. The other two are provider coverage gaps.

This matters for CFB specifically because **SGO carries CFB games but not CFB player
box scores outside the playoff.** Moore's three populated games were Dec 21, Jan 1
and Jan 10; Madsen's single one was Dec 14. Every regular-season game from August
through November returned null for both. So on this sport the bug does not fire
occasionally, it fires on roughly 90% of games.

### The fix

`lookupPlayerStat` returns a discriminated `StatLookup` instead of `number | null`,
and **the discriminator is computed from the event rather than assumed**: does this
period carry player-keyed entries for anyone on the event roster? None means no box
score exists and no conclusion about any individual can be drawn from it. Entries
for others but not this player is a genuine absence.

Deriving it rather than hardcoding what a CFB results object looks like means the
check keeps working when a provider changes shape, which is the failure mode behind
`visitor_team`/`away_team` (v2.0.3) and the third `away_record` variant (v2.6.6).

Consequences:

- Coverage gaps are excluded from the play-rate **denominator** entirely. Missing
  data says nothing either way about whether a player was on the field.
- A new `UNKNOWN` availability flag covers the case where nothing is measurable. A
  naive fix would have returned `OK` here, which is a false all-clear on exactly the
  players you cannot verify. Pinned in a test.
- `PROVIDER COVERAGE GAP` is surfaced explicitly, with the split between the two
  kinds, rather than being silently absorbed.
- `gamesWithData` joins the availability block so the denominator is visible instead
  of inferred.

Genuine bench players still flag `IRREGULAR`. That path is pinned too, because the
value of the flag is entirely in its real catches — Bobby Witt Jr. at 15 of 28,
Napheesa Collier at 8 of 21, Brittney Sykes at 1 of 9.

---

## 2. "This is all the data that exists" was not true

The same investigation was sent down a wrong path for two rounds by this string:

> `The team's available history is exhausted. This is all the data that exists.`

It fires whenever the scan ceiling was **not** reached. That was correct when
v1.2.0 controlled cost with an **event ceiling**, where falling short really did
mean the history had run out. **v2.6.1 replaced the ceiling with a sized window and
did not revisit the message.** Ever since, a window that simply did not reach far
enough has been reported as an absence of data.

The empty NFL and CFB samples on 2026-08-31 were read as "SGO holds no prior
season". Widening the window to its 400-day ceiling returned the entire 2025 season
for both.

This is the pattern v2.6.0 named exactly: *the fixes were correct, the audits were
scoped to the file the symptom appeared in.*

The message now names the window, distinguishes a window limit from a coverage gap,
and says which knob moves it.

---

## 3. `includePriorSeason` — the opening-weeks window

### The measurement

`tkb_screen_props` on the NFL Week 1 opener, 2026-08-31:

```
70 priced markets screened. 0 qualified.
```

Identical in shape to the CFB Week 0 failure that produced `tkb_get_prop_board` in
v2.6.4: a full board discarded at the last step and reported as an answer.

`sizeLookbackWindow` gives an NFL position player 173 days, sized to hold the ~23
team games the role needs. That is right in November and useless in Week 1, because
173 days before a September opener is mid-March — empty offseason. All it catches is
three preseason games in which the starters sat.

Widened, the same players return real samples. Jaxon Smith-Njigba: **14 of 21** on
receiving yards over 84.5, `sampleSufficient: true`.

### Why it is one flag and not two numbers

Raising `lookbackGames` alone is silently clamped by the `position_player`
`defaultMaxScan` of 30, capping the window at **225 days**. 225 days before a
September opener lands in January: it catches the **playoffs** and misses the entire
regular season, while looking like it worked. A boolean cannot be half-applied.
Pinned in a test that asserts the 225-day trap specifically.

### Both bounds, on both paths

Easy to miss, and missing it would have made the flag inert exactly where it is
needed: **BDL is the primary rate source for MLB and NFL**, so widening only the SGO
fallback would never fire on the path that actually serves. The BDL window has two
independent bounds — `lookbackDays` defaults to 75 and `seasons` defaults to the
current season alone — and widening only the days would still ask the 2026 season
for games it has not played. `priorSeasonBdlLookback()` moves both.

Every widened board announces itself in the routing line, and every rate carries the
prior-season warning. **Take the flag off around Week 5**: cost roughly doubles once
a 400-day window holds two seasons, and per `seasonBoundary.ts` current-season form
overtakes prior-season form four to six games in. Same deadline, two independent
reasons.

### Cost

Measured, not projected. A 400-day NFL window returns **26 events per team**, versus
the 23 the default window is sized to hold. You are relocating the window, not
deepening the scan.

| | Per team | Per game |
|---|---|---|
| NFL, 173d default | 3 | 6, and unusable |
| NFL, 400d widened | 26 | ~52 |
| MLB in-season, measured v2.6.x | ~28 | ~56 |
| CFB, 400d widened | 14–15 | ~30 |

A widened NFL screen costs about what an MLB screen costs today. A full 16-game
Week 1 slate is roughly 830 entities against a 100,000 monthly cap.

**One caution.** The history cache key includes both date bounds, day-bucketed, so a
400-day call and a 173-day call on the same team are *different keys* and the
depth-upgrade path never sees them. Mixing window sizes on one team in one night
pays for both fetches. Widen consistently per sport per night, or not at all.

---

## 4. CollegeFootballData as the CFB rate source

SGO has no CFB player box scores outside the playoff. BALLDONTLIE gates NCAAF player
stats behind GOAT. So CFB has had no rate source at all, which is why
`tkb_screen_props` returns an empty board on a full CFB market.

CFBD's free tier covers player statistics. New: `services/cfbdClient.ts`,
`services/cfbdStatMap.ts`, `services/cfbdHitRateAggregator.ts`, and the probe below.

### The call budget is the whole design

Free tier is **1,000 requests a month** (3,000 on a verified `.edu` key), which
sounds impossible against a 392-game season and is not, because `/games/players`
accepts **year + week with no team filter** and returns every player's box score for
every game that week in **one request**.

| | Requests |
|---|---|
| Full 2025 season backfill | ~16, once, ever |
| In-season weekly refresh | 1 per week, ~14 a season |

The failure mode is the naive shape — per game, or per player, from inside the
thread builder — which is 392+ a month and gone in a week. **The client fetches by
week and never by game or player**, and every consumer reads the week cache.

Caching is **permanent, not TTL'd**, which is the deliberate difference from
SGOClient's 15-minute history cache: a completed week's box scores are immutable, so
re-fetching one can only spend budget to receive identical bytes. Only the current
week gets a short TTL. `seedWeek()` exists so a prior season can ship in the repo as
data (alongside `data/cfbStadiums.ts`) and cost zero requests forever — which also
sidesteps Render's ephemeral filesystem, where a runtime backfill would silently
re-run on every cold start.

`tkb_get_api_usage` now reports CFBD requests, hits, misses and coalesced fetches.
The stakes are higher than the SGO counters: an unnoticed miss loop here costs a
month, not sixty seconds.

### CFB refuses rather than falling back

`dataSource: "auto"` on CFB routes to CFBD, and **a missing `CFBD_API_KEY` returns a
refusal instead of falling through to SGO**. Falling back would not degrade cost, it
would manufacture a wrong answer — those empty games are precisely what produced the
0.2 play rate in section 1. An unanswerable question gets a refusal, not a plausible
answer.

The server still boots without the key. Every other tool is unaffected.

---

## 5. `tkb_debug_cfbd_stats` — run this first

CFBD's OpenAPI schema pins the box-score **structure** exactly:

```
teams[] -> categories[]{name} -> types[]{name} -> athletes[]{id,name,stat}
```

…and then types `categories[].name` and `types[].name` as **bare strings with no
enum**. So the schema guarantees the nesting and guarantees nothing about the
literals, which are the one thing a mapping depends on.

This repo has been burned by guessed provider literals three times: the `p_k`
batting/pitching collision (v2.0.1), `visitor_team`/`away_team` (v2.0.3), and the
third `away_record` variant (v2.6.6). All silent.

So `cfbdStatMap.ts` ships **candidate arrays** rather than single guesses, reports
which literal matched, and returns `null` — never `0` — when nothing resolves.
`tkb_debug_cfbd_stats` prints the literals the provider actually uses and resolves
every mapped statID against a real athlete.

**Run it once after deploy, before any CFB thread uses a CFBD number.** If a stat
reports `matched: null`, add the real literal to the candidate array. Add, never
replace.

### Two hazards this shape creates

**`YDS` is not unique.** It appears under passing, rushing *and* receiving. Matching
a type without its category would resolve a receiver's prop to a quarterback's
passing yards — the `p_k` collision on a bigger surface. Every entry is keyed on the
`(category, type)` **pair** and there is no code path that matches a type alone.

**`stat` is a string, and some are compound.** `C/ATT` arrives as `"24/35"`.
`Number("24/35")` is `NaN`, and anything coercing `NaN` to `0` reports a quarterback
who threw 35 times as having thrown 0. Compound fields are parsed by index and
refuse rather than guess.

---

## Tests

**30 new, suite now 121.** Both bugs are pinned with the real cases that exposed
them, not invented fixtures.

`assessAvailability` is now exported, for the reason v2.6.1 learned the hard way and
v2.6.3 restated: logic that changes which data reaches the user is correctness
logic, and burying it inside a function that needs an API client makes it
unassertable. The 91-test suite passed against the broken v2.6.0 window for exactly
that reason.

**Mutation-tested:**

| Mutation | Result |
|---|---|
| Count a coverage gap as a DNP again | 2 tests fail |
| Match a CFBD type name without its category | 4 tests fail |
| Let a partial composite sum through | 1 test fails |

---

## Deploy

`tsconfig.json` is unchanged and deliberately not included.

1. Copy `src/`, `test/`, `docs/`, `package.json`, `README.md` over the repo.
2. **Add `CFBD_API_KEY` to the Render environment**, alongside `SGO_API_KEY` and
   `BDL_API_KEY`.
3. `npm test`. **121 passing.**
4. Commit, let Render redeploy.
5. `node scripts/verify-deploy.mjs --expect 2.7.0`

Then, in this order, because each one gates the next:

6. `tkb_debug_cfbd_stats year=2025 week=1 team="Oregon"` — read the real category and
   type literals. **Do not skip this.** If any mapped stat reports `matched: null` on
   a player who plainly recorded it, fix the candidate array before going further.
7. `tkb_get_player_hit_rate sport="cfb" teamID="Oregon" playerName="Dante Moore"
   statID="passing_yards" line=250.5 direction="over" includePriorSeason=true` —
   should now return a real 2025 sample, and **must not** report a 0.2 play rate.
8. `tkb_screen_props` on an NFL Week 1 event with `includePriorSeason=true` — should
   return a populated board where it returned 0 of 70.

---

## Still open, carried forward

- **The 2025 backfill is not shipped in this build.** `seedWeek()` is in place and
  the client fetches weeks on demand, so CFB rates work as soon as the key is set,
  but a cold start re-fetches. ~16 requests a season is affordable; committing the
  season as repo data makes it zero and removes the Render cold-start question
  entirely. Worth doing once the literals from step 6 are confirmed.
- **`preferredBookmakers` is still not passed by the nightly prompts.** Open since
  v2.5.3, three releases. Still one argument in three scheduled tasks.
- **CFBD availability is genuinely weaker than SGO's.** CFBD lists a player only in
  categories where he recorded a stat, so absence cannot distinguish "did not play"
  from "quiet game". The aggregator returns `UNKNOWN` and says so rather than
  guessing. Depth-chart confirmation stays manual for CFB.
- **Period codes remain unverified** for halves and quarters.

---

# v2.7.1 — the new CFB path shipped without its most important label

**Found by the first live run of v2.7.0, minutes after deploy.** Exactly what the
verification pass in section 5 exists for.

## What v2.7.0 returned

The regression check passed loudly. Dante Moore went from `3 of 15, playRate 0.2,
IRREGULAR` to:

```
gamesConsidered: 15,  gamesExcludedDNP: 0,  playRate: 1
```

Fifteen real 2025 games, eight over 250.5. The section 1 bug is fixed.

And then, in the same response:

```
seasonWarning:        null
priorSeasonGames:     0
seasonsRepresented:   []
crossesSeasonBoundary: false
```

Every one of those fifteen games is from 2025, read on 2026-08-31. The
prior-season warning — the single most important label on a CFB sample, because in
the opening weeks **every** CFB sample is prior-season by construction — was
silent.

## Why

`/games/players` returns a bare numeric game id and nothing else identifying the
game. No date, no kickoff, no calendar position. The aggregator stamped its log
with a synthetic `"2025-W7"` string built from the loop counter.

`seasonForDate` does `new Date("2025-W7")`, gets `Invalid Date`, returns null. So
`summarizeSeasons` received fifteen dates it could not parse, counted zero of them,
and correctly reported that nothing crossed a season boundary. The guardrail did
exactly what it was told; it was told nothing.

**This is bug-for-bug identical to v2.0.2 on the BDL path**, whose changelog records
the same three consequences from the same cause: no sorting, no recency, and a
season-provenance guardrail that "stayed silent while the contamination it was built
to catch was happening." BDL's MLB stat rows also carried a bare `game_id`.

The synthetic label was wrong on its own terms too: postseason games were pushed as
`week: 1`, so three playoff games rendered as `2025-W1` alongside the actual Week 1.

## The fix, which is also v2.0.2's fix

`/games?year=Y` returns `id`, `season`, `week`, `seasonType`, `startDate` and
`completed` for every game in a season. **One request, cached permanently**, joined
to the box scores by game id. The log now carries real ISO dates, sorts newest-first
like every other path in this repo, and both guardrails have something to key on.

Cost: one request per season, on a budget where a full backfill is ~16.

**And a hard refusal**, per the rule v2.0.2 set: if stat rows resolve but not one
matches a date, the aggregator throws rather than returning a rate. An unsortable
sample is not a recent-form hit rate, and returning one anyway is the precise
failure this connector exists to prevent.

## The lesson, again

v2.7.0 built a new provider path and reused `summarizeSeasons` and `describeRecency`
deliberately, on the grounds that they encode hard-won rules. That was right. What
it missed is that **both of those are date-keyed, so reusing them without supplying
real dates buys the API and not the protection.** A guardrail with no input does not
fail loudly; it returns a clean result.

## Tests

3 new, suite now **124**. Built from the actual failing response.

**Mutation-tested:** restoring the synthetic `${year}-W${week}` label fails all
three.

## Deploy

1. Copy `src/`, `test/`, `docs/`, `package.json`, `README.md`.
2. `npm test`. **124 passing.**
3. Commit, redeploy.
4. Re-run the CFB regression from section 6. It must now return
   `crossesSeasonBoundary: true` and a populated `seasonWarning`, alongside the
   `playRate: 1` that v2.7.0 already fixed.

---

# v2.8.0 — confirmed starters and posted lineups, from MLB directly

One tool added (**26**). No existing path changed. No key, no quota, zero SGO
objects consumed.

## The gap this closes

The README has said since v2.6.4 that SGO events carry no `lineups` field, confirmed
live via `tkb_probe_event_fields`, and that **"confirmed starting pitchers still
require a live web search, per game, per date."** That rule exists because a Chris
Sale rotation shuffle produced a published error.

`statsapi.mlb.com` carries both, unauthenticated and unmetered. Verified before
building:

| | Verified |
|---|---|
| Probable pitchers | Populated for games ten hours out |
| Lineups | `lineups.homePlayers[]`, nine entries, **in batting order** |
| Batting slot | Array position, so index 0 is leadoff |
| Auth / quota | None of either |
| 2026 coverage | statsapi's Aug 31 slate matches SGO's exactly |

That last row was the blocker and it cleared. If statsapi's 2026 view had not matched
SGO's, the whole feature would have been dead regardless of build quality.

## The timing finding, which changes how this gets used

**The two fields have different availability windows, and confusing them would
produce a false all-clear worse than the manual search it replaces.**

- **Probable pitchers**: available days ahead. Works at build time today.
- **Lineups**: post roughly 3 to 4 hours before first pitch. Before that the field
  exists and is EMPTY.

**The 10 PM Pacific MLB job cannot confirm a lineup.** It builds threads for the
following day, whose first pitches are 17 or more hours out. The 3:45 AM prop fill
pass is too early for the same reason.

So an empty lineup means *not posted yet*, never *he is not playing*, and the tool
says which of the two it is rather than returning an empty array a caller could read
either way. Pinned in a test, and mutation-tested.

Practically: use it for **probable pitchers at build time**, and run it again in a
**late pass close to first pitch** to confirm a lineup before publishing a hitter
prop. That late pass does not exist yet as a scheduled job.

## Batting order slot

Carried because it is the reasoning sentence, not decoration. A leadoff hitter gets
roughly 0.7 more plate appearances per game than a seven-hole hitter, which is most
of the edge on a 0.5 hits or 1.5 total bases line. The tool states the direction
explicitly for top, middle and bottom of the order, so a bottom-third slot reads as
the headwind it is rather than as neutral colour.

Taken from `lineups.homePlayers` array position rather than the boxscore's
per-player `battingOrder` string, which encodes slot-plus-substitution ("102" is the
second player to bat leadoff) and only populates once a game is underway.

## Two things deliberately NOT built

**Batter vs pitcher.** The endpoint exists and needs no key. Measured 2026-08-31:
Aaron Judge against Clayton Kershaw returns **two career plate appearances**. That is
the typical BvP sample, not an unlucky draw. This connector's floor is eight
appearances and its own words are *"a rate on 1 game is NOT a hit rate and must not
be quoted as one."* Shipping BvP would be the first thing in the codebase to
contradict its own sample-sufficiency rule, and it is the most abused stat in betting
content precisely because it reads as authoritative.

**Home plate umpire.** The assignment is real: boxscore `officials[]` carries
`officialType: "Home Plate"`, verified on a final game. But it is **absent from a
scheduled game's boxscore**, so it arrives too late for a pre-game thread. And an
assignment is not a tendency: "this umpire runs high on strikeouts" requires a season
aggregated per umpire, which is its own project. Parked, not rejected.

## Tests

10 new, suite now **134**.

**Mutation-tested:**

| Mutation | Result |
|---|---|
| Treat an unposted lineup as a populated one | 1 test fails |
| Number the batting order from 0 | 2 tests fail |

## Deploy

1. Copy `src/`, `test/`, `docs/`, `package.json`, `README.md`.
2. No new environment variable. There is no key.
3. `npm test`. **134 passing.**
4. Commit, redeploy.
5. `tkb_get_mlb_matchup date="<today>"` — starters should be named for every game.
   Lineups will read NOT POSTED unless you run it within about 4 hours of first pitch.
6. Run it again close to first pitch on one game and confirm the lineup populates with
   nine slots. That is the check that proves the timing behaviour, and it cannot be
   done at build time.

---

# v2.8.1 — the new tool answered a question it had never checked the premise of

**Found by live verification of v2.8.0, before anything used it in a thread.** No
tools added or removed. Still 26.

## The two bugs, which are one bug

**1. Off-day false positive.** Asking for Mookie Betts on 2026-08-31 returned:

```
LINEUP NOT POSTED YET for 2026-08-31. This is NOT evidence that "Mookie Betts"
is out - nothing has been announced.
```

The Dodgers were not on that slate. There was no lineup coming, because there was no
game. A job polling for it would have waited forever.

**2. No name validation.** `"Zzzz Notaplayer"` returned the identical message, the
name echoed back entirely unchecked.

**The root cause is the same for both: v2.8.0 validated the LINEUP STATE and never
the PREMISE.** It asked "is any lineup posted for these games", found none, and
reported "not posted yet" without ever establishing that the player existed or that
his team was playing.

**The asymmetry was the tell**, and it is worth naming because it will recur. Once a
lineup IS posted the tool hedged carefully on spelling, because a posted lineup gave
it a roster to check against. Before one was posted it had nothing to check against,
and *absence of a way to verify became absence of doubt*. That inversion is the thing
to watch for: the branch with the least information was the branch that sounded most
certain.

This is the same family as every other bug in `docs/`: calm, plausible, wrong, with
no guardrail firing. The v2.8.0 changelog argued at length that an empty lineup must
never read as a scratch. It got that direction right and missed the other one
entirely.

## The fix

`/sports/1/players?season=YYYY` returns every player with `currentTeam`, in one
unauthenticated call, cached for twelve hours. That turns one guess into four
distinguishable answers, resolved **in this order**, because each later question is
only meaningful once the earlier one holds:

| State | Answer |
|---|---|
| Name matches nobody | NO SUCH PLAYER. A name problem, not a lineup problem |
| Name matches several | AMBIGUOUS. Refuses, per the v2.0.1 "Marte" rule |
| Found, team not on the slate | TEAM NOT PLAYING. No lineup to wait for |
| Found, team playing, lineup empty | LINEUP NOT POSTED YET, naming the opponent |
| Found, lineup posted, absent | NOT IN THE POSTED LINEUP. A real scratch |

`resolvePlayerLineupStatus` is **exported and pure**, for the reason v2.6.1 learned
the hard way and v2.6.3 restated: logic that changes which answer reaches the user is
correctness logic, and burying it inside a function that needs a network client makes
it unassertable.

**If the player index is unavailable, the tool REFUSES rather than falling back.**
Degrading to v2.8.0's behaviour would restore the exact bug, and "lineup not posted
yet" is indistinguishable from an off day or a misspelling. A refusal that names the
reason is the correct failure.

The player question now resolves against the **full slate** rather than the
team-filtered subset, so a team that is playing but excluded by a filter cannot read
as "not scheduled".

## The guardrail now reaches machine readers

Verification found that all the protective prose lived on the `playerName` branch.
The slate path returned `lineupsPosted: false` plus two bare empty arrays, so
anything consuming JSON rather than text got no warning at all, and an empty array is
precisely the shape that reads as "nobody is playing".

`lineupStatus` and `lineupStatusNote` are now fields on every game. A consumer that
never reads a word of prose still cannot mistake "not announced" for "not playing".

## On `null` versus `"TBD"`

Verification flagged that an unknown starter comes back `null` in JSON while the
rendered text says TBD. **The null stays.** Substituting a magic string into a typed
field is the exact class of thing the "null, never 0" rule exists to forbid.

But a consumer should not have to infer meaning from a null, so
`awayProbablePitcherStatus` and `homeProbablePitcherStatus` now state it explicitly
as `"confirmed"` or `"tbd"` alongside the nullable object. Unambiguous signal, honest
null.

## Also confirmed working

Verification found two genuinely TBD starters ten hours before first pitch. That is
not a defect, it is the tool doing its job on exactly the case the per-game starter
rule was written for.

## Tests

10 new, suite now **144**. Built from the two real failing queries.

**Mutation-tested:**

| Mutation | Result |
|---|---|
| Skip the team-scheduled check (restore the off-day bug) | 2 tests fail |
| Skip the name-exists check | 2 tests fail |

## Deploy

1. Copy `src/`, `test/`, `docs/`, `package.json`, `README.md`.
2. No new environment variable.
3. `npm test`. **144 passing.**
4. Commit, redeploy. Confirm 26 tools and version 2.8.1 (append `?cb=` to `/health`,
   which was verified to defeat the cache the v2.6.6 note said it could not).
5. The three checks that matter, all of which failed or were absent before:
   - a player whose team is NOT on today's slate should say TEAM NOT PLAYING
   - a nonsense name should say NO SUCH PLAYER
   - the plain slate call's JSON should carry `lineupStatus` and `lineupStatusNote`

---

# v2.8.2 — the fix for the confident wrong answer was a confident wrong answer

**Found in live testing of v2.8.1, within minutes of deploy.** No tools added or
removed. Still 26.

## What broke

v2.8.1's own verification steps passed. Mookie Betts on an off day returned
`team_not_scheduled` instead of the old `lineup_pending`. A nonsense name returned
`player_unknown`. Both regressions from v2.8.0 were fixed.

Then a control case that was not on the checklist:

```
tkb_get_mlb_matchup date="2026-08-31" playerName="Matt Olson"
-> {"kind":"team_not_scheduled","teamName":"unknown team"}
```

The Braves were playing that night. Olson is their first baseman.

**Every player in the league returned `team_not_scheduled`.** Betts only looked
correct by accident, because the Dodgers genuinely were off. The `"unknown team"`
string was the tell and it was in the v2.8.1 output all along.

## Why

v2.8.1 matched a player to a game by team NAME, read from the player index's
`currentTeam.name`. Checked against the live endpoint after the failure:

| Season | `currentTeam` |
|---|---|
| 2025 | `{"id": 144, "name": "Atlanta Braves"}` |
| **2026** | **`{"id": 144}`** |

For the current season that field carries an id and no name. So `teamName` was null
for everyone, no game ever matched, and the resolver fell to its "not scheduled"
branch for the entire league.

**This is the v2.8.0 bug inverted.** v2.8.0 said "lineup not posted yet" when the
team was off. v2.8.1 said "team not playing" when the team was on. One confident
wrong answer traded for another, in the opposite direction, by a change written
specifically to stop confident wrong answers.

And the cause is one I have written about twice in this file already: I read
`currentTeam.name` because a spot check said it was there. It was there **for the
season I spot-checked**. The same class as `p_k`, as `away_record`, as the synthetic
CFBD week label. Verifying a provider field once is not the same as verifying it
holds where the code will actually run.

## The fix

**Match on team ID, not team name.** The numeric id is present on both sides, is
stable across seasons, and needs no fuzzy matching. `MlbGameMatchup` now carries
`homeTeamId` and `awayTeamId` from the schedule, and the resolver joins on those.
Names survive for display and as a fallback for a feed that omits the id instead.

That also deletes a whole category of risk: the name path needed
`teamNamesMatch` to reconcile "Athletics" against "Oakland Athletics" across two
providers. Ids do not care.

## A fifth state

`team_unresolved`, for a player the index returns with neither an id nor a name.
v2.8.1 answered that case with `team_not_scheduled`, which is the same mistake in
miniature: not being able to place someone is not evidence his team is off. One
existing test asserted the old, weaker expectation and was updated rather than the
code, because the old expectation was wrong.

## Tests

5 new, suite now **149**. Fixtures now reflect what the 2026 index actually returns:
a team id and **no** team name. Assuming the name would be there is what broke this.

**Mutation-tested:** removing the ID match so it falls back to names, exactly as
v2.8.1 behaved, fails 3 tests.

## The lesson worth keeping

Three releases in a row, the same shape: a fix that was right about its own case and
wrong about the case next to it. v2.8.0 checked the lineup and not the premise.
v2.8.1 checked the premise using a field that only exists in some seasons. Each
passed its own verification steps because the steps were written from the same
understanding that produced the bug.

**The control case is the one that finds this.** Not "does the failure case now
fail correctly", but "does the SUCCESS case still succeed". v2.8.1 was verified
entirely on inputs expected to return warnings, and every one of them did.

## Deploy

1. Copy `src/`, `test/`, `docs/`, `package.json`, `README.md`.
2. `npm test`. **149 passing.**
3. Commit, redeploy, confirm 2.8.2 via `/health?cb=`.
4. **Run the control case first**, before any failure case:
   `tkb_get_mlb_matchup date="<today>" playerName="<a hitter whose team plays today>"`
   It must return LINEUP NOT POSTED YET naming his real team and opponent. If it says
   TEAM NOT PLAYING, the join is broken again.
5. Then the failure cases: a player on an off day, and a nonsense name.
