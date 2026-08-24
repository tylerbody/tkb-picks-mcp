# v2.6.0 — tennis moneyline, three cost bugs, and the first tests

Two new sports, three live entity-cost fixes, a test suite, and a deploy script.
No tools added, removed, or renamed. Still 19.

---

## 1. Three cost bugs, all the same class

Each one is a bug this repo has already found and fixed **somewhere else** and
not carried across. That is the pattern worth naming: the fixes were correct, the
audits were scoped to the file the symptom appeared in.

### 1a. Concurrent identical fetches were not deduplicated

`screenProps`' `availabilityFor` reads its team map, awaits a probe, then writes:

```ts
let team = availabilityByTeam.get(teamID);
if (!team) {
  team = await probeTeamAvailability(...);   // three workers can all be here
  availabilityByTeam.set(teamID, team);
}
```

`HIT_RATE_CONCURRENCY` is 3, so up to three workers miss the same key before any
writes. Each fires an identical 30-event team-history fetch. A two-team game
could pay for six probes instead of two, roughly **60 wasted entities per
screened game**.

The `historyCache` in `SGOClient` does not help: it also only writes after the
fetch resolves, so simultaneous identical calls all miss it and all get billed.

**This is precisely the race v2.4.0 fixed for `rateCache`**, by storing the
in-flight promise rather than the resolved value. That fix stopped one function
short. The comment explaining it sits forty lines above the code that still had
the bug.

**Fixed at the client layer, not in `screenProps`.** v1.2.0 put the history cache
in `getAllEvents` so every caller would benefit from one change; the same
argument applies here, and it closes the hole for `splitsAggregator`,
`hitRateAggregator` and every future call site simultaneously.

Only cacheable (finalized) keys coalesce. Live and non-finalized queries still
hit the network every time, unchanged.

### 1b. `maxPages` over-fetch on the two most expensive paths

v2.4.1 established that **`limit` is the per-page size**, not a total, and that
`maxPages` defaults to 10. It fixed the availability probe with `maxPages: 1` and
did not audit anything else. Both remaining offenders were on the paths that cost
the most:

| Call site | Asked for | Could actually pull |
|---|---|---|
| `hitRateAggregator` (position player) | 30 team games | up to 300 |
| `hitRateAggregator` (pitcher) | 140 team games | clamped to 100/page, then 10 pages |
| `splitsAggregator` (both calls) | 100 events | up to 1,000 |

The hit-rate window is **400 days**, which for an MLB club holds well over 200
finalized games, so the cursor kept returning pages.

**Fixed by making the parameter mean what every caller already assumed.**
`getAllEvents` now takes `maxEvents` as a genuine total and stops paging when it
is reached. Passing `maxPages` at each call site would have worked and would have
been forgotten again by the next person to add a caller.

Note SGO caps `/events` at 100 per page, so `limit: 140` was already being
clamped upstream and then paged — which is exactly how a 140-game pitcher scan
became an unbounded crawl. Page size is now clamped explicitly in code so the
behaviour is visible rather than happening silently in the API.

### 1c. The cache recorded page size, not events held

```ts
depth: requestedDepth,   // was params.limit
```

Combined with 1b, cached entries routinely held far more events than their own
`depth` claimed. The consequence was a spurious refetch on a constant path:

A position-player rate (`limit: 30`) and a pitcher rate (`limit: 140`) on the
same team **share a cache key** — same league, same team, same 400-day date
bucket, same `oddIDs`. The pitcher request failed `depth >= requested`, counted a
depth upgrade, and refetched a team history the cache very likely already held in
full. Every MLB thread has at least one pitcher prop and several hitter props, so
this fired roughly once per team per screen.

Now stores `Math.max(allEvents.length, ceiling)`. `events.length` is the honest
measure of what an entry can serve.

### Observability

`tkb_get_api_usage` now reports **coalesced** alongside hits, misses and depth
upgrades. Same reasoning as every other counter here: a saving you cannot observe
is a saving you are assuming.

