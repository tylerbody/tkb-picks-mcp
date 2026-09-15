# v2.9.4 - a documentation audit, and the bug that had been invisible since v2.8.12

No tools added or removed. Still **28**. Tests: **435 -> 445**.

A full read of the SportsGameOdds, BALLDONTLIE and CollegeFootballData
documentation against what this codebase actually claims. Two real bugs, four stale
factual claims corrected, and one place where the docs are wrong and the code is
right.

---

## 1. THE FIELD SGO TELLS YOU TO GRADE ON, WHICH THIS CONNECTOR NEVER READ

From SGO's FAQ, verbatim:

> We recommend waiting until `status.finalized` is true before you finalise a grade.
> You can start as soon as `status.ended` is true.

`services/eventStatus.ts` exists because of a bug in v2.8.8: a `finalized: true`
QUERY returned an in-progress CFB game, which was graded off a live score. The
conclusion drawn at the time was that the request flag is "a request, not a
guarantee". That conclusion was correct and **incomplete**. The query parameter is
not a guarantee, but the EVENT carries its own `status.finalized` boolean, and
nothing in this repo ever looked at it.

For two releases this file inferred finality from `displayShort` - a field SGO
documents as a plain string **with no enumeration at all**. Every value it matches
on ("F", "FT", "F (ET)", "4th", "HT") was measured live, not read from a spec. The
feed was stating the answer in a documented boolean the whole time.

Now: `finalized === true` is checked first and beats everything short of a
cancellation. `ended === true` also grades, but says plainly that the result is not
yet finalised and can still be revised - SGO's schema carries a `reGrade` flag, so a
settled result is not immutable and a cached grade can go stale.

The display-string matching stays as the fallback. It is measured, it works, and it
is the only thing available when the booleans are absent.

---

## 2. THE BDL CROSS-CHECK WAS BROKEN FOR MLB AND WNBA, AND COULD NOT SHOW IT

v2.8.12 added a second-source finality check against BALLDONTLIE. It was written
against the NFL game shape. **BALLDONTLIE does not have one game shape. It has one
per sport.**

| field | NFL / NBA | WNBA | MLB |
|---|---|---|---|
| away team | `visitor_team` | `visitor_team` | **`away_team`** |
| home score | `home_team_score` | **`home_score`** | **`home_team_data.runs`** |
| away score | `visitor_team_score` | **`away_score`** | **`away_team_data.runs`** |
| status | `"Final"` | `"Final"` | **`"STATUS_FINAL"`** |

The old code read `visitor_team`, `home_team_score` and `visitor_team_score` only,
and matched final on an anchored `startsWith("final")`.

So on **MLB** the away team never resolved and no row ever matched. On **WNBA** the
teams matched and both scores read `undefined`, so the score-agreement guard refused
every time. And `"STATUS_FINAL"` does not start with `"final"`.

**Why it never surfaced:** every one of those paths degrades to "could not confirm",
which is indistinguishable from a genuine feed disagreement. The feature was safe and
completely inert on the sport that posts most nights, and nothing could tell you.

`status_state` is the fix. It is the one field BDL normalises across every sport,
with the same nine values everywhere: `scheduled`, `in_progress`, `final`,
`postponed`, `canceled`, `delayed`, `suspended`, `abandoned`, `unknown`. It is now
read first, with the per-sport `status` string as fallback. Team and score reads
cover all three spellings, and a missing score still returns `undefined` rather than
0 - a zero would make two disagreeing feeds look like they agreed on 0-0.

---

## 3. FOUR STALE FACTUAL CLAIMS, CORRECTED

This codebase states facts inside its error messages on purpose, so that a failure
names its own cause. The cost of that choice is that a stale claim actively misleads.
Four were wrong:

**CFBD limits are published.** This repo called 1,000 calls a month "an unverified
planning assumption, not a documented fact". It is published, at
collegefootballdata.com/api-tiers: Free 1k, Academic 3k (free with a .edu email),
then $1/5k through $30/500k. Hedging a published number is its own kind of wrong - it
invites the reader to re-derive something already settled.

**What IS undocumented got labelled properly.** CFBD publishes no per-minute limit
and no concurrency limit, and does **not** publish a status code for an exhausted
quota - their errors page lists 400/401/404/500 and describes quota only as "a quota
or entitlement response". The 429 this code branches on is an expectation, not a
contract, and now says so.

**The authoritative number is an endpoint, not a constant.** `GET /info` returns
`monthlyLimit`, `remainingCalls`, `usedCalls` and `resetAt`. `GET /info/usage`
splits the shared pool into `totals.cfbRequests` and `totals.cbbRequests`. `resetAt`
answers "when does this come back" exactly, which no comment in this repo ever
could. The CFBD and CBBD quotas being shared is confirmed on both key pages.

