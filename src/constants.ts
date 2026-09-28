// Response size guard - if a formatted response would exceed this, truncate with a clear message
export const CHARACTER_LIMIT = 25000;

// SportsGameOdds API
export const SGO_BASE_URL = "https://api.sportsgameodds.com/v2";

// BALLDONTLIE API - base URL differs per sport (path-based, not subdomain)
export const BDL_BASE_URL = "https://api.balldontlie.io";

/**
 * THE BOOKS THIS ACCOUNT'S AUDIENCE CAN ACTUALLY BET.
 *
 * ONE DEFINITION, IMPORTED EVERYWHERE (v2.8.6). This string previously existed as
 * THREE copies: a const in tools/screenProps.ts, an identical const in
 * tools/propBoard.ts, and a third written inline into tools/gameLines.ts's zod
 * .default(). Three copies of a value that must agree is the same drift that put
 * SERVER_VERSION out of step with /health three separate times, and it is exactly
 * why v2.5.4 collapsed STARTING_PITCHER_THRESHOLDS into one exported constant.
 *
 * IT ALSO WAS NOT APPLIED EVERYWHERE. v2.6.2 called this "a policy rather than a
 * parameter" and then applied it to three call sites. Three more were missed:
 *   - tools/odds.ts declared preferredBookmakers optional with NO default
 *   - tools/yesNoProps.ts accepted no book parameter at all
 *   - tools/lineMovement.ts accepted no book parameter at all
 * v2.8.3 recorded the symptom of the last one (a test priced off BetOnline) and
 * filed it as a missing argument rather than as the pattern it is. All six call
 * sites now import this.
 *
 * ---- hardrockbet ADDED IN v2.8.6, AND IT IS A JUDGEMENT CALL ----
 *
 * v2.5.3 and v2.6.2 both measured Hard Rock among the venues polluting an
 * unfiltered board and deliberately left it out. That was an AUDIENCE-REACH call,
 * not a legitimacy one - it is a regulated US book, live in far fewer states than
 * the other four.
 *
 * WHAT CHANGED IS CFB. Measured 2026-09-02 on the Week 1 Thursday slate:
 *
 *   UAB @ Illinois           4-book default: 18 priced rows, ZERO two-sided
 *                            + hardrockbet:  36 priced rows, 22 two-sided
 *   Colorado @ Georgia Tech  4-book default: 12 priced rows,  4 two-sided
 *                            + hardrockbet:  27 priced rows, 17 two-sided
 *
 * Early-season CFB player markets are almost entirely Hard Rock right now; the
 * other four post one-sided touchdown longshots. Without it a CFB player-prop
 * thread has no publishable two-way number to build on AT ALL, which is a bigger
 * problem than the reach caveat. Revisit once CFB boards fill out later in the
 * season - this is one string in one file now, which is the point.
 *
 * NOTE ON THE ID: `hardrockbet` is now LISTED in SGO's published bookmakers table
 * (docs/data-types/bookmakers), alongside draftkings, fanduel, betmgm and caesars.
 * An earlier version of this comment said the page did not list it and that live
 * data beat the doc page. Re-checked 2026-09-15: the table has it. The underlying
 * principle stands - that table is explicitly not exhaustive, since SGO says more
 * bookmakers "can be made available upon request through a custom (AllStar) plan" -
 * but the specific claim was stale and has been corrected rather than left to
 * mislead the next reader.
 *
 * TWO THINGS FROM THAT PAGE WORTH CARRYING. A bookmaker appearing in the table does
 * NOT mean this key receives it: SGO filters bookmaker odds by plan and says so in a
 * response notice rather than an error. And `unknown` is a real bookmakerID in their
 * list, so a book-specific lookup has to tolerate odds attributed to nobody.
 */
export const DEFAULT_BOOKMAKERS =
  "draftkings,fanduel,betmgm,caesars,hardrockbet,betrivers,espnbet,ballybet";

