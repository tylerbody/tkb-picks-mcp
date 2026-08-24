# v2.2.0 — screen_props routed to BALLDONTLIE, availability safeguard kept

## The problem, measured

**~1,080 entities per game.** A 12-game slate ran ~13,000, and daily builds burned a 100,000 key in under two weeks.

One line item dominated. SGO has **no player game-log endpoint**, so computing "Torkelson has hits in 13 of 15" means pulling *Detroit's entire recent history* and reading his line out of each event. And because a starter pitches every fifth game, collecting 10 starts scans **up to 140 team games**.

Two pitcher props on one game can cost more than all 18 hitters combined.

## What was actually wrong

`tkb_get_player_hit_rate` already routed to BDL. **`tkb_screen_props` never did** — it imported the SGO aggregator directly, and it's the tool that runs on every game of every slate.

BDL returns rows for **one player directly** and has no monthly object cap.

## The catch, and why it mattered

BDL only returns games a player **actually appeared in**. DNPs are invisible. A bench bat who started 8 of the last 30 looks identical to an everyday regular — the hit rate is correct, but the context that it was compiled from sporadic appearances disappears.

That context has been the deciding factor repeatedly:

| Player | Screened | Actually played |
|---|---|---|
| Bobby Witt Jr. | 12 of 15 | 15 of 28 team games |
| Cameron Brink | 11 of 15 | 15 of 23 |
| Azzi Fudd | 12 of 15 | hadn't played in a week |

Each would have been published on the strength of the rate alone.

## The fix — split the two jobs

**Rates → BDL.** Per-player, no quota.

**Availability → one SGO probe per team**, shared across every player on that roster via the existing client cache.

A two-team game pays roughly **60 entities total** for the safeguard, regardless of how many players get screened. That's a deliberate trade: a small fixed cost to keep a check that has caught something nearly every day.

The emitted `availabilityFlag` now comes from the probe, **not** from the rate object — the BDL path's own flag would read "OK" for a player who's been sitting.

## Failure behavior

- BDL fails for any reason — tier gate, unmapped stat, ambiguous name, unresolvable dates — the rate falls back to SGO. **Cost degrades, never correctness.**
- The probe fails — no flag rather than a wrong flag. Screening continues.

## Routing visibility

Every screen now reports its source split:

```
Rate sources: 34 from BALLDONTLIE (no SGO quota), 0 from SportsGameOdds.
Availability probed across 2 team(s).
```

If `bdlServed` is 0 on MLB, every rate came from SGO and the screen cost ~10x what it should. That's now visible immediately rather than at the quota wall.

## Coverage

| Sport | BDL stats mapped | Status |
|---|---|---|
| **MLB** | **16** — hits, TB, RBI, HR, doubles, triples, singles, walks, Ks, SB + all 5 pitching | ✅ verified live |
| WNBA | 15 — points, rebounds, assists, steals, blocks, 3PM + 5 combo stats | ⛔ tier-gated (401), falls back to SGO |

WNBA is unaffected and will keep using SGO. At 2-4 games/day that's ~3,000/month, which fits comfortably.

## Projected

| Scenario | Before | After |
|---|---|---|
| 12-game MLB slate | ~13,000 | **~700** |
| 3 WNBA games | ~3,000 | ~3,000 |
| Month of daily builds | ~480,000 | **~30,000** |

## Verify after deploy

1. `/health` should report **2.2.0**
2. Run `tkb_screen_props` on any MLB game — check the **Rate sources** line shows BDL serving
3. `tkb_get_api_usage` before and after — a single game should cost roughly **60-100 entities**, down from ~1,080
4. Confirm at least one player still shows `availabilityFlag: "IRREGULAR"` across a full slate — if nothing ever flags, the probe isn't working

Step 4 matters most. A silent probe failure looks exactly like a clean slate.

## Not changed

- `splitsAggregator` still tallies up to 100 SGO events for home/road records even though `splits.ts` calls BDL standings first. Redundant, but it only runs when explicitly invoked.
- Pitcher scan depth stays at 140. Lowering it to 100 would save ~40 entities per pitcher, but with rates now on BDL the SGO path is a fallback only.
