# TKB connector v2.19.0: screener on ESPN + ESPN injury feed

Built on GitHub main at v2.18.0 (commit 053a4ff). 985/985 tests pass, `tsc` clean.

## Upload these (same paths, overwrite)

- package.json
- src/constants.ts
- src/index.ts
- src/services/espnClient.ts
- src/services/espnInjuries.ts   (NEW)
- src/tools/injuries.ts
- src/tools/screenProps.ts
- test/v2_19_0.test.ts            (NEW)

## Delete this on GitHub

- src/tools/debugInjuries.ts

v2.15.0 already removed it, but it is still in the repo, and the v2.15.0 test fails
because of it. Nothing imports it.

## What changed

1. tkb_screen_props: NBA, NFL, WNBA, EPL and UCL rates now come from ESPN, the same
   source tkb_get_player_hit_rate uses. Before this, NBA went to BDL (cancelled),
   then fell back to SGO and produced nothing: 0 of 113 markets. If ESPN refuses a
   prop, it is no longer passed silently to SGO (that cost entities and produced no
   rate either). ESPN requests are memoised within each screen, so roughly 450
   requests become about 30.
2. Every screen now reports WHY each prop left the board: no rate, sample too thin,
   under minSample, under edge, under hit rate, or an error. Errors used to be
   swallowed silently. If most of the board has no rate, it says the problem is the
   source, not the market.
3. Screen props for NBA, NFL and WNBA carry injuryStatus from ESPN, and the board
   states how old the injury feed is. This is a warning, not a filter.
4. tkb_get_injuries: NBA, NFL, NHL and WNBA now read ESPN's free league-wide feed.
   Both ESPN hosts are fetched and the newer snapshot wins, because they serve
   different copies (one was measured two months behind the other). Every answer
   shows the feed's age. Anything older than 24h is marked STALE, and an empty result
   from a stale feed is never treated as "healthy". A return date that has already
   passed is flagged.
5. The NBA injuries refusal no longer talks about a missing NCAAF endpoint.

## After deploy, check

- tkb_get_api_usage shows version 2.19.0 (or check /health).
- tkb_screen_props on an NBA eventID: "Rate sources: N from ESPN" and a
  "WHY PROPS LEFT THE BOARD" line.
- tkb_get_injuries sport=nba: entries plus "ESPN injury feed last updated ...".