/**
 * WIDENED 2026-09-28 from five books to eight, on measurement rather than preference.
 *
 * BetRivers, ESPN Bet and Bally Bet are regulated US books and were in NO block list.
 * They were simply absent from this string, so every prop tool filtered them out
 * silently while treating them as if they did not exist.
 *
 * MEASURED on NHL Boston at Florida, eventID QRDNo27CIPW3UiHjAzAV, a finalized
 * 2026-04-02 event with a full board:
 *
 *   old five books      80 priced rows
 *   filter disabled    102 priced rows
 *
 * And it was not only a row count. The `Goals` market at line 0.5, which is anytime
 * goalscorer in over/under form, came back ONE-SIDED under the old list (longshot
 * overs, no under, so the devig gate could never run) and TWO-SIDED once ESPN Bet was
 * visible, because ESPN Bet is what prices the under 0.5.
 *
 * The four block lists in oddsPricing.ts are untouched and still apply: pick'em apps,
 * Fliff, prediction markets and offshore books each stay blocked for their own
 * documented reason. This change adds regulated venues that were never blocked, it
 * does not relax a block.
 */

/**
 * WHAT A SPORT CAN ACTUALLY DO.
 *
 * WHY THIS EXISTS (added v2.6.0 with the tennis build): adding ATP/WTA widened
 * every tool's sport enum at once, because SUPPORTED_SPORTS is derived from
 * SPORT_CONFIG. Six tools would then have accepted sport="atp" and returned
 * something confidently useless rather than refusing:
 *
 *   - tkb_get_game_weather fell through to the CFB branch and searched
 *     CFB_STADIUMS for a tennis player's name
 *   - tkb_get_players returned "props are not posted yet, retry closer to first
 *     pitch", which is false and invites a pointless retry - tennis participants
 *     occupy home/away event slots and there is no roster to populate, ever
 *   - tkb_get_player_hit_rate skipped BDL (no stat mapping) and went to the SGO
 *     path, which needs a teamID and playerID that do not exist for tennis
 *   - tkb_get_team_split fell through to tallying SGO events and produced a
 *     number with no meaning
 *
 * Every one of those is a plausible-looking wrong answer rather than a clear
 * refusal, which is the exact failure class this connector was built to prevent
 * (see services/oddsPricing.ts for the original statement of the rule).
 *
 * DECLARED HERE RATHER THAN BRANCHED IN EACH TOOL, for the same reason
 * standingsNormalizer resolves aliases instead of branching on sport: a per-tool
 * `if (sport === "atp")` breaks again the moment NHL or NBA arrives with its own
 * shape. One table, checked the same way everywhere, and adding a sport later is
 * a row rather than an audit.
 */
export interface SportCapabilities {
  /** Player-level over/under props exist and players have roster IDs. */
  playerProps: boolean;
  /** A per-player game-log source exists for counted hit rates. */
  hitRates: boolean;
  /** An injury feed exists on the current subscription. */
  injuries: boolean;
  /** Games are outdoors at a fixed, known venue. */
  weather: boolean;
  /** Home/road and head-to-head records are meaningful for this sport. */
  teamSplits: boolean;
}

const TEAM_SPORT_CAPABILITIES: SportCapabilities = {
  playerProps: true,
  hitRates: true,
  injuries: true,
  weather: true,
  teamSplits: true,
};

