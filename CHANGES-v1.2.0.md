# v1.2.0 — entity-cost fix + win-rate screening

All 18 tools intact. Three files changed, nothing removed.

---

## 1. Team-history cache in `sgoClient.ts` — the main fix

### What was measured

One `tkb_screen_props` call on a single MLB game: **1,610 entities, 286 requests.**

| Scope | Before |
|---|---|
| 1 game | ~1,610 entities |
| 15-game slate | ~24,000 (24% of the 100k monthly cap) |
| Daily for a month | ~720,000 — impossible on Rookie |

A day combining a slate with other work hit **67,697** and exhausted the plan.

It also blew past the per-minute request cap silently: 286 requests against a limit of 50.

### The actual cause

Not payload size. **Duplication.**

`getPlayerHitRate` issues an identical team-history query for every player it evaluates — same `leagueID`, `teamID`, date window, `finalized` flag — then filters by `playerID` locally. Screening 18 players across 2 teams re-fetched the same two ~90-event histories dozens of times.

`screenProps` does memoise, but on `playerID|statID|line`. That collapses the two sides of one market and cannot see that different players share a team.

### The fix

Cache at the `getAllEvents` layer, so every caller benefits — hit rates, screening, splits, head-to-head.

Three details that make it actually work:

**Subset-aware on `limit`.** Role profiles request different depths for the same team: 140 team games for a starting pitcher, 30 for a position player. Keying on limit would defeat the cache exactly when it matters. Fetched depth is stored; a cached entry serves any equal-or-shallower request, and a deeper request upgrades the entry.

**Date bucketing.** `hitRateAggregator` derives its window from `new Date()` at call time, so two calls milliseconds apart produce different ISO strings. Raw keying would miss on *every single call*. Dates bucket to the day — far finer than the 400-day window needs.

**Finalized-only.** Completed games are immutable, so a cache hit returns byte-identical data. Live odds, schedules, and any non-finalized query bypass the cache entirely and always hit the network. Efficiency without trading away correctness.

### Verified, not assumed

| Test | Result |
|---|---|
| 18 players / 2 teams | 2 fetches (was 18) |
| batter(30) → pitcher(140) → batter(30) | 2 fetches, correct upgrade |
| 5 calls with drifting timestamps | 1 fetch |
| 4 live odds calls | 4 fetches — correctly uncached |
| 4 distinct teams, 2 passes | 4 fetches — no collisions |

Projected: **~180 entities per game, ~2,700 per slate — 2.7% of cap instead of 24%.**

TTL 15 minutes, capped at 60 entries with LRU eviction.

---

## 2. Win-rate screening in `screenProps.ts`

### The problem

The screener ranked only by edge, which is an ROI framework. On 2026-08-10 it surfaced a prop at **6 of 15 — a 40% hit rate** — as qualifying, because +220 made the maths work. That bet loses 60% of the time.

Meanwhile props at 8/12 (67%) were being rejected for being priced at -237.

For an account judged on **visible win rate**, that ranking is backwards.

### Added

- **`minHitRate`** (0–1, default 0) — a win-rate floor applied independently of edge.
- **`rankBy`** (`"edge"` | `"hitRate"`, default `"edge"`) — default behaviour unchanged.

Both `edge` and `hitRatePct` are always returned, so the trade-off is never hidden.

**For a win-rate-first screen:**
```
minHitRate: 0.6, maxAmericanOdds: -200, minEdge: 0, rankBy: "hitRate"
```

---

## 3. Cache visibility in `usage.ts`

`tkb_get_api_usage` now reports hits, misses, depth upgrades, and cached team histories alongside the quota numbers — so the saving is observable rather than assumed.

---

## 4. Pre-existing build error fixed

`oddsPricing.ts` had an unused `hasBookOdds` variable that failed `noUnusedLocals`. **The uploaded source did not compile.** Removed — it was dead code left behind when the guardrail moved to checking `book` directly. The guardrail itself is unchanged.

---

## Deploy

Upload `src/` contents to GitHub, let Render redeploy, then verify:

1. `tkb_get_api_usage` → confirm it returns and shows a cache line
2. Run `tkb_screen_props` on one game
3. `tkb_get_api_usage` again → **entity delta should be ~180, not ~1,610**

That third step is the real proof. If the delta is still large, the cache isn't being hit and it's worth investigating before running a full slate.

---

## Not done, deliberately

- **Request throttling** — the per-minute breach is a symptom of duplication; caching should resolve it. Adding a throttle now would mask whether the real fix worked. Revisit if 429s persist.
- **Moving hit rates to BALLDONTLIE** — potentially eliminates SGO entity cost for stats entirely, but it's an architecture change that needs its own testing pass. Worth scoping once this fix is measured.
