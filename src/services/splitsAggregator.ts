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
    seasonStartsAfter?: string; // ISO date - defaults to a broad lookback if omitted
  }
): Promise<TeamSplitRecord> {
  const leagueID = sgo.leagueIDFor(params.sport);

  const events = await sgo.getAllEvents({
    leagueID,
    teamID: params.teamID,
    finalized: true,
    startsAfter: params.seasonStartsAfter,
    limit: 100,
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

  const events = await sgo.getAllEvents({
    leagueID,
    teamID: params.teamID,
    finalized: true,
    startsAfter: params.startsAfter,
    limit: 100,
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