// Maps our internal sport identifiers to each provider's expected league/sport identifiers.
// This is the single place to extend when NBA/NHL seasons start - add a row here,
// and TypeScript will refuse to compile until every Record<SportKey, ...> table is
// filled in (marketCatalog has three, seasonBoundary has one). That compiler error
// is the feature: there is no way to add a sport and silently forget a table.
export const SPORT_CONFIG = {
  mlb: {
    label: "MLB",
    sgoLeagueID: "MLB",
    bdlPath: "mlb",
    supports: TEAM_SPORT_CAPABILITIES,
  },
  wnba: {
    label: "WNBA",
    sgoLeagueID: "WNBA",
    bdlPath: "wnba",
    // Indoors. The weather tool already returns "indoors, not a factor" for WNBA
    // by name; the flag keeps that answer consistent with every other sport.
    supports: { ...TEAM_SPORT_CAPABILITIES, weather: false },
  },
  nfl: {
    label: "NFL",
    sgoLeagueID: "NFL",
    bdlPath: "nfl",
    supports: TEAM_SPORT_CAPABILITIES,
  },
  cfb: {
    label: "NCAAF",
    sgoLeagueID: "NCAAF",
    bdlPath: "ncaaf",
    // INJURIES: BALLDONTLIE has NO NCAAF injuries endpoint. Verified live
    // 2026-08-31: /ncaaf/v1/player_injuries and /ncaaf/v1/injuries both return 404
    // while /mlb/v1/player_injuries returns 200 on the same key and path shape. This
    // is a missing product, not a missing entitlement, so upgrading to GOAT would
    // NOT provide it. The earlier wording here ("not available on the current plan")
    // implied it was buyable, which is worse than saying nothing.
    //
    // HIT RATES stay true, but they are served by CollegeFootballData, NOT by an SGO
    // fallback. v2.7.0 removed that fallback deliberately: SGO carries CFB games but
    // not CFB player box scores outside the playoff, so falling back to it reported
    // started games as DNPs and produced Dante Moore at a 0.2 play rate. With no
    // CFBD_API_KEY the CFB path REFUSES rather than degrading.
    supports: { ...TEAM_SPORT_CAPABILITIES, injuries: false },
  },

  // ---- TENNIS ----
  //
  // MONEYLINE ONLY, DELIBERATELY. SGO does carry tennis games totals, games
  // handicaps, set winners and serving props, but this account posts moneyline
  // picks for tennis and nothing else, so none of the player-prop machinery is
  // wired up.
  //
  // TENNIS HAS NO PLAYERS IN SGO'S SENSE. Each competitor occupies the home or
  // away PARTICIPANT SLOT on the event rather than a roster position, so what is
  // a "player prop" in every other sport is addressed here through the home/away
  // entity. event.players is therefore permanently empty, which is why
  // playerProps and hitRates are false rather than "not yet built".
  //
  // A NOTE FOR WHOEVER ADDS TOTALS LATER: match winner settles on `points`,
  // which in tennis carries the SET score. Games totals and handicaps settle on
  // `games`, which carries the GAME count. Requesting points-all-game-ou-over
  // when you meant a games total is, per SGO's own docs, the most common tennis
  // integration mistake. Moneyline is unaffected - `points` is correct there,
  // which is why buildOddID needs no tennis-specific handling today.
  atp: {
    label: "ATP",
    sgoLeagueID: "ATP",
    // Real path: BALLDONTLIE publishes /atp/v1/head_to_head and /atp/v1/match_stats,
    // but as a SEPARATE subscription this account does not hold. Left populated
    // deliberately - the TTL tier gate in BDLClient handles the 401 on its own and
    // heals within 30 minutes if the subscription is ever bought, with no redeploy.
    bdlPath: "atp",
    supports: {
      playerProps: false,
      hitRates: false,
      injuries: false,
      weather: false,
      teamSplits: false,
    },
  },
  wta: {
    label: "WTA",
    sgoLeagueID: "WTA",
    bdlPath: "wta",
    supports: {
      playerProps: false,
      hitRates: false,
      injuries: false,
      weather: false,
      teamSplits: false,
    },
  },

  // ---- MEN'S COLLEGE BASKETBALL (v2.9.0) ----
  //
  // WHY THIS ONE FIRST. The season opens in early November, which is exactly when
  // the CFB board - currently the account's biggest driver - runs out. It is a
  // nightly slate of 350+ D1 teams, and the props it posts (points, rebounds,
  // assists, threes) are the ones the WNBA path already handles.
  //
  // FREE TIER ON SGO. Measured from SGO's own pricing page 2026-09-14: NCAAB is one
  // of the eight leagues on the Amateur plan. That matters operationally rather than
  // financially, because this account SWAPS between a rookie key and a pro key. A
  // league that is free-tier keeps working on every key that will ever be installed.
  // EPL (rookie or above) and UFC (unlisted, presumed pro) do not have that property.
  //
  // HIT RATES COME FROM CollegeBasketballData, NOT BALLDONTLIE. Same relationship
  // CFB has with CollegeFootballData, and for the same reason: BDL gates NCAAB
  // /player_stats behind GOAT, while CBBD is free, uses the identical Bearer auth,
  // and returns a whole DATE RANGE of player box scores in one request. Without a
  // CBBD_API_KEY the CBB hit-rate path REFUSES rather than falling back to SGO -
  // exactly the rule v2.7.0 established for CFB after an SGO fallback reported
  // started games as DNPs.
  //
  // INJURIES: BALLDONTLIE lists no NCAAB injuries endpoint at all, so false.
  // WEATHER: indoors, so false, same as WNBA.
  // TEAM SPLITS: false. splitsAggregator leans on BDL standings, and BDL's paid
  // tiers are PER SPORT - this account's BDL subscription does not cover NCAAB, so
  // the call would 401. Saying so is better than tallying SGO events into a number
  // with no meaning.
  cbb: {
    label: "NCAAB",
    sgoLeagueID: "NCAAB",
    bdlPath: "ncaab",
    supports: {
      playerProps: true,
      hitRates: true,
      injuries: false,
      weather: false,
      teamSplits: false,
    },
  },

  // ---- SOCCER ----
  //
  // TWO LEAGUES, ONE SHAPE. EPL and the Champions League share every market
  // convention, so they are two rows rather than two builds. What they do NOT share
  // is IDs: SGO defines teams and players per league, so Mohamed Salah is
  // MOHAMED_SALAH_1_EPL in the Premier League and a DIFFERENT id in UCL. Never cache
  // a soccer player id across leagues.
  //
  // THE TRAP THAT MAKES SOCCER DIFFERENT FROM EVERY OTHER SPORT HERE: match lines
  // settle on the `reg` period, player props on `game`. SGO's EPL page states it
  // outright - "the full-match moneyline is points-home-reg-ml-home, while player
  // props stay on game". Query a match line with `game` and SGO returns nothing,
  // which reads downstream as "no odds posted" rather than as a malformed request.
  // See matchLinePeriodFor() below; no tool builds a soccer match line by hand.
  //
  // THE SECOND TRAP: draws. Soccer has a third outcome, so grading a two-way
  // moneyline the way every other sport is graded would score a draw as a loss for
  // whichever side was picked. services/pickGrader.ts refuses that case by name.
  //
  // GOALS ARE `points`. There is no `goals` statID in SGO's soccer stat list.
  //
  // HIT RATES FALSE, and this is a subscription fact rather than a missing product:
  // BALLDONTLIE publishes /epl/v2/player_match_stats and /ucl/v1/player_match_stats,
  // both gated behind GOAT for that specific sport, which this account does not hold.
  // The free Fantasy Premier League API would serve EPL (not UCL) per-gameweek player
  // stats, and is the obvious next step, but it is a new client rather than a config
  // row and is deliberately NOT half-built here.
  epl: {
    label: "EPL",
    sgoLeagueID: "EPL",
    bdlPath: "epl",
    supports: {
      playerProps: true,
      hitRates: false,
      injuries: false,
      weather: false,
      teamSplits: false,
    },
  },
  ucl: {
    label: "UCL",
    sgoLeagueID: "UEFA_CHAMPIONS_LEAGUE",
    bdlPath: "ucl",
    supports: {
      playerProps: true,
      hitRates: false,
      injuries: false,
      weather: false,
      teamSplits: false,
    },
  },

  // ---- UFC ----
  //
  // A THIRD PARTICIPANT MODEL, which is the whole reason this row needed thought.
  // Tennis competitors occupy the home/away slots and have NO props. Team athletes
  // have rosters AND props. A fighter occupies a home/away slot AND is a prop
  // entity: SGO's UFC page says both "UFC is configured as a single-participant
  // league, so the home and away slots on an event hold the two fighters rather than
  // teams" and "Fighter-level props carry the fighter's ID in that slot instead of
  // all". So `isIndividualSport` could no longer be a boolean - see PARTICIPANT_MODEL.
  //
  // WHETHER event.players IS POPULATED ON A UFC EVENT IS UNVERIFIED. The docs are in
  // tension on it and this connector does not guess at provider shapes. Everything
  // here is written so that an empty players object produces an explanation rather
  // than a wrong answer: tkb_get_players reports it, and the prop path refuses.
  //
  // HIT RATES FALSE. There is no cheap fighter game-log source. BDL's
  // /mma/v1/fight_stats is GOAT-only for MMA, and the free alternative is scraping
  // ufcstats.com, which is infrastructure this repo does not have. Refusing is the
  // honest answer; a "0 of his last 5" built from nothing is not.
  ufc: {
    label: "UFC",
    sgoLeagueID: "UFC",
    // BDL publishes /mma/v1/. Populated deliberately even though MMA stats are not
    // subscribed: BDLClient's TTL tier gate handles the 401 and heals within 30
    // minutes if the subscription is ever bought, with no redeploy. Same reasoning
    // as the atp row above.
    bdlPath: "mma",
    supports: {
      playerProps: true,
      hitRates: false,
      injuries: false,
      weather: false,
      teamSplits: false,
    },
  },

  // ---- NHL (v2.10.0) ----
  //
  // THE STUB THAT USED TO SIT HERE WAS WRONG IN THREE WAYS, and it is worth naming
  // them, because it looked authoritative and would have been uncommented on trust:
  //
  //   `supports: TEAM_SPORT_CAPABILITIES`  claimed weather: true. Hockey is indoors.
  //                                        It also claimed injuries: true, and no
  //                                        free NHL injury feed exists at all.
  //   `bdlPath: "nhl"`                     pointed hit rates at BALLDONTLIE, which
  //                                        gates NHL player stats behind GOAT
  //                                        ($39.99/mo) and NHL games behind ALL-STAR.
  //
  // A stale stub that reads like a decision is worse than no stub. This row was
  // written from measurement instead.
  //
  // HIT RATES COME FROM THE NHL'S OWN API, FREE AND WITH NO KEY. Same relationship
  // MLB has with statsapi.mlb.com, and the reason is the same: the league publishes
  // it, so there is no quota to spend and no subscription to lapse. Measured
  // 2026-09-24 against api-web.nhle.com:
  //
  //   /v1/player/{id}/game-log/{season}/2   82 games in ONE request
  //   /v1/score/{date}                      gameState "OFF" plus both scores
  //   /v1/gamecenter/{id}/boxscore          per-player rows keyed on playerId
  //   /v1/roster/{team}/{season}            firstName/lastName, full spellings
  //
  // See services/nhlStatsClient.ts. That one game-log call is why NHL hit rates are
  // cheaper than every other sport in this connector, BDL included.
  //
  // THE TRAP THAT WILL BITE WHOEVER TOUCHES THIS NEXT: `points` MEANS TWO DIFFERENT
  // THINGS in the two feeds, and they are one word apart.
  //
  //   SGO      `points`           = "Goals scored"          (goals only)
  //   SGO      `goals+assists`    = "Hockey Points"         (what a bettor calls points)
  //   NHL API  `goals`            = goals
  //   NHL API  `points`           = goals + assists
  //
  // So SGO `points` maps to NHL `goals`, and SGO `goals+assists` maps to NHL
  // `points`. Wire them across by name and every "player points" prop in the
  // connector silently grades against goals alone, which is right about 40% of the
  // time by accident. Both statIDs are quoted from SGO's stats page; both NHL fields
  // were read off a live game log. services/nhlStatMap.ts states the crossover once
  // and nothing else is allowed to map these by hand.
  //
  // INJURIES: false, and this is a MISSING SOURCE rather than a missing entitlement
  // in a way the other sports are not. The NHL publishes no injury endpoint on its
  // own API, the league leaves designations to team reporting, and BDL puts NHL
  // injuries behind GOAT. Upgrading BDL for NHL alone would fix it; nothing free will.
  //
  // WEATHER: false. Indoors, same as WNBA and CBB. The one exception in the real
  // world is the outdoor Stadium Series, a handful of games a year, and a stadium
  // coordinate table built for two games would be worse than returning nothing.
  //
  // TEAM SPLITS: true, with a convention caveat the splits tool prints. BDL standings
  // are ALL-STAR-gated for NHL so that call will 401, and splitsAggregator then falls
  // back to tallying finalized SGO events - which WORKS for hockey, because the NHL
  // has had no ties since 2005 and every game produces a decision. What it does not
  // produce is the league's own three-column record: an overtime or shootout loss is
  // a loss here and a separate column officially, so "20-15 at home" here can face a
  // "20-10-5" in a box score. For a betting read a loss is a loss, so the number is
  // right for the purpose and has to say which convention it used.
  nhl: {
    label: "NHL",
    sgoLeagueID: "NHL",
    // BDL publishes /nhl/v1/. Populated deliberately even though NHL stats are not
    // subscribed: BDLClient's TTL tier gate absorbs the 401 and would heal within 30
    // minutes if the subscription were ever bought, with no redeploy. Same reasoning
    // as the atp and ufc rows. Hit rates do NOT route here - they go to the NHL's own
    // API - so a lapsed BDL subscription cannot take NHL hit rates down.
    bdlPath: "nhl",
    supports: {
      playerProps: true,
      hitRates: true,
      injuries: false,
      weather: false,
      teamSplits: true,
    },
  },

  // Add when NBA season starts:
  // nba: { label: "NBA", sgoLeagueID: "NBA", bdlPath: "nba", supports: TEAM_SPORT_CAPABILITIES },
} as const;

