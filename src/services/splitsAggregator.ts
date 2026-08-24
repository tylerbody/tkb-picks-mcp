import type { SGOClient } from "./sgoClient.js";
import type { SportKey } from "../constants.js";
import type { TeamSplitRecord, SGOEvent } from "../types.js";

/**
 * Computes a team's home or road record by pulling their finalized events for
 * the current season and tallying wins/losses filtered by home/away.
 *
 * Same underlying mechanism as hit-rate: no dedicated "standings splits" endpoint,
 * this filters/tallies from raw event results.
 */
export async function getHomeRoadSplit(
  sgo: SGOClient,
  params: {
    sport: SportKey;
    teamID: string;
    teamName: string;
    location: "home" | "road";
    seasonStartsAfter?: string; // ISO date - defaults to a ~220-day lookback if omitted
  }
): Promise<TeamSplitRecord> {
  const leagueID = sgo.leagueIDFor(params.sport);

  // CRITICAL: always bound by date, same root-cause fix as hitRateAggregator -
  // fetching finalized=true with no date bound is confirmed (via live testing)
  // to potentially return games from a much earlier season, not recent ones.
  const startsAfter = params.seasonStartsAfter ?? defaultLookbackStart();

  const events = await sgo.getAllEvents({
    leagueID,
    teamID: params.teamID,
    finalized: true,
    startsAfter,
    startsBefore: new Date().toISOString(),
    // Only win/loss (from scores) is needed here, never odds - narrow the odds
    // payload to a single market to keep response size minimal. Same fix as
    // hitRateAggregator.ts.
    oddIDs: "points-home-game-ml-home",
    // BOUND THE TOTAL. `limit` is per-page and getAllEvents defaulted to 10
    // pages, so this could pull up to 1,000 billed event objects to answer one
    // home/road question. This is a fallback path (BDL standings are tried
    // first), but it fires whenever standings miss - which is exactly when
    // nobody is watching the cost.
    limit: 100,
    maxEvents: 100,
  });

  const filtered = events.filter((e) => {
    const isHome = e.teams.home.teamID === params.teamID;
    return params.location === "home" ? isHome : !isHome;
  });

  let wins = 0;
  let losses = 0;

  for (const event of filtered) {
    const result = getWinLoss(event, params.teamID);
    if (result === "win") wins++;
    if (result === "loss") losses++;
    // ties/unfinished excluded from the tally, not counted either way
  }

  return {
    teamName: params.teamName,
    wins,
    losses,
    context: params.location,
  };
}

/**
 * Computes a team's record specifically against one opponent, optionally
 * bounded by a lookback window (e.g. "last 3 seasons").
 */
export async function getOpponentSplit(
  sgo: SGOClient,
  params: {
    sport: SportKey;
    teamID: string;
    teamName: string;
    opponentTeamID: string;
    opponentName: string;
    startsAfter?: string;
  }
): Promise<TeamSplitRecord> {
  const leagueID = sgo.leagueIDFor(params.sport);

  const startsAfter = params.startsAfter ?? defaultLookbackStart();

  const events = await sgo.getAllEvents({
    leagueID,
    teamID: params.teamID,
    finalized: true,
    startsAfter,
    startsBefore: new Date().toISOString(),
    oddIDs: "points-home-game-ml-home",
    // BOUND THE TOTAL. `limit` is per-page and getAllEvents defaulted to 10
    // pages, so this could pull up to 1,000 billed event objects to answer one
    // home/road question. This is a fallback path (BDL standings are tried
    // first), but it fires whenever standings miss - which is exactly when
    // nobody is watching the cost.
    limit: 100,
    maxEvents: 100,
  });

  const vsOpponent = events.filter((e) => {
    return (
      e.teams.home.teamID === params.opponentTeamID ||
      e.teams.away.teamID === params.opponentTeamID
    );
  });

  let wins = 0;
  let losses = 0;

  for (const event of vsOpponent) {
    const result = getWinLoss(event, params.teamID);
    if (result === "win") wins++;
    if (result === "loss") losses++;
  }

  return {
    teamName: params.teamName,
    wins,
    losses,
    context: `vs ${params.opponentName}`,
  };
}

function getWinLoss(event: SGOEvent, teamID: string): "win" | "loss" | "unknown" {
  const { home, away } = event.teams;
  if (home.score === undefined || away.score === undefined) return "unknown";

  const isHome = home.teamID === teamID;
  const teamScore = isHome ? home.score : away.score;
  const oppScore = isHome ? away.score : home.score;

  if (teamScore === oppScore) return "unknown"; // tie - sport-dependent, exclude
  return teamScore > oppScore ? "win" : "loss";
}

/**
 * Default lookback window when no explicit seasonStartsAfter/startsAfter is given -
 * roughly one full MLB season's worth of days back from now. Prevents the
 * "unbounded query returns ancient history" bug found via live testing.
 */
function defaultLookbackStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - 220);
  return d.toISOString();
}
