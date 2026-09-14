import type { CBBDClient, CbbdTeamBoxScore } from "./cbbdClient.js";
import type { GameLogEntry, HitRateResult } from "../types.js";
import type { CbbdPlayerRow } from "./cbbdStatMap.js";
import { lookupCbbdStat, isCbbdStatSupported, supportedCbbdStatIDs } from "./cbbdStatMap.js";
import { summarizeSeasons } from "./seasonBoundary.js";
import { describeRecency } from "./sampleRecency.js";

/**
 * COUNTED COLLEGE BASKETBALL HIT RATES FROM CollegeBasketballData.
 *
 * A FOURTH AGGREGATOR, and the fourth shape. SGO walks team EVENTS backward; BDL
 * fetches one PLAYER'S rows and joins them to a games list for dates; CFBD arrives
 * a WEEK at a time; CBBD arrives a DATE WINDOW at a time with the dates already
 * attached. Forcing any of these into another's shape has been tried in this repo
 * and the result each time was a number that looked right.
 *
 * WHAT IT REUSES DELIBERATELY: summarizeSeasons and describeRecency. College
 * basketball needs both harder than any sport here except CFB, and for a reason
 * specific to its calendar - see below.
 *
 * ============================================================================
 * THE NOVEMBER PROBLEM, WHICH IS THIS SPORT'S VERSION OF THE CFB OPENING WEEKS
 * ============================================================================
 *
 * The season tips in early November. For the first three weeks EVERY sample is
 * either tiny or prior-season, and a prior-season college basketball sample is
 * weaker than a prior-season NFL one: rosters turn over far harder, a large share
 * of last year's minutes have transferred or graduated, and a sophomore's role can
 * change completely between seasons.
 *
 * So the honest output in November is usually "not enough games yet", and this
 * aggregator is built to say that rather than to fill the gap. The
 * minCurrentSeasonGames floor added to tkb_screen_props in v2.8.12 exists for
 * exactly this case and applies here.
 *
 * ============================================================================
 * ONE THING THAT IS GENUINELY BETTER THAN THE FOOTBALL PATH
 * ============================================================================
 *
 * CBBD filters its player array on `minutes is not null`, so a player who did not
 * play is ABSENT from the box score rather than present with zeros. That means a
 * CBB availability flag can be honest in a way the CFB one cannot: presence proves
 * he played, and `minutes` says how much. The CFB aggregator has to report UNKNOWN
 * because CFBD lists a player only where he recorded a stat, so a quiet game and an
 * absence look identical. Here they do not.
 */

/** How many days each fetched window spans. One week, to match the CFBD economics. */
const WINDOW_DAYS = 7;

/** Never walk back further than this, regardless of how few appearances are found. */
const MAX_WINDOWS = 30;

export interface CbbdHitRateParams {
  /** CBBD's team name, e.g. "Purdue". Compared with a normalised exact match. */
  teamName: string;
  playerName: string;
  statID: string;
  line: number;
  direction: "over" | "under";
  /** Stop once this many appearances are collected. */
  targetAppearances?: number;
  minSufficient?: number;
  /** Overridable for tests. Defaults to now. */
  asOf?: Date;
}

