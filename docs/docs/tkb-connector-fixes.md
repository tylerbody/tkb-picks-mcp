# tkb-picks MCP Server — Hit Rate & Prop Screening Fixes

**Date:** 2026-08-09
**Root cause:** `lookbackGames` counts *team* games, then filters to games the player appeared in. Starting pitchers appear in roughly 1 of every 5 team games, so a 30-game window (the current hard cap) yields 4–6 starts for an established arm and 0–1 for anyone recently promoted or returning.

**Observed failures on the 8/9 slate:**

| Player | Request | Result |
|---|---|---|
| Cade Povich | 30 team games | 0 starts, unusable |
| Connor Prielipp | 30 team games | 1 start |
| J.T. Ginn | 30 team games | 4 starts |
| Logan Webb | 30 team games | 5 starts |
| Matthew Boyd | 30 team games | 3 starts |
| Joey Cantillo | 30 team games | 6 starts |

Six fixes below, ordered by priority. Fixes 1 and 6 stop the bleeding. Fix 4 is the one that changes the daily workflow.

---

## Fix 1 — Count player appearances, not team games

**Priority: critical**

Change the semantic of `lookbackGames` from "team games to scan" to "player appearances to collect." Page backward through team games until the target appearance count is reached or a safety cap is hit.

### Schema change

```typescript
const HitRateInput = z.object({
  sport: z.enum(["mlb", "wnba", "nfl", "ncaafb"]),
  playerID: z.string(),
  playerName: z.string().optional(),
  teamID: z.string(),
  statID: z.string(),
  line: z.number(),
  direction: z.enum(["over", "under"]),

  // CHANGED: now means player appearances, not team games
  lookbackGames: z.number().int().min(1).max(40).default(10)
    .describe(
      "Number of games the PLAYER actually appeared in. The server scans " +
      "backward through team games until it collects this many appearances. " +
      "For starting pitchers this may scan 5x this many team games."
    ),

  // NEW: safety valve
  maxTeamGamesScanned: z.number().int().min(10).max(200).default(120)
    .describe(
      "Hard ceiling on team games scanned before giving up. Prevents a " +
      "season-ending injury from triggering a full-season crawl."
    ),

  // NEW: keeps a stale sample from being quoted as current form
  maxDaysBack: z.number().int().min(7).max(365).optional()
    .describe("Optional cutoff. Games older than this are not counted."),
});
```

### Implementation

```typescript
const TEAM_GAMES_PER_PAGE = 30;

async function collectPlayerAppearances(params: {
  sport: string;
  teamID: string;
  playerID: string;
  statID: string;
  targetAppearances: number;
  maxTeamGamesScanned: number;
  maxDaysBack?: number;
}): Promise<{
  appearances: AppearanceRow[];
  teamGamesScanned: number;
  hitCeiling: boolean;
  oldestDateReached: string | null;
}> {
  const appearances: AppearanceRow[] = [];
  let teamGamesScanned = 0;
  let cursor: string | undefined = undefined;
  let oldestDateReached: string | null = null;

  const cutoff = params.maxDaysBack
    ? new Date(Date.now() - params.maxDaysBack * 86_400_000)
    : null;

  while (
    appearances.length < params.targetAppearances &&
    teamGamesScanned < params.maxTeamGamesScanned
  ) {
    const remaining = params.maxTeamGamesScanned - teamGamesScanned;
    const pageSize = Math.min(TEAM_GAMES_PER_PAGE, remaining);

    const page = await fetchTeamGames({
      sport: params.sport,
      teamID: params.teamID,
      limit: pageSize,
      before: cursor,
    });

    if (page.games.length === 0) break; // exhausted history

    for (const game of page.games) {
      teamGamesScanned++;
      oldestDateReached = game.date;

      if (cutoff && new Date(game.date) < cutoff) {
        return {
          appearances,
          teamGamesScanned,
          hitCeiling: false,
          oldestDateReached,
        };
      }

      const value = extractStat(game, params.playerID, params.statID);
      if (value === null || value === undefined) continue; // DNP

      appearances.push({
        eventID: game.eventID,
        date: game.date,
        opponent: game.opponent,
        isHome: game.isHome,
        statValue: value,
        seasonYear: game.seasonYear,
      });

      if (appearances.length >= params.targetAppearances) break;
    }

    cursor = page.games[page.games.length - 1]?.date;
    if (!cursor) break;
  }

  return {
    appearances,
    teamGamesScanned,
    hitCeiling: teamGamesScanned >= params.maxTeamGamesScanned,
    oldestDateReached,
  };
}
```