export type SportKey = keyof typeof SPORT_CONFIG;

export const SUPPORTED_SPORTS = Object.keys(SPORT_CONFIG) as SportKey[];

/**
 * HOW COMPETITORS ARE ADDRESSED ON AN EVENT. Three cases, not two.
 *
 * This was a boolean (`isIndividualSport`) until v2.9.0, when UFC broke it. The
 * boolean conflated two independent questions that tennis happened to answer the
 * same way:
 *
 *   1. Do competitors occupy the home/away slots, or a roster?
 *   2. Do player-level props exist?
 *
 * Tennis answers "slots" and "no props", team sports answer "roster" and "props",
 * and a UFC fighter answers "slots" AND "props" - SGO's own UFC page says the home
 * and away slots hold the two fighters, and that fighter props carry the fighter's
 * ID in the entity slot. One boolean cannot express that, and forcing it would have
 * meant either losing fighter props or telling the caller UFC has rosters.
 *
 * Declared as its own exhaustive table for the same reason SPORT_CONFIG is: adding
 * a sport should be a row plus a compiler error, never an audit of scattered
 * `if (sport === ...)` branches.
 */
export type ParticipantModel = "roster" | "participant_slots" | "fighters";

export const PARTICIPANT_MODEL: Record<SportKey, ParticipantModel> = {
  mlb: "roster",
  wnba: "roster",
  nfl: "roster",
  cfb: "roster",
  cbb: "roster",
  epl: "roster",
  ucl: "roster",
  nhl: "roster",
  atp: "participant_slots",
  wta: "participant_slots",
  ufc: "fighters",
};