/** Normalised comparison for team and player names. */
function norm(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * SGO teamID -> the team NAME CollegeBasketballData uses.
 *
 * THE v2.8.6 BUG, PRE-EMPTED. On the football side, tools/hitRate.ts passed an SGO
 * teamID (COLORADO_NCAAF) into an aggregator that compares against CFBD's display
 * name ("Colorado"). The exact-match never fired, every CFB hit rate returned NO
 * SAMPLE, and it did so silently for several releases because an empty CFB sample
 * looks completely ordinary in the opening weeks.
 *
 * College basketball has the same collision - SGO writes PURDUE_NCAAB - so the same
 * derivation ships from day one rather than after the same outage.
 *
 * IT CANNOT COVER EVERY PROGRAM and does not pretend to. 350+ D1 schools include
 * Saint Mary's, Texas A&M, UMass and Miami (OH), and the overrides below cover the
 * shapes most likely to be posted. Anything else falls through to title-casing, and
 * the caller REPORTS THE NAME IT SEARCHED on a miss so it is diagnosable in one
 * read rather than looking like an absent player.
 */
const CBBD_NAME_OVERRIDES: Record<string, string> = {
  "OLE MISS": "Ole Miss",
  UMASS: "UMass",
  UCONN: "UConn",
  "TEXAS AM": "Texas A&M",
  "SAINT MARYS": "Saint Mary's",
  "ST JOHNS": "St. John's",
  "SAINT JOSEPHS": "Saint Joseph's",
  "MIAMI OHIO": "Miami (OH)",
  "MIAMI FLORIDA": "Miami",
  "SAN JOSE STATE": "San Jose State",
  HAWAII: "Hawai'i",
  "NC STATE": "NC State",
  "UNC GREENSBORO": "UNC Greensboro",
};

/** Programs written in full capitals by the provider. */
const CBBD_ALL_CAPS = new Set([
  "BYU", "LSU", "TCU", "UCF", "UCLA", "UNLV", "USC", "UTSA", "SMU", "UAB",
  "UTEP", "FIU", "VCU", "UIC", "UMBC", "IUPUI", "UNC", "NC",
]);

export function deriveCbbdTeamName(sgoTeamID: string): string {
  const stripped = sgoTeamID
    .replace(/_NCAAB$/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return sgoTeamID;

  const override = CBBD_NAME_OVERRIDES[stripped.toUpperCase()];
  if (override) return override;

  return stripped
    .split(" ")
    .map((w) =>
      CBBD_ALL_CAPS.has(w.toUpperCase())
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join(" ");
}

/**
 * Find a player's CBBD athleteId by name within one team's box scores.
 *
 * REFUSES ON AMBIGUITY. Two players with the same name on one roster is rarer in
 * college basketball than in baseball, but the rule does not change: a hit rate
 * attached to the wrong player is worse than no hit rate. v2.0.1 declined eighteen
 * "Marte" matches for this reason and that was the right call.
 */
export function resolveCbbdPlayer(
  rows: CbbdTeamBoxScore[],
  teamName: string,
  playerName: string
): { id: number; name: string } | { error: string } {
  const wantTeam = norm(teamName);
  const wantPlayer = norm(playerName);
  const found = new Map<number, string>();

  for (const row of rows) {
    if (norm(row.team) !== wantTeam) continue;
    for (const p of row.players ?? []) {
      if (norm(p.name) === wantPlayer) found.set(p.athleteId, p.name);
    }
  }

  if (found.size === 1) {
    const [id, name] = [...found.entries()][0];
    return { id, name };
  }
  if (found.size === 0) {
    return {
      error:
        `No CollegeBasketballData player named "${playerName}" found on "${teamName}" in ` +
        `the scanned windows. Check the spelling against the roster, and check the TEAM ` +
        `NAME - CBBD writes school names its own way and an exact-match miss on the team ` +
        `looks identical to an absent player.`,
    };
  }
  return {
    error:
      `AMBIGUOUS PLAYER: ${found.size} players named "${playerName}" on ${teamName} ` +
      `(athleteIds ${[...found.keys()].join(", ")}). Refusing to guess - a hit rate ` +
      `attached to the wrong player is worse than no hit rate.`,
  };
}

/** The windows to walk, newest first. */
export function buildWindows(
  asOf: Date,
  count: number = MAX_WINDOWS
): { startISO: string; endISO: string; closed: boolean }[] {
  const day = 86_400_000;
  const out: { startISO: string; endISO: string; closed: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const end = new Date(asOf.getTime() - i * WINDOW_DAYS * day);
    const start = new Date(end.getTime() - WINDOW_DAYS * day);
    out.push({
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      // A window whose end is in the past is immutable and cached forever. The
      // first window contains today and is not.
      closed: i > 0,
    });
  }
  return out;
}

export async function getCbbdPlayerHitRate(
  cbbd: CBBDClient,
  params: CbbdHitRateParams
): Promise<HitRateResult & { cbbdAthleteID: number | null; matchedFields: string[] }> {
  if (!isCbbdStatSupported(params.statID)) {
    throw new Error(
      `Stat "${params.statID}" has no CollegeBasketballData mapping. Supported: ` +
        `${supportedCbbdStatIDs().join(", ")}. Do NOT substitute a value.`
    );
  }

  const targetAppearances = params.targetAppearances ?? 15;
  const minSufficient = params.minSufficient ?? 8;
  const asOf = params.asOf ?? new Date();

  const log: GameLogEntry[] = [];
  const matchedFields = new Set<string>();
  let overHits = 0;
  let underHits = 0;
  let pushCount = 0;
  let appearances = 0;
  let teamGamesScanned = 0;
  let minutesTotal = 0;
  let athleteID: number | null = null;

  // NEWEST WINDOW FIRST. Recency comes from the order we walk, never from trusting
  // provider ordering - the v2.5.0 rule, restated after v2.1.0 shipped a reversed
  // array that presented the oldest games as the most recent.
  for (const window of buildWindows(asOf)) {
    if (appearances >= targetAppearances) break;

    let rows: CbbdTeamBoxScore[];
    try {
      rows = await cbbd.getPlayerBoxScores({
        startISO: window.startISO,
        endISO: window.endISO,
        permanent: window.closed,
      });
    } catch {
      // One unavailable window must not abort the scan. Skipping is honest: the
      // sample size reported at the end reflects only what was actually read.
      continue;
    }

    if (athleteID === null) {
      const resolved = resolveCbbdPlayer(rows, params.teamName, params.playerName);
      if ("error" in resolved) continue;
      athleteID = resolved.id;
    }

    const teamRows = rows.filter((r) => norm(r.team) === norm(params.teamName));
    // Newest game first inside the window too.
    teamRows.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());

    for (const row of teamRows) {
      teamGamesScanned++;

      const player: CbbdPlayerRow | undefined = (row.players ?? []).find(
        (p) => p.athleteId === athleteID
      );

      if (!player) {
        // CBBD omits a player who did not play, so this IS a genuine absence rather
        // than a quiet game. That distinction is available here and is not on the
        // football path, so it is recorded rather than blurred.
        log.push({
          eventID: String(row.gameId),
          date: row.startDate || "unknown",
          opponent: row.opponent || "unknown",
          isHome: row.isHome,
          statValue: null,
          dataStatus: "player_absent",
          seasonYear: row.season,
        });
        continue;
      }

      const lookup = lookupCbbdStat(player, params.statID);
      if (lookup.kind !== "value") {
        log.push({
          eventID: String(row.gameId),
          date: row.startDate || "unknown",
          opponent: row.opponent || "unknown",
          isHome: row.isHome,
          statValue: null,
          dataStatus: "stat_unsettled",
          seasonYear: row.season,
        });
        continue;
      }

      matchedFields.add(lookup.matchedField);
      appearances++;
      if (typeof player.minutes === "number") minutesTotal += player.minutes;
      if (lookup.value > params.line) overHits++;
      else if (lookup.value < params.line) underHits++;
      else pushCount++;

      log.push({
        eventID: String(row.gameId),
        date: row.startDate || "unknown",
        opponent: row.opponent || "unknown",
        isHome: row.isHome,
        statValue: lookup.value,
        dataStatus: "value",
        seasonYear: row.season,
      });
      if (appearances >= targetAppearances) break;
    }
  }

  const gamesHit = params.direction === "over" ? overHits : underHits;
  const countedDates = log.filter((g) => g.statValue !== null).map((g) => g.date);

  // HARD REFUSAL, not a warning. Same rule as the BDL and CFBD paths: an unsortable
  // sample is not a recent-form hit rate, and summarizeSeasons reports
  // crossesSeasonBoundary FALSE when it receives dates it cannot parse, so the
  // prior-season warning goes SILENT exactly when it is most needed.
  if (countedDates.length > 0 && countedDates.every((d) => d === "unknown")) {
    throw new Error(
      `DATE RESOLUTION FAILED: ${countedDates.length} CBBD row(s) for ${params.playerName} ` +
        `carried no usable startDate, so season provenance and staleness cannot be ` +
        `assessed. Refusing to return a rate.`
    );
  }

  log.sort((a, b) => {
    const ta = a.date === "unknown" ? 0 : new Date(a.date).getTime();
    const tb = b.date === "unknown" ? 0 : new Date(b.date).getTime();
    return tb - ta;
  });

  const seasons = summarizeSeasons("cbb", countedDates);
  const sufficient = appearances >= minSufficient;
  const gamesAbsent = log.filter((g) => g.dataStatus === "player_absent").length;

  const sampleWarning =
    athleteID === null
      ? `NO SAMPLE. "${params.playerName}" was not found on "${params.teamName}" in any ` +
        `scanned window. CHECK THE TEAM NAME FIRST - CollegeBasketballData writes school ` +
        `names its own way, and a team-name miss is indistinguishable from an absent ` +
        `player. DO NOT WRITE REASONING AROUND THIS PROP.`
      : appearances === 0
        ? `NO SAMPLE. ${params.playerName} recorded no ${params.statID} in any of the ` +
          `${teamGamesScanned} scanned team games. DO NOT WRITE REASONING AROUND THIS PROP.`
        : !sufficient
          ? `INSUFFICIENT SAMPLE: ${appearances} appearance(s), ${minSufficient} needed. ` +
            `A rate on ${appearances} game(s) is NOT a hit rate and must not be quoted as ` +
            `one. In November this is the NORMAL answer, not a malfunction.`
          : null;

  const recency = describeRecency(log, {});
  const combinedWarning =
    [sampleWarning, seasons.warning, recency.warning].filter(Boolean).join(" ") || null;

  const playRate = teamGamesScanned > 0 ? appearances / teamGamesScanned : 0;
  const avgMinutes = appearances > 0 ? minutesTotal / appearances : 0;

  return {
    playerName: params.playerName,
    statID: params.statID,
    line: params.line,
    direction: params.direction,
    gamesConsidered: appearances,
    gamesHit,
    gamesExcludedDNP: gamesAbsent,
    log,
    overHits,
    underHits,
    pushCount,
    teamGamesScanned,
    hitScanCeiling: false,
    sampleSufficient: sufficient,
    sampleWarning: combinedWarning,
    playerRole: "position_player",
    recentAvailability: {
      gamesPlayed: appearances,
      teamGamesScanned,
      gamesWithData: teamGamesScanned,
      playRate,
      // AN HONEST FLAG, WHICH THE CFB PATH CANNOT PRODUCE. CBBD includes a player
      // only when he logged minutes, so absence means he did not play rather than
      // "had a quiet game". A low play rate here is a real availability signal.
      flag: teamGamesScanned === 0 ? "UNKNOWN" : playRate >= 0.8 ? "OK" : "IRREGULAR",
      note:
        teamGamesScanned === 0
          ? `No team games were scanned, so nothing is established about availability.`
          : `CollegeBasketballData lists a player only when he logged minutes, so these ` +
            `${gamesAbsent} absence(s) are genuine DNPs rather than quiet games. Averaged ` +
            `${avgMinutes.toFixed(1)} minutes in the ${appearances} game(s) he played` +
            (playRate < 0.8
              ? ` - a play rate of ${(playRate * 100).toFixed(0)}% is low enough to check the ` +
                `reason before posting this prop.`
              : `.`),
    },
    currentSeasonGames: seasons.current,
    priorSeasonGames: seasons.prior,
    seasonsRepresented: seasons.seasonsRepresented,
    crossesSeasonBoundary: seasons.crossesSeasonBoundary,
    seasonWarning: seasons.warning,
    cbbdAthleteID: athleteID,
    matchedFields: [...matchedFields],
  };
}
