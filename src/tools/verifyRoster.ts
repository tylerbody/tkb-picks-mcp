import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BDLClient } from "../services/bdlClient.js";
import { normalizeName } from "../services/standingsNormalizer.js";
import {
  SUPPORTED_SPORTS,
  supportsCapability,
  unsupportedMessage,
  type SportKey,
} from "../constants.js";

/**
 * ROSTER VERIFICATION - is this player actually on the team the odds feed claims?
 *
 * THE BUG THIS EXISTS TO CATCH, measured 2026-08-31 on the Baylor @ Auburn board:
 * SportsGameOdds returned a priced Touchdowns market for BRYSON WASHINGTON under
 * team "Baylor". He transferred to AUBURN in January 2026 and is on Auburn's
 * published depth chart. Had that market been screened and written up, the thread
 * would have named a player on the wrong sideline.
 *
 * WHY NOTHING ELSE CATCHES IT, and this is the important part:
 *
 *   1. tkb_get_prop_board reports SGO's team field verbatim. It has no second
 *      opinion to check against.
 *   2. tkb_get_player_hit_rate keyed to the team SGO gave you returns a CLEAN,
 *      fully populated, sampleSufficient sample - because he really did play at
 *      Baylor last season. Measured: 12 games summing to exactly 788 rushing
 *      yards, matching independent reporting.
 *   3. Keyed to his ACTUAL team it returns NO SAMPLE, which is the correct
 *      refusal - but that only fires if you already knew the right team, which
 *      is the thing you are trying to find out.
 *
 * So SGO's stale team field and CFBD's season-keyed history AGREE WITH EACH OTHER,
 * and the agreement is a coincidence of the player having genuinely played there.
 * Every guardrail passes. This is the exact "fully populated, plausible,
 * confidently wrong" shape this connector keeps rediscovering.
 *
 * ---- WHY THIS IS SET MEMBERSHIP AND NOT IDENTITY RESOLUTION ----
 *
 * BALLDONTLIE returned THREE exact "Bryson Washington" matches on 2026-08-31:
 * ids 43426 (Western Kentucky), 47333 (Oklahoma), 54512 (Auburn). Resolving WHICH
 * one is the right person is the "Marte" problem from v2.0.1, and this connector's
 * standing answer is to refuse rather than guess, because a hit rate attached to
 * the wrong player is worse than no hit rate.
 *
 * THIS TOOL ASKS A DIFFERENT AND EASIER QUESTION: does ANY player by this name
 * appear on the team the feed claims? That needs no identity resolution at all.
 * SGO said Baylor; none of the three rows says Baylor; that is a flag, and it is
 * correct without ever deciding which Bryson Washington is which.
 *
 * ---- WHAT IT DELIBERATELY DOES NOT DO ----
 *
 * IT NEVER REWRITES THE TEAM. It reports a disagreement and stops. v2.8.2 is the
 * precedent: a roster-resolution feature took three consecutive releases to stop
 * producing confident wrong answers, and every one of those releases was a fix
 * that was right about its own case and wrong about the case beside it. A silent
 * correction that is itself wrong is worse than the error it replaces.
 *
 * IT NEVER CONFIRMS AVAILABILITY. A CONFIRMED verdict means "a player by this name
 * is listed on this team", not "he will play". Depth-chart confirmation stays
 * manual for CFB, because CollegeFootballData lists a player only in categories
 * where he recorded a stat and therefore cannot separate a DNP from a quiet game.
 *
 * ---- COST ----
 *
 * One paginated player search, which is throttled at 1100ms per page and exits on
 * the first page carrying an exact match. Cached 15 minutes per name by BDLClient,
 * so re-checking the same player inside one build is free. ZERO SportsGameOdds
 * entities - different provider, no object cap.
 */