/**
 * Sports where competitors are individuals in the home/away slots, not rosters.
 *
 * KEPT, and still true of UFC: a fighter does occupy a participant slot. What
 * changed is that this no longer implies "no player props", so every caller that
 * used it to answer THAT question now asks `supportsCapability(sport, "playerProps")`
 * instead.
 */
export const INDIVIDUAL_SPORTS: SportKey[] = (Object.keys(PARTICIPANT_MODEL) as SportKey[]).filter(
  (s) => PARTICIPANT_MODEL[s] !== "roster"
);

export function isIndividualSport(sport: SportKey): boolean {
  return PARTICIPANT_MODEL[sport] !== "roster";
}

export function participantModel(sport: SportKey): ParticipantModel {
  return PARTICIPANT_MODEL[sport];
}

/**
 * Leagues whose match lines settle on REGULATION rather than the full event.
 *
 * SOCCER ONLY, and it is the single most expensive thing to get wrong in this
 * release. SGO's EPL documentation states it plainly: "the full-match moneyline is
 * `points-home-reg-ml-home`, while player props stay on `game`." Two periods, one
 * event, split by market kind.
 *
 * The failure mode is quiet rather than loud. A soccer moneyline requested with
 * `game` does not error - it returns no market, which every tool downstream reports
 * as "no odds posted for this game yet", inviting a retry that can never succeed.
 * Every caller therefore asks this function rather than assuming "game".
 */
