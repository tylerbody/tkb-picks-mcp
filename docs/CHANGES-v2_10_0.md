# v2.10.0 - NHL

Tenth league. Sports 10 -> 11, tests 481 -> 548.

Built from measurement: every SGO statID below is quoted from their stats page, and
every NHL API field was read off a live response on 2026-09-24.

---

## 1. The stub that was already here was wrong, and it looked right

`SPORT_CONFIG` carried this, commented out, waiting to be uncommented on trust:

```
// nhl: { label: "NHL", sgoLeagueID: "NHL", bdlPath: "nhl", supports: TEAM_SPORT_CAPABILITIES },
```

Three errors in one line. `TEAM_SPORT_CAPABILITIES` claims `weather: true`, and hockey
is indoors. It claims `injuries: true`, and no free NHL injury feed exists. And
`bdlPath` pointed hit rates at BALLDONTLIE, which gates NHL player stats behind GOAT
($39.99/mo) and NHL games behind ALL-STAR - so the feature would have 401'd on the day
it shipped.

A stale stub that reads like a decision is worse than no stub. The row was rewritten
from measurement.

---

## 2. Hit rates come from the NHL's own API, and they are the cheapest in the connector

`api-web.nhle.com`. No key, no quota, no plan, nothing to lapse. Same relationship MLB
has with statsapi.mlb.com.

| endpoint | what it gives |
| --- | --- |
| `/v1/player/{id}/game-log/{season}/2` | **82 games in ONE request** |
| `/v1/club-schedule-season/{team}/{season}` | the play-rate denominator |
| `/v1/score/{date}` | `gameState`, both scores, `gameOutcome.lastPeriodType` |
| `/v1/roster/{team}/{season}` | full first names |

**An NHL hit rate costs two requests and zero billable objects.** Every other path in
this repo pages through games and reads players out of each one; SGO bills per event
object, BDL throttles per minute, CFBD and CBBD share one 1,000-call monthly pool.

The second request is not optional. A game log contains only games the player PLAYED,
so a DNP is an absent row. Without the club schedule, a backup goalie who started three
of ten would report "cleared 30 saves in 2 of 3" with no sign the other seven games
happened. Goalies get their own play-rate threshold for that reason: 40% of team games
makes a goalie a starter, where 85% is the bar for a skater.

---

## 3. `points` means two different things and the two feeds are crossed

This is the whole reason `services/nhlStatMap.ts` exists.

| | means |
| --- | --- |
| SGO `points` | "Goals scored" - goals only |
| SGO `goals+assists` | "Hockey Points" - what a bettor calls points |
| NHL API `goals` | goals |
| NHL API `points` | goals + assists |

So **SGO `points` maps to NHL `goals`, and SGO `goals+assists` maps to NHL `points`.**
Wire them across by name and every player-points prop silently grades against goals
alone, which is right about 40% of the time by accident - the worst possible failure
rate, because it reads as noise rather than as a bug.

Stated in one file. Nothing else in the repo maps a hockey stat by hand.

Second, milder collision: the NHL game log's `shots` field is the official S column,
which is shots ON GOAL. SGO has both `shots_onGoal` and a bare `shots` ("total shots
taken"). So `shots_onGoal` maps to NHL `shots`, and SGO's `shots` is **refused** -
mapping it because the words match would overstate a shots prop by every attempt that
missed the net.

Third: a goalie log has no `saves` field. Saves are **derived** as `shotsAgainst -
goalsAgainst`, which is exact arithmetic rather than an estimate, emitted only when both
inputs are present, and reported as derived in `matchedField`.

---

## 4. What hockey cannot count, refused by name

`hits`, `blocks`, `faceOffs_won`, `powerPlay_assists`, `shots`, `shots_blocked` and
`fantasyScore` have no countable rate from the game log. Each gets its own explanation
naming the route that WOULD work and its price - hits and blocks are on the per-game box
score at one HTTP request per game, which is a trade deliberately not taken.

They stay in the OU prop catalog, because SGO prices them and a thread can quote the
line. Refusing a counted rate is not the same as refusing to quote a number.

---

## 5. Second source for finality is the NHL, not BALLDONTLIE

Every other sport cross-checks a lagging SGO status against BDL. For hockey that call
would 401 forever and degrade to "could not confirm", and a cross-check that can never
fire is worse than none because its silence reads as a considered answer.

`reconcileFinalityWithNHL` holds the same discipline as the BDL reconciler line for
line: whole normalised team names never containment, no bare abbreviations, scores
undefined rather than 0 when absent, an unrecognised state is no information, and SGO's
scores are what gets graded. One hockey addition: when the feeds agree, the note reports
whether it ended in regulation, overtime or a shootout, because a 3-2 shootout final and
a 3-2 regulation final are the same score and different results for a regulation-scoped
market.

`crossCheckFinalityForSport` is now the single dispatch point, and both graders call it.
Previously each called `crossCheckFinality` directly, so adding hockey would have meant
the same branch in two files - which is exactly how the v2.9.3 UFC message ended up in
`players.ts` and not in `propBoard.ts`.

---

## 6. Smaller decisions worth recording

- **Club codes are a complete 32-row table, not a derivation.** The CBB path derives a
  team name because 350+ programs make a table impossible. Thirty-two clubs make a
  derivation strictly worse. The Arizona-to-Utah move is mapped as an alias so an
  archived Coyotes id resolves to UTA rather than failing like an absent player.
- **Team splits are ON, with a printed caveat.** BDL standings will 401, and the SGO
  event fallback works for hockey because there have been no ties since 2005. What it is
  not is the league's three-column record: an OT or shootout loss is a loss here and its
  own column officially, so the tool now says which convention it used rather than
  letting a reader compare "20-15" against a published "20-10-5" and conclude the
  connector is broken.
- **Season boundary is October.** Read as the calendar year, every January-through-June
  game - more than half the season, all of the playoffs - would be filed under a season
  that had not started. The NHL's own `20262027` season id is derived from this one rule
  rather than from a second copy of it.
- **Periods are `1p`/`2p`/`3p` only.** `ot` and `so` are real documented ids and hockey
  reaches them, but no market is documented on them, and a request that returns nothing
  reads as "not posted yet" rather than "not sold".
- **`nhlStatus.ts` is its own pure module** so `eventStatus.ts` can use the game-state
  predicate without importing axios. That file opens with "no client anywhere near it",
  and that is a property rather than a decoration.

---

## Tests

481 -> 548, all passing. New `test/nhl.test.ts`.

Mutation-tested, eight mutations, all caught:

| mutation | failures |
| --- | --- |
| swap the points/goals crossover so the names line up | 3 |
| derive saves from one input instead of two | 1 |
| make `nhlSaysFinal` a deny-list (`!== "FUT"`) | 4 |
| count preseason games in the play-rate denominator | 2 |
| guess on an ambiguous surname instead of refusing | 1 |
| read a missing score as 0 | 1 |
| ignore home/away orientation when matching the feeds | 1 |
| restore the stale stub's capability flags | 2 |

---

## Not built, deliberately

- **`GET /leagues` for entitlement.** SGO documents it as returning the leagues
  available to YOUR key, which would replace `tkb_check_league_access`'s
  empty-window heuristic with a direct answer. Worth doing; it is its own change.
- **Hits and blocked-shots rates**, which need one request per game. See section 4.
- **NHL injuries.** Buyable from BDL at GOAT for hockey. Nothing free will serve it.
