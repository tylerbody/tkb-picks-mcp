# v2.3.0 — the actual cause, found and fixed

## What the instrumentation said

v2.2.1 bucketed the BDL fallback reasons. One run answered it outright:

```
Rate sources: 18 from BALLDONTLIE, 55 from SportsGameOdds.
BDL fallback reasons: BDL rate limit (56).
```

**Not a mapping bug. Not names. Not dates. Not a tier gate.**

BALLDONTLIE's own **60 requests/minute** ceiling on ALL-STAR.

Worth noting how much guessing this avoided — five plausible causes were on the table, and four of them would have produced a fix that changed nothing.

## Why it was burning requests

The caller memoises hit rates on `playerID|statID|line`. That is correct for *its* purpose — it collapses the two sides of one market — but it cannot see that **one player's game rows answer every stat posted on them**.

So a player with 8 markets triggered **8 name searches and 8 paginated stat fetches** for data that is identical every time. Under 3-way concurrency across 74 markets, that saturates a 60/min budget in seconds.

Each 429 then fell back to SGO, which is exactly the expensive path the migration exists to avoid.

## Three fixes, all at the client layer

**1. Player search cache.** Name → BDL id resolves once per player instead of once per stat.

**2. Player stats cache.** One paginated fetch of a player's rows serves hits, total bases, RBI, singles, walks — every market on that player. Keyed on player + season + date window so a changed window still refetches.

**3. Request throttle.** 1,100ms minimum gap holds ~54 req/min, under the ceiling with headroom.

All three sit in `BDLClient` rather than the aggregator, so a new call site cannot bypass them.

## Why throttling rather than retrying

A 429 is treated as a reason to fall back to SGO, which costs real entities. Spacing requests slightly is strictly cheaper than being rate-limited into the expensive path. A slow request beats a billed one.

## Projected

| | Before | After |
|---|---|---|
| BDL requests per player | ~16 (8 searches + 8 fetches) | **2** |
| Rates served by BDL | 18 of 74 | **near all** |
| Entities per MLB game | ~1,195 | **~100** |

## The availability probe is working

v2.2.0's safeguard earned its place on this very run:

```
Cesar Prieto — availabilityFlag: "IRREGULAR"
"appeared in only 5 of the last 53 team games"
```

He screened at **13 of 15 (86.7%)** with a 30-point edge — the top result on the board. Without the probe he would have looked like the best pick in the game. He has played five times in two months.

That is the exact failure the BDL path cannot catch on its own, and it justifies the ~60 entities per game the probe costs.

## Verify after deploy

1. `/health` reports **2.3.0**
2. `tkb_get_api_usage`, run one MLB screen, check usage again
3. Target: **~100 entities**, down from 1,195
4. Routing line should show BDL serving nearly everything with no rate-limit failures

If `BDL rate limit` still appears, raise `MIN_REQUEST_GAP_MS` above 1100.
