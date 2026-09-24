/**
 * NHL GAME-STATE VOCABULARY. PURE, NO CLIENT, NO AXIOS.
 *
 * WHY THIS IS ITS OWN FILE rather than living in nhlStatsClient with the code that
 * fetches these states: eventStatus.ts opens with "Pure, exported, no client anywhere
 * near it", and that is a real property rather than a decoration. Importing the
 * predicate from the axios-backed client would have pulled an HTTP library into the
 * one module in this repo that is deliberately free of them, and the next person to
 * read that header would find it no longer true.
 *
 * nhlStatsClient re-exports these, so there is still exactly one definition.
 */

/**
 * TERMINAL STATES, AS AN ALLOW-LIST.
 *
 * Measured 2026-09-24: a scheduled game reads "FUT", a finished one reads "OFF". The
 * league also uses "PRE" (pregame), "LIVE", "CRIT" (late and close) and "FINAL" (the
 * horn has sounded, before the game is closed out).
 *
 * BOTH "FINAL" AND "OFF" COUNT AS FINISHED. The distinction is worth keeping in mind
 * rather than collapsing - "FINAL" is the horn, "OFF" is certified - but grading on
 * either is safe because both carry settled scores.
 *
 * AN ALLOW-LIST RATHER THAN A DENY-LIST, for the reason eventStatus.ts gives at
 * length: a state this connector has never seen must read as "no information", never
 * as "not live, therefore over". These paths are undocumented, so an unseen state is
 * likelier here than anywhere else in the repo.
 */
export const NHL_TERMINAL_GAME_STATES = new Set(["FINAL", "OFF"]);

/** States that affirmatively say the puck is in play. */
export const NHL_LIVE_GAME_STATES = new Set(["LIVE", "CRIT"]);

/** PURE. Does this state affirmatively mean the game is over? */
export function nhlSaysFinal(gameState: string | undefined): boolean {
  if (!gameState) return false;
  return NHL_TERMINAL_GAME_STATES.has(gameState.trim().toUpperCase());
}

/** PURE. Does this state affirmatively mean the game is being played right now? */
export function nhlSaysLive(gameState: string | undefined): boolean {
  if (!gameState) return false;
  return NHL_LIVE_GAME_STATES.has(gameState.trim().toUpperCase());
}
