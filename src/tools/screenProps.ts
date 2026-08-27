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
import { getBdlPlayerHitRate } from "../services/bdlHitRateAggregator.js";
import { isStatSupported } from "../services/bdlStatMap.js";
import { describeRecency, STARTING_PITCHER_THRESHOLDS } from "../services/sampleRecency.js";
import { parseOddID } from "../services/oddIdParser.js";
import type { BDLClient } from "../services/bdlClient.js";
import {
  SUPPORTED_SPORTS,
  supportsCapability,
  unsupportedMessage,
  type SportKey,
} from "../constants.js";

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
 * first pitch can exceed 1,000 markets. That is one bounded object for one event.
 * What is NOT done is a per-candidate event fetch, which would multiply that by
 * several hundred and reproduce the historical OOM crashes.
 */

const HIT_RATE_CONCURRENCY = 3;

/**
 * THE BOOKS THIS ACCOUNT'S AUDIENCE CAN ACTUALLY BET.
 *
 * A DEFAULT RATHER THAN A PROMPT ARGUMENT, DELIBERATELY. Passing this from the
 * nightly tasks was listed as an open follow-up in v2.5.3 and again in v2.5.4,
 * and was still not being passed as of v2.6.1. Two releases is enough evidence
 * that a thing which must be remembered every time will not be. There is no
 * situation where this account wants a board ranked against a book its followers
 * cannot bet, so this is a policy rather than a parameter, and policies belong in
 * code - the same reasoning that moved "never publish fair odds" out of prose and
 * into extractPricedLine.
 *
 * FANDUEL STAYS IN THE LIST. Every WNBA prop screened on 2026-08-19 was priced by
 * FanDuel, and five of six again on 2026-08-24. Dropping it empties that board.
 *
 * BEHAVIOUR CHANGE WORTH KNOWING: this WILL sometimes return fewer props, or an
 * empty board, on games where only excluded venues priced a market. That is the
 * correct answer - "nothing bettable here" beats a prop priced at Bovada - and the
 * empty-result message says which of the two happened so it never reads as a
 * silent failure.
 */
const DEFAULT_BOOKMAKERS = "draftkings,fanduel,betmgm,caesars";

/**
 * HOW MANY PLAYERS TO SCREEN, BY SPORT.
 *
 * A FLAT DEFAULT OF 18 WAS SILENTLY CLIPPING MLB. Measured 2026-08-24: five of
 * six MLB games reported exactly 18 players screened while the availability probe
 * covered 20 to 22 on the same events. The probe uses the FULL event roster and
 * screening used the capped one, so 2 to 4 players per game were never evaluated -
 * every game, invisibly, because a board of 18 looks perfectly healthy.
 *
 * The excluded players are not the worst ones. `roster.slice(0, maxPlayers)` cuts
 * on SGO's response order, which is not sorted by minutes, usage, or anything
 * else. On the WNBA game screened the same day, capping at 10 of 14 removed Maya
 * Caldwell, who was the 4th-best prop on the board at 11 of 15.
 *
 * COST OF RAISING IT IS LATENCY, NOT QUOTA. The team history is fetched once and
 * cached; each extra player only reads from it, and MLB rates come from
 * BALLDONTLIE which has no object cap. The binding constraint is the 60-second
 * tool ceiling via BDL's 1,100ms throttle, so roughly 2 extra requests per extra
 * player. Four more MLB players is about 9 seconds.
 *
 * CFB STAYS AT 18 DELIBERATELY. Its rosters are genuinely huge and a cap is doing
 * real work there rather than quietly losing everyday starters.
 */
const DEFAULT_MAX_PLAYERS: Record<SportKey, number> = {
  mlb: 24,   // rosters observed at 20-22
  wnba: 20,  // rosters observed at 14, ample headroom
  nfl: 24,   // 22 observed on a Week 1 game
  cfb: 18,   // large rosters, cap is intentional
  atp: 0,    // no roster - refused by the capability guard before reaching here
  wta: 0,
};