---

## 2. Tennis, moneyline only

ATP and WTA added to `SPORT_CONFIG`. Because `SportKey` is derived from that
object, TypeScript then refused to build until all four `Record<SportKey, ...>`
tables were filled in. **That compiler error is the feature** — there is no way to
add a sport and silently forget a table.

### What needed no code at all

- `buildOddID` already accepts `betType: "ml"`. The oddIDs are
  `points-home-game-ml-home` / `points-away-game-ml-away`, exactly what
  `tkb_get_odds` already constructs for moneyline.
- `tkb_get_schedule` needed only description changes. Every CFB branch is gated
  behind `sport === "cfb"`, and the `teamName` filter reads
  `teams.home.names.long`, which for tennis is the player name.
- `tkb_grade_pick` and `tkb_grade_slate` grade moneyline entirely off
  `teams.home.score` / `away.score`, never touching `OU_PROP_MARKETS`. If SGO
  populates participant scores for tennis, **grading works with zero changes**.
- `extractPricedLine` is sport-agnostic, so the fair-odds guardrail and the
  pick'em/Fliff blocks apply to tennis automatically. This matters more than it
  sounds: early-round slam matches are exactly where books are slowest to post,
  so "NOT YET PRICED BY ANY SPORTSBOOK" is doing real work rather than being an
  edge case.

### Capability flags, and why they exist

Adding tennis widened **every** tool's sport enum at once. Six tools would then
have accepted `sport: "atp"` and returned something confidently useless:

| Tool | What it would have done |
|---|---|
| `tkb_get_game_weather` | fallen through to the CFB branch and searched `CFB_STADIUMS` for a player's surname |
| `tkb_get_players` | returned "props not posted yet, retry closer to first pitch" — false, and an invitation to retry forever |
| `tkb_get_player_hit_rate` | skipped BDL, gone to the SGO path, which needs a teamID and playerID tennis does not have |
| `tkb_get_team_split` | tallied SGO events and produced a number with no meaning |
| `tkb_screen_props` | returned "No countable markets for atp. Available: " with nothing after the colon |
| `tkb_get_injuries` | built `/atp/v1/injuries` and failed opaquely |

Every one is a **plausible-looking wrong answer rather than a clear refusal**,
which is the exact failure class this connector exists to prevent.

`SPORT_CONFIG` now carries a `supports` block per sport, and each affected tool
checks it and returns an explanation naming the reason. "Not supported" invites a
retry; "tennis competitors occupy the home/away participant slots rather than
roster positions, so this is permanent" does not.

Declared in one table rather than branched per tool, for the same reason
`standingsNormalizer` resolves aliases instead of branching on sport: a scattered
`if (sport === "atp")` breaks again the moment NBA or NHL arrives. Adding a sport
later is a row, not an audit.

The flags also record two pre-existing gaps that were previously only prose:
WNBA has no weather (indoors), CFB has no injuries (not on the current BDL plan).

### For whoever adds tennis totals later

Match winner settles on `points`, which in tennis carries the **set score**.
Games totals and handicaps settle on `games`, the **game count**. Requesting
`points-all-game-ou-over` when you meant a games total is, per SGO's own docs,
the most common tennis integration mistake. Moneyline is unaffected, which is why
`buildOddID` needs no tennis special-casing today. Set period codes `1s` through
`5s` are added and ready.

### Two things to verify live before trusting any of it

Both are inferences from SGO's documentation, not observations:

1. **Do tennis events populate `teams.home.names.long` with player names?** If
   not, schedule output and the `teamName` filter degrade to raw IDs.
2. **Do finished tennis events populate `teams.home.score` / `away.score`?** This
   is the entire grading path.

If both hold, tennis grading moves off web scraping entirely. The results
workflow currently records tennisexplorer returning an impossible 6-5 set score,
finished matches rendering as "Upcoming" with zeroed stats, and atptour.com
serving 2024 data behind a 403. Grading from the same feed you priced from
removes all of it.

