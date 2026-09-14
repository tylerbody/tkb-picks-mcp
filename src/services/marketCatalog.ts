import type { SportKey } from "../constants.js";

/**
 * Player-level Over/Under prop catalog per sport - human-readable label to statID,
 * extracted directly from SportsGameOdds' published market CSVs (full-event,
 * player-level Over/Under rows only). Used by tkb_get_odds to construct exact
 * oddIDs instead of loose text matching.
 */
export const OU_PROP_MARKETS: Record<SportKey, { statID: string; label: string }[]> = {
  mlb: [
    { statID: "batting_doubles", label: "Doubles" },
    { statID: "pitching_earnedRuns", label: "Earned Runs" },
    { statID: "fantasyScore", label: "Fantasy Score" },
    { statID: "batting_hits", label: "Hits" },
    { statID: "batting_hits+runs+rbi", label: "Hits + Runs + RBIs" },
    { statID: "pitching_hits", label: "Hits Allowed" },
    { statID: "batting_homeRuns", label: "Home Runs" },
    { statID: "pitching_outs", label: "Outs" },
    { statID: "pitching_pitchesThrown", label: "Pitches Thrown" },
    { statID: "batting_runs+rbi", label: "Runs + RBIs" },
    { statID: "batting_RBI", label: "Runs Batted In" },
    { statID: "points", label: "Score" },
    { statID: "batting_singles", label: "Singles" },
    { statID: "batting_stolenBases", label: "Stolen Bases" },
    { statID: "batting_strikeouts", label: "Strikeouts (batter)" },
    { statID: "pitching_strikeouts", label: "Strikeouts (pitcher)" },
    { statID: "batting_totalBases", label: "Total Bases" },
    { statID: "batting_triples", label: "Triples" },
    { statID: "pitching_basesOnBalls", label: "Walks (pitcher)" },
    { statID: "batting_basesOnBalls", label: "Walks (batter)" },
  ],
  wnba: [
    { statID: "assists", label: "Assists" },
    { statID: "blocks", label: "Blocks" },
    { statID: "blocks+steals", label: "Blocks + Steals" },
    { statID: "fantasyScore", label: "Fantasy Score" },
    { statID: "fieldGoalsMade", label: "Field Goals Made" },
    { statID: "freeThrowsAttempted", label: "Free Throws Attempted" },
    { statID: "freeThrowsMade", label: "Free Throws Made" },
    { statID: "points+assists", label: "Points + Assists" },
    { statID: "points+rebounds", label: "Points + Rebounds" },
    { statID: "points+rebounds+assists", label: "Points + Rebounds + Assists" },
    { statID: "rebounds", label: "Rebounds" },
    { statID: "rebounds+assists", label: "Rebounds + Assists" },
    { statID: "points", label: "Score" },
    { statID: "steals", label: "Steals" },
    { statID: "threePointersMade", label: "Three Pointers Made" },
    { statID: "turnovers", label: "Turnovers" },
  ],
  nfl: [
    { statID: "defense_assistedTackles", label: "Assisted Tackles" },
    { statID: "defense_combinedTackles", label: "Combined Tackles + Assists" },
    { statID: "extraPoints_kicksMade", label: "Extra Points Made" },
    { statID: "fantasyScore", label: "Fantasy Score" },
    { statID: "fieldGoals_made", label: "Field Goals Made" },
    { statID: "defense_interceptions", label: "Interceptions" },
    { statID: "kicking_totalPoints", label: "Kicking Total Points" },
    { statID: "passing_longestCompletion", label: "Longest Completion" },
    { statID: "receiving_longestReception", label: "Longest Reception" },
    { statID: "rushing_longestRush", label: "Longest Rush" },
    { statID: "passing+rushing_yards", label: "Passing + Rushing Yards" },
    { statID: "passing_attempts", label: "Passing Attempts" },
    { statID: "passing_completions", label: "Passing Completions" },
    { statID: "passing_touchdowns", label: "Passing Touchdowns" },
    { statID: "passing_yards", label: "Passing Yards" },
    { statID: "receiving_touchdowns", label: "Receiving Touchdowns" },
    { statID: "receiving_yards", label: "Receiving Yards" },
    { statID: "receiving_receptions", label: "Receptions" },
    { statID: "rushing+receiving_yards", label: "Rushing + Receiving Yards" },
    { statID: "rushing_attempts", label: "Rushing Attempts" },
    { statID: "rushing_touchdowns", label: "Rushing Touchdowns" },
    { statID: "rushing_yards", label: "Rushing Yards" },
    { statID: "defense_sacks", label: "Sacks" },
    { statID: "points", label: "Score" },
    { statID: "defense_soloTackles", label: "Solo Tackles" },
    { statID: "touchdowns", label: "Touchdowns" },
    { statID: "turnovers", label: "Turnovers" },
  ],
  cfb: [
    { statID: "extraPoints_kicksMade", label: "Extra Points Made" },
    { statID: "fantasyScore", label: "Fantasy Score" },
    { statID: "fieldGoals_made", label: "Field Goals Made" },
    { statID: "defense_interceptions", label: "Interceptions" },
    { statID: "kicking_totalPoints", label: "Kicking Total Points" },
    { statID: "passing_longestCompletion", label: "Longest Completion" },
    { statID: "receiving_longestReception", label: "Longest Reception" },
    { statID: "rushing_longestRush", label: "Longest Rush" },
    { statID: "passing+rushing_yards", label: "Passing + Rushing Yards" },
    { statID: "passing_attempts", label: "Passing Attempts" },
    { statID: "passing_completions", label: "Passing Completions" },
    { statID: "passing_touchdowns", label: "Passing Touchdowns" },
    { statID: "passing_yards", label: "Passing Yards" },
    { statID: "receiving_touchdowns", label: "Receiving Touchdowns" },
    { statID: "receiving_yards", label: "Receiving Yards" },
    { statID: "receiving_receptions", label: "Receptions" },
    { statID: "rushing+receiving_yards", label: "Rushing + Receiving Yards" },
    { statID: "rushing_attempts", label: "Rushing Attempts" },
    { statID: "rushing_touchdowns", label: "Rushing Touchdowns" },
    { statID: "rushing_yards", label: "Rushing Yards" },
    { statID: "defense_sacks", label: "Sacks" },
    { statID: "points", label: "Score" },
    { statID: "touchdowns", label: "Touchdowns" },
  ],

  // ---- TENNIS ----
  // EMPTY BY DESIGN, NOT BY OMISSION. SGO does carry tennis player markets
  // (serving aces, break points won), but they are addressed through the
  // home/away PARTICIPANT SLOTS rather than a playerID, so they do not fit the
  // shape of this catalog - every consumer of OU_PROP_MARKETS pairs a statID
  // with a playerID from event.players, which is permanently empty for tennis.
  //
  // An empty array is the correct value: tkb_screen_props reports "no countable
  // markets" and stops, rather than screening garbage. The capability flags in
  // constants.ts are what produce the actual explanation to the caller.
  //
  // IF TOTALS ARE EVER ADDED: use statID `games`, never `points`. `points`
  // carries the SET score and settles the match winner; `games` carries the game
  // count and is what totals and handicaps are priced on.
  atp: [],
  wta: [],

  // ---- MEN'S COLLEGE BASKETBALL ----
  //
  // SGO HAS ONE BASKETBALL STAT NAMESPACE. Its stats page lists basketball statIDs
  // once, not per league, so NBA, WNBA and NCAAB share identical spellings. These
  // are therefore the WNBA entries verbatim, minus nothing and plus the two-pointer
  // splits, rather than a parallel guess at college-specific names.
  //
  // WHICH of these actually carry posted odds on a given college board is a separate
  // COVERAGE question, and an early-season mid-major game will post far fewer than a
  // ranked matchup. SGO's own NCAAB page names only points, rebounds, assists and
  // threes explicitly. The rest are listed here because the statID is documented; a
  // market that is not posted returns no odds and says so, which is the correct
  // outcome and not a catalog error.
  cbb: [
    { statID: "assists", label: "Assists" },
    { statID: "blocks", label: "Blocks" },
    { statID: "blocks+steals", label: "Blocks + Steals" },
    { statID: "fantasyScore", label: "Fantasy Score" },
    { statID: "fieldGoalsAttempted", label: "Field Goals Attempted" },
    { statID: "fieldGoalsMade", label: "Field Goals Made" },
    { statID: "freeThrowsAttempted", label: "Free Throws Attempted" },
    { statID: "freeThrowsMade", label: "Free Throws Made" },
    { statID: "minutesPlayed", label: "Minutes Played" },
    { statID: "offensiveRebounds", label: "Offensive Rebounds" },
    { statID: "points+assists", label: "Points + Assists" },
    { statID: "points+rebounds", label: "Points + Rebounds" },
    { statID: "points+rebounds+assists", label: "Points + Rebounds + Assists" },
    { statID: "rebounds", label: "Rebounds" },
    { statID: "rebounds+assists", label: "Rebounds + Assists" },
    { statID: "points", label: "Score" },
    { statID: "steals", label: "Steals" },
    { statID: "threePointersAttempted", label: "Three Pointers Attempted" },
    { statID: "threePointersMade", label: "Three Pointers Made" },
    { statID: "turnovers", label: "Turnovers" },
  ],

  // ---- SOCCER (EPL and UCL share one catalog) ----
  //
  // `points` IS GOALS. SGO's soccer stat list contains no `goals` statID at all - it
  // has `goals+assists` but no bare `goals` - and the EPL page gives the mapping as
  // "points (goals)". Anything built against a `goals` string would silently match
  // nothing.
  //
  // PLAYER PROPS USE THE `game` PERIOD even though MATCH LINES use `reg`. That split
  // is enforced in constants.ts (matchLinePeriodFor), not here, because it is a
  // property of the market kind rather than of the stat.
  //
  // Note two spellings that look like typos and are not: SGO writes `disposessed`
  // with a single middle "s", and the goalkeeper stats are prefixed `goalie_`, not
  // `keeper_` or `gk_`. Both are quoted from their stats page.
  epl: [
    { statID: "assists", label: "Assists" },
    { statID: "clearances", label: "Clearances" },
    { statID: "duels_won", label: "Duels Won" },
    { statID: "fantasyScore", label: "Fantasy Score" },
    { statID: "fouls", label: "Fouls Committed" },
    { statID: "foulsDrawn", label: "Fouls Drawn" },
    { statID: "goals+assists", label: "Goals + Assists" },
    { statID: "points", label: "Goals" },
    { statID: "interceptions", label: "Interceptions" },
    { statID: "minutesPlayed", label: "Minutes Played" },
    { statID: "offsides", label: "Offsides" },
    { statID: "passes_accurate", label: "Passes Completed" },
    { statID: "goalie_saves", label: "Saves" },
    { statID: "shots", label: "Shots" },
    { statID: "shots_blocked", label: "Shots Blocked" },
    { statID: "shots_onGoal", label: "Shots On Target" },
    { statID: "tackles", label: "Tackles" },
    { statID: "touches", label: "Touches" },
  ],
  ucl: [
    { statID: "assists", label: "Assists" },
    { statID: "clearances", label: "Clearances" },
    { statID: "duels_won", label: "Duels Won" },
    { statID: "fantasyScore", label: "Fantasy Score" },
    { statID: "fouls", label: "Fouls Committed" },
    { statID: "foulsDrawn", label: "Fouls Drawn" },
    { statID: "goals+assists", label: "Goals + Assists" },
    { statID: "points", label: "Goals" },
    { statID: "interceptions", label: "Interceptions" },
    { statID: "minutesPlayed", label: "Minutes Played" },
    { statID: "offsides", label: "Offsides" },
    { statID: "passes_accurate", label: "Passes Completed" },
    { statID: "goalie_saves", label: "Saves" },
    { statID: "shots", label: "Shots" },
    { statID: "shots_blocked", label: "Shots Blocked" },
    { statID: "shots_onGoal", label: "Shots On Target" },
    { statID: "tackles", label: "Tackles" },
    { statID: "touches", label: "Touches" },
  ],

  // ---- UFC ----
  //
  // SINGULAR/PLURAL IS LOAD-BEARING HERE AND IS THE EASIEST PLACE TO SHIP A BUG.
  // SGO's MMA stat list pairs a PLURAL landed stat with a SINGULAR attempts stat:
  //
  //   landed                      attempted
  //   significant_strikes         significant_strike_attempts
  //   strikes                     strike_attempts
  //   takedowns_landed            takedown_attempts
  //
  // So it is `significant_strikes`, NOT `significant_strikes_landed`, and
  // `takedown_attempts`, NOT `takedowns_attempted`. Every string below is quoted
  // from that list rather than derived from its neighbour.
  //
  // `roundsCompleted` is a FIGHT-level stat and uses the `all` entity, not a
  // fighter. It is in this catalog because tkb_get_odds addresses game totals the
  // same way it addresses player totals; the entity is chosen by the caller.
  ufc: [
    { statID: "controlTime_minutes", label: "Control Time (minutes)" },
    { statID: "fantasyScore", label: "Fantasy Score" },
    { statID: "knockdowns", label: "Knockdowns" },
    { statID: "roundsCompleted", label: "Rounds Completed" },
    { statID: "significant_strike_attempts", label: "Significant Strikes Attempted" },
    { statID: "significant_strikes", label: "Significant Strikes Landed" },
    { statID: "strike_attempts", label: "Strikes Attempted" },
    { statID: "strikes", label: "Strikes Landed" },
    { statID: "submissions_attempted", label: "Submission Attempts" },
    { statID: "takedown_attempts", label: "Takedowns Attempted" },
    { statID: "takedowns_landed", label: "Takedowns Landed" },
  ],
};

