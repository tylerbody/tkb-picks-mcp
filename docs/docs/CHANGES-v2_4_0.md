# v2.4.0 — full audit, four bugs fixed

Deep pass over the whole connector after the BDL routing landed. Four real issues, all fixed.

---

## 1. Name resolution broke on accents and multi-word surnames

**Measured:** a full-roster screen fell back to SGO on **24 of 191 rates** — evenly split between "player not found" and "ambiguous name."

The lineup: **Heriberto Hernández, Eugenio Suárez, Elly De La Cruz.**

Two separate failures:

- **No diacritic stripping.** SGO returns "Suarez", BDL returns "Suárez", the exact-match comparison failed.
- **Last-token-only surname split.** "Elly De La Cruz" searched for `Cruz`, returned every Cruz in the league, and the disambiguator correctly refused to guess.

**Fixed:** accent-insensitive matching in both the client and the aggregator, plus progressively longer surname suffixes (`Cruz` → `La Cruz` → `De La Cruz`), stopping at the first exact hit so the extra attempts cost nothing when unneeded.

The refusal-to-guess rule is untouched — that is what stops a wrong-player hit rate being published.

**Why it mattered:** this is not an edge case. A large share of MLB rosters carry accents or compound surnames, so it was a persistent ~13% fallback concentrated on exactly the players most likely to be in a lineup.

---

## 2. Combo stats were blocked even though BDL can compute them

`UNCOUNTABLE_STATIDS` excluded Points + Rebounds, Reb + Ast, Pts + Reb + Ast and Hits + Runs + RBIs.

That was an **SGO limitation** — its results object exposes one statID at a time with no way to sum components. **A BDL row carries every component**, so the sum is exact.

**Fixed:** the exclusion is now conditional. A combo stat passes when `bdlStatMap` has a derivation, and is blocked otherwise. Added MLB derivations for `batting_hits+runs+rbi` and `batting_runs+rbi`; the five WNBA combos were already mapped.

`fantasyScore` stays excluded on every path — scoring formulas vary by book and are not reconstructible from a box score.

---

## 3. Concurrency race caused duplicate fetches

The rate cache stored **resolved values**. With three workers running concurrently, all three could miss the same key before any of them wrote it, firing three identical upstream fetches.

This is what inflated the earlier counters — 235 counted computations across roughly 120 unique `player|stat|line` keys.

**Fixed:** the cache now stores the **in-flight promise**, so the second and third callers await the first one's work.

---

## 4. A silent availability failure looked like a clean slate

The probe swallows its own errors by design — a failed probe should mean *no flag*, not a *wrong flag*. But it returned an empty map while still counting as a "probed team," so the summary read:

```
Availability probed across 2 team(s).
```

...whether it found 40 players or zero. **A total failure was indistinguishable from a clean slate** — precisely the blind spot the safeguard exists to close.

**Fixed:** coverage is now reported, not attempts:

```
Availability: 38 player(s) covered across 2 team(s), 3 flagged IRREGULAR.
```

And on failure, it says so outright:

```
AVAILABILITY UNAVAILABLE: the playing-time probe returned no data for 2 team(s),
so no IRREGULAR flag can be trusted on this screen. Confirm lineups manually.
```

---

## Audited and found correct

- **`splits.ts`** — already tries BDL standings first and only tallies SGO events as fallback. No change needed.
- **`mapWithConcurrency` catch** — deliberately swallows per-market errors so one bad market cannot abort a sweep. Correct.
- **`bdlHitRateAggregator` games catch** — followed by the hard `DATE RESOLUTION FAILED` check, so it fails loudly downstream. Correct.

---

## Known behaviour worth understanding

**The throttle serialises BDL requests.** `HIT_RATE_CONCURRENCY` is 3, but the 1,100ms gap means effective BDL parallelism is 1. That is intentional — a 429 forces the expensive SGO path, so pacing is strictly cheaper than being rate limited. The promise cache reduces how often this matters.

Practically: a full-roster screen takes tens of seconds rather than a few. Budget for it in any scheduled task.

---

## Verify after deploy

1. `/health` reports **2.4.0**
2. Run a full-roster screen on a game with accented names (Marlins @ Reds is a good test)
3. Expect **near-zero** `player not found` / `ambiguous name` failures
4. Confirm the availability line reports **player counts**, not just team counts