---

## 3. Tests (`npm test`)

**39 tests, no network, no API keys, runs in about half a second.**

Every case was already worked out and confirmed by hand in a previous release,
and then existed only as prose in a markdown file. v2.5.2 verified nine
combo-stat cases, v2.5.3 six recency cases, v2.5.4 six more. Nothing stopped the
next edit from breaking any of them.

Covered: odds rounding and the 5-away-from-zero boundary, implied probability and
the Hoerner negative-edge case, the Underdog flat-price case, `p_k` versus `k`,
total-base derivation and its refusal on inconsistent rows, WNBA combo sums
including the all-zero case, the four verified recency cases (Sasaki clean,
Bassitt stale, Sykes stale, Collier clean), NFL January season attribution, oddID
shapes, X character weighting, and a completeness check that every sport has
every catalog table.

**Mutation-tested before shipping.** Adding `"k"` back to the pitcher strikeout
resolver — the exact regression the comment there warns against — fails the suite.
The protection is now a wall rather than a request.

### One documentation discrepancy found while writing them

The style guide says `-113 → -115`, which contradicts its own stated rule
("0-4 rounds toward zero"). Nearest ten from -113 is **-110**, which is what the
code produces. Treated as a typo in the guide rather than changing working code,
and pinned in a test so the decision is recorded rather than re-argued later.

---

## 4. `/health` now carries evidence, not just a claim

The version string has been wrong three times: 2.0.1–2.0.3, 2.5.2 vs 2.5.3, and
again at 2.5.4 where the deployed repo still declared 2.5.3.

v2.5.4's one-constant fix solved "two copies in one file disagree." It did not
solve "someone has to remember to edit the constant," which is the failure that
keeps recurring.

`/health` now returns `toolCount`, `tools` and `sports`, all read off a real
server instance at request time. These cannot go stale independently of the code.
If the version says 2.5.3 but `sports` contains `atp`, the build is new and only
the string was forgotten — diagnosable in one curl instead of a debugging cycle.

`package.json` is also bumped to 2.6.0, having sat at 1.0.0 since the beginning.

---

## 5. `scripts/verify-deploy.mjs`

Replaces the manual `DEPLOY-CHECK.md` routine. Checks `/health`, compares its
tool count against `tools/list`, confirms the tennis capability guard actually
refuses, and — with `--screen <eventID>` — measures the **entity delta** of one
screen.

That last number is the one that has silently regressed twice. Reading it at
deploy time is the difference between catching a cost regression in thirty
seconds and catching it at the quota wall mid-slate.

```bash
node scripts/verify-deploy.mjs --expect 2.6.0
node scripts/verify-deploy.mjs --screen <mlbEventID>
```

Exits non-zero on failure, so it can gate a deploy.

---

## 6. Housekeeping

- **`README.md` rewritten.** It said v1.1.1, claimed 15 tools, and documented
  `tkb_get_futures`, `tkb_debug_raw_event` and `tkb_get_team_record`, all deleted
  in v2.0.0. It is the first file anyone opens.
- **Four orphaned files moved to `archive/tools/`**: `debugEvent.ts`,
  `debugInjuries.ts`, `futures.ts`, `teamRecord.ts`. None were imported by
  `index.ts`, but `futures.ts` instructed the reader to run `tkb_debug_raw_event`,
  a tool that no longer exists. **Delete these from `src/tools/` in your repo** —
  copying `src/` over will not remove them.
- **Stray character removed** from the `tkb_grade_slate` description, which read
  `Returns:每 pick graded`. That string is part of what the model reads when
  deciding how to call the tool.
- Changelogs moved into `docs/`.

---

## Deploy

`tsconfig.json` is unchanged and deliberately **not** included — keep yours.

1. Copy `src/`, `test/`, `scripts/` and `package.json` over the repo.
2. Delete `src/tools/debugEvent.ts`, `debugInjuries.ts`, `futures.ts`,
   `teamRecord.ts`.
