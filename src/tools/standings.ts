import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BDLClient } from "../services/bdlClient.js";
import { currentSeason } from "../services/seasonBoundary.js";
import { normalizeStanding } from "../services/standingsNormalizer.js";
import { SUPPORTED_SPORTS, supportsCapability, unsupportedMessage, type SportKey } from "../constants.js";
import type { NormalizedStanding } from "../types.js";
import type { EspnClient } from "../services/espnClient.js";
import type { CFBDClient } from "../services/cfbdClient.js";
import { ESPN_STANDINGS_SPORTS, getEspnStandings } from "../services/espnStandings.js";
import { parseCfbdRecords, matchesConference } from "../services/cfbdRecords.js";
import { isBdlConfigured } from "../services/bdlUnavailable.js";

/**
 * STANDINGS - the whole table, not one team's split.
 *
 * WHY THIS IS DIFFERENT FROM tkb_get_team_split. That tool answers "what is THIS
 * team's home record", one team at a time, and falls back to tallying SGO events
 * when standings miss. This returns the full table in one call, which is what you
 * need when the question is comparative: who is actually good in this conference,
 * who is the best team without a ranking, where does tonight's favourite sit
 * relative to the field.
 *
 * WHY IT MATTERS MORE THAN "another data tool". The standing research rule splits
 * every fact into DECAYING and NON-DECAYING, and puts records, streaks, standings
 * position and games back firmly in the decaying bucket that must NEVER be taken
 * from an article. The mechanical test is "has this team played since the article
 * was published", and in MLB or WNBA the answer is usually yes within hours.
 *
 * Before this, the connector could answer that for one team at a time. Now it
 * answers it for a whole conference or league in one call, which is the shape the
 * rule actually demands.
 *
 * COSTS ZERO SGO ENTITIES. BALLDONTLIE has no object cap.
 *
 * NCAAF NEEDS A CONFERENCE, AND THAT IS NOT A QUIRK TO PAPER OVER. BDL documents
 * conference_id as REQUIRED for NCAAF standings and absent for the league-wide
 * sports. There are 25 conferences; looping them all would be 25 throttled
 * requests to answer a question nobody asked. So CFB requires a conference and
 * says which ones exist when one is missing or unrecognised.
 */

const StandingsInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    conference: z
      .string()
      .optional()
      .describe(
        "REQUIRED for cfb, e.g. 'ACC', 'Big Ten', 'SEC', 'Big 12', 'Mountain West'. Ignored for league-wide sports. Matched case-insensitively against name and abbreviation."
      ),
    season: z
      .number()
      .int()
      .optional()
      .describe("Season year. Defaults to the current season for this sport."),
    teamName: z
      .string()
      .optional()
      .describe("Optional filter to one team (partial match), when you only want that row."),
  })
  .strict();

type StandingsInput = z.infer<typeof StandingsInputSchema>;

