# v2.0.3 — pagination fix + full build audit

## The root cause of all three wrong BDL results

**BDL returns rows ASCENDING from season start, capped at 100 per page. Neither the stats nor the games fetch paginated.**

So page 1 was always the **oldest** games of the season. Sorting locally could never fix it — the recent games were never in the response.

That's why BDL kept returning late-May through mid-June games while SGO correctly returned late-July through August for the same player and line. Three different symptoms, one cause.

**Fixed:** `getAllPlayerGameStats()` and `getAllGames()` now auto-paginate (6 pages max, ~600 rows — well past a full season). BDL has no object cap, so cost isn't a factor.

---

## Audit findings — two more instances of the same bug class

### 1. `tkb_scan_streaks` had it too

It called `getPlayerGameStats` unpaginated. An "active streak" would have been computed from the **first 100 games of the season** — a streak that ended in June, presented as current form. Worse than posting nothing.

**Fixed:** paginated, season-bounded, and the sort now pushes undated rows to the *end* rather than letting them silently land at the front and corrupt the count.

### 2. Opponents showed "unknown" on home games

The join read `visitor_team` only. MLB feeds have used `away_team`. Half the log rendered as "unknown".

**Fixed:** both field names checked.

---

## Rate-limit exposure (found in audit, not yet a failure)

BDL ALL-STAR allows **60 requests/minute**. Every player on a team needs the same games map to date their rows, so a multi-prop thread would refetch an identical ~70-game list per player.

**Fixed:** `getAllGames` is now cached (15-min TTL, LRU-capped at 40 entries).

Note the distinction: the **SGO cache controls per-object billing**; this one **controls request rate**. Different constraints, same fix.

---

## Known limitation, deliberately not changed

**`tkb_screen_props` still uses the SGO hit-rate path**, so it remains the most expensive tool (~1,079 entities/game).

Routing it to BDL was considered and rejected for now: 18 players × (search + paginated stats + games) would run ~90 requests, **over the 60/min ALL-STAR limit**. It needs request batching before it can move, and given BDL has taken four rounds of fixes, forcing it into the primary thread-building path unproven is the wrong trade.

**The manual workflow remains both cheaper and safer** — measured at 211 entities per thread versus 1,079 for a single screen.

---

## Verify after deploy

```
tkb_get_player_hit_rate ... dataSource="bdl"
tkb_get_player_hit_rate ... dataSource="sgo"
```

Check three things:
1. **Counts match**
2. **BDL dates are recent** — should be the last ~2 weeks, not May/June
3. **Opponents resolve** — not "unknown"

If all three pass, BDL is safe and you get the cost reduction. If not, stay on `dataSource="sgo"`.

Then probe WNBA, still completely unverified:
```
tkb_debug_bdl_stats  sport="wnba"  playerName="A'ja Wilson"
```