### Why the safety cap matters

Without `maxTeamGamesScanned`, a request for 10 appearances on a pitcher who tore a UCL in May walks the entire season and every prior season in the store. The 120 default gives a starter roughly 24 starts of runway, which is more than enough, while capping worst-case latency and memory.

---

## Fix 2 — Type-aware defaults

**Priority: high**

The server already infers player type from the `pitching_` prefix. Use it to set the default window instead of applying one number to both.

```typescript
type PlayerRole = "starting_pitcher" | "reliever" | "batter";

function inferRole(statID: string, sport: string): PlayerRole {
  if (!statID.startsWith("pitching_")) return "batter";
  // Outs/pitches thrown markets are only posted for starters
  if (statID === "pitching_outs" || statID === "pitching_pitchesThrown") {
    return "starting_pitcher";
  }
  return "starting_pitcher";
}

const ROLE_DEFAULTS: Record<PlayerRole, {
  appearances: number;
  maxScan: number;
  minSufficient: number;
}> = {
  starting_pitcher: { appearances: 10, maxScan: 120, minSufficient: 5 },
  reliever:         { appearances: 15, maxScan: 60,  minSufficient: 8 },
  batter:           { appearances: 15, maxScan: 25,  minSufficient: 8 },
};
```

Resolution order: explicit caller value, then role default. Never a global constant.

---

## Fix 3 — Return both directions in one response

**Priority: high**

Today, evaluating an under means either calling with `direction: "under"` or calling for the over and inverting it mentally. That is an unnecessary round trip and an easy place to make an error.

Compute both from the same appearance set.

```typescript
interface HitRateResult {
  playerName: string;
  statID: string;
  line: number;

  over:  { hits: number; rate: number; impliedBreakeven: number | null };
  under: { hits: number; rate: number; impliedBreakeven: number | null };
  push:  { count: number };

  gamesConsidered: number;
  teamGamesScanned: number;
  sampleSufficient: boolean;
  sampleWarning: string | null;

  log: AppearanceRow[];
}

function computeBothDirections(values: number[], line: number) {
  let over = 0, under = 0, push = 0;
  for (const v of values) {
    if (v > line) over++;
    else if (v < line) under++;
    else push++; // only possible on whole-number lines
  }
  const n = values.length;
  return {
    over:  { hits: over,  rate: n ? over / n : 0,  impliedBreakeven: null },
    under: { hits: under, rate: n ? under / n : 0, impliedBreakeven: null },
    push:  { count: push },
  };
}
```

**Note on pushes:** current logic treats `>` as a hit and everything else as a miss, which silently buckets a push as a miss. Half-point lines make this moot, but whole-number lines (`pitching_outs` at 15, `batting_hits` at 1) do occur and would be scored wrong.

---

## Fix 4 — Prop screener

**Priority: high. This is the workflow fix.**

Replaces 10–15 manual calls per game with one.