/**
 * Yes/No prop catalog per sport - statID and human-readable name, extracted
 * directly from SportsGameOdds' published market CSVs (not guessed). These are
 * "milestone"-style bets: did the player/team do X at all, not an over/under line.
 *
 * cfb here also covers ncaaf naming from the source data.
 */
export const YES_NO_MARKETS: Record<SportKey, { statID: string; label: string }[]> = {
  mlb: [
    { statID: "batting_doubles", label: "Any Doubles" },
    { statID: "pitching_earnedRuns", label: "Any Earned Runs" },
    { statID: "batting_firstHomeRun", label: "First Home Run" },
    { statID: "batting_hits", label: "Any Hits" },
    { statID: "batting_hits+runs+rbi", label: "Any Hits + Runs + RBIs" },
    { statID: "pitching_hits", label: "Any Hits Allowed" },
    { statID: "batting_homeRuns", label: "Any Home Runs" },
    { statID: "pitching_outs", label: "Any Outs" },
    { statID: "pitching_win", label: "Pitching Win" },
    { statID: "batting_runs+rbi", label: "Any Runs + RBIs" },
    { statID: "batting_RBI", label: "Any RBIs" },
    { statID: "points", label: "Any Score" },
    { statID: "batting_singles", label: "Any Singles" },
    { statID: "batting_stolenBases", label: "Any Stolen Bases" },
    { statID: "batting_strikeouts", label: "Any Strikeouts (batter)" },
    { statID: "pitching_strikeouts", label: "Any Strikeouts (pitcher)" },
    { statID: "batting_totalBases", label: "Any Total Bases" },
    { statID: "batting_triples", label: "Any Triples" },
    { statID: "batting_basesOnBalls", label: "Any Walks (batter)" },
    { statID: "pitching_basesOnBalls", label: "Any Walks (pitcher)" },
  ],
  wnba: [
    { statID: "assists", label: "Any Assists" },
    { statID: "blocks", label: "Any Blocks" },
    { statID: "blocks+steals", label: "Any Blocks + Steals" },
    { statID: "doubleDouble", label: "Double-Double" },
    { statID: "firstBasket", label: "First Basket" },
    { statID: "freeThrowsMade", label: "Any Free Throws Made" },
    { statID: "points+rebounds+assists", label: "Any Points + Rebounds + Assists" },
    { statID: "rebounds", label: "Any Rebounds" },
    { statID: "rebounds+assists", label: "Any Rebounds + Assists" },
    { statID: "points", label: "Any Score" },
    { statID: "steals", label: "Any Steals" },
    { statID: "threePointersMade", label: "Any Threes Made" },
    { statID: "tripleDouble", label: "Triple-Double" },
    { statID: "turnovers", label: "Any Turnovers" },
  ],
  nfl: [
    { statID: "defense_safeties", label: "Defensive Safety" },
    { statID: "firstTouchdown", label: "First Touchdown" },
    { statID: "passing_interceptions", label: "Any Interception Thrown" },
    { statID: "lastTouchdown", label: "Last Touchdown" },
    { statID: "passing_touchdowns", label: "Any Passing TD" },
    { statID: "rushing_yards", label: "Any Rushing Yards" },
    { statID: "points", label: "Any Score" },
    { statID: "touchdowns", label: "Any Touchdown" },
  ],
  cfb: [
    { statID: "firstTouchdown", label: "First Touchdown" },
    { statID: "lastTouchdown", label: "Last Touchdown" },
    { statID: "points", label: "Any Score" },
    { statID: "touchdowns", label: "Any Touchdown" },
  ],

  // ---- TENNIS ----
  // Same reasoning as OU_PROP_MARKETS above: milestone markets exist but are
  // participant-slot addressed, not playerID addressed. Moneyline only.
  atp: [],
  wta: [],

  cbb: [
    { statID: "assists", label: "Any Assists" },
    { statID: "blocks", label: "Any Blocks" },
    { statID: "blocks+steals", label: "Any Blocks + Steals" },
    { statID: "doubleDouble", label: "Double-Double" },
    { statID: "firstBasket", label: "First Basket" },
    { statID: "freeThrowsMade", label: "Any Free Throws Made" },
    { statID: "rebounds", label: "Any Rebounds" },
    { statID: "points", label: "Any Score" },
    { statID: "steals", label: "Any Steals" },
    { statID: "threePointersMade", label: "Any Threes Made" },
    { statID: "tripleDouble", label: "Triple-Double" },
  ],

  // SOCCER. Anytime goalscorer is the one milestone market that matters for this
  // account, and SGO writes it as `points` + `yn` - confirmed by their own verbatim
  // example, `points-MOHAMED_SALAH_1_EPL-game-yn-yes`. Note the `game` period on a
  // player market, sitting alongside `reg` match lines on the same event.
  //
  // `bothTeamsScored` is a TEAM/GAME-level yes-no, not a player one. It is listed
  // because tkb_get_yes_no_prop can address the `all` entity, but it must never be
  // paired with a playerID.
  epl: [
    { statID: "points", label: "Anytime Goalscorer" },
    { statID: "assists", label: "Any Assist" },
    { statID: "bothTeamsScored", label: "Both Teams To Score" },
    { statID: "firstToScore", label: "First To Score" },
    { statID: "lastToScore", label: "Last To Score" },
    { statID: "shots_onGoal", label: "Any Shot On Target" },
    { statID: "yellowCards", label: "Any Yellow Card" },
  ],
  ucl: [
    { statID: "points", label: "Anytime Goalscorer" },
    { statID: "assists", label: "Any Assist" },
    { statID: "bothTeamsScored", label: "Both Teams To Score" },
    { statID: "firstToScore", label: "First To Score" },
    { statID: "lastToScore", label: "Last To Score" },
    { statID: "shots_onGoal", label: "Any Shot On Target" },
    { statID: "yellowCards", label: "Any Yellow Card" },
  ],

  // UFC METHOD OF VICTORY. These three are the fight-outcome markets and they are
  // FIGHTER-entity yes/no questions: "does this fighter win by knockout".
  //
  // GRADING THEM NEEDS A METHOD, WHICH THIS CONNECTOR CANNOT SETTLE FROM AN EVENT
  // SCORE. A UFC event carries a winner, not a method, in the fields this repo
  // reads. tkb_grade_pick therefore refuses a wonBy_* market by name rather than
  // inferring "the favourite won inside the distance" from a rounds figure. They are
  // catalogued so the odds can be PULLED and posted; settling them is a manual read
  // of the result.
  ufc: [
    { statID: "wonBy_decision", label: "Win By Decision" },
    { statID: "wonBy_knockout", label: "Win By Knockout / TKO" },
    { statID: "wonBy_submission", label: "Win By Submission" },
  ],
};

