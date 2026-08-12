import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import {
  extractPricedLine,
  roundToNearestTen,
  impliedProbability,
  computeEdge,
} from "../services/oddsPricing.js";
import { getPlayerHitRate } from "../services/hitRateAggregator.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * PROP SCREENER
 *
 * THE PROBLEM THIS SOLVES: building one thread meant 10-15 sequential calls -
 * pull the player list, pick a name, pull odds, pull the hit rate, discard,
 * repeat. On 2026-08-09 screening two MLB games by hand took 15 calls and yielded
 * exactly one prop that cleared the bar; seven of eight hitters checked came back
 * between 5 and 6 of 12, which is a coin flip. Across an 11-game slate that is
 * ~150 calls, almost all of it spent discarding.
 *
 * This sweeps a whole game in ONE upstream event fetch plus one hit-rate call per
 * surviving player/stat/line combination.
 *
 * RANKED BY EDGE, NOT HIT RATE. This is the key design decision. A raw hit rate
 * misleads: a Hoerner singles prop that morning read 7 of 11, which looks strong,
 * priced at -186 whose break-even is 65.0% against his actual 63.6%. Sorting by
 * hit rate floats that to the top; sorting by edge puts it below the line where it
 * belongs. Every row carries its break-even so the comparison cannot be skipped.
 *
 * TWO EXCLUSIONS HAPPEN BEFORE RANKING AND ARE NON-NEGOTIABLE:
 *   1. Model-estimated prices. SGO returns `fairOdds` when no book has posted and
 *      it is indistinguishable from a real price at a glance. extractPricedLine
 *      is the guardrail and is applied to every candidate.
 *   2. Insufficient samples. A rate on 1-2 appearances is a data point, not
 *      evidence, and is filtered out rather than surfaced with a caveat.
 *
 * MEMORY DISCIPLINE: this reads the event's full odds map, which on a game near
 * first pitch can exceed 1,000 markets. That is one bounded object for one event,
 * which is one bounded object for one event. What is NOT
 * done is a per-candidate event fetch, which would multiply that by several
 * hundred and reproduce the historical OOM crashes.
 */

const HIT_RATE_CONCURRENCY = 3;

/** Combo stats the hit-rate path cannot compute - there is no per-component log. */
const UNCOUNTABLE_STATIDS = new Set([
  "batting_hits+runs+rbi",
  "batting_runs+rbi",
  "points+rebounds",
  "points+assists",
  "points+rebounds+assists",
  "rebounds+assists",
  "blocks+steals",
  "fantasyScore",
]);

interface ScreenedProp {
  playerName: string;
  playerID: string;
  teamName: string;
  market: string;
  line: string;
  side: "over" | "under";
  americanOdds: string;
  roundedOdds: string;
  bookmaker: string;
  hitRate: string;
  hitRatePct: number;
  breakevenPct: number;
  edge: number;
  sample: number;
  /** The single most recent appearance, named so it cannot be inferred by position. */
  mostRecentGame: { date: string; value: number | null } | null;
  /** Newest first. Each entry carries its own date so direction is never ambiguous. */
  recentGamesNewestFirst: { date: string; value: number | null }[];
  availabilityFlag: string;
  availabilityNote: string | null;
  seasonWarning: string | null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R | null>
): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        const r = await fn(items[idx]!);
        if (r !== null) out.push(r);
      } catch {
        // One bad market must never abort the sweep.
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return out;
}