```typescript
server.registerTool(
  "tkb_screen_props",
  {
    title: "Screen all posted props for a game",
    description:
      "Pulls every posted player prop for an event, computes the counted hit " +
      "rate for each side, and returns them ranked by edge. Use this FIRST " +
      "when building a thread. Only returns markets with real book prices; " +
      "model-estimated prices are excluded automatically.",
    inputSchema: {
      eventID: z.string(),
      sport: z.enum(["mlb", "wnba", "nfl", "ncaafb"]),
      minSample: z.number().int().default(5)
        .describe("Exclude props with fewer counted appearances than this."),
      minHitRate: z.number().min(0).max(1).default(0.6),
      maxAmericanOdds: z.number().default(-200)
        .describe("Reject prices shorter than this. -200 rejects -250."),
      minAmericanOdds: z.number().default(-10000)
        .describe("Optional floor to exclude long plus-money."),
      markets: z.array(z.string()).optional()
        .describe("Restrict to specific market labels."),
      limit: z.number().int().max(25).default(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (input) => {
    const players = await getEventPlayers(input.eventID, input.sport);
    const results: ScreenedProp[] = [];

    // Bounded concurrency: the OOM crashes came from unbounded fan-out
    const queue = buildPropQueue(players, input.markets);
    await mapWithConcurrency(queue, 4, async (candidate) => {
      const odds = await getOdds({
        eventID: input.eventID,
        sport: input.sport,
        playerID: candidate.playerID,
        marketLabel: candidate.marketLabel,
        side: candidate.side,
      });

      if (!odds || odds.isModelEstimate) return; // never surface fair-value

      const rate = await getHitRate({
        sport: input.sport,
        playerID: candidate.playerID,
        teamID: candidate.teamID,
        statID: candidate.statID,
        line: odds.line,
        direction: candidate.side,
      });

      if (!rate.sampleSufficient) return;
      if (rate[candidate.side].hits < input.minSample * input.minHitRate) return;

      const breakeven = impliedProbability(odds.americanOdds);
      results.push({
        playerName: candidate.playerName,
        market: candidate.marketLabel,
        line: odds.line,
        side: candidate.side,
        americanOdds: odds.americanOdds,
        roundedOdds: roundToNearestTen(odds.americanOdds),
        bookmaker: odds.bookmaker,
        hitRate: rate[candidate.side].rate,
        hits: rate[candidate.side].hits,
        sample: rate.gamesConsidered,
        breakeven,
        edge: rate[candidate.side].rate - breakeven,
        recentValues: rate.log.slice(0, 6).map(r => r.statValue),
      });
    });

    results.sort((a, b) => b.edge - a.edge);
    return jsonResult({
      eventID: input.eventID,
      screened: queue.length,
      qualified: results.length,
      props: results.slice(0, input.limit),
    });
  }
);
```

**The `edge` field is the point.** Hit rate alone is not a signal. Hoerner at 7 of 11 on singles reads well until you notice the price was -186, whose breakeven is 65.0% against his 63.6%. That is a negative-edge pick that looks positive. Surfacing `edge = hitRate - breakeven` makes that visible without arithmetic.

---

## Fix 5 — Combined evaluate endpoint

**Priority: medium**

Two calls become one, and it becomes structurally impossible to quote a price without its hit rate attached.

```typescript
server.registerTool(
  "tkb_evaluate_prop",
  {
    title: "Get price and counted hit rate for one prop",
    description:
      "Single call returning the real book price, the counted hit rate on " +
      "both sides, sample size, and a sufficiency flag. Prefer this over " +
      "calling tkb_get_odds and tkb_get_player_hit_rate separately.",
    inputSchema: {
      eventID: z.string(),
      sport: z.enum(["mlb", "wnba", "nfl", "ncaafb"]),
      playerID: z.string(),
      playerName: z.string().optional(),
      marketLabel: z.string(),
      side: z.enum(["over", "under"]),
      lookbackGames: z.number().int().min(1).max(40).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (input) => {
    const odds = await getOdds({ ...input });

    if (!odds) {
      return errorResult(
        `NO USABLE ODDS. No book has posted ${input.marketLabel} for this ` +
        `player. Try tkb_screen_props to see what IS posted for this event.`
      );
    }
    if (odds.isModelEstimate) {
      return errorResult(
        `NOT YET PRICED. Only a model fair-value estimate exists ` +
        `(${odds.americanOdds}). Do not publish. Use tkb_screen_props to ` +
        `find markets with real prices.`
      );
    }

    const rate = await getHitRate({
      ...input,
      line: odds.line,
      teamID: odds.teamID,
      statID: odds.statID,
    });

    const breakeven = impliedProbability(odds.americanOdds);
    const chosen = rate[input.side];

    return jsonResult({
      pick: `${input.playerName} ${input.side.toUpperCase()} ${odds.line} ${input.marketLabel}`,
      americanOdds: odds.americanOdds,
      roundedOdds: roundToNearestTen(odds.americanOdds),
      bookmaker: odds.bookmaker,
      hitRate: `${chosen.hits} of ${rate.gamesConsidered}`,
      hitRatePct: chosen.rate,
      breakevenPct: breakeven,
      edge: chosen.rate - breakeven,
      sampleSufficient: rate.sampleSufficient,
      sampleWarning: rate.sampleWarning,
      recentValues: rate.log.slice(0, 8).map(r => ({
        date: r.date, opponent: r.opponent, value: r.statValue,
      })),
    });
  }
);
```

---

## Fix 6 — Explicit sample sufficiency

**Priority: critical. Small change, prevents the worst failure mode.**