3. `npm test` locally. 39 passing before you push.
4. Commit, let Render redeploy.
5. `node scripts/verify-deploy.mjs --expect 2.6.0`

Then the two things only live data can answer:

6. `tkb_get_schedule sport="atp"` — confirm player names populate
   `homeTeam`/`awayTeam` rather than raw IDs.
7. `tkb_grade_pick` on a finished ATP match, `marketType="moneyline"` — confirm
   scores settle.

If 6 and 7 both pass, tennis is live end to end and the web-scraping grading path
can be retired.

---

## Still open, deliberately

- **`preferredBookmakers` is still not passed by the nightly prompts.** Listed as
  a follow-up in both v2.5.3 and v2.5.4. It is not a code change — it is one
  argument in three scheduled tasks — and until it is done the entire v2.5.3 fix
  is inert and screens still rank against arbitrary books. Cheapest win available.
- **Period codes remain unverified** for halves and quarters. Only `1ix5` was ever
  confirmed against real data. With NFL and CFB both live this is now cheap to
  settle: pull a first-half moneyline and see whether the oddID resolves.
- **The MLB availability probe may not cover bench players** (the Ben Rortvedt
  case from v2.5.4). Unconfirmed, still worth a dedicated look rather than a
  guessed fix.
- **A market scorecard** feeding published results back into screening remains the
  highest-value remaining item, and still needs a longer tracker export before
  thresholds mean anything.

---

# v2.6.1 — the cost fix was wrong, found by live testing

**Caught within minutes of deploying 2.6.0, by running one real hit rate.**

## What broke

`tkb_get_player_hit_rate` on Spencer Torkelson, 24 Aug 2026, returned **fifteen
games all dated August 2025**. Every value correct, every date real, the whole
sample exactly one year stale.

## Why

v2.6.0 controlled cost with an **event ceiling** (`maxEvents`) against the
existing fixed 400-day window. But SGO's ordering for finalized events is
confirmed **not** to be most-recent-first — it is stated twice in this codebase's
own comments — so the window's first page is routinely its OLDEST games. Capping
the fetch at 30 events therefore truncated to the oldest 30, and the local
newest-first sort had nothing recent left to find.

This is the **same failure as the Alejandro Kirk case in v2.5.0**, reproduced on a
different path by a fix that was trying to save money.

## The rule that came out of it

> With untrusted API ordering, the WINDOW is the only safe cost control. A window
> bounds cost without changing which games are eligible. Anything that caps the
> fetch mid-window silently changes the answer.

v2.5.0 already stated this when it fixed the availability probe: *"recency comes
from the date bound rather than trusting API ordering."* v2.6.0 had the lesson
available and did not apply it.

## The fix

The 400-day fixed window is replaced by one **sized to the role and sport**, and
the fetch exhausts it rather than truncating:

| Case | Window | Team games it holds | Was |
|---|---|---|---|
| MLB batter | 30d | ~26 | 400d, up to 300 events |
| MLB pitcher | 94d | ~78 (≈16 starts) | 400d, up to 1,000 events |
| WNBA player | 60d | ~23 | 400d |
| NFL player | 173d | ~23 | 400d |

`maxEvents` survives only as a **safety valve set above what the window can
hold**, so it can never truncate. Cost control comes from the window, correctness
from exhausting it. Both goals met, which the ceiling approach could not do.

`splitsAggregator` had the identical latent bug — a 100-event cap against a
220-day window would have computed a home/road record from an arbitrary partial
season and presented it as complete. Ceiling raised above a full season.

## What the guardrails did

Worth recording, because they worked exactly as designed. The bad result arrived
carrying **two** loud warnings:

- `EVERY game in this sample is from a PRIOR season (2025)`
- `STALE SAMPLE: the most recent appearance was 369 days ago`

Neither is a data-integrity check — the data was internally perfect. Both are
context checks added in v2.0.2 and v2.5.3 specifically because "right values,
wrong story" is this connector's most common failure mode. They turned a silent
corruption into an obvious one.

