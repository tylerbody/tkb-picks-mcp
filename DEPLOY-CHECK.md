# Deploy verification — read this first

## Version is now visible

`/health` reports **2.0.3**. Check it before testing anything:

```
https://tkb-picks-mcp.onrender.com/health
```

- Shows `"version": "2.0.3"` → new build is live, test away
- Shows `"version": "2.0.0"` → still the old build, wait for Render

**My mistake:** versions weren't bumped through 2.0.1–2.0.3, so `/health` reported 2.0.0 for all of them and couldn't distinguish builds. That's why the last test was ambiguous. Fixed — every future build bumps.

---

## What changed in 2.0.3

### Pagination (the root cause of three wrong results)

BDL returns rows **ascending from season start**, capped at 100/page, and nothing paginated. Page 1 was always the **oldest** games — sorting locally could never recover recent games that were never in the response.

Now auto-paginates, up to 6 pages.

### Defensive cursor extraction

Pagination stopping silently after page 1 is **indistinguishable from "there was only one page"** — and because rows are ascending, a silent stop means only old games are ever seen. That is exactly how the earlier wrong hit rates looked normal.

So the cursor is now read from every known location (`meta.next_cursor` or top-level `next_cursor`) rather than one assumed shape.

### Same bug found in `tkb_scan_streaks`

It was unpaginated too. An "active streak" would have been computed from the first 100 games of the season — a streak that ended in June, posted as current form.

### Games cache

BDL ALL-STAR allows **60 requests/minute**. Every player on a team needs the same games map, so a multi-prop thread would refetch an identical ~70-game list per player. Now cached, 15-min TTL.

Note the two caches solve different problems: **SGO's controls per-object billing, BDL's controls request rate.**

---

## Test sequence

**1. Confirm the build is live** — `/health` must say 2.0.3.

**2. Cross-check:**
```
tkb_get_player_hit_rate ... dataSource="bdl"
tkb_get_player_hit_rate ... dataSource="sgo"
```

Three things must be true:
- Counts match
- BDL dates are from the **last ~2 weeks**, not May/June
- Opponents resolve rather than showing "unknown"

**3. If BDL still disagrees**, the remaining suspect is the away-team field name. Home games currently show `opponent: "unknown"` while away games resolve, meaning `home_team` exists but the away side is under a name other than `visitor_team` or `away_team`. `tkb_debug_bdl_stats` won't reveal it — it would need a raw `/games` response.

---

## Until BDL is verified

**Use `dataSource="sgo"` for anything published.** It is demonstrably correct — clean dated logs, correct game window, DNP handling — and at ~211 entities per thread there is ample monthly headroom.