**hardrockbet is in SGO's published bookmaker table.** A comment here said the page
did not list it and that live data beat the doc page. Re-checked: the table has it.
The underlying principle stands, since SGO says that table is not exhaustive, but the
specific claim was stale. Two things from that page are worth carrying and are now
recorded: a bookmaker being listed does NOT mean this key receives it (SGO filters by
plan and says so in a response notice rather than an error), and `unknown` is a real
bookmakerID, so book-specific lookups must tolerate odds attributed to nobody.

---

## 4. WHERE THE DOCS ARE WRONG AND THE CODE IS RIGHT

The audit nearly undid v2.9.1.

SGO documents `oddID` as a **response-shaping** parameter - "an oddID or
comma-separated list of oddIDs to include odds for", grouped with `bookmakerID` and
`playerID`, explicitly distinguished from the event-filtering parameters. Nowhere do
they say an event carrying none of the requested markets is dropped from `data`. Read
the documentation alone and you would conclude v2.9.1 fixed a non-problem.

The measurement disagrees:

```
tkb_get_schedule sport="epl"  with points-home-game-ml-home   ->   0 events
the same call    sport="epl"  with points-home-reg-ml-home    ->  21 events
```

One parameter changed and twenty-one Premier League fixtures appeared. Whatever the
documentation intends, the observable behaviour is that such an event does not come
back. That is now recorded in `oddIdBuilder.ts` so nobody reverts the fix on the
strength of a doc page. The doc is SILENT on the case rather than contradictory, and
silence loses to a reproducible measurement.

Also recorded: SGO documents two real event-level filters this connector does not
use, `oddsAvailable` and `oddsPresent`. Those are the supported way to ask which
games have a board.

---

## 5. VERIFIED CORRECT, WHICH IS ALSO WORTH KNOWING

Not everything the audit touched was wrong. Confirmed against the docs:

- **Billing is per top-level object**, 10 events returned = 10 objects, and SGO does
  not charge per market or per bookmaker. So trimming `oddIDs` buys latency, not
  money - and every response costs a minimum of 1 object even when empty.
- **BDL auth is the raw key with no `Bearer` prefix**, and the per-sport paths this
  repo uses are exact: `/mlb/v1/stats`, `/nfl/v1/stats`, `/wnba/v1/player_stats`,
  `/ncaaf/v1/player_stats`.
- **NCAAF genuinely has no injuries endpoint at any tier.** The word "injury" does
  not appear anywhere in BDL's NCAAF reference, and it is absent from their tier
  table entirely, so it is not purchasable even on ALL-ACCESS. This repo's error
  message has said exactly that since v2.8.3 and it is correct.
- **MLB stat rows really do carry a bare `game_id` and nothing else identifying the
  game** - no date, no opponent, no home/away. The join to `/games` that v2.0.2 added
  is not defensive, it is mandatory. MLB is also the only sport whose stats endpoint
  has no date filter at all.
- **BDL rate limits are per-minute only**, with no monthly object cap, exactly as
  this connector has assumed since it moved hit rates there.
- **CFBD's `/games/players` shape** - game to teams to categories to types to
  athletes, with `stat` as a STRING and category and type names carrying **no enum** -
  is confirmed, which is precisely why `cfbdStatMap` matches on candidate arrays
  rather than assumed literals.

---

## 6. WORTH KNOWING, NOT YET BUILT

Recorded so they are not rediscovered from scratch:

- **BDL tiers are PER SPORT.** "Paid tiers do not apply across sports." A key is not
  ALL-STAR generally, it is ALL-STAR for the sports purchased and Free for the rest.
  This repo's header describes one account holding ALL-STAR for four sports, which is
  only true if four subscriptions were bought.
- **NCAAF gates `/games` itself behind ALL-STAR**, unlike MLB, NFL and WNBA where it
  is free. On a Free-for-NCAAF key even a schedule lookup fails.
- **The prop-board wildcard.** SGO: "replace the playerID portion of any oddID with
  `PLAYER_ID` to fetch that oddID across all players." That is the intended way to
  pull a whole prop board, and this connector iterates player IDs instead.
- **`isMainLine` exists under `byBookmaker`.** Without filtering on it, an alt line
  and the main line are indistinguishable in the payload.
- **`lastUpdatedAt` is per bookmaker.** Staleness is per book, not per response, so a
  fresh fetch can still carry an hours-old line. Directly relevant to the standing
  "recheck before posting" rule.
- **SGO returns partial responses silently** when a plan lacks access - a 200 with
  fewer events plus a notice string, not an error. A connector that ignores the
  notice will report "no FanDuel line" when the real cause is the plan.
- **BDL has no historical odds**, so any line-movement work must come from this
  connector's own snapshots.

---

## Testing

Ten new cases. Mutation-tested, six mutations, six killed:

| mutation | caught by |
|---|---|
| ignore `status.finalized` | the finalized-beats-everything case |
| ignore `status.ended` | the ended-grades-with-a-caveat case |
| `status_state` always reads final | the in_progress override case |
| drop the WNBA and MLB score spellings | three per-sport reconciliation cases |
| drop MLB's `away_team` | four cases, including every MLB row |
| drop MLB's `STATUS_FINAL` | the status-without-status_state case |