## The testing lesson

`npm test` passed 39/39 against the broken build, because the window sizing lived
inline inside a function that needs a network client, so nothing could assert on
it.

`sizeLookbackWindow()` is now **exported and pure**, with six tests covering it.
**A cost change that alters which data comes back is a correctness change and
needs a test.**

Suite is now 45 tests.

---

# Live test results, 24 Aug 2026

Run against the deployed 2.6.0 build.

| Check | Result |
|---|---|
| `/health`, fresh process | PASS |
| `atp`/`wta` in every tool enum | PASS |
| Tennis capability guards refuse with reasons, zero quota | PASS |
| MLB schedule | PASS, 4 games |
| MLB roster and playerIDs | PASS, 8 players |
| MLB hit rate | **FAIL — one-year-stale window** (fixed in 2.6.1) |
| **ATP/WTA schedule** | **BLOCKED — subscription tier** |

## The tennis blocker is not code

```
The leagueID ATP is unavailable at your current subscription tier. Upgrade to unlock
```

Identical for WTA. **The tennis build is complete and correct, and cannot run on
the Rookie plan.** Nothing in the connector can work around this.

Before paying for an upgrade, confirm with SGO directly:

1. Which tier includes ATP and WTA. Their public pricing pages advertise per-tier
   object counts and bookmaker counts but do **not** publish a league-by-tier
   matrix, and third-party sources disagree on Rookie's price ($99 vs $149), so
   the tier list is not reliably knowable from outside.
2. Whether tennis events populate `teams.home.names.long` with player names.
3. Whether finished tennis events populate `teams.home.score` / `away.score`.

Questions 2 and 3 are the two live checks the tennis grading path depends on, and
they can be answered during a trial rather than after committing.

Everything else in the tennis build ships inert and harmless: the capability
guards return clean refusals, the empty catalogs stop the screener, and no other
sport is affected.

---

# v2.6.2 — prediction markets blocked, book filter now a default

Both found by running six real screens on the 2026-08-24 slate.

## 1. Polymarket was topping the board with a 33% prop

A Lynx/Valkyries screen returned this at **rank 1 of 6**:

> Courtney Williams OVER 4.5 Rebounds, **+3079**, priced by **polymarket**,
> counted hit rate **5 of 15 (33%)**, edge **30.2%**

Break-even at +3079 is 3.1%. Against a 33% rate that computes a 30-point edge, so
it sorted above five legitimate FanDuel props.

**Same mechanism as the Underdog case in v2.5.0.** A price that is not a
two-sided sportsbook market makes the break-even comparison meaningless, so edge
stops measuring value and starts measuring how strange the price is. Underdog
distorted by being flat at +100; Polymarket distorts by being enormous.

`polymarket`, `kalshi`, `predictit` and `manifold` now blocked in `oddsPricing`,
in their **own set** rather than folded into `PICKEM_APPS` — following the
reasoning v2.5.3 used to keep Fliff separate: the reason a venue is blocked
determines where it goes and what to expect from it.

- Pick'em apps distort by being **flat**
- Fliff is real but **unbettable for this audience**
- Prediction markets are genuine markets whose **contract pricing is not
  comparable to a sportsbook over/under**

Blocking at the pricing layer means no call site can source from them, including
`tkb_get_odds` on the mandatory re-pull.

**Exchanges deliberately NOT blocked.** ProphetX appeared six times in the same
sweep at -139, -161, +124 and similar — realistic two-way prices that do not
corrupt the maths. It is also a TKB affiliate partner, so blocking it outright
here would be the wrong call to make silently. It is excluded from screening by
the bookmaker default below, which is a ranking decision rather than a
correctness one.

## 2. `preferredBookmakers` now defaults instead of being remembered

**Measured across 6 MLB games, 55 props, no filter:**

| Book | Props | Bettable |
|---|---|---|
| draftkings | 37 | yes |
| hardrockbet | 6 | no |
| prophetexchange | 6 | exchange |
| espnbet | 3 | no |
| bovada | 2 | no |
| fanduel | 1 | yes |