/**
 * HOW MANY PROPS ONE PLAYER MAY OCCUPY ON A RETURNED BOARD.
 *
 * THE PROBLEM, MEASURED 2026-08-24. A Padres/Pirates board returned six props
 * belonging to THREE players: Fernando Tatis Jr. took three slots, Nick Yorke two,
 * Brandon Lowe one. A Tigers/Rays board gave Dillon Dingler four of the top
 * twenty-five. Nothing was wrong with any individual prop - they ranked where they
 * ranked - but a board is supposed to answer "what are the best plays in this
 * game", and one that is half Tatis answers a narrower question.
 *
 * WHY THIS MATTERS BEYOND VARIETY. This account posts two player props per thread.
 * If the top two slots are the same player, the thread has one real opinion in it
 * rather than two, and the two picks rise and fall together - a correlated pair
 * presented as independent. That is a worse bet than it looks, and the reader
 * cannot see it.
 *
 * DEFAULT 2, NOT 1. One would throw away genuinely different markets on the same
 * player (a hits prop and a strikeouts prop are not the same read), and would make
 * the board thinner on games where few players clear the bar. Two guarantees a
 * 12-prop board draws on at least six players while still allowing a real
 * double-up when a player is the story of the game.
 *
 * SUPPRESSED PROPS ARE COUNTED AND REPORTED, never silently dropped. A board that
 * quietly hides its own filtering is the failure mode this connector keeps finding.
 */
const DEFAULT_MAX_PER_PLAYER = 2;

/** Playing-time picture for one player, derived from real team game history. */
export interface AvailabilityInfo {
  gamesPlayed: number;
  teamGamesScanned: number;
  playRate: number;
  flag: "OK" | "IRREGULAR";
  note: string | null;
}

/**
 * ONE SGO fetch per team, reused for every player on that roster.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE HIT RATE. BALLDONTLIE returns only games a
 * player actually appeared in, so a bench bat who has started 8 of the last 30
 * looks identical to an everyday regular. The hit rate is correct either way -
 * what disappears is the CONTEXT that the rate was compiled from sporadic
 * appearances.
 *
 * That context has repeatedly been the deciding factor: Bobby Witt Jr. screened
 * 12 of 15 while playing 15 of 28 team games, Cameron Brink 11 of 15 while
 * missing 8 of 23, and Azzi Fudd 12 of 15 having not played in a week. Each
 * would have been published on the strength of the rate alone.
 *
 * Cost is bounded: the client caches team histories, so a two-team game pays
 * roughly 60 entities total no matter how many players get screened. That is a
 * deliberate trade - a small fixed cost to keep a safeguard that has caught
 * something nearly every day.
 */
