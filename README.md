# TKB Picks MCP Server (v2.6.4)

MCP server wrapping **SportsGameOdds** (odds, schedules, props, results) and
**BALLDONTLIE** (stats, injuries, standings) for building TKB Picks betting
threads across MLB, WNBA, NFL, CFB, and ATP/WTA tennis.

## Deploy

Render Web Service, Node environment:

- Build: `npm install && npm run build`
- Start: `npm start`
- Env vars: `SGO_API_KEY`, `BDL_API_KEY`
- MCP endpoint: `https://<your-app>.onrender.com/mcp`
- Health check: `/health`

Then verify rather than assume:

```bash
npm test                                        # 77 tests, no network needed
node scripts/verify-deploy.mjs --expect 2.6.4
node scripts/verify-deploy.mjs --screen <mlbEventID>   # measures entity cost
```

`/health` returns `version`, `toolCount`, `tools` and `sports`. The last three are
read off a running server, so they cannot go stale independently of the code. If
the version looks old but `sports` contains `atp`, the build is new and only the
constant was forgotten.

## Sports and what each one supports

| Sport | Key | Props | Hit rates | Injuries | Weather | Splits |
|---|---|---|---|---|---|---|
| MLB | `mlb` | yes | yes | yes | yes | yes |
| WNBA | `wnba` | yes | yes | yes | indoors | yes |
| NFL | `nfl` | yes | yes | yes | yes | yes |
| CFB | `cfb` | yes | yes | not on plan | yes | yes |
| ATP | `atp` | no | no | no | no | no |
| WTA | `wta` | no | no | no | no | no |

Capabilities are declared in `src/constants.ts` and checked by each tool. A sport
that does not support something returns an explanation naming the reason, never an
empty result that reads like an answer.

**Tennis is moneyline only.** Competitors occupy the home/away participant slots
on an event rather than roster positions, so `event.players` is permanently empty
and player props cannot be addressed by playerID. This is structural, not
unfinished. Use `tkb_get_odds` with `marketType="moneyline"`.

## Tools (21)

**Picks**

| Tool | Purpose |
|---|---|
| `tkb_get_schedule` | Games by date/range/team. CFB tiering: top25 / power4 / rivalry / postable |
| `tkb_get_odds` | Moneyline, spread, total, player props. Pricing guardrail enforced |
| `tkb_screen_props` | Sweeps every posted prop for one event, ranked by edge or hit rate |
| `tkb_get_prop_board` | Every priced prop on one event, NO hit-rate gate. Use when a screen returns empty |
| `tkb_get_game_lines` | Moneyline, spread and total across a whole slate in one call |
| `tkb_get_player_hit_rate` | Real counted hit rate, DNP-excluded, season- and recency-labelled |
| `tkb_get_yes_no_prop` | Milestone markets (first TD, any HR, double-double) |
| `tkb_get_period_odds` | Half / quarter / inning / set markets |
| `tkb_get_players` | Roster and playerIDs for an event |
| `tkb_get_injuries` | Injury reports, multi-shape team resolution |
| `tkb_get_team_split` | Home/road via BDL standings; head-to-head via events |
| `tkb_get_game_weather` | MLB + NFL + CFB, roof-aware |

**Content**

| Tool | Purpose |
|---|---|
| `tkb_scan_streaks` | Active streaks and standout games. Non-pick content. Zero SGO quota |
| `tkb_get_line_movement` | Opening versus current line. Rides an existing fetch |
| `tkb_get_cover_player` | Cover-photo subject, availability-gated |
| `tkb_count_tweet_chars` | True X-weighted length (URLs cost 23, emoji cost 2) |

**Results**

| Tool | Purpose |
|---|---|
| `tkb_grade_pick` | Resolve one posted pick to WIN/LOSS/PUSH |
| `tkb_grade_slate` | Grade a whole day at once, one fetch per event |
| `tkb_monitor_live_picks` | Early-cashout detection, over/under asymmetry enforced |

**Ops**

| Tool | Purpose |
|---|---|
| `tkb_get_api_usage` | SGO quota, plus cache hit/miss/coalesce counters |
| `tkb_debug_bdl_stats` | Diagnostic: BDL tier access and real field names |

## Design rules this connector actually enforces

These are not aspirations. Each one exists because its absence caused a specific
published or near-published error, documented in `docs/`.

- **A price is only usable if a named sportsbook posted it.** SGO's modelled
  `fairOdds` is never returned as odds. Pick'em apps (Underdog, PrizePicks,
  Sleeper, Betr, Dabble, ParlayPlay) and Fliff are blocked at the pricing layer,
  so no call site can source from them.
- **Hit rates are counted, never estimated.** Sample size is the real number of
  appearances, DNPs excluded rather than counted as misses.
- **A stat that cannot be resolved returns `null`, never `0`.** A missing field
  reading as zero is indistinguishable from a real zero.
- **Ordering is self-describing.** Game logs carry dates on every entry, because
  a bare newest-first array was once read backwards and published as its inverse.
- **Warnings, not filters.** Stale samples and playing-time risk are surfaced with
  reasons; the writer decides. A tool that silently drops props teaches nothing.
- **A missing rate is not a missing market.** `tkb_screen_props` cannot rank what it
  cannot score, so on a sport with no rate source it returns an empty board while a
  full one exists. `tkb_get_prop_board` prints that board. Being unable to grade a
  market is not a reason to hide that it is priced.
- **An unanswerable question gets a refusal, not a plausible answer.** This is why
  capability flags exist, and why an empty injury filter can return CANNOT VERIFY.

## Repo layout

```
src/
  constants.ts        sport config + capability flags (start here)
  types.ts            provider response shapes
  index.ts            server, tool registration, /health
  services/           API clients, aggregators, pricing, catalogs
  tools/              one file per registered MCP tool
  data/               stadiums, CFB tiers
test/                 npm test, no network required
scripts/              verify-deploy.mjs
docs/                 changelogs, one per release
archive/tools/        removed in v2.0.0, kept for reference only
```

## Known gaps

- **CFB injuries** are unavailable through BALLDONTLIE on the current plan.
- **WNBA and NCAAF player stats** are GOAT-gated on BDL, so their hit rates fall
  back to SGO. A 401 disables the BDL path for 30 minutes and heals itself, so an
  upgrade takes effect without a redeploy.
- **Retractable roofs are never assumed.** Roof status is a same-day team
  decision; those stadiums are flagged for manual verification.
- **CFB rankings are an input, not a lookup.** SGO does not expose a verified
  ranking field, so pass `rankedTeams` from a live search.
- **Player props appear close to game time.** An empty roster means "not priced
  yet", not "no players". Build threads inside the normal pre-game window.
- **No CFB or WNBA hit rates from BALLDONTLIE**, and in the opening weeks of any
  season there is no current-year sample to count at all. Those threads run on
  preview language and team markets. `tkb_get_prop_board` and `tkb_get_game_lines`
  are the two tools that still work in that state.
- **Tennis grading is unconfirmed against live data.** The code path exists and
  needs one finished match to validate. See `docs/CHANGES-v2_6_0.md`.