export function registerStandingsTool(
  server: McpServer,
  bdl: BDLClient,
  espn: EspnClient | null = null,
  cfbd: CFBDClient | null = null
) {
  server.registerTool(
    "tkb_get_standings",
    {
      title: "Get the full standings table",
      description: `Every team's record in one call - the comparative view tkb_get_team_split cannot give.

WHY IT MATTERS: records, streaks, standings position and games back are DECAYING
facts. They are wrong the moment a team plays again, which in MLB and WNBA is
usually the same night. They must come from the connector, never from an article.
This is the cheapest way to get them for a whole field at once.

Costs ZERO SportsGameOdds entities.

SOURCES (v2.20.0, BALLDONTLIE is cancelled): ESPN standings for NBA, NFL, NHL, MLB and
WNBA (overall, home, road, division, conference and last-10 records, streak, points
for/against, point differential, playoff seed, games back; NHL adds OT losses and
standings points). CollegeFootballData /records for CFB (overall, home, away and
conference records). ESPN's own CFB standings were measured all 0-0 in week 9 and are
not used. Every answer names its source.

Args:
  - sport
  - conference: for cfb, the conference ('ACC', 'SEC', 'Big Ten', 'Big 12', ...);
    cfb needs a conference OR a teamName. For pro leagues it optionally filters to
    a conference ('Eastern', 'AFC', ...).
  - season (optional): defaults to the current season
  - teamName (optional): filter to one team's row

Returns per team: overall record, home and road records, conference record, win
percentage, games back, streak, and point differential where the provider carries
it. Fields vary by sport and are reported as present or null rather than assumed.

WHY POINT DIFFERENTIAL IS WORTH READING: an analysis of 26 seasons of play-by-play
found that after roughly six games, point differential alone was as predictive as
any advanced metric tested. It is stronger material for a moneyline bullet than a
raw win-loss record, which hides margin entirely.

Examples:
  - Use when: writing any team-level reasoning bullet that cites a record
  - Use when: "how good is this conference actually" before a CFB thread
  - Use when: you need to re-derive a number an article gave you
  - Don't use when: you want ONE team's home/road split - use tkb_get_team_split
  - Don't use when: you want the poll - use tkb_get_rankings

Error Handling:
  - CFB without a conference returns the list of valid conferences rather than an
    empty table
  - A 401 names the subscription rather than reporting no data`,
      inputSchema: StandingsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: StandingsInput) => {
      try {
        const sport = input.sport as SportKey;

        if (!supportsCapability(sport, "teamSplits")) {
          return {
            content: [
              { type: "text" as const, text: unsupportedMessage(sport, "teamSplits") },
            ],
          };
        }

        const season = input.season ?? currentSeason(sport).seasonYear;
        let scope = `${sport.toUpperCase()} league-wide`;
        let source = "";
        let rows: NormalizedStanding[] = [];
        let sourceNote = "";

        /* ---- v2.20.0 ROUTING. BALLDONTLIE IS CANCELLED. ----
         * ESPN for the pro leagues, CollegeFootballData for CFB. The BDL path below is
         * kept only for a swap back and is reached only when a BDL key is configured. */
        if (espn && ESPN_STANDINGS_SPORTS.includes(sport)) {
          const t = await getEspnStandings(espn, sport);
          rows = t.rows;
          source = `ESPN standings (${t.host})`;
          if (t.seasonLabel) scope = `${scope}, ${t.seasonLabel}`;
          if (input.conference) {
            const needle = input.conference.toLowerCase();
            rows = rows.filter((r) => String((r as { conference?: string }).conference ?? "").toLowerCase().includes(needle));
            scope = `${sport.toUpperCase()} ${input.conference}`;
          }
        } else if (sport === "cfb" && cfbd) {
          const raw = await cfbd.getTeamRecords(season);
          const parsed = parseCfbdRecords(raw, season);
          let cfRows = parsed.rows.filter((r) => !r.classification || r.classification.toLowerCase() === "fbs");
          if (input.conference) {
            cfRows = cfRows.filter((r) => matchesConference(r.conference, input.conference!));
            scope = input.conference;
          } else if (!input.teamName) {
            const confs = [...new Set(parsed.rows.map((r) => r.conference).filter(Boolean))].sort();
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `CFB standings need a conference or a teamName, so the answer is one table ` +
                    `rather than every FBS team.\n\nConferences in the data: ${confs.join(", ")}`,
                },
              ],
            };
          }
          rows = cfRows;
          source = "CollegeFootballData /records";
          if (parsed.unreadable) {
            sourceNote = ` ${parsed.unreadable} CFBD row(s) had no readable record and were left out rather than shown as 0-0.`;
          }
        } else if (isBdlConfigured(bdl)) {
          source = "BALLDONTLIE";
          let raw;
          if (sport === "cfb") {
            const conferences = await bdl.getConferences(sport);
            const needle = (input.conference ?? "").trim().toLowerCase();
            const match = needle
              ? conferences.find((c) => c.name.toLowerCase() === needle) ??
                conferences.find((c) => (c.abbreviation ?? "").toLowerCase() === needle) ??
                conferences.find((c) => c.name.toLowerCase().includes(needle))
              : undefined;
            if (!match) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `CFB standings need a recognised conference. Valid: ${conferences.map((c) => c.name).join(", ")}`,
                  },
                ],
                isError: true,
              };
            }
            scope = match.name;
            raw = await bdl.getConferenceStandings(sport, { conferenceId: match.id, season });
          } else {
            raw = await bdl.getStandings(sport, season);
          }
          rows = (raw.data ?? []).map(normalizeStanding);
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No standings source is wired for ${sport.toUpperCase()}. ESPN serves ` +
                  `${ESPN_STANDINGS_SPORTS.join(", ")}, CollegeFootballData serves cfb` +
                  (sport === "cfb" ? " (CFBD_API_KEY is not set)" : "") +
                  `, and BALLDONTLIE is cancelled. Confirm records by live search.`,
              },
            ],
            isError: true,
          };
        }

        if (input.teamName) {
          const needle = input.teamName.toLowerCase();
          rows = rows.filter((r) => r.teamName.toLowerCase().includes(needle));
        }

        if (!rows.length) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No standings rows returned for ${scope}, season ${season}` +
                  (input.teamName ? ` matching "${input.teamName}"` : "") +
                  `.\n\nEarly in a season the table may not be populated yet, which is a real ` +
                  `answer rather than an error.`,
              },
            ],
          };
        }

        // Best record first. Where the provider gives no win percentage, fall back
        // to wins so the ordering is still meaningful rather than arbitrary.
        const winPct = (r: (typeof rows)[number]): number => {
          const rec = r.overallRecord;
          if (!rec) return -1;
          const [w, l] = rec.split("-").map((n) => parseInt(n.trim(), 10));
          if (!Number.isFinite(w) || !Number.isFinite(l)) return -1;
          const total = (w as number) + (l as number);
          return total > 0 ? (w as number) / total : -1;
        };
        rows.sort((a, b) => winPct(b) - winPct(a) || a.teamName.localeCompare(b.teamName));

        const withDiff = rows.filter((r) => typeof r.pointDifferential === "number").length;

        const summary =
          `${rows.length} team(s), ${scope}, season ${season}. Source: ${source}.${sourceNote}` +
          (withDiff
            ? ` ${withDiff} row(s) carry point differential, which is stronger reasoning material than a raw record.`
            : ` Point differential is not populated for this sport/season.`) +
          `\n\nThese are DECAYING facts - correct now, wrong the next time these teams play. ` +
          `Re-pull same-day before publishing any number from here.`;

        return {
          content: [
            { type: "text" as const, text: `${summary}\n\n${JSON.stringify(rows, null, 2)}` },
          ],
          structuredContent: {
            sport,
            scope,
            season,
            source,
            count: rows.length,
            standings: rows,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching standings: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