export const REGULATION_MATCH_LINE_SPORTS: SportKey[] = ["epl", "ucl"];

/** The periodID a MATCH LINE (moneyline, spread, total) settles on for this sport. */
export function matchLinePeriodFor(sport: SportKey): "full_game" | "regulation" {
  return REGULATION_MATCH_LINE_SPORTS.includes(sport) ? "regulation" : "full_game";
}

/**
 * WHAT A GAME TOTAL IS ACTUALLY COUNTING, PER SPORT.
 *
 * ADDED v2.9.3, after a live measurement that a doc comment in this repo had
 * already predicted and nobody had wired up.
 *
 * `points` is SGO's universal "stat that decides the winner", and for a moneyline
 * that is correct in every sport here, including MMA. A TOTAL is a different
 * question, and the answer is not always points:
 *
 *   MEASURED 2026-09-15, UFC 331, Pantoja vs Van:
 *     tkb_get_odds marketType="moneyline" -> -136 / +106, FanDuel. Correct.
 *     tkb_get_odds marketType="total"     -> "No market found for total (over)".
 *
 *   The tool asked for `points-all-game-ou-over`. A fight total is ROUNDS, and SGO
 *   prints the market itself on its UFC page as `roundsCompleted-all-game-ou-over`.
 *   Nothing was broken upstream; the connector was asking for a market that does
 *   not exist and reporting the absence as "not offered for this game".
 *
 * TENNIS IS THE SAME TRAP, and this repo wrote it down before it had a tennis total
 * to get wrong. From services/marketCatalog.ts: "IF TOTALS ARE EVER ADDED: use
 * statID `games`, never `points`. `points` carries the SET score and settles the
 * match winner; `games` carries the game count and is what totals and handicaps are
 * priced on." That warning sat in a comment where no code could read it. It is a
 * table row now.
 *
 * SOCCER stays on `points`, which IS goals - SGO's soccer stat list has no bare
 * `goals` statID at all.
 */
