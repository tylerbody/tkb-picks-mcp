import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BDLClient } from "../services/bdlClient.js";
import { SUPPORTED_SPORTS, supportsCapability, unsupportedMessage, type SportKey } from "../constants.js";
import type { NormalizedInjury, BDLInjury } from "../types.js";
import type { EspnClient } from "../services/espnClient.js";
import {
  ESPN_INJURY_SPORTS,
  getEspnInjuries,
  describeFeedFreshness,
  injuryTeamHaystack,
} from "../services/espnInjuries.js";
import { normaliseEspnName } from "../services/espnPlayerResolution.js";

const InjuriesInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    playerName: z
      .string()
      .optional()
      .describe("Filter to a specific player (partial match, case-insensitive)."),
    teamName: z
      .string()
      .optional()
      .describe(
        "Filter to a specific team's injury report (partial match). Matches against full name, location, nickname, and abbreviation."
      ),
  })
  .strict();

type InjuriesInput = z.infer<typeof InjuriesInputSchema>;

/**
 * Resolve a team display name from a BALLDONTLIE injury record.
 *
 * THE BUG THIS FIXES (found via live test, 8 Aug 2026): every one of the 162 NFL
 * injury records came back with team "unknown", because the code read only
 * `player.team.display_name`. That field is real for MLB and WNBA, but NFL returns
 * `full_name` instead (alongside `location` and `name`), so the lookup silently
 * missed on every record.
 *
 * THE DANGEROUS PART was not the blank field, it was what happened downstream:
 * filtering by team then matched nothing, and the tool answered
 *   "No injuries found... This is a good sign, not an error."
 * That told the caller a team was healthy when the truth was that the tool could
 * not answer the question at all. In NFL, where Friday designations decide whether
 * a player suits up, that could put a ruled-out player into a live thread.
 *
 * Rather than swap one hardcoded field for another - the same assumption that has
 * now been wrong twice - this checks every known shape in order and composes a name
 * from location + name as a last resort.
 */
function resolveTeamName(injury: BDLInjury): string | null {
  const t = injury.player?.team;
  if (!t) return null;
  if (t.full_name) return t.full_name;
  if (t.display_name) return t.display_name;
  if (t.location && t.name) return `${t.location} ${t.name}`;
  if (t.name) return t.name;
  if (t.abbreviation) return t.abbreviation;
  return null;
}

