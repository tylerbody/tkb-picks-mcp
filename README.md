# TKB Picks MCP Server (v1.1.0)

MCP server wrapping **SportsGameOdds** (odds, schedules, props, results) and
**BALLDONTLIE** (injuries, standings) for building TKB Picks betting threads
across MLB, WNBA, NFL, and CFB.

## Deploy

Render Web Service, Node environment:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Env vars: `SGO_API_KEY`, `BDL_API_KEY`
- MCP endpoint: `https://<your-app>.onrender.com/mcp`
- Health check: `/health`

## Tools (15)

| Tool | Purpose |
|---|---|
| `tkb_get_schedule` | Games by date/range/team. CFB tiering: top25 / power4 / rivalry |
| `tkb_get_odds` | Moneyline, spread, total, player props. Pricing guardrail enforced |
| `tkb_get_period_odds` | Half / quarter / inning markets |
| `tkb_get_yes_no_prop` | Milestone markets (first TD, any HR, double-double) |
| `tkb_get_futures` | Season-long markets (MVP, win totals, division) |
| `tkb_get_players` | Roster + playerIDs for an event or team |
| `tkb_get_player_hit_rate` | Real counted hit rate, DNP-excluded, season-labelled |
| `tkb_get_injuries` | Injury reports, multi-shape team resolution |
| `tkb_get_team_record` | Overall record from standings |
| `tkb_get_team_split` | Home/road via BDL standings; head-to-head via events |
| `tkb_get_game_weather` | MLB + NFL + CFB, roof-aware |
| `tkb_grade_pick` | Resolve a posted pick to WIN/LOSS/PUSH |
| `tkb_get_api_usage` | SGO quota and rate-limit monitoring |
| `tkb_debug_raw_event` | Diagnostic: raw SGO event |
| `tkb_debug_raw_injuries` | Diagnostic: raw BDL injuries |

## What changed in v1.1.0

**Correctness**
- Injury team resolution now handles NFL (`full_name`) and MLB/WNBA
  (`display_name`); comment field reads `comment`, `short_comment`, `description`,
  or `long_comment`. Previously every NFL record returned `team: "unknown"` with
  no detail.
- Empty team-filtered injury results no longer report "this is a good sign."
  When team-data coverage is below 50% the tool returns **CANNOT VERIFY** instead
  of a false all-clear.
- `includeOpposingOdds` corrected to `includeOpposingOddIDs`. The old name is not
  a real SGO parameter and was silently ignored on every request.
- Pricing guardrail: a market is only usable if a real sportsbook priced it.
  SGO's modelled `fairOdds` is never published. This prevents the NFL Week 1 case
  where an unpriced prop returned "-137" on both sides with no line.
- Hit rates are labelled by season, so prior-season games can't masquerade as
  current form.

**Cost and performance**
- New `/players` endpoint replaces using the debug event dump for playerIDs.
- Home/road splits use BDL standings (one free call) instead of tallying up to
  100 billed SGO event objects, and now also return point differential, streak,
  and division/conference records.
- BDL injury pagination raised to `per_page=100` from the default 25.
- `tkb_get_api_usage` exposes quota. SGO bills per **event object** returned, and
  hit-rate checks are the heaviest consumer.

**New coverage**
- NFL stadiums (all 32) and CFB stadiums with roof types, enabling weather beyond MLB.
- CFB tiering filters out the Division II teams SGO's NCAAF feed returns, plus a
  named-rivalry list.
- Futures and pick grading.

## Known gaps

- **CFB injuries are unavailable** through BALLDONTLIE on the current plan. Use
  preview articles for notable CFB injuries.
- **Retractable roofs** are never assumed. Roof status is a same-day team decision;
  the weather tool flags these for manual verification.
- **CFB top-25 filtering takes rankings as an input** rather than looking them up,
  because SGO does not expose a verified ranking field. Pass the current Top 25.
- **Player props appear close to game time.** A live test showed 6 markets on an NFL
  preseason game, 266 on Week 1 five weeks out, and 1,180 on an MLB game starting
  within the hour. Build threads inside the normal pre-game window.
