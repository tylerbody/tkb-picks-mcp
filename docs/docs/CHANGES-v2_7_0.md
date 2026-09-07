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
