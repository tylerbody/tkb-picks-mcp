# v2.5.1 — the WNBA screen timeout, diagnosed and fixed

Three files changed. No tools added, removed, or renamed. No behaviour change for MLB or NFL.

---

## The symptom

`tkb_screen_props` timed out at 60s on **every** WNBA event, across multiple sessions and
both games on the 8/19 slate, while the same tool ran fine on all 15 MLB games that night.
Other tkb tools (`tkb_get_odds`, `tkb_get_api_usage`, `tkb_get_injuries`) responded
instantly throughout, so the connector was plainly reachable.

The nightly WNBA build therefore produced nothing, while the NFL build (which never calls
`screen_props`) and the MLB build both completed normally.

## What it was not

Ruled out by live testing rather than reasoning:

- **Not a global outage.** Every other tool worked in the same session, same minute.
- **Not a stuck job or per-session lock.** The throttle queue self-heals on error
  (`this.queue = run.catch(() => undefined)`), so a failed request cannot block later ones.
- **Not a wrong endpoint path.** `/wnba/v1/player_stats` is exactly what BALLDONTLIE
  publishes, confirmed against both their OpenAPI index and the WNBA docs site. The
  connector builds it correctly.
- **Not a lapsed subscription.** MLB, NFL, NCAAF and WNBA are all active at ALL-STAR.

## The actual cause

**BALLDONTLIE tiers features per sport, and the boundaries differ by sport.** From their own
published feature tables:

| Endpoint | WNBA / NCAAF | MLB / NFL |
|---|---|---|
| Teams, Players, Games | Free | Free |
| Injuries, Standings, Play-by-Play | ALL-STAR | ALL-STAR |
| **Player Stats** | **GOAT only** | **ALL-STAR** |

So `/wnba/v1/player_stats` and `/ncaaf/v1/player_stats` return **401 at ALL-STAR, correctly**.
Verified live: MLB and NFL stats probes return full field lists; WNBA and NCAAF both 401,
while WNBA players, injuries and standings all succeed on the same key.

v2.2.1 was right that WNBA is tier-gated. What was missed is that the gate is *per endpoint
per sport*, and more importantly that **the 401 was never cached.**

That is the defect. A *successful* stats fetch is memoised per player+window by
`getAllPlayerGameStats`, so its cost is paid once and every other market on that player is
free. A 401 was memoised nowhere, so every `player|stat|line` combination paid a throttled
round trip (1100ms) for the name search **and** another for the stats fetch, all guaranteed
to fail. On a 13-player WNBA event that is roughly 90 doomed requests, about 100 seconds of
pure latency, before any real SGO work began.

MLB never showed the symptom because its calls succeed, and therefore cache.

## The fix

A **TTL-memoised tier gate** in `BDLClient`, checked in two places:

1. `getPlayerGameStats` — fast-fails before the network or the throttle queue. Covers direct
   callers such as `tkb_scan_streaks`.
2. `getBdlPlayerHitRate` — checked **before** `resolveBdlPlayerID`, because the aggregator
   resolves a player name first. Guarding only the fetch would still burn a throttled search
   per candidate.

One 401 now disables the BDL stats path for that sport for 30 minutes; everything falls
through to SportsGameOdds immediately, exactly as it already did, just without the wait.
Roughly 90 doomed requests become 2.

**Memoised rather than hardcoded, deliberately.** A `wnba is gated` constant would keep BDL
switched off even after an upgrade to GOAT was paid for, and would need a redeploy plus
someone remembering the constant exists. A TTL heals itself within one window and covers
NCAAF automatically, which matters as college football ramps up.

`getRawPlayerGameStats` is deliberately left un-memoised so `tkb_debug_bdl_stats` always
performs a real network check and can verify an upgrade instantly.

## Correctness notes

- The thrown message contains `401`, so `screenProps` still buckets it under **tier gate** in
  its routing line. No change needed in `screenProps.ts`.
- `isStatSupported` is untouched. It answers "is there a field mapping", which stays true
  regardless of subscription, and is the wrong place for an entitlement check.
- MLB and NFL never set the memo, so their BDL path is bit-for-bit unchanged.

## Confirmed working, not assumed

Checked live on 2026-08-19 while diagnosing, and worth recording:

- **The SGO WNBA hit-rate path is healthy.** Courtney Williams returned 15 of 15 games with
  real values, playRate 1.0, flag OK, dated back to 8 July.
- **The IRREGULAR flag is a true positive, not noise.** Napheesa Collier returned 9 of 30
  team games and was flagged; she genuinely did not play 2 June through 21 July. The
  safeguard is doing its job.
- **SGO combination props cannot be counted, confirming `UNCOUNTABLE_STATIDS`.** SGO does
  post and price combo markets, and its docs list composite statIDs, but the settled
  `results` object does not populate them. Same player, same 30 events: `points` returned
  real values on 9 games while `points+rebounds+assists` returned null on all 30, including
  those same 9. So combos remain BDL-only, i.e. GOAT-only for WNBA.

## Deploy

1. Copy `src/` over the repo, commit, let Render redeploy.
2. `/health` must report **2.5.1** before testing anything.
3. `tkb_debug_bdl_stats sport="wnba" playerName="Napheesa Collier"` should still report the
   tier gate. That is the expected answer, not a failure.
4. Run `tkb_screen_props` on a WNBA event. It should now **return within seconds** instead of
   timing out, with a routing line reading roughly
   `Rate sources: 0 from BALLDONTLIE, N from SportsGameOdds. BDL fallback reasons: tier gate (N).`
5. Run one MLB screen and confirm the routing line still shows BDL serving, to prove MLB was
   untouched.

Once step 4 passes, the `maxPlayers=10` stopgap can be removed from the nightly WNBA
scheduled task so it screens the full board again.

## If you ever upgrade WNBA to GOAT

Nothing to change in code. The memo expires within 30 minutes and BDL starts serving WNBA
rates on its own. That would additionally unlock WNBA **combo props** (Pts+Reb+Ast and the
rest), which the thread format asks for and which cannot be computed on SGO at all.