/** Every string worth matching a user-supplied team filter against. */
function teamHaystack(injury: BDLInjury): string {
  const t = injury.player?.team;
  if (!t) return "";
  return [t.full_name, t.display_name, t.location, t.name, t.abbreviation, t.short_display_name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Resolve the human-readable injury note. NFL uses `comment`; MLB/WNBA use
 * `short_comment` or `description`. Previously only the latter two were checked,
 * so every NFL record rendered as "no summary available" even though a real,
 * sourced update was present.
 */
function resolveSummary(injury: BDLInjury): string {
  return (
    injury.comment ??
    injury.short_comment ??
    injury.description ??
    injury.long_comment ??
    "no summary available"
  );
}

/**
 * ESPN PATH, v2.19.0. NBA, NFL, NHL and WNBA read ESPN's keyless league-wide feed.
 * Exported so it is testable without an MCP server.
 */
export async function espnInjuriesResponse(
  espn: Pick<EspnClient, "fetchRawEspn"> & Partial<Pick<EspnClient, "fetchTeams">>,
  params: InjuriesInput
) {
  const feed = await getEspnInjuries(espn, params.sport);
  let entries = feed.entries;
  if (params.playerName) {
    const needle = normaliseEspnName(params.playerName);
    entries = entries.filter((e) => normaliseEspnName(e.playerName).includes(needle));
  }
  if (params.teamName) {
    const needle = params.teamName.toLowerCase();
    entries = entries.filter((e) => injuryTeamHaystack(e).includes(needle));
  }
  const freshness = describeFeedFreshness(feed);
  const label = params.sport.toUpperCase();
  const scope = params.playerName
    ? `player matching "${params.playerName}"`
    : params.teamName
      ? `team matching "${params.teamName}"`
      : label;

  const passed = entries.filter((e) => e.returnDatePassed).length;
  const passedNote = passed
    ? ` ${passed} entr${passed === 1 ? "y has" : "ies have"} a return date that has ALREADY PASSED; ` +
      `ESPN often leaves those up after the player is back, or before his status is updated, so ` +
      `read them as "check this player", never as a confirmed status.`
    : "";

  // v2.20.0: a team with no entries is checked against the per-team endpoint, so an
  // empty result says WHICH of "ESPN lists zero" and "the feed left this team out" it is.
  const teamCheck = params.teamName
    ? feed.coverage?.notListed.find((n) => n.team.toLowerCase().includes(params.teamName!.toLowerCase()))
    : undefined;
  const header = entries.length
    ? `${entries.length} ${label} injury record(s) for ${scope}. Source: ESPN (${feed.host}).`
    : feed.stale
      ? `No ${label} injury entries found for ${scope}, BUT THE FEED IS STALE, so this is NOT a clean bill of health.`
      : teamCheck?.status === "ESPN_LISTS_ZERO"
        ? `No ${label} injury entries for ${scope}. ESPN's per-team endpoint CONFIRMS ${teamCheck.team} has zero ` +
          `listed injuries, so this is a real empty list, not a gap in the feed.`
        : teamCheck?.status === "MISSING_FROM_FEED"
          ? `WARNING: the league feed has no entries for ${teamCheck.team}, but ESPN's per-team endpoint shows ` +
            `${teamCheck.perTeamCount}. The feed LEFT THIS TEAM OUT. Treat every ${teamCheck.team} player as UNVERIFIED and search.`
          : teamCheck?.status === "UNCONFIRMED"
            ? `No ${label} injury entries for ${scope}, and the per-team check could not run. UNVERIFIED, not healthy.`
            : `No ${label} injury entries found for ${scope} in a current ESPN feed.`;

  const sportNote =
    params.sport === "nfl"
      ? ` NFL: Wednesday-Friday practice reports and Friday game designations move here with a lag, and ` +
        `inactives come 90 minutes before kickoff. A clean entry on Thursday is not a Sunday confirmation.`
      : params.sport === "nhl"
        ? ` NHL: clubs report "upper body"/"lower body" and goalie starts are confirmed at warmups, ` +
          `which this feed does not carry. Confirm the starting goalie separately.`
        : ` Game-time decisions and late scratches can post after this feed updates.`;

  const output = {
    source: "espn",
    sport: params.sport,
    feedTimestamp: feed.feedTimestamp,
    feedAgeHours: feed.feedAgeHours,
    newestEntryAt: feed.newestEntryAt,
    stale: feed.stale,
    coverage: feed.coverage
      ? {
          leagueTeams: feed.coverage.leagueTeams,
          teamsWithEntries: feed.coverage.teamsInFeed.length,
          notListed: feed.coverage.notListed,
        }
      : null,
    host: feed.host,
    hostsTried: feed.hostsTried,
    count: entries.length,
    injuries: entries,
  };

  return {
    content: [
      {
        type: "text" as const,
        text:
          `${header}\n\n${freshness}${passedNote}${sportNote} ESPN's status wording is loose (a ` +
          `months-long injury has been measured as "Day-To-Day"), so read shortComment and returnDate, ` +
          `not the status alone.\n\n${JSON.stringify(output, null, 2)}`,
      },
    ],
    structuredContent: output,
  };
}

export function registerInjuriesTool(server: McpServer, bdl: BDLClient, espn?: EspnClient) {
  server.registerTool(
    "tkb_get_injuries",
    {
      title: "Get Player Injuries",
      description: `Get current injury reports for a sport, optionally filtered by player or team.

SOURCE BY SPORT (v2.20.0): NBA, NFL, NHL, WNBA and MLB read ESPN's free league-wide
injury feed (no key, zero SportsGameOdds entities). BALLDONTLIE is cancelled.
FRESHNESS is the age of the NEWEST ENTRY (ESPN's top-level timestamp is just when the
response was built); 36 hours without a new entry is flagged STALE.
TEAM COVERAGE: ESPN's league feed omits teams with nothing listed, so every answer
lists which teams it covered, and every team NOT in the feed is checked against ESPN's
per-team endpoint: ESPN_LISTS_ZERO (a real empty list), MISSING_FROM_FEED (the league
feed dropped entries that exist; treat that team as unverified) or UNCONFIRMED.
Two ESPN hosts are fetched and the one with the newer entries is used.

This is a structured injury data source (not a web search) - use it as the FIRST
check before including any player in a pick. It returns status (Out/Questionable/
Doubtful/etc.), a dated sourced comment, and expected return date where known.

IMPORTANT: this data has an update cadence that has not been independently verified
against real-time news. For a player with very recent (same-day) injury news, still
cross-check with a live web search before finalizing a pick - don't treat this as
the only source for breaking news, only as the fast first-pass structured check.

NFL SPECIFICALLY: official practice reports drop Wednesday through Friday, with
final game designations on Friday, and inactives 90 minutes before kickoff. Those
late changes move props more than anything else in the sport. A clean report here
on Thursday does NOT mean a player is confirmed active on Sunday.

Args:
  - sport ('mlb'|'wnba'|'nfl'): which sport. CFB and tennis are refused with an
    explanation. For CFB the reason is that BALLDONTLIE has NO NCAAF injuries
    endpoint (verified 2026-08-31: 404 on both known paths, while MLB returns 200 on
    the same key), so this is not something a subscription upgrade would fix.
  - playerName (string, optional): narrow to one player
  - teamName (string, optional): narrow to one team's report

Returns: list of injuries with player name, team, status, sourced comment, and
return date, plus a coverage note stating how many records carried usable team data.

Examples:
  - Use when: about to include a player in a thread, checking they're clean to use
  - Use when: "Is anyone on the Rangers hurt right now?" -> teamName="Rangers"
  - Don't use when: you need breaking news from the last few hours - web search is faster

Error Handling:
  - An empty result is reported HONESTLY: the tool distinguishes "this team genuinely
    has no injury flags" from "team data was missing so the filter could not be
    applied." It will never claim a clean bill of health it cannot actually verify.`,
      inputSchema: InjuriesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: InjuriesInput) => {
      try {
        if (espn && ESPN_INJURY_SPORTS.includes(params.sport)) {
          return await espnInjuriesResponse(espn, params);
        }

        if (!supportsCapability(params.sport, "injuries")) {
          return {
            content: [
              { type: "text" as const, text: unsupportedMessage(params.sport, "injuries") },
            ],
          };
        }

        const allInjuries = await bdl.getAllInjuries(params.sport);

        // How much of this payload actually carries team data? This drives whether
        // an empty team-filtered result can be trusted as "no injuries" or has to be
        // reported as "cannot determine".
        const withTeam = allInjuries.filter((i) => resolveTeamName(i) !== null).length;
        const teamCoverage = allInjuries.length ? withTeam / allInjuries.length : 0;

        let filtered = allInjuries;

        if (params.playerName) {
          const needle = params.playerName.toLowerCase();
          filtered = filtered.filter((i) =>
            `${i.player.first_name} ${i.player.last_name}`.toLowerCase().includes(needle)
          );
        }

        if (params.teamName) {
          const needle = params.teamName.toLowerCase();
          filtered = filtered.filter((i) => teamHaystack(i).includes(needle));
        }

        if (!filtered.length) {
          // CRITICAL: only claim "no injuries" when we can actually see team data.
          // If team fields are largely missing, the filter is unreliable and saying
          // "good sign" would be a false all-clear.
          if (params.teamName && teamCoverage < 0.5) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `CANNOT VERIFY - do not treat this as a clean injury report.\n\n` +
                    `Team data is missing on ${allInjuries.length - withTeam} of ${allInjuries.length} ${params.sport.toUpperCase()} injury records, ` +
                    `so filtering by team "${params.teamName}" is unreliable right now. An empty result here means the filter could not be applied, ` +
                    `NOT that the team is healthy.\n\n` +
                    `Do one of the following before using any player from this team: re-run without teamName and scan the full list, ` +
                    `query the specific player by playerName, or check the injury report via live web search.`,
                },
              ],
            };
          }

          const scope = params.playerName
            ? `player matching "${params.playerName}"`
            : params.teamName
              ? `team matching "${params.teamName}"`
              : `${params.sport.toUpperCase()}`;
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No current injury flags found for ${scope}. Team data was present on ${withTeam} of ${allInjuries.length} records, ` +
                  `so this filter was applied against real data and the empty result is meaningful.\n\n` +
                  `Still cross-check same-day news before locking a pick - this feed is not real-time.`,
              },
            ],
          };
        }

        const injuries: NormalizedInjury[] = filtered.map((i) => ({
          playerName: `${i.player.first_name} ${i.player.last_name}`,
          team: resolveTeamName(i) ?? "unknown",
          status: i.status,
          type: i.type,
          detail: i.detail,
          side: i.side,
          summary: resolveSummary(i),
          returnDate: i.return_date ?? null,
          updatedAt: i.date,
        }));

        const unknownTeams = injuries.filter((i) => i.team === "unknown").length;
        const coverageNote = unknownTeams
          ? ` NOTE: ${unknownTeams} of these record(s) had no resolvable team field - treat those with caution.`
          : "";

        const output = { count: injuries.length, injuries };

        return {
          content: [
            {
              type: "text" as const,
              text: `${injuries.length} injury record(s) found.${coverageNote}\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching injuries: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
