import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import type { BDLClient } from "../services/bdlClient.js";
import type { CFBDClient } from "../services/cfbdClient.js";
import type { CBBDClient } from "../services/cbbdClient.js";
import type { EspnClient } from "../services/espnClient.js";
import { registerScreenPropsTool } from "./screenProps.js";
import { slateDayBounds } from "../services/slateDay.js";
import { narrowingOddID } from "../services/oddIdBuilder.js";
import { enumerateSlate } from "../services/slateEvents.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * tkb_screen_slate. ADDED v2.20.0.
 *
 * WHY. tkb_screen_props takes ONE eventID, so a 12-game NBA night was 12 calls, each a
 * round trip through the model. This runs the SAME screen (the exact registered
 * tkb_screen_props handler, parsed through its own schema so every default is
 * identical) over every game on a date, and returns one ranked board.
 *
 * TIME BUDGET. Tools have a ~60 second ceiling. Games run three at a time, and no new
 * game is started after 40 seconds; any game not reached is LISTED, never dropped
 * silently, so the caller can screen it individually.
 */

type Handler = (p: unknown) => Promise<{ content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>;

const SlateInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]),
    date: z
      .string()
      .optional()
      .describe("YYYY-MM-DD, a PACIFIC calendar day (same meaning as tkb_get_schedule date). Use this OR eventIDs."),
    eventIDs: z.array(z.string()).min(1).max(15).optional().describe("Explicit eventIDs instead of a date, up to 15."),
    limit: z.number().int().min(1).max(60).default(20).describe("Props on the combined board."),
    perGameLimit: z.number().int().min(1).max(25).default(6).describe("Props kept per game before combining."),
    rankBy: z.enum(["edge", "hitRate"]).default("edge"),
    minEdge: z.number().optional(),
    minHitRate: z.number().min(0).max(1).optional(),
    minSample: z.number().int().optional(),
    maxAmericanOdds: z.number().optional(),
    maxPerPlayer: z.number().int().min(1).max(6).optional(),
    includePriorSeason: z.boolean().optional(),
    minCurrentSeasonGames: z.number().int().min(0).optional(),
    preferredBookmakers: z.string().optional(),
  })
  .strict();

type SlateInput = z.infer<typeof SlateInputSchema>;

const CONCURRENCY = 3;
const START_DEADLINE_MS = 40_000;