export function registerScreenPropsTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_screen_props",
    {
      title: "Screen every posted prop for a game, ranked by edge or hit rate",
      description: `THE FIRST CALL when building a pick thread. Sweeps every posted player prop for one event, computes the counted hit rate, and ranks by EDGE (hit rate minus break-even) or by raw HIT RATE, whichever the caller asks for.

EDGE VS HIT RATE - PICK THE RIGHT ONE FOR THE JOB:
  - rankBy="edge" (default) finds the best price-adjusted value. A prop showing 7 of 11 looks strong until you notice the price is -186, whose break-even is 65% against an actual 63.6%. Edge catches that.
  - rankBy="hitRate" plus minHitRate finds the props most likely to ACTUALLY WIN. Edge alone can surface a 40% prop at +220 because the maths works - a losing pick most nights, and the wrong answer for an account judged on visible win rate rather than closing-line value.

Set minHitRate=0.6 with maxAmericanOdds=-200 for a win-rate-first screen. Both fields are always returned, so the trade-off is never hidden either way.

AUTOMATICALLY EXCLUDED: model-estimated (fairOdds) prices that no book has posted, samples too small to be evidence, combo stats that cannot be counted, and prices shorter than maxAmericanOdds.

Replaces 10-15 manual tkb_get_odds + tkb_get_player_hit_rate calls per game.

Returns per prop: player, market, line, side, real price, roundedOdds (publishable form), book, hit rate, sample size, break-even, edge, last 6 values, and a playing-time flag.

Examples:
  - Use when: starting any pick thread and you need to know what is actually bettable
  - Use when: "what are the best props in this game?"
  - Use when: chasing win rate -> rankBy="hitRate", minHitRate=0.6, minEdge=0
  - Don't use when: you already know the exact player and market - use tkb_get_odds
  - Don't use when: props are not posted yet - it will tell you so

Empty result is informative: it means nothing cleared the bar, and the thread should lean on team-level markets instead of a padded prop.`,
      inputSchema: {
        sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]),
        eventID: z.string().describe("SGO eventID from tkb_get_schedule."),
        minSample: z
          .number()
          .int()
          .default(6)
          .describe("Minimum counted appearances. Below this a rate is not evidence."),
        minEdge: z
          .number()
          .default(0.05)
          .describe(
            "Minimum hitRate minus break-even. 0.05 = a 5 percentage point edge. Set 0 to see every priced prop with a real sample."
          ),
        minHitRate: z
          .number()
          .min(0)
          .max(1)
          .default(0)
          .describe(
            "Minimum counted hit rate, 0-1. A WIN-RATE FLOOR, separate from edge. 0.6 returns only props that have actually hit 60%+ of the time. Use this when the account is judged on visible wins rather than closing-line value - a +EV prop that hits 40% of the time is still a losing pick most nights."
          ),
        rankBy: z
          .enum(["edge", "hitRate"])
          .default("edge")
          .describe(
            "Sort order. 'edge' surfaces the best price-adjusted value. 'hitRate' surfaces the props most likely to actually win, which is usually what a free-picks account wants. Both fields are returned either way."
          ),
        maxAmericanOdds: z
          .number()
          .default(-200)
          .describe("Reject prices shorter than this. -200 rejects -250, allows -180."),
        markets: z
          .array(z.string())
          .optional()
          .describe("Optional market-label filter, e.g. ['Total Bases','Singles']."),
        maxPlayers: z
          .number()
          .int()
          .max(30)
          .default(18)
          .describe("Cap on players screened, keeps latency bounded."),
        limit: z.number().int().max(25).default(12),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      const leagueID = sgo.leagueIDFor(input.sport as SportKey);

      const catalog = OU_PROP_MARKETS[input.sport as SportKey] ?? [];
      const wanted = catalog.filter((m) => {
        if (UNCOUNTABLE_STATIDS.has(m.statID)) return false;
        if (input.markets && !input.markets.includes(m.label)) return false;
        return true;
      });

      if (wanted.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No countable markets for ${input.sport}` +
                (input.markets ? ` matching ${input.markets.join(", ")}` : "") +
                `. Available: ${catalog.map((m) => m.label).join(", ")}`,
            },
          ],
        };
      }

      const statIDToLabel = new Map(wanted.map((m) => [m.statID, m.label]));

      // ONE fetch. Reading the event's odds map directly avoids a per-candidate
      // request, which is what makes this tool viable rather than just relocating
      // the same 150 calls inside the server.
      const events = await sgo.getAllEvents({ leagueID, eventIDs: input.eventID });
      if (!events.length) {
        return {
          content: [
            { type: "text" as const, text: `No event found for eventID "${input.eventID}".` },
          ],
        };
      }

      const event = events[0]!;
      const homeID = event.teams.home.teamID;
      const awayID = event.teams.away.teamID;
      const teamNames: Record<string, string> = {
        [homeID]: event.teams.home.names?.long ?? homeID,
        [awayID]: event.teams.away.names?.long ?? awayID,
      };

      const roster = Object.values(event.players ?? {});
      if (roster.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No players attached to ${teamNames[awayID]} @ ${teamNames[homeID]} yet.\n\n` +
                `Sportsbooks have not posted player props for this game. SGO builds the ` +
                `player list from posted markets, so an empty roster means "not priced yet", ` +
                `not "no players". MLB props typically post the morning of the game.\n\n` +
                `Team-level markets (moneyline, spread, total) are available much earlier ` +
                `via tkb_get_odds.`,
            },
          ],
        };
      }

      const allowedPlayerIDs = new Set(
        roster.slice(0, input.maxPlayers).map((p) => p.playerID)
      );
      const playerByID = new Map(roster.map((p) => [p.playerID, p]));

      // Walk the posted odds map. oddID shape: statID-entity-period-betType-side
      interface Candidate {
        playerID: string;
        statID: string;
        line: number;
        side: "over" | "under";
        americanOdds: string;
        bookmaker: string;
      }
      const candidates: Candidate[] = [];

      for (const [oddID, odd] of Object.entries(event.odds ?? {})) {
        const parts = oddID.split("-");
        if (parts.length < 5) continue;

        const side = parts[parts.length - 1] as string;
        const betType = parts[parts.length - 2];
        const period = parts[parts.length - 3];
        const entity = parts[parts.length - 4] as string;
        const statID = parts.slice(0, parts.length - 4).join("-");

        if (betType !== "ou") continue;
        if (period !== "game") continue;
        if (side !== "over" && side !== "under") continue;
        if (!statIDToLabel.has(statID)) continue;
        if (!allowedPlayerIDs.has(entity)) continue;

        const priced = extractPricedLine(odd, {
          requireLine: true,
          marketDescription: `${statIDToLabel.get(statID)} for ${entity}`,
        });
        if (!priced.priced || !priced.value) continue;

        const american = parseInt(priced.value.americanOdds, 10);
        if (Number.isNaN(american)) continue;
        if (american < input.maxAmericanOdds) continue;

        const line = parseFloat(priced.value.line ?? "");
        if (Number.isNaN(line)) continue;

        candidates.push({
          playerID: entity,
          statID,
          line,
          side,
          americanOdds: priced.value.americanOdds,
          bookmaker: priced.value.bookmaker ?? "unknown",
        });
      }

      // Hit rates are memoised per player+stat+line, so both sides of a market
      // share a single upstream game-log fetch.
      const rateCache = new Map<string, Awaited<ReturnType<typeof getPlayerHitRate>>>();

      const screened = await mapWithConcurrency(
        candidates,
        HIT_RATE_CONCURRENCY,
        async (c): Promise<ScreenedProp | null> => {
          const player = playerByID.get(c.playerID);
          if (!player) return null;

          const key = `${c.playerID}|${c.statID}|${c.line}`;
          let rate = rateCache.get(key);
          if (!rate) {
            rate = await getPlayerHitRate(sgo, {
              sport: input.sport as SportKey,
              teamID: player.teamID,
              playerID: c.playerID,
              playerName: player.name,
              statID: c.statID,
              line: c.line,
              direction: c.side,
            });
            rateCache.set(key, rate);
          }

          if (!rate.sampleSufficient) return null;
          if (rate.gamesConsidered < input.minSample) return null;

          const hits = c.side === "over" ? rate.overHits : rate.underHits;
          const hitRatePct = hits / rate.gamesConsidered;
          const breakevenPct = impliedProbability(c.americanOdds);
          const edge = computeEdge(hitRatePct, c.americanOdds);
          if (edge < input.minEdge) return null;
          // WIN-RATE FLOOR, applied independently of edge. A prop can carry a
          // positive edge on a plus-money price while still losing most nights -
          // one screened on 2026-08-10 showed 6 of 15 (40%) at +220 and cleared
          // an edge filter comfortably. For an account judged on visible wins
          // rather than ROI, that is the wrong pick regardless of the maths.
          if (hitRatePct < input.minHitRate) return null;

          return {
            playerName: player.name,
            playerID: c.playerID,
            teamName: teamNames[player.teamID] ?? player.teamID,
            market: statIDToLabel.get(c.statID) ?? c.statID,
            line: String(c.line),
            side: c.side,
            americanOdds: c.americanOdds,
            roundedOdds: roundToNearestTen(c.americanOdds),
            bookmaker: c.bookmaker,
            hitRate: `${hits} of ${rate.gamesConsidered}`,
            hitRatePct: Number(hitRatePct.toFixed(3)),
            breakevenPct: Number(breakevenPct.toFixed(3)),
            edge: Number(edge.toFixed(3)),
            sample: rate.gamesConsidered,
            // DATED AND LABELLED DELIBERATELY. This was a bare number array
            // (`recentValues`) sorted newest-first, and on 2026-08-12 it was read
            // left-to-right as oldest-to-newest while writing a thread. Gunnar
            // Henderson's [7,0,0,0,0,0] - a 7-total-base game LAST NIGHT followed
            // by five earlier zeros - got published as "held to zero in five
            // consecutive starts", the exact inverse of the truth.
            //
            // Every existing guardrail passed, because none of them were wrong:
            // the odds were real, the sample was real, the 13-of-15 hit rate was
            // computed correctly. The error was in PROSE describing the array, and
            // no data check can catch that. So the fix is to make the ordering
            // impossible to misread rather than merely documented: each value now
            // carries its own date and the most recent game is named outright.
            mostRecentGame: (() => {
              const g = rate.log.find((x) => x.statValue !== null);
              return g ? { date: g.date.slice(0, 10), value: g.statValue } : null;
            })(),
            recentGamesNewestFirst: rate.log
              .filter((g) => g.statValue !== null)
              .slice(0, 6)
              .map((g) => ({ date: g.date.slice(0, 10), value: g.statValue })),
            availabilityFlag: rate.recentAvailability.flag,
            availabilityNote: rate.recentAvailability.note,
            seasonWarning: rate.seasonWarning,
          };
        }
      );

      screened.sort((a, b) =>
        input.rankBy === "hitRate"
          ? b.hitRatePct - a.hitRatePct || b.edge - a.edge
          : b.edge - a.edge || b.hitRatePct - a.hitRatePct
      );
      const top = screened.slice(0, input.limit);

      const filterSummary =
        `minSample ${input.minSample} / minEdge ${input.minEdge} / ` +
        `minHitRate ${input.minHitRate} / maxAmericanOdds ${input.maxAmericanOdds}`;

      const summary =
        top.length === 0
          ? `NOTHING CLEARED. Screened ${candidates.length} priced markets across ` +
            `${allowedPlayerIDs.size} players in ${teamNames[awayID]} @ ${teamNames[homeID]}, ` +
            `and none met ${filterSummary}. This is a real answer, not an ` +
            `error - build this thread from team-level markets rather than padding it ` +
            `with a coin-flip prop.`
          : `${top.length} prop(s) cleared, ranked by ${input.rankBy}. Screened ${candidates.length} ` +
            `priced markets across ${allowedPlayerIDs.size} players. Use roundedOdds when ` +
            `publishing. Check availabilityFlag before locking any pick.`;

      return {
        content: [
          { type: "text" as const, text: `${summary}\n\n${JSON.stringify(top, null, 2)}` },
        ],
        structuredContent: {
          eventID: input.eventID,
          matchup: `${teamNames[awayID]} @ ${teamNames[homeID]}`,
          pricedMarketsScreened: candidates.length,
          qualified: screened.length,
          props: top,
        },
      };
    }
  );
}