async function probeTeamAvailability(
  sgo: SGOClient,
  sport: SportKey,
  teamID: string,
  rosterIDs: Set<string>
): Promise<Map<string, AvailabilityInfo>> {
  const result = new Map<string, AvailabilityInfo>();
  try {
    const now = new Date();
    const windowStart = new Date(now);
    // THIRTY DAYS, NOT SIXTY. SGO's default ordering for finalized events is
    // confirmed NOT to be most-recent-first, so asking for one page of 30 out of
    // a 60-day window returned an arbitrary 30 of roughly 50 games - often the
    // oldest. That is how Alejandro Kirk was reported at "2 of the last 30 team
    // games" on 2026-08-15 while actually starting 4 of his last 6: the window
    // simply did not contain his recent starts.
    //
    // A 30-day window holds roughly 26 games for an MLB club, so a single page
    // of 30 captures essentially all of them and recency is guaranteed by the
    // date bound rather than by trusting API ordering.
    windowStart.setDate(windowStart.getDate() - 30);

    const events = await sgo.getAllEvents(
      {
        leagueID: sgo.leagueIDFor(sport),
        teamID,
        finalized: true,
        startsAfter: windowStart.toISOString(),
        startsBefore: now.toISOString(),
        // Narrow the odds payload to a single market - only results are read here.
        oddIDs: "points-home-game-ml-home",
        limit: 30,
        // Belt and braces with the maxPages: 1 below. maxEvents states the
        // intent ("thirty games") in the same terms every other call site now
        // uses, so the denominator in the IRREGULAR note stays honest even if
        // the page argument is ever dropped.
        maxEvents: 30,
      },
      // ONE PAGE. `limit` is the PAGE SIZE in getAllEvents, not a total cap, and
      // the default maxPages of 10 turned "limit: 30" into up to 300 events.
      1
    );

    // Sort newest-first and cap, so the denominator is genuinely "recent games"
    // even if the window happens to hold more than one page.
    const recent = [...events]
      .sort((a, b) => {
        const da = a.status?.startsAt ? new Date(a.status.startsAt).getTime() : 0;
        const db = b.status?.startsAt ? new Date(b.status.startsAt).getTime() : 0;
        return db - da;
      })
      .slice(0, 30);

    const teamGames = recent.length;
    if (teamGames === 0) return result;

    // COUNT ONLY THIS TEAM'S ROSTER. An event's results object holds BOTH teams'
    // players, so tallying every key counted opponents too - each appearing in
    // one or two of the thirty games and therefore landing under the 0.7 play
    // rate. That produced "629 players covered, 613 flagged IRREGULAR" for a
    // two-team game, which is noise rather than a signal.
    const appearances = new Map<string, number>();
    for (const event of recent) {
      const period = event.results?.["game"];
      if (!period) continue;
      for (const playerID of Object.keys(period)) {
        if (!rosterIDs.has(playerID)) continue;
        appearances.set(playerID, (appearances.get(playerID) ?? 0) + 1);
      }
    }

    for (const [playerID, played] of appearances) {
      const playRate = played / teamGames;
      const irregular = playRate < 0.7;
      result.set(playerID, {
        gamesPlayed: played,
        teamGamesScanned: teamGames,
        playRate: Number(playRate.toFixed(2)),
        flag: irregular ? "IRREGULAR" : "OK",
        note: irregular
          ? `PLAYING TIME RISK: appeared in only ${played} of the last ${teamGames} ` +
            `team games. This player is not an everyday lock. CONFIRM THE POSTED ` +
            `LINEUP before using this prop, and do not describe the hit rate as ` +
            `current form without noting the missed time.`
          : null,
      });
    }
  } catch {
    // A failed probe means no flag, not a wrong flag. Screening continues and the
    // caller is told availability was unavailable rather than being told "OK".
  }
  return result;
}

/** Combo stats the hit-rate path cannot compute - there is no per-component log. */
/**
 * Stats the SGO aggregator cannot count.
 *
 * SGO exposes one value per statID in an event's results object, with no way to
 * add components together, so a "Points + Rebounds" line has no countable
 * source. Publishing a hit rate for one would mean inventing it.
 *
 * THE BDL PATH CAN COMPUTE THESE EXACTLY, because a single stat row carries
 * every component. So the exclusion is now conditional: a combo stat is allowed
 * through when bdlStatMap has a derivation for it, and blocked otherwise. That
 * unlocks Points + Rebounds, Reb + Ast, Pts + Reb + Ast and Hits + Runs + RBIs
 * without loosening the rule that an uncountable stat never gets a rate.
 *
 * fantasyScore stays excluded on every path - scoring formulas vary by book and
 * are not reconstructible from a box score.
 */
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

/** Never computable from a box score regardless of provider. */
const NEVER_COUNTABLE = new Set(["fantasyScore"]);

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
  /** True when the counted games are not recent - see services/sampleRecency.ts. */
  sampleIsStale: boolean;
  /** Prose naming which recency check fired, or null when the sample is current. */
  stalenessNote: string | null;
  daysSinceMostRecentGame: number | null;
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

