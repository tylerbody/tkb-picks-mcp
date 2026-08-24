# v2.2.1 — instrument the BDL fallback

## What v2.2.0 measured

Ran a screen on one MLB game. Expected ~100 entities. Got **1,195** — essentially unchanged from the 1,080 baseline.

The routing line explained the count but not the cause:

```
Rate sources: 18 from BALLDONTLIE, 217 from SportsGameOdds
```

**217 of 235 rates threw an exception and silently fell back.** The catch block discarded the reason.

## The actual problem with v2.2.0

A fallback that hides its own cause is indistinguishable from a fallback that never fires. The routing counter proved BDL wasn't serving, but gave no way to tell whether it was:

- a tier gate
- unmapped stats
- ambiguous player names
- unresolvable game dates
- BDL rate limiting

Five plausible causes, no evidence. Guessing between them and shipping a fix would be the same mistake that produced the `p_k` collision and the reversed-array bug — both of which came from assuming rather than checking.

## The change

Failures are now **bucketed by cause** and reported:

```
Rate sources: 18 from BALLDONTLIE, 217 from SportsGameOdds.
BDL fallback reasons: dates unresolvable (198), ambiguous name (12),
stat not mapped (7). Availability probed across 2 team(s).
```

Buckets: `ambiguous name`, `player not found`, `dates unresolvable`, `tier gate`, `BDL rate limit`, `stat not mapped`, `other`.

## Why this is the right next step rather than a fix

Each cause needs a different repair:

| Cause | Fix |
|---|---|
| dates unresolvable | the `/games` join window or team filter is wrong |
| ambiguous name | disambiguation needs the team hint to actually match |
| stat not mapped | add the statID to `bdlStatMap` |
| tier gate | subscription problem, not code |

Shipping a guess would likely fix nothing and cost another deploy cycle. One run of this build names the culprit exactly.

## Also confirmed this round

**WNBA endpoint path is correct.** Verified `/wnba/v1/player_stats` against BALLDONTLIE's official OpenAPI index — it matches what `statsPathFor` builds. The 401 is a genuine tier gate on that specific endpoint, not a path bug. WNBA stays on SGO.

## Discovered in the spec, worth knowing

BALLDONTLIE exposes considerably more than the connector currently uses:

- `/mlb/v1/odds/player_props` and `/wnba/v1/odds/player_props` — **odds, not just stats**
- `/mlb/v1/players/versus` — batter vs pitcher history
- `/mlb/v1/players/splits` — platoon and situational splits
- `/atp/v1/head_to_head`, `/wta/v1/head_to_head`, `/atp/v1/match_stats` — tennis, currently 100% web search
- `/ncaaf/v1/rankings` — AP Top 25

The tennis endpoints are the most interesting: ATP and WTA are separate subscriptions, but they would replace manual research entirely for the highest-win-rate categories on the account (WTA 79.4%, ATP 67.6%).

## Verify after deploy

1. `/health` reports **2.2.1**
2. Run `tkb_screen_props` on any MLB game
3. Read the **BDL fallback reasons** line — that names the fix
