# v2.5.0 — three fixes found mid-slate

Caught while building the Aug 15 MLB threads. Stopped at 2 of 15 rather than hand-filtering the same problems thirteen more times.

---

## 1. Pick'em apps were being used as odds sources

Underdog was pricing roughly **a third of every screen** at a flat +100/+100.

That is a product decision, not a market opinion — the payout is fixed and the edge comes from requiring multiple correct legs. Treating one of those numbers as a market price makes every prop look like a coin flip with enormous edge, because the break-even is always 50%.

**The clearest example:** a Cardinals/Cubs screen returned Pedro Pagés at **12 of 12 with a 50-point edge**, purely because a perfect hit rate was being compared against a flat 50% break-even. Unpublishable — a follower opening DraftKings would find a completely different number.

**Fixed:** `underdog`, `prizepicks`, `sleeper`, `betr`, `dabble` and `parlayplay` are excluded in `oddsPricing`, alongside the existing rule that fair-odds estimates are never publishable. Applies to every tool, so no call site can source from them.

---

## 2. The IRREGULAR flag was firing on healthy starting pitchers

**Cam Schlittler: "appeared in only 6 of the last 30 team games."**

A starter works every fifth game. Six of thirty is a rotation arm on normal rest — the opposite of a playing-time risk.

The SGO aggregator carried an explicit `starting_pitcher` exemption from the beginning. The probe added in v2.4.0 did not.

**Why this mattered more than it looks:** a false positive is not a conservative error here. It trains the reader to ignore the flag, and the flag's whole value is the real catches — Bobby Witt Jr. at 15 of 28, Napheesa Collier at 8 of 21, Azzi Fudd absent a full week.

**Fixed:** any `pitching_` stat returns OK.

---

## 3. The probe was sampling the wrong 30 games

**Alejandro Kirk: "appeared in only 2 of the last 30 team games"** — while actually starting 4 of his last 6, including the previous night.

That number was simply wrong. `getAllEvents` was pulling **one page of 30 from a 60-day window** holding roughly 50 games, and SGO's default ordering for finalized events is confirmed **not** most-recent-first. The 30 returned were frequently the oldest, so a player's recent starts were never in the sample.

**Fixed two ways:**
- Window narrowed to **30 days** (~26 MLB games), so a single page captures essentially all of them and recency comes from the date bound rather than trusting API ordering
- Events are sorted newest-first and capped at 30 before tallying

This also makes the denominator honest: "last 30 team games" now means the last 30.

---

## The pattern worth noting

All three were **wrong outputs that looked plausible**. A 50-point edge reads like a find. "6 of 30" reads like diligence. "2 of 30" reads like a catch. None announced itself as broken.

They surfaced only because the picks were being read closely against the underlying data — which is the argument for reviewing boards rather than trusting them.

---

## Verify after deploy

1. `/health` reports **2.5.0**
2. Run a screen on any MLB game
3. **No `underdog` in the bookmaker field** on any returned prop
4. Starting pitchers show `availabilityFlag: "OK"`
5. Everyday regulars who played yesterday are **not** flagged IRREGULAR
6. Flag text reads "of the last 30 team games" and the number is credible