/**
 * Cap how many props any one player may occupy, preserving rank order.
 *
 * APPLIED AFTER RANKING, NEVER BEFORE. Ranking first guarantees the props that
 * survive are each player's BEST ones. A player's third-best prop is dropped;
 * their best is never touched, so diversifying can only change WHICH marginal
 * props appear, never demote a genuinely top-ranked play.
 *
 * Exported and pure so this is testable without a network. The v2.6.0 stale-window
 * bug shipped precisely because logic that changes which data reaches the user was
 * buried inside a function needing an API client.
 */
export function diversifyByPlayer<T extends { playerID: string }>(
  ranked: T[],
  maxPerPlayer: number
): { kept: T[]; suppressed: number } {
  const seen = new Map<string, number>();
  const kept: T[] = [];
  let suppressed = 0;
  for (const p of ranked) {
    const n = seen.get(p.playerID) ?? 0;
    if (n >= maxPerPlayer) {
      suppressed++;
      continue;
    }
    seen.set(p.playerID, n + 1);
    kept.push(p);
  }
  return { kept, suppressed };
}

export function registerScreenPropsTool(server: McpServer, sgo: SGOClient, bdl: BDLClient) {
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
          .optional()
          .describe(
            "Cap on players screened. Defaults BY SPORT: mlb 24, nfl 24, wnba 20, cfb 18. Raise only if a roster is unusually large - the cut is on SGO's response order, NOT on player quality, so a low cap silently removes everyday starters rather than fringe players. Costs latency, not quota."
          ),
        maxPerPlayer: z
          .number()
          .int()
          .min(1)
          .max(6)
          .default(DEFAULT_MAX_PER_PLAYER)
          .describe(
            "Max props ONE player may occupy on the returned board (default 2). Prevents a single player taking most of the slots - measured 2026-08-24, one board returned 6 props across only 3 players, with Tatis holding 3 of them. Since threads post two player props, an undiversified board means two correlated picks presented as independent reads. Set higher only when deliberately building a single-player thread."
          ),
        preferredBookmakers: z
          .string()
          .default(DEFAULT_BOOKMAKERS)
          .describe(
            "Comma-separated bookmaker IDs to price against. DEFAULTS to 'draftkings,fanduel,betmgm,caesars' - the books this account's audience can actually bet. Pass a different list to override, or 'all' to disable the filter entirely (diagnostic only, not for building threads). Without a filter the screen prices each prop from whichever book appears first in SGO's response: measured across 6 MLB games on 2026-08-24, only 69% of props came from DraftKings or FanDuel, with the rest split across Hard Rock, ProphetX, ESPN Bet and Bovada. Edge is computed from that price, so an unbettable one silently corrupts the RANKING, not just the display."
          ),
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
      // Without this, an empty tennis catalog produces "No countable markets for
      // atp. Available: " with nothing after the colon - accurate, and useless
      // about why. The capability message explains that it is structural.
      if (!supportsCapability(input.sport as SportKey, "playerProps")) {
        return {
          content: [
            {
              type: "text" as const,
              text: unsupportedMessage(input.sport as SportKey, "playerProps"),
            },
          ],
        };
      }

      const leagueID = sgo.leagueIDFor(input.sport as SportKey);
      const maxPlayers =
        input.maxPlayers ?? DEFAULT_MAX_PLAYERS[input.sport as SportKey];

      const catalog = OU_PROP_MARKETS[input.sport as SportKey] ?? [];
      const wanted = catalog.filter((m) => {
        // Blocked only if BDL also cannot derive it. fantasyScore is never
        // countable; the rest become countable once a BDL derivation exists.
        if (NEVER_COUNTABLE.has(m.statID)) return false;
        if (
          UNCOUNTABLE_STATIDS.has(m.statID) &&
          !isStatSupported(input.sport as SportKey, m.statID)
        ) {
          return false;
        }
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
      // PRICE AGAINST THE BOOKS YOU CAN ACTUALLY BET. SGO returns every book that
      // priced a market, and firstAvailableBook() in oddsPricing simply takes the
      // first entry it finds - there is no preference ordering - so the displayed
      // price was effectively arbitrary. Filtering at the request means the odds,
      // the break-even and therefore the EDGE RANKING all reflect a real,
      // obtainable number. It also shrinks the payload and the candidate list.
      // "all" is an explicit opt-out for diagnostics - it is how the book
      // distribution above was measured. Anything else is passed through as a
      // filter on the fetch itself, which also shrinks the payload.
      const bookFilter =
        input.preferredBookmakers.trim().toLowerCase() === "all"
          ? undefined
          : input.preferredBookmakers;

      const events = await sgo.getAllEvents({
        leagueID,
        eventIDs: input.eventID,
        bookmakerID: bookFilter,
      });
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

      const rosterClipped = roster.length > maxPlayers;
      const allowedPlayerIDs = new Set(
        roster.slice(0, maxPlayers).map((p) => p.playerID)
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
        // HARDENED IN v2.6.5. This previously sliced the last four segments off
        // by position, which silently misreads the documented six-segment form
        // (...-betType-side-bookmakerID) by treating the bookmaker as the side.
        // The shared parser anchors on the closed betType/side vocabularies
        // instead of counting, and refuses rather than guessing.
        const parsed = parseOddID(oddID);
        if (!parsed) continue;

        const { side, betType, period, entity, statID } = parsed;

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
          side: side as "over" | "under",
          americanOdds: priced.value.americanOdds,
          bookmaker: priced.value.bookmaker ?? "unknown",
        });
      }

      // ---- BDL-FIRST HIT RATES WITH A SHARED AVAILABILITY PROBE ----
      //
      // WHY THIS IS SPLIT IN TWO. Hit rates and playing-time risk come from the
      // same SGO fetch today, and that fetch is what makes screening expensive:
      // SGO has no player game-log endpoint, so computing one rate means pulling
      // a whole TEAM's recent history. A starting pitcher appears in roughly 1 of
      // every 5 team games, so collecting 10 starts scans up to 140 events.
      // Measured 2026-08-14: ~1,080 entities per game, and two pitcher props can
      // cost more than all 18 hitters combined.
      //
      // BALLDONTLIE returns rows for ONE PLAYER directly and has no monthly
      // object cap, so moving the rate calculation there removes the cost almost
      // entirely. Verified game-for-game against SGO on 2026-08-12.
      //
      // BUT BDL ONLY RETURNS GAMES THE PLAYER APPEARED IN. DNPs are invisible,
      // which means the IRREGULAR playing-time flag cannot be computed from it.
      // That flag is not decorative - it vetoed Bobby Witt Jr. (15 of 28 team
      // games), Gary Sanchez, Rhys Hoskins and Cameron Brink in a single week,
      // each of whom screened with a strong hit rate while quietly missing time.
      // Dropping it to save entities would trade a real accuracy safeguard for
      // money, which is the wrong trade.
      //
      // So: rates come from BDL (cheap, per-player), and availability comes from
      // ONE SGO team-history fetch per team, shared across every player on that
      // roster via the client's existing cache. Two teams per game means the
      // safeguard costs ~60 entities total rather than ~30 per player.
      // PROMISES, NOT VALUES. Three workers run concurrently, so storing only
      // resolved rates let all three miss the same key before any of them wrote
      // it - triggering three identical upstream fetches. Caching the in-flight
      // promise means the second and third callers await the first one's work.
      // This is what inflated the source counters on 2026-08-14 (235 counted
      // computations across ~120 unique player+stat+line keys).
      const rateCache = new Map<
        string,
        Promise<Awaited<ReturnType<typeof getPlayerHitRate>>>
      >();
      const availabilityByTeam = new Map<string, Map<string, AvailabilityInfo>>();
      let bdlServed = 0;
      let sgoFallback = 0;
      const bdlFailures = new Map<string, number>();

      const availabilityFor = async (
        teamID: string,
        playerID: string,
        statID: string
      ): Promise<AvailabilityInfo | null> => {
        let team = availabilityByTeam.get(teamID);
        if (!team) {
          const rosterIDs = new Set(
            roster.filter((p) => p.teamID === teamID).map((p) => p.playerID)
          );
          team = await probeTeamAvailability(
            sgo,
            input.sport as SportKey,
            teamID,
            rosterIDs
          );
          availabilityByTeam.set(teamID, team);
        }
        const info = team.get(playerID) ?? null;
        if (!info) return null;

        // STARTING PITCHERS ARE EXEMPT FROM THE PLAY-RATE TEST. A starter works
        // every fifth game, so appearing in 6 of 30 is a healthy rotation arm on
        // normal rest, not a player losing playing time. Flagging that as
        // IRREGULAR is not a conservative error - it is a false positive that
        // trains the reader to ignore the flag, which then costs a real catch
        // like Bobby Witt Jr. at 15 of 28.
        //
        // The SGO aggregator carried this exemption from the start; the probe
        // added in v2.4.0 did not, and on 2026-08-15 it flagged Cam Schlittler
        // at "6 of the last 30" while he was simply pitching on schedule.
        if (statID.startsWith("pitching_")) {
          return {
            ...info,
            flag: "OK",
            note: null,
          };
        }
        return info;
      };

      const screened = await mapWithConcurrency(
        candidates,
        HIT_RATE_CONCURRENCY,
        async (c): Promise<ScreenedProp | null> => {
          const player = playerByID.get(c.playerID);
          if (!player) return null;

          const key = `${c.playerID}|${c.statID}|${c.line}`;
          let pending = rateCache.get(key);
          if (!pending) {
            pending = (async () => {
            let rate: Awaited<ReturnType<typeof getPlayerHitRate>> | undefined;
            // Try BDL first. Any failure - tier gate, unmapped stat, ambiguous
            // name, unresolvable dates - falls back to SGO rather than degrading
            // the answer. Cost is the thing that degrades, never correctness.
            //
            // FAILURE REASONS ARE COUNTED, NOT SWALLOWED. A silent catch here
            // produced exactly one bad outcome on 2026-08-14: 217 of 235 rates
            // fell back to SGO, the screen cost 1,195 entities instead of the
            // projected 100, and the output gave no indication why. A fallback
            // that hides its own cause is indistinguishable from a fallback that
            // never fires.
            if (isStatSupported(input.sport as SportKey, c.statID)) {
              try {
                const bdlRate = await getBdlPlayerHitRate(bdl, {
                  sport: input.sport as SportKey,
                  playerName: player.name,
                  statID: c.statID,
                  line: c.line,
                  direction: c.side,
                  teamName: teamNames[player.teamID] ?? undefined,
                });
                rate = bdlRate as unknown as Awaited<ReturnType<typeof getPlayerHitRate>>;
                bdlServed++;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // Bucket by cause so the pattern is visible at a glance rather
                // than requiring 200 individual messages to be read.
                const bucket = msg.includes("AMBIGUOUS PLAYER")
                  ? "ambiguous name"
                  : msg.includes("No BALLDONTLIE player found")
                    ? "player not found"
                    : msg.includes("DATE RESOLUTION FAILED")
                      ? "dates unresolvable"
                      : msg.includes("auth error") || msg.includes("401")
                        ? "tier gate"
                        : msg.includes("rate limit") || msg.includes("429")
                          ? "BDL rate limit"
                          : "other";
                bdlFailures.set(bucket, (bdlFailures.get(bucket) ?? 0) + 1);
                rate = undefined;
              }
            } else {
              bdlFailures.set(
                "stat not mapped",
                (bdlFailures.get("stat not mapped") ?? 0) + 1
              );
            }
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
              sgoFallback++;
            }
            return rate;
            })();
            rateCache.set(key, pending);
          }
          const rate = await pending;

          if (!rate.sampleSufficient) return null;
          if (rate.gamesConsidered < input.minSample) return null;

          const avail = await availabilityFor(player.teamID, c.playerID, c.statID);

          const recency = describeRecency(
            rate.log,
            c.statID.startsWith("pitching_") ? STARTING_PITCHER_THRESHOLDS : {}
          );

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
            // From the shared per-team SGO probe, NOT from the rate object. The
            // BDL path cannot see DNPs, so its own flag would read "OK" for a
            // player who has been sitting. Falls back to the rate's flag only
            // when the probe returned nothing for this player.
            availabilityFlag: avail?.flag ?? rate.recentAvailability.flag,
            // `avail?.note ?? rate...note` was WRONG. A player the probe covered
            // and found healthy has note === null, so ?? fell straight through to
            // the BDL disclaimer. Every healthy MLB position player therefore
            // displayed "Playing-time risk is NOT assessed on this path" while
            // simultaneously being flagged OK - teaching the writer to distrust a
            // safeguard that was working. Choose the SOURCE first, then its note.
            availabilityNote: avail ? avail.note : rate.recentAvailability.note,
            seasonWarning: rate.seasonWarning,
            // DELIBERATELY A WARNING, NOT A FILTER. Chris Bassitt screened 8 of 10
            // on 2026-08-19 with one of those ten starts inside the last 30 days,
            // the rest from May and June, and seasonWarning was null because it
            // was all one season. The under may still be correct; what it cannot
            // be is written as "his last 10" without saying when they happened.
            sampleIsStale: recency.isStale,
            stalenessNote: recency.warning,
            daysSinceMostRecentGame: recency.daysSinceMostRecent,
          };
        }
      );

      screened.sort((a, b) =>
        input.rankBy === "hitRate"
          ? b.hitRatePct - a.hitRatePct || b.edge - a.edge
          : b.edge - a.edge || b.hitRatePct - a.hitRatePct
      );

      const { kept: diversified, suppressed: suppressedByDiversity } =
        diversifyByPlayer(screened, input.maxPerPlayer);

      const top = diversified.slice(0, input.limit);
      const distinctPlayers = new Set(top.map((p) => p.playerID)).size;

      const filterSummary =
        `minSample ${input.minSample} / minEdge ${input.minEdge} / ` +
        `minHitRate ${input.minHitRate} / maxAmericanOdds ${input.maxAmericanOdds}`;

      const summary =
        top.length === 0
          ? `NOTHING CLEARED. Screened ${candidates.length} priced markets across ` +
            `${allowedPlayerIDs.size} players in ${teamNames[awayID]} @ ${teamNames[homeID]}, ` +
            `and none met ${filterSummary}. This is a real answer, not an ` +
            `error - build this thread from team-level markets rather than padding it ` +
            `with a coin-flip prop.` +
            `\n\nTO SEE THE BOARD ANYWAY, use tkb_get_prop_board. It prints every priced ` +
            `market with no hit-rate requirement. That is the right call when the sport ` +
            `has no rate source at all - early-season CFB, or any WNBA market while BDL ` +
            `gates player stats - where this screener will always return empty no matter ` +
            `how low the thresholds go.` +
            (bookFilter
              ? `\n\nNOTE: priced against ${bookFilter} only. A market that exists but ` +
                `was only priced by an excluded venue is invisible here BY DESIGN, so ` +
                `"nothing cleared" and "nothing cleared at your books" are different ` +
                `statements. To see the unfiltered board for diagnosis, re-run with ` +
                `preferredBookmakers="all" - but never publish a price from it.`
              : `\n\nNOTE: the book filter was disabled (preferredBookmakers="all"), so ` +
                `this board may contain prices from venues your audience cannot bet.`)
          : `${top.length} prop(s) cleared across ${distinctPlayers} player(s), ranked by ` +
            `${input.rankBy}. Screened ${candidates.length} priced markets across ` +
            `${allowedPlayerIDs.size} players. Use roundedOdds when publishing. Check ` +
            `availabilityFlag before locking any pick.`;

      // Routing visibility. If bdlServed is 0 on a sport that should be mapped,
      // every rate came from SGO and the screen cost roughly 10x what it should -
      // worth noticing immediately rather than discovering it at the quota wall.
      // NEVER FILTER SILENTLY. Both of these change WHICH props are visible, so
      // both are stated outright rather than left for the reader to infer from a
      // board that looks complete.
      const diversityLine = suppressedByDiversity
        ? ` Diversity: ${suppressedByDiversity} lower-ranked prop(s) suppressed so no ` +
          `player exceeds ${input.maxPerPlayer} on the board; ${distinctPlayers} distinct ` +
          `player(s) shown. Raise maxPerPlayer to see them.`
        : ` Diversity: ${distinctPlayers} distinct player(s) shown, none capped.`;

      const rosterLine = rosterClipped
        ? ` ROSTER CLIPPED: ${roster.length} players attached, ${maxPlayers} screened. ` +
          `The cut follows SGO's response order, not player quality, so raise ` +
          `maxPlayers if this game matters.`
        : "";

      const bookLine = bookFilter
        ? `Priced against: ${bookFilter}.`
        : `Priced against ALL venues - book filter disabled. Diagnostic only; ` +
          `do NOT publish prices from this board without re-pulling at your books.`;

      const routing =
        bdlServed + sgoFallback === 0
          ? `\n\n${bookLine}${rosterLine}${diversityLine}`
          : `\n\n${bookLine}${rosterLine}${diversityLine} Rate sources: ${bdlServed} from BALLDONTLIE (no SGO quota), ` +
            `${sgoFallback} from SportsGameOdds.` +
            (bdlFailures.size
              ? ` BDL fallback reasons: ` +
                [...bdlFailures.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, n]) => `${reason} (${n})`)
                  .join(", ") +
                `.`
              : "") +
            (() => {
              // REPORT COVERAGE, NOT ATTEMPTS. A failed probe returns an empty
              // map but still counts as a "probed team", so counting teams made
              // a total failure look identical to a clean slate - the precise
              // blind spot this safeguard exists to close.
              const covered = [...availabilityByTeam.values()].reduce(
                (n, m) => n + m.size,
                0
              );
              const flagged = [...availabilityByTeam.values()].reduce(
                (n, m) => n + [...m.values()].filter((a) => a.flag === "IRREGULAR").length,
                0
              );
              return covered === 0
                ? ` AVAILABILITY UNAVAILABLE: the playing-time probe returned no data for ` +
                  `${availabilityByTeam.size} team(s), so no IRREGULAR flag can be trusted ` +
                  `on this screen. Confirm lineups manually.`
                : ` Availability: ${covered} player(s) covered across ` +
                  `${availabilityByTeam.size} team(s), ${flagged} flagged IRREGULAR.`;
            })();

      return {
        content: [
          { type: "text" as const, text: `${summary}${routing}\n\n${JSON.stringify(top, null, 2)}` },
        ],
        structuredContent: {
          eventID: input.eventID,
          matchup: `${teamNames[awayID]} @ ${teamNames[homeID]}`,
          pricedMarketsScreened: candidates.length,
          qualified: screened.length,
          playersScreened: allowedPlayerIDs.size,
          playersAttached: roster.length,
          rosterClipped,
          distinctPlayersShown: distinctPlayers,
          suppressedByDiversity,
          props: top,
        },
      };
    }
  );
}