/** One candidate row, reduced to what a verdict actually needs. */
export interface RosterCandidate {
  bdlPlayerID: number;
  name: string;
  team: string;
  /** Every string worth matching a team filter against, pre-normalised. */
  teamKeys: string[];
}

export type RosterVerdict =
  | "CONFIRMED"
  | "MISMATCH"
  | "NAME_NOT_FOUND"
  | "INCONCLUSIVE_TRUNCATED";

export interface RosterAssessment {
  verdict: RosterVerdict;
  expectedTeam: string;
  matchedOnExpectedTeam: RosterCandidate[];
  allCandidates: RosterCandidate[];
  /**
   * The highest BDL id among candidates. Ids are assigned in ingest order, so the
   * highest is the most recently ingested row and the best available guess at a
   * current affiliation. A GUESS, surfaced as context, never used to decide.
   */
  mostRecentCandidate: RosterCandidate | null;
  note: string;
}

/**
 * EXACT NORMALISED MATCHING ONLY. NO CONTAINMENT.
 *
 * findStandingForTeam falls back to substring containment, which is right there -
 * a miss only blanks a column. Here a wrong MATCH hides a wrong-team pick, so the
 * trade runs the other way.
 *
 * Containment is specifically dangerous in college football: "Miami" contains and
 * is contained by "Miami (OH)", "Texas" by "Texas State" and "Texas Tech",
 * "Washington" by "Washington State". Every one of those pairs is two different
 * programs that play each other. Exact matching on a candidate set (college, name,
 * full name, abbreviation, location+name) resolves "Baylor" against college
 * "Baylor" cleanly while refusing every trap above.
 */
export function assessRosterMatch(
  candidates: RosterCandidate[],
  expectedTeam: string,
  truncated: boolean
): RosterAssessment {
  const want = normalizeName(expectedTeam);

  const matched = candidates.filter((c) => c.teamKeys.includes(want));
  const mostRecent =
    candidates.length > 0
      ? candidates.reduce((a, b) => (b.bdlPlayerID > a.bdlPlayerID ? b : a))
      : null;

  if (!candidates.length) {
    return {
      verdict: truncated ? "INCONCLUSIVE_TRUNCATED" : "NAME_NOT_FOUND",
      expectedTeam,
      matchedOnExpectedTeam: [],
      allCandidates: [],
      mostRecentCandidate: null,
      note: truncated
        ? `INCONCLUSIVE. The player search hit its page cap with more results pending, so ` +
          `absence here is NOT evidence of absence. BALLDONTLIE returns players ascending by ` +
          `id, meaning the pages read are the OLDEST entries and a current player can sit ` +
          `past the cap. Do not treat this as a mismatch.`
        : `This name was not found in the index at all, on any team. That is usually a ` +
          `spelling difference rather than a roster problem - the index is cumulative and ` +
          `does carry current players. Verify the spelling against the team's published ` +
          `roster before drawing any conclusion.`,
    };
  }

  if (matched.length) {
    return {
      verdict: "CONFIRMED",
      expectedTeam,
      matchedOnExpectedTeam: matched,
      allCandidates: candidates,
      mostRecentCandidate: mostRecent,
      note:
        `A player by this name is listed on ${expectedTeam}. This confirms the TEAM FIELD ` +
        `only. It says nothing about whether he starts, is healthy, or will play - confirm ` +
        `the depth chart separately, which for CFB is mandatory and manual.` +
        (candidates.length > matched.length
          ? ` Note that ${candidates.length - matched.length} other player(s) share this name on ` +
            `other teams, so any hit-rate lookup on this name will be ambiguous and should be ` +
            `keyed by id.`
          : ``),
    };
  }

  return {
    verdict: "MISMATCH",
    expectedTeam,
    matchedOnExpectedTeam: [],
    allCandidates: candidates,
    mostRecentCandidate: mostRecent,
    note:
      `NO player by this name is listed on ${expectedTeam}, but ${candidates.length} ` +
      `player(s) with this name exist on other team(s). The odds feed's team field is the ` +
      `most likely thing that is wrong - a transfer that the feed has not picked up is the ` +
      `common cause, and it is common in the portal era. DO NOT publish a pick describing ` +
      `this player as being on ${expectedTeam} until it is resolved against a published ` +
      `roster or depth chart. This tool does NOT correct the team, deliberately: a silent ` +
      `correction that is itself wrong is worse than the error it replaces.`,
  };
}