/**
 * Valid periods per sport (beyond full game), matching real market coverage
 * confirmed from SGO's CSVs. NBA carries the same set as WNBA/NFL/CFB (quarters
 * only, no innings). This is used to validate tkb_get_period_odds input so we
 * fail fast with a clear message rather than silently returning empty results
 * for a period that sport doesn't support.
 */
export const SUPPORTED_PERIODS: Record<SportKey, string[]> = {
  mlb: [
    "1st_half",
    "1st_inning",
    "2nd_inning",
    "3rd_inning",
    "4th_inning",
    "5th_inning",
    "6th_inning",
    "7th_inning",
    "8th_inning",
    "9th_inning",
    "1st_3_innings",
    "1st_5_innings",
    "1st_7_innings",
  ],
  wnba: ["1st_half", "2nd_half", "1st_quarter", "2nd_quarter", "3rd_quarter", "4th_quarter"],
  nfl: ["1st_half", "2nd_half", "1st_quarter", "2nd_quarter", "3rd_quarter", "4th_quarter"],
  cfb: ["1st_half", "2nd_half", "1st_quarter", "2nd_quarter", "3rd_quarter", "4th_quarter"],
  // TENNIS: sets, not halves or quarters. Period codes 1s through 5s, added to
  // oddIdBuilder alongside these. Best-of-five at the Grand Slams means 4s/5s
  // only exist in men's slam matches; requesting them elsewhere returns no
  // market rather than an error, which is the correct behaviour.
  atp: ["1st_set", "2nd_set", "3rd_set", "4th_set", "5th_set"],
  wta: ["1st_set", "2nd_set", "3rd_set"],

  // COLLEGE BASKETBALL PLAYS HALVES, NOT QUARTERS. SGO's NCAAB page mentions only
  // halves ("Swap game for 1h in the oddID to get the first-half version") and lists
  // no quarter market anywhere. Quarters are omitted deliberately: offering them
  // would produce an empty result that reads like a missing line rather than like a
  // period this sport does not play.
  cbb: ["1st_half", "2nd_half"],

  // SOCCER. Halves only. `et` (extra time) and `ps` (penalty shootout) are real
  // documented periodIDs and are obviously soccer-shaped, but nothing in the docs
  // binds them to specific markets and league play never reaches them, so they are
  // left out rather than guessed at. They matter for knockout-round UCL ties and are
  // worth confirming against GET /markets before a knockout stage is covered.
  epl: ["1st_half", "2nd_half"],
  ucl: ["1st_half", "2nd_half"],

  // UFC ROUNDS. 1r through 5r are documented periodIDs ("1st Round" ... "5th Round")
  // and five is the ceiling: championship and main-event fights are five rounds,
  // everything else is three, and requesting 4r on a three-round fight returns no
  // market rather than an error, which is correct.
  //
  // THE "OPENING ROUNDS" GROUP MARKET IS DELIBERATELY ABSENT. SGO's UFC page refers
  // to it in prose but never prints its periodID, and no documented code matches its
  // shape. Guessing one would produce silent empties. Confirm it against
  // GET /markets before adding.
  ufc: ["1st_round", "2nd_round", "3rd_round", "4th_round", "5th_round"],
};