```typescript
function assessSample(
  appearances: AppearanceRow[],
  role: PlayerRole,
  scan: { teamGamesScanned: number; hitCeiling: boolean }
): { sufficient: boolean; warning: string | null } {
  const n = appearances.length;
  const min = ROLE_DEFAULTS[role].minSufficient;

  if (n === 0) {
    return {
      sufficient: false,
      warning:
        `NO SAMPLE. Player did not appear in any of the ${scan.teamGamesScanned} ` +
        `team games scanned. DO NOT WRITE REASONING AROUND THIS PROP. ` +
        `Pick a different player or market.`,
    };
  }
  if (n < min) {
    return {
      sufficient: false,
      warning:
        `INSUFFICIENT SAMPLE: ${n} appearance(s) found, ${min} needed for a ` +
        `${role.replace("_", " ")}. A rate computed on ${n} game(s) is not ` +
        `evidence and must not be quoted as a hit rate. ` +
        (scan.hitCeiling
          ? `Scan ceiling of ${scan.teamGamesScanned} team games was reached; ` +
            `raise maxTeamGamesScanned if the player has a longer history.`
          : `Player history is exhausted; this is all the data that exists.`),
    };
  }

  const seasons = new Set(appearances.map(a => a.seasonYear));
  if (seasons.size > 1) {
    return {
      sufficient: true,
      warning:
        `Sample spans ${seasons.size} seasons. Cross-season form is weaker ` +
        `evidence than same-season form.`,
    };
  }

  return { sufficient: true, warning: null };
}
```

Set `sampleSufficient: false` in the response body **and** prefix the text content with the warning. The dual signal matters because a model skimming a large JSON blob may miss a nested boolean but will not miss a leading all-caps line.

---

## Also worth testing: BALLDONTLIE MLB game logs

You already pay for BALLDONTLIE ALL-STAR tier per sport and currently use it only for injuries. If their MLB stats endpoint supports querying by player ID with a date range, it sidesteps this entire windowing problem, because you would fetch player appearances directly instead of reconstructing them from team events.

Test before rebuilding the windowing logic:

```
GET https://api.balldontlie.io/mlb/v1/stats?player_ids[]={id}&seasons[]=2026&per_page=25
```

Check for: whether pitching stats are included, whether it supports `start_date` / `end_date`, and whether relief appearances are distinguishable from starts. If all three are yes, Fix 1 becomes a much smaller change and Fix 4 becomes considerably faster.

**Known field bug to carry over:** team is at `player.team.display_name`, not `player.team_name`.

---

## Implementation order

1. **Fix 6** — half a day, prevents unsupported picks from being written
2. **Fix 1** — one to two days, the actual root cause
3. **Fix 2** — a few hours, rides along with Fix 1
4. **Fix 3** — a few hours, halves call volume immediately
5. **Fix 4** — two to three days, the workflow transformation
6. **Fix 5** — one day, convenience wrapper over the above

Fixes 1, 2, 3 and 6 all touch `getHitRate` and should ship as one PR. Fixes 4 and 5 build on that and should ship second.

---

## Regression tests

Lock these in before deploying, using 8/9/2026 data:

| Case | Input | Expected after fix |
|---|---|---|
| Established starter | Logan Webb, `pitching_strikeouts`, 10 appearances | 10 starts returned, `sampleSufficient: true` |
| Recent callup | Connor Prielipp, `pitching_outs`, 10 appearances | Returns what exists, `sampleSufficient: false`, warning fires |
| No appearances | Cade Povich, `pitching_outs` | `sampleSufficient: false`, NO SAMPLE warning |
| Everyday batter | Ceddanne Rafaela, `batting_totalBases`, 15 | ~15 appearances, scan under 20 team games |
| Whole-number line | any `pitching_outs` at 15 | pushes counted separately, not as misses |
| Model price rejected | Mike Trout, `Strikeouts (batter)` | rejected before hit-rate computation |
| Scan ceiling | injured player, low `maxTeamGamesScanned` | terminates cleanly, `hitCeiling: true` |
| Screener | any 8/9 MLB eventID | one call, ranked list, no OOM |

---

## Note on the OOM crashes

The existing guidance to pass exact `oddIDs`, `playerID` and `bookmakerID` on every request was a workaround for unbounded fan-out. Fix 4 concentrates that fan-out in one place, so `mapWithConcurrency` with a limit of 4 and an explicit field projection on every upstream call is load-bearing, not optional. Do not let the screener fetch full event objects.