const VerifyRosterInputSchema = z
  .object({
    sport: z
      .enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]])
      .describe("Which sport. Tennis has no roster and is refused with a reason."),
    playerName: z
      .string()
      .describe("Full player name as the odds feed spells it, e.g. 'Bryson Washington'."),
    expectedTeam: z
      .string()
      .describe(
        "The team the odds feed claims this player is on - the value to CHECK, not a filter. " +
          "Pass it exactly as SGO gave it, e.g. 'Baylor' or 'Auburn Tigers'."
      ),
  })
  .strict();

type VerifyRosterInput = z.infer<typeof VerifyRosterInputSchema>;

export function registerVerifyRosterTool(server: McpServer, bdl: BDLClient) {
  server.registerTool(
    "tkb_verify_roster",
    {
      title: "Check a player against the team the odds feed claims",
      description: `Verify that a player is actually on the team SportsGameOdds says he is on.

WHY THIS EXISTS: SGO's player-to-team field goes stale after a transfer. Measured
2026-08-31, SGO listed Bryson Washington under Baylor on the Baylor @ Auburn board.
He transferred to Auburn in January. Writing that market up would have put a player
on the wrong sideline in a published thread.

NOTHING ELSE CATCHES IT. tkb_get_prop_board repeats SGO's field. tkb_get_player_hit_rate
keyed to Baylor returns a CLEAN 12-game sample, because he really did play there last
season - so the stale field and the historical stats agree with each other and every
guardrail passes.

RUN THIS on any player whose team you have not independently confirmed, and ALWAYS in
early-season college football, where portal movement is heavy and boards are built from
last season's rosters.

Costs ZERO SportsGameOdds entities. One paginated BALLDONTLIE search, cached 15 minutes.

Args:
  - sport, playerName
  - expectedTeam: the team the FEED claims. This is the value being tested.

Returns one of:
  - CONFIRMED: a player by this name is listed on that team. Team field only - this is
    NOT a statement about availability, health, or snap share.
  - MISMATCH: nobody by this name is on that team, but the name exists on other teams.
    The feed's team field is the likely error. Do not publish until resolved.
  - NAME_NOT_FOUND: the name is not in the index at all. Usually a spelling difference.
  - INCONCLUSIVE_TRUNCATED: the search hit its page cap. Absence is NOT evidence here.

Examples:
  - Use when: any CFB or NFL prop where the player could plausibly have moved
  - Use when: a hit rate looks clean but you have not confirmed the roster
  - Don't use when: you need availability - that is tkb_get_injuries, and for CFB a
    manual depth-chart check
  - Don't use when: you need a hit rate - that is tkb_get_player_hit_rate

Error Handling:
  - NEVER rewrites the team. It reports a disagreement and stops.
  - Distinguishes "not on this team" from "search truncated", which are different
    answers and only one of them justifies a flag.`,
      inputSchema: VerifyRosterInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: VerifyRosterInput) => {
      try {
        // Tennis competitors occupy home/away event slots and have no roster, so
        // the players index cannot answer this at all.
        if (!supportsCapability(params.sport, "playerProps")) {
          return {
            content: [
              { type: "text" as const, text: unsupportedMessage(params.sport, "playerProps") },
            ],
          };
        }

        const search = await bdl.searchPlayers(params.sport, params.playerName);

        const wantName = normalizeName(params.playerName);
        const candidates: RosterCandidate[] = (search.data ?? [])
          .filter(
            (p) => normalizeName(`${p.first_name} ${p.last_name}`) === wantName
          )
          .map((p) => {
            const t = (p.team ?? {}) as Record<string, unknown>;
            const str = (k: string): string | null =>
              typeof t[k] === "string" && t[k] ? (t[k] as string) : null;
            const display =
              str("full_name") ??
              str("display_name") ??
              [str("location"), str("name")].filter(Boolean).join(" ") ??
              str("college") ??
              str("name") ??
              "unknown";

            // Candidate set for EXACT matching. "college" matters most for NCAAF,
            // where SGO says "Baylor" and BDL's full_name is "Baylor Bears".
            const keys = [
              str("full_name"),
              str("display_name"),
              str("short_display_name"),
              str("college"),
              str("name"),
              str("location"),
              str("abbreviation"),
              [str("location"), str("name")].filter(Boolean).join(" "),
              [str("college"), str("name")].filter(Boolean).join(" "),
            ]
              .filter((v): v is string => Boolean(v))
              .map(normalizeName)
              .filter(Boolean);

            return {
              bdlPlayerID: p.id,
              name: `${p.first_name} ${p.last_name}`,
              team: display,
              teamKeys: [...new Set(keys)],
            };
          });

        const assessment = assessRosterMatch(
          candidates,
          params.expectedTeam,
          Boolean(search.truncated)
        );

        const headline =
          assessment.verdict === "CONFIRMED"
            ? `CONFIRMED: ${params.playerName} is listed on ${params.expectedTeam}.`
            : assessment.verdict === "MISMATCH"
              ? `MISMATCH - DO NOT PUBLISH THIS PICK YET. ${params.playerName} is NOT on ${params.expectedTeam}.`
              : assessment.verdict === "INCONCLUSIVE_TRUNCATED"
                ? `INCONCLUSIVE: the player search was truncated, so this proves nothing either way.`
                : `NAME NOT FOUND: no "${params.playerName}" in the ${params.sport.toUpperCase()} index on any team.`;

        const teamsLine = assessment.allCandidates.length
          ? `\n\nTeams carrying this name: ` +
            assessment.allCandidates
              .map((c) => `${c.team} (id ${c.bdlPlayerID})`)
              .join(", ") +
            (assessment.mostRecentCandidate
              ? `\nHighest id is ${assessment.mostRecentCandidate.bdlPlayerID} (${assessment.mostRecentCandidate.team}). ` +
                `Ids are assigned in ingest order, so the highest is the most recently ingested ` +
                `row - useful CONTEXT for guessing a current affiliation, and nothing more. It ` +
                `is not used to decide the verdict and must not be treated as authoritative.`
              : ``)
          : ``;

        return {
          content: [
            {
              type: "text" as const,
              text: `${headline}\n\n${assessment.note}${teamsLine}\n\n${JSON.stringify(
                {
                  verdict: assessment.verdict,
                  playerName: params.playerName,
                  expectedTeam: params.expectedTeam,
                  candidateCount: assessment.allCandidates.length,
                  candidates: assessment.allCandidates.map((c) => ({
                    bdlPlayerID: c.bdlPlayerID,
                    team: c.team,
                  })),
                  searchTruncated: Boolean(search.truncated),
                },
                null,
                2
              )}`,
            },
          ],
          structuredContent: {
            verdict: assessment.verdict,
            playerName: params.playerName,
            expectedTeam: params.expectedTeam,
            candidateCount: assessment.allCandidates.length,
            candidates: assessment.allCandidates.map((c) => ({
              bdlPlayerID: c.bdlPlayerID,
              team: c.team,
            })),
            searchTruncated: Boolean(search.truncated),
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Error verifying roster: ${err instanceof Error ? err.message : String(err)}\n\n` +
                `A failure here is NOT a mismatch. It means the check could not run, so the ` +
                `team field is simply unverified - confirm it manually before publishing.`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