**Only 69% came from books this audience can bet.** A single-game sample looked
like 88% DraftKings and badly understated the problem.

Passing this from the nightly tasks was an open follow-up in v2.5.3 **and**
v2.5.4, and still was not being passed at v2.6.1. Two releases is enough evidence
that a thing which must be remembered every time will not be. There is no case
where this account wants a board ranked against a book its followers cannot bet,
so it is a policy, not a parameter — the same reasoning that moved "never publish
fair odds" out of prose and into `extractPricedLine`.

Default: `draftkings,fanduel,betmgm,caesars`. FanDuel stays in because it priced
every WNBA prop on 2026-08-19 and five of six again on 2026-08-24; dropping it
empties that board.

**`preferredBookmakers="all"` disables the filter** for diagnostics — it is how
the table above was measured. The routing line then says so loudly.

### The empty board now says which kind of empty it is

Filtering means a market priced only by an excluded venue is invisible **by
design**. That is correct, but it must not read as a silent failure, so the
no-results message now distinguishes "nothing cleared" from "nothing cleared at
your books" and names the filter in use. Every board also reports
`Priced against: ...` in its routing line.

## 3. Tests

Nine new, suite now **54**. Includes the actual +3079 Polymarket odd object
asserted to be refused, a test documenting that its edge *would* have ranked
first, and one confirming a blocked venue cannot shadow a real book that priced
the same market.

**Mutation-tested:** removing `polymarket` from the set fails four tests.

Real books observed in live testing are pinned as NOT blocked, so a future
blocklist edit cannot quietly take DraftKings or FanDuel with it.

---

# Measured entity cost after the v2.6.x fixes

Live, 2026-08-24, 6 screens plus 2 schedule pulls: **435 entities total.**

| Workload | Cost |
|---|---|
| MLB game, both teams uncached | ~56 |
| MLB game, one team cached | ~28 |
| WNBA game | ~143 |

WNBA is ~2.5x MLB because the BDL tier gate forces all rates onto SGO, and its
60-day hit-rate window does not share a cache key with the 30-day availability
probe.

| Build | Per MLB game | 15-game slate |
|---|---|---|
| v2.2.0 | ~1,080 | ~16,200 |
| v2.5.4 | ~600 | ~9,000 |
| **v2.6.1+** | **~56** | **~850** |

A full MLB slate plus both WNBA games is roughly **1,150 entities**, so a month of
nightly builds lands near **34,000 against the 100,000 cap** — leaving real
headroom for NFL and CFB.

Cache during the sweep: **153 hits, 16 misses, 6 coalesced**. Those six were
concurrent duplicates that would each have been billed before v2.6.0.

An unplanned benefit of the v2.6.1 window fix: the hit-rate window for an MLB
position player is now 30 days, which **matches the availability probe's window**,
so they share cache entries. Under the old fixed 400-day window they never could.

---

# v2.6.3 — the roster cap was clipping MLB, and one player could own a board

Two related problems. The first was silently losing candidates; the second was
letting a single player monopolise what survived.

## 1. A flat maxPlayers of 18 was clipping MLB on every game

**Measured 2026-08-24.** Five of six MLB screens reported exactly 18 players
screened, while the availability probe on the same events covered 20 to 22. The
probe uses the FULL event roster; screening used the capped one.

Confirmed directly: the Rockies alone had **10 players** attached to
Nationals/Rockies, and the probe found 22 across both teams against 18 screened.

**The cut is not by quality.** `roster.slice(0, maxPlayers)` cuts on SGO's
response order, which is not sorted by minutes, usage, or anything else. So the
lost players are arbitrary, not fringe. On the WNBA game screened the same day,
capping at 10 of 14 removed **Maya Caldwell, the 4th-best prop on the board** at
11 of 15 priced -102 by FanDuel.

A clipped board looks completely healthy. It returns six good props and says
nothing about the four players it never evaluated.