export const GAME_TOTAL_STAT: Record<SportKey, string> = {
  mlb: "points",
  wnba: "points",
  nfl: "points",
  cfb: "points",
  cbb: "points",
  epl: "points",
  ucl: "points",
  // HOCKEY GOALS ARE `points`, exactly as in soccer. SGO's stats page defines the
  // hockey `points` statID as "Goals scored" and offers no bare `goals` statID, so a
  // 6.5 total is points-all-game-ou-over. The word collision with the NHL's own
  // `points` field (goals plus assists) is real and is handled in nhlStatMap.ts; it
  // does not reach this table, because a GAME total is goals in both vocabularies.
  nhl: "points",
  // A fight total is rounds completed, not points. Quoted from SGO's UFC page.
  ufc: "roundsCompleted",
  // Documented by SGO as the games count rather than the set score. NOT yet
  // measured against a live tennis board on this account - the account posts
  // tennis moneylines only - so treat a tennis total as unverified until one
  // returns a price.
  atp: "games",
  wta: "games",
};

export function gameTotalStatFor(sport: SportKey): string {
  return GAME_TOTAL_STAT[sport];
}

/** True where a match can end level and the book prices a third outcome. */
export function hasDrawOutcome(sport: SportKey): boolean {
  return REGULATION_MATCH_LINE_SPORTS.includes(sport);
}

export function labelFor(sport: SportKey): string {
  return SPORT_CONFIG[sport].label;
}

export function supportsCapability(
  sport: SportKey,
  capability: keyof SportCapabilities
): boolean {
  return SPORT_CONFIG[sport].supports[capability];
}

/**
 * The refusal message a tool returns when a sport does not support what was asked.
 *
 * Centralised so every refusal explains the REASON rather than just saying no.
 * "Not supported" invites a retry; "tennis participants occupy event slots rather
 * than roster positions" does not.
 */
