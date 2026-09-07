# v2.0.2 — recency and season bounding fix

The cross-check caught a real bug. This fixes it.

## What went wrong

BDL said **10 of 15** where SGO said **11 of 15**, same player, same line. They were grading **different sets of games**.

**Root cause:** BDL's MLB stat rows carry a bare `game_id` and nothing else identifying the game — no date, no opponent, no season.

Three failures followed:

1. **No sorting.** The aggregator sorts by date. With every date `unknown`, the comparator returned 0 for every pair, so the sort was a no-op and it kept whatever 15 rows arrived.
2. **Not recent.** Returned game_ids spanned ~7,000 to ~44,000 — almost certainly multiple seasons mixed together.
3. **The guardrail stayed silent.** Season provenance exists to catch exactly this, but it keys off dates. With none present it reported `crossesSeasonBoundary: false` while the contamination it was built to catch was happening.

"10 of 15" would have read as completely normal in a thread.

## The fix — two halves, both required

**1. Bound the query.** Stats are now requested with `seasons`, `startDate` and `endDate` (75-day rolling window, configurable via `lookbackDays`). This controls *which* games come back rather than depending on sort order.

**2. Join to real dates.** Stat rows are matched against `/games` by `game_id` to recover date, opponent and home/away. This makes ordering and season provenance possible at all.

Bounding alone wouldn't fix ordering within the window. The join alone wouldn't stop cross-season rows arriving. Both are needed.

## Hard refusal

If stat rows return but **none** can be matched to a date, the aggregator **throws** instead of returning a rate. `dataSource="auto"` then falls back to SGO automatically.

An unsortable sample is not a recent-form hit rate. Returning one anyway is the precise failure mode this connector exists to prevent — a fully populated, plausible, wrong number.

## Verify after deploy

```
tkb_get_player_hit_rate ... dataSource="bdl"
tkb_get_player_hit_rate ... dataSource="sgo"
```

**The counts must match.** Also confirm the BDL log now shows real dates and opponents instead of `"unknown"`, and that `seasonsRepresented` is populated.

If BDL still disagrees, do not use it. Fall back to `dataSource="sgo"` — it is more expensive but demonstrably correct, with clean dated logs and DNP handling.

## Still unverified

**WNBA field names.** Only MLB has been probed. Run:
```
tkb_debug_bdl_stats  sport="wnba"  playerName="A'ja Wilson"
```
MLB turned up two surprises (the `p_` pitching prefix, last-name-only search). Expect at least one in WNBA.