**Now sport-aware:**

| Sport | Was | Now | Rosters observed |
|---|---|---|---|
| MLB | 18 | **24** | 20-22 |
| NFL | 18 | **24** | 22 on a Week 1 game |
| WNBA | 18 (10 in the nightly task) | **20** | 14 |
| CFB | 18 | 18 | large, cap is intentional |

**Cost of raising it is latency, not quota.** The team history is fetched once
and cached; each extra player only reads from it, and MLB rates come from
BALLDONTLIE which has no object cap. The binding constraint is the 60-second tool
ceiling via BDL's 1,100ms throttle, roughly 2 requests per extra player. Four more
MLB players is about 9 seconds, and v2.6.2's book filter buys some of that back.

**Remove `maxPlayers=10` from the WNBA nightly task.** It was a timeout stopgap
added in v2.5.1 whose root cause (uncached 401s burning ~90 doomed requests) was
fixed in that same release. v2.5.1's own deploy notes said to lift it once
verified. It never happened, and it has been costing picks since.

The board now says `ROSTER CLIPPED: N players attached, M screened` whenever it
happens, so this can never again be invisible.

## 2. One player could own most of a board

**The Padres/Pirates board, same day:** six props across **three players**. Tatis
held three slots, Yorke two, Lowe one. The Tigers/Rays board gave Dillon Dingler
**four of the top twenty-five**.

No individual prop was wrong. Each ranked where it ranked. But a board is supposed
to answer "what are the best plays in this game", and one that is half Tatis
answers a narrower question.

**Why this is a betting problem, not just a variety problem.** This account posts
two player props per thread. If the top two slots are the same player, the thread
contains one real opinion presented as two, and the picks rise and fall together.
A correlated pair sold as independent reads is a worse bet than it looks, and the
reader cannot see it.

**New `maxPerPlayer`, default 2.** Not 1: a hits prop and a strikeouts prop on the
same player are genuinely different reads, and 1 would thin boards on games where
few players clear. Two guarantees a 12-prop board draws on at least six players
while still allowing a real double-up when one player is the story.

**Applied AFTER ranking, never before.** This is the design point. Ranking first
means every surviving prop is still that player's best. Tatis keeps his 0.318 and
0.292 props and loses the 0.233 one. **The top-ranked prop on a board can never be
removed by diversifying**, at any cap value, which is asserted in the tests.

Suppressed props are counted and reported, never silently dropped:

```
Diversity: 1 lower-ranked prop(s) suppressed so no player exceeds 2 on the
board; 3 distinct player(s) shown. Raise maxPerPlayer to see them.
```

## 3. Tests

Nine new, suite now **63**. `diversifyByPlayer` is exported and pure, built
directly from the two real boards above. Covers rank preservation, the
top-prop-is-untouchable invariant, caps of 1 and 6, an already-diverse board, and
an empty board.

**Mutation-tested:** reversing the insertion order inside `diversifyByPlayer`
fails four tests.

Exported rather than left inline for the reason v2.6.1 learned the hard way: logic
that changes **which data reaches the user** is correctness logic, and burying it
inside a function that needs an API client makes it untestable.

## What this does NOT solve

**Repetition across nights.** A three-game series means the same two rosters three
nights running, and nothing here knows what was posted yesterday. Solving it
properly needs posted-pick history as state, which is exactly what the tracker and
Typefully already hold. That is a real feature, not a parameter, and it should
wait for the market scorecard work rather than being bolted on.

**Market-type concentration.** Worth watching: of 55 MLB props screened on
2026-08-24, a large share were `Hits + Runs + RBIs` unders and `Singles` unders.
Same-market picks across different players are also correlated - a high-scoring
night takes them together. The `markets` argument already allows filtering, and
the tracker shows Hits+Runs+RBIs running 61.5% at +27.8% ROI against Total Bases
at 36.9%, so the concentration may be earned rather than a bug. Flagging it as
something to measure, not something to fix blind.