export function unsupportedMessage(
  sport: SportKey,
  capability: keyof SportCapabilities
): string {
  const label = SPORT_CONFIG[sport].label;
  const model = PARTICIPANT_MODEL[sport];
  const slots = model === "participant_slots";
  const soccer = REGULATION_MATCH_LINE_SPORTS.includes(sport);

  const reasons: Record<keyof SportCapabilities, string> = {
    playerProps: slots
      ? `${label} competitors occupy the home/away participant slots on an event rather than roster positions, so SGO never populates a player list and player props cannot be addressed by playerID. This is permanent, not a "retry closer to match time" situation. ${label} picks are moneyline only - use tkb_get_odds with marketType="moneyline".`
      : `Player props are not available for ${label}.`,

    hitRates:
      sport === "ufc"
        ? `Counted hit rates are NOT available for ${label}, and this is a missing SOURCE rather than a missing feature. BALLDONTLIE publishes /mma/v1/fight_stats with significant strikes, takedowns, control time and knockdowns, but gates it behind GOAT for MMA specifically, which this account does not hold. The only free alternative is scraping ufcstats.com, which this connector does not do. Write ${label} reasoning from researched fight history and say so, rather than any counted "X of his last Y" phrasing - a hit rate assembled from nothing is worse than no hit rate.`
        : soccer
          ? `Counted hit rates are NOT available for ${label}. BALLDONTLIE does publish per-match player stats for this competition, but gates them behind GOAT for that sport, which this account does not hold. NOTE FOR WHOEVER PICKS THIS UP: the free Fantasy Premier League API (fantasy.premierleague.com/api, no key) carries per-gameweek goals, assists, shots, key passes and minutes and would serve EPL, though NOT UCL. It is a new client rather than a config change and was deliberately not half-built. Until then, use researched or projection language in ${label} threads.`
          : slots
            ? `Counted hit rates are not available for ${label}. There is no per-player game-log source subscribed for this tour, and the SGO path needs a teamID/playerID that tennis events do not carry. Use researched or projection language in ${label} threads, per the style guide, rather than counted "X of his last Y" phrasing.`
            : `Hit rates are not available for ${label}.`,

    injuries:
      sport === "nhl"
        ? `No injury feed is available for ${label}, and this one is a missing SOURCE rather than a plan limit. The NHL's own public API - which serves every ${label} hit rate in this connector - publishes no injury endpoint, and BALLDONTLIE gates /nhl/v1/player_injuries behind GOAT for hockey specifically, which this account does not hold. Hockey also reports availability more vaguely than any other sport here: clubs announce "upper body" or "lower body" and a goalie starter is often confirmed at warmups. Confirm the projected lines and the starting goalie by live search before posting an ${label} player prop, and treat a goalie saves line as unplayable until the start is confirmed.`
        : sport === "cbb"
        ? `BALLDONTLIE publishes no NCAAB injuries endpoint. College basketball availability also moves late and is reported by the school rather than a league office, so confirm it by live search against the team's own release before posting a ${label} player prop.`
        : sport === "ufc"
          ? `There is no injury feed for ${label}. A fight is either on the card or off it, and withdrawals are announced by the promotion, often inside the final week. Check the current card by live search before posting - a fighter replacement changes the entire matchup, not just one line.`
          : soccer
            ? `No injury feed is available for ${label} on the current subscription. BALLDONTLIE gates /player_injuries behind GOAT for this sport. Rotation matters more here than injury in a midweek-plus-weekend competition, so confirm the expected XI from team news before posting a ${label} player prop.`
            : slots
              ? `No injury feed is available for ${label} on the current subscription. Tennis withdrawals and retirements are announced by the tournament, so check tour news directly before posting a ${label} pick.`
              : `BALLDONTLIE has no ${label} injuries endpoint at all. Verified live 2026-08-31: both /ncaaf/v1/player_injuries and /ncaaf/v1/injuries return 404, while the same path returns 200 for MLB on the same key. This is a MISSING ENDPOINT, not a subscription limit, so it cannot be unlocked by upgrading. Check ${label} injury and availability news via live web search, and note that CFB availability also has to be confirmed from a depth chart because CollegeFootballData lists a player only where he recorded a stat.`,

    weather:
      sport === "ufc"
        ? `Weather is not a factor for ${label} - fights are indoors.`
        : soccer
          ? `Weather is not wired up for ${label}. Matches are outdoors and conditions do matter, but this connector has no stadium coordinate table for European grounds, and inventing one would be worse than returning nothing. Check conditions by live search if a total depends on it.`
          : slots
            ? `Weather is not wired up for ${label}. Tour events move between venues week to week, so there is no fixed stadium table to look up, and guessing a location would be worse than returning nothing. Grand Slam roof status must be checked via live search.`
            : `Weather is not a factor for ${label}.`,

    teamSplits:
      sport === "ufc" || slots
        ? `Team splits do not apply to ${label} - there are no teams. For head-to-head history between two competitors, use live search; SGO's event feed is not a reliable H2H source across seasons.`
        : soccer
          ? `Team splits are not wired up for ${label}. Home and away form is genuinely meaningful in soccer, but this tool computes it from BALLDONTLIE standings, and BDL's paid tiers are PER SPORT - this account's subscription does not cover it, so the call would 401. A DRAW also breaks the win/loss tally this aggregator assumes, so a number produced here would be wrong in a way that looks right.`
          : sport === "cbb"
            ? `Team splits are not wired up for ${label}. BALLDONTLIE's tiers are per sport and this account's subscription does not cover NCAAB, so the standings call would 401 rather than return a home/road record.`
            : `Team splits are not available for ${label}.`,
  };
  return reasons[capability];
}
