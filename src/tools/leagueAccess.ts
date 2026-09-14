import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { SUPPORTED_SPORTS, SPORT_CONFIG, type SportKey } from "../constants.js";
import { probeAllLeagues, leagueTierNote } from "../services/leagueAccess.js";

/**
 * WHICH LEAGUES DOES THE INSTALLED KEY ACTUALLY RETURN?
 *
 * Built for one specific operational fact: this account swaps between a ROOKIE
 * SportsGameOdds key and a PRO key, and SGO gates LEAGUE ACCESS by plan, not only
 * rate limits. Eight leagues on the free plan, 17 on rookie, 53 on pro.
 *
 * Without this tool, a league the current key cannot see is indistinguishable from
 * a league with an empty calendar: both return "no games found". See
 * services/leagueAccess.ts for the measured case that produced this.
 */
export function registerLeagueAccessTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_check_league_access",
    {
      title: "Check which leagues the installed SGO key can actually see",
      description: `Probe every configured league and report what the CURRENT key returns.

Use when:
  - A slate comes back empty and you need to know whether that is a calendar gap or a key that cannot see the league
  - The SGO key has just been swapped (rookie <-> pro) and you want to know what changed
  - Before building threads for a league this account has not posted recently

HOW IT DECIDES. Two windows per league: the last 45 days and the next 21. Looking
BACKWARD is the load-bearing half - a forward window is empty for ordinary calendar
reasons constantly, but a 45-day backward window is empty only if the league did not
play or cannot be seen.

WHAT IT WILL NOT DO: assert that a key lacks entitlement. SGO's behaviour for an
unentitled league has not been measured on this account, and an empty list from an
out-of-season league looks identical. It reports both counts, says which plan each
league is documented under, and leaves the conclusion to a human holding the one
fact this connector does not have: which key is currently installed.

COST: two requests per league, on a key that bills per event object. Cheap, but not
free - do not poll it.`,
      inputSchema: {
        sports: z
          .array(z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]))
          .optional()
          .describe("Limit the probe to these sports. Default: every configured league."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: { sports?: SportKey[] }) => {
      try {
        const sports = input.sports?.length ? input.sports : SUPPORTED_SPORTS;
        const results = await probeAllLeagues(sgo, sports);

        const reachable = results.filter((r) => r.verdict === "reachable");
        const silent = results.filter((r) => r.verdict === "no_events_either_direction");
        const errored = results.filter((r) => r.verdict === "error");

        const lines = results.map(
          (r) =>
            `${r.label.padEnd(6)} (${r.leagueID})  recent ${String(r.recentEvents).padStart(3)}  ` +
            `upcoming ${String(r.upcomingEvents).padStart(3)}  -> ${r.reading}`
        );

        const header =
          `${reachable.length} of ${results.length} league(s) returned events.` +
          (silent.length
            ? `\n\n${silent.length} league(s) returned NOTHING in either direction: ` +
              `${silent.map((r) => r.label).join(", ")}. That is correct and expected for an ` +
              `out-of-season league. For one that is in season, it is the signature of a key ` +
              `that cannot see it.`
            : "") +
          (errored.length
            ? `\n\n${errored.length} probe(s) FAILED outright, so nothing is established about ` +
              `${errored.map((r) => r.label).join(", ")} either way.`
            : "");

        return {
          content: [
            {
              type: "text" as const,
              text:
                `${header}\n\n${lines.join("\n\n")}\n\n` +
                `PLAN CONTEXT: SGO gates league access by plan - Amateur 8 leagues, Rookie 17, ` +
                `Pro 53 - and their leagues doc states "not all leagues may be available ` +
                `depending on your subscription plan". Check the list above against whichever ` +
                `key is installed right now.\n\n` +
                `${JSON.stringify(
                  {
                    probedAt: new Date().toISOString(),
                    results: results.map((r) => ({
                      sport: r.sport,
                      leagueID: r.leagueID,
                      recentEvents: r.recentEvents,
                      upcomingEvents: r.upcomingEvents,
                      verdict: r.verdict,
                      documentedTier: leagueTierNote(r.sport),
                      error: r.error,
                    })),
                  },
                  null,
                  2
                )}`,
            },
          ],
          structuredContent: {
            probedAt: new Date().toISOString(),
            reachable: reachable.map((r) => r.sport),
            silent: silent.map((r) => r.sport),
            errored: errored.map((r) => r.sport),
            results: results.map((r) => ({
              sport: r.sport,
              label: r.label,
              leagueID: SPORT_CONFIG[r.sport].sgoLeagueID,
              recentEvents: r.recentEvents,
              upcomingEvents: r.upcomingEvents,
              verdict: r.verdict,
              error: r.error,
            })),
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `League access probe failed: ${err instanceof Error ? err.message : String(err)}. Nothing is established about any league.`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