export function registerScreenSlateTool(
  server: McpServer,
  sgo: SGOClient,
  bdl: BDLClient,
  cfbd: CFBDClient | null,
  cbbd: CBBDClient | null,
  espn: EspnClient | null
) {
  // Capture the real single-game screen: same handler, same schema, same defaults.
  let screenOne: Handler | null = null;
  let screenSchema: { parse: (v: unknown) => unknown } | null = null;
  registerScreenPropsTool(
    {
      registerTool: (_n: string, def: { inputSchema?: unknown }, h: Handler) => {
        screenOne = h;
        // tkb_screen_props registers a raw zod SHAPE, not a z.object, so wrap it.
        const raw = def.inputSchema as { parse?: (v: unknown) => unknown } | Record<string, z.ZodTypeAny>;
        screenSchema =
          raw && typeof (raw as { parse?: unknown }).parse === "function"
            ? (raw as { parse: (v: unknown) => unknown })
            : z.object(raw as Record<string, z.ZodTypeAny>);
      },
    } as never,
    sgo,
    bdl,
    cfbd,
    cbbd,
    espn
  );

  server.registerTool(
    "tkb_screen_slate",
    {
      title: "Screen every game on a date",
      description: `Run tkb_screen_props over EVERY game on a date (or a list of eventIDs) in ONE call and return one combined, ranked board.

Same screen, same sources and same defaults as tkb_screen_props (ESPN rates for NBA, NFL, WNBA, EPL, UCL; CFBD for CFB; CBBD for CBB; SGO for MLB). Each prop carries its matchup and eventID. Per game it reports how many markets were screened, how many qualified, and why props were dropped, so an empty game is always explained.

Args:
  - sport; date (Pacific calendar day) OR eventIDs (up to 15)
  - limit (combined board, default 20), perGameLimit (default 6)
  - any tkb_screen_props filter: rankBy, minEdge, minHitRate, minSample, maxAmericanOdds, maxPerPlayer, includePriorSeason, minCurrentSeasonGames, preferredBookmakers

TIME LIMIT: games run three at a time; a game not started within 40 seconds is listed under notScreened, never silently dropped. Games already started are skipped and listed.`,
      inputSchema: SlateInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input: SlateInput) => {
      const started = Date.now();
      try {
        if (!screenOne || !screenSchema) throw new Error("tkb_screen_props handler was not captured.");
        const sport = input.sport;
        let events: { eventID: string; matchup: string; startsAt: string | null; started: boolean }[] = [];

        if (input.eventIDs?.length) {
          events = input.eventIDs.map((id) => ({ eventID: id, matchup: id, startsAt: null, started: false }));
        } else if (input.date) {
          const w = slateDayBounds(input.date);
          // v2.20.2: enumerate with AND without the odd filter (see services/slateEvents.ts).
          const raw = (
            await enumerateSlate(sgo, {
              leagueID: sgo.leagueIDFor(sport),
              startsAfter: w.startsAfter,
              startsBefore: w.startsBefore,
              oddIDs: narrowingOddID(sport),
            })
          ).events;
          events = raw.map((e) => ({
            eventID: e.eventID,
            matchup: `${e.teams?.away?.names?.long ?? "?"} @ ${e.teams?.home?.names?.long ?? "?"}`,
            startsAt: e.status?.startsAt ?? null,
            started: Boolean(e.status?.started || e.status?.completed),
          }));
        } else {
          return {
            content: [{ type: "text" as const, text: "Pass a date (YYYY-MM-DD) or eventIDs." }],
            isError: true,
          };
        }

        const skippedStarted = events.filter((e) => e.started);
        const queue = events.filter((e) => !e.started);
        const { sport: _s, date: _d, eventIDs: _e, limit, perGameLimit, ...filters } = input;

        type GameResult = {
          eventID: string;
          matchup: string;
          startsAt: string | null;
          status: "screened" | "no_props_posted" | "no_props_priced" | "error";
          screened?: number;
          qualified?: number;
          dropReasons?: unknown;
          note?: string;
          props: Record<string, unknown>[];
        };
        const results: GameResult[] = [];
        const notScreened: string[] = [];
        let cursor = 0;
        const worker = async () => {
          while (cursor < queue.length) {
            const ev = queue[cursor++]!;
            if (Date.now() - started > START_DEADLINE_MS) {
              notScreened.push(`${ev.matchup} (${ev.eventID})`);
              continue;
            }
            try {
              const args = screenSchema!.parse({ sport, eventID: ev.eventID, limit: perGameLimit, ...filters });
              const r = await screenOne!(args);
              const sc = r.structuredContent;
              if (!sc) {
                const text = r.content[0]?.text ?? "";
                results.push({
                  eventID: ev.eventID,
                  matchup: ev.matchup,
                  startsAt: ev.startsAt,
                  status: /No players attached|not posted|not priced yet/i.test(text) ? "no_props_posted" : "error",
                  note: text.split("\n")[0]?.slice(0, 200),
                  props: [],
                });
                continue;
              }
              const matchup = String(sc.matchup ?? ev.matchup);
              const screenedCount = Number(sc.pricedMarketsScreened ?? 0);
              results.push({
                eventID: ev.eventID,
                matchup,
                startsAt: ev.startsAt,
                /* v2.20.1: zero priced markets is NOT a screen that found nothing. Measured
                 * 2026-10-28: three games read "screened, 0 of 0 qualified" when their
                 * players were attached but no house book had priced a prop yet. */
                status: screenedCount === 0 ? "no_props_priced" : "screened",
                screened: Number(sc.pricedMarketsScreened ?? 0),
                qualified: Number(sc.qualified ?? 0),
                dropReasons: sc.dropReasons,
                props: ((sc.props as Record<string, unknown>[]) ?? []).map((p) => ({ ...p, matchup, eventID: ev.eventID })),
              });
            } catch (err) {
              results.push({
                eventID: ev.eventID,
                matchup: ev.matchup,
                startsAt: ev.startsAt,
                status: "error",
                note: err instanceof Error ? err.message : String(err),
                props: [],
              });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

        const rankKey = input.rankBy === "hitRate" ? "hitRatePct" : "edge";
        const board = results
          .flatMap((r) => r.props)
          .sort((a, b) => Number(b[rankKey] ?? 0) - Number(a[rankKey] ?? 0) || Number(b.edge ?? 0) - Number(a.edge ?? 0))
          .slice(0, limit);

        const perGame = results
          .sort((a, b) => String(a.startsAt ?? "").localeCompare(String(b.startsAt ?? "")))
          .map((r) =>
            r.status === "screened"
              ? `- ${r.matchup}: ${r.qualified} of ${r.screened} qualified, ${r.props.length} kept`
              : r.status === "no_props_priced"
                ? `- ${r.matchup}: NO PROPS PRICED AT YOUR BOOKS YET (players are attached; re-run closer to tip)`
                : `- ${r.matchup}: ${r.status === "no_props_posted" ? "NO PROPS POSTED YET" : `ERROR: ${r.note}`}`
          )
          .join("\n");

        const line = (p: Record<string, unknown>) =>
          `${p.playerName} ${String(p.side).toUpperCase()} ${p.line} ${p.market} (${p.roundedOdds}, ${p.bookmaker}) | ${p.hitRate} | edge ${p.edge} | ${p.matchup}` +
          (p.injuryStatus ? ` | INJURY: ${p.injuryStatus}` : "");

        const text =
          `SLATE SCREEN: ${sport.toUpperCase()} ${input.date ?? `${events.length} event(s)`}, ` +
          `${results.filter((r) => r.status === "screened").length} of ${events.length} game(s) screened in ` +
          `${Math.round((Date.now() - started) / 1000)}s, ${board.length} prop(s) on the combined board, ranked by ${input.rankBy}.` +
          (skippedStarted.length ? `\nSkipped (already started): ${skippedStarted.map((e) => e.matchup).join(", ")}.` : "") +
          (notScreened.length
            ? `\nNOT SCREENED (time budget): ${notScreened.join(", ")}. Run tkb_screen_props on these individually.`
            : "") +
          `\n\nPER GAME:\n${perGame}\n\nBOARD:\n${board.map(line).join("\n") || "(nothing cleared)"}` +
          `\n\nEach prop keeps every tkb_screen_props field (seasonWarning, availabilityFlag, injuryStatus, recent games). ` +
          `Re-pull any price with tkb_get_odds before publishing.`;

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: {
            sport,
            date: input.date ?? null,
            gamesFound: events.length,
            gamesScreened: results.filter((r) => r.status === "screened").length,
            skippedStarted: skippedStarted.map((e) => e.eventID),
            notScreened,
            perGame: results.map(({ props, ...rest }) => ({ ...rest, kept: props.length })),
            props: board,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error screening slate: ${err instanceof Error ? err.message : String(err)}. Nothing about the slate has been established; screen games individually.`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
