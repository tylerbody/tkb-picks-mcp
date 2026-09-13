import type { SGOEvent, SGOPlayer } from "../types.js";

/**
 * WHY A playerID MISS MUST NOT BE A DEAD END.
 *
 * ============================================================================
 * THE CALEB WILLIAMS CASE, measured live 2026-09-13
 * ============================================================================
 *
 * Bears @ Panthers, eventID Nw0i5lD1IafZ0HlX842y. SGO carries the Bears
 * quarterback like this:
 *
 *   playerID: CHRIS_WILLIAMS_1_NFL
 *   name:     Caleb Williams
 *
 * Right display name, wrong ID stem. Every lookup built on the obvious
 * CALEB_WILLIAMS_1_NFL returned "No market found for this selection on this
 * event" while his passing line sat there at 229.5 (-112).
 *
 * A confident refusal, on a player with a posted market, discovered only because
 * someone happened to run tkb_get_players with nameContains.
 *
 * ============================================================================
 * WHAT MAKES THIS WORSE THAN A NORMAL MISS
 * ============================================================================
 *
 * The ID format LOOKS derivable: FIRST_LAST_1_LEAGUE. It is right the large
 * majority of the time, which is exactly what makes it a trap. A pattern that
 * works often enough becomes a habit, and then it fails silently on the
 * exceptions - which land on precisely the players worth writing about, because
 * a QB1 with a posted passing line is not an obscure name.
 *
 * Same family as the p_k batting/pitching collision (v2.0.1) and the
 * visitor_team/away_team split (v2.0.3): a plausible shape that is right until
 * it quietly is not.
 *
 * ============================================================================
 * WHY THIS IS CODE AND NOT A RULE
 * ============================================================================
 *
 * "Never construct a playerID, always read it from tkb_get_players" is a correct
 * rule and it only works while someone remembers it. Meanwhile the answer is
 * already sitting in the response: `event.players` came back on the SAME fetch
 * that produced the miss, and it contains Caleb Williams under his real key.
 *
 * The tool had the disproof in hand and did not look. That is the same shape as
 * the spread that ignored both team scores, the grader that ignored the status
 * block, and the schedule that ignored its own cursor. So it gets the same
 * treatment: look before refusing.
 *
 * ============================================================================
 * IT REPORTS. IT NEVER SUBSTITUTES.
 * ============================================================================
 *
 * No automatic swap to the candidate ID, for the reason v2.8.2 took three
 * consecutive releases to learn and v2.8.5 restated: a silent correction that is
 * itself wrong is worse than the error it replaces. This names what it found and
 * stops. The caller decides.
 *
 * SURNAME MATCHING IS EXACT ON THE TOKEN, NEVER CONTAINMENT. "Williams" must not
 * match "Williamson", which is a different person on some rosters. That is the
 * v2.8.5 Miami / Miami (OH) trade running the same direction here: a false
 * positive would point at the wrong player, and pointing confidently at the wrong
 * player is the failure this whole file exists to prevent.
 */

/** Strip diacritics and punctuation so Suarez matches Suárez (the v2.4.0 case). */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the name part out of a playerID stem.
 * CALEB_WILLIAMS_1_NFL -> "caleb williams"
 * Trailing numeric index and league suffix are dropped.
 */
export function nameFromPlayerID(playerID: string): string {
  const parts = playerID.split("_").filter(Boolean);
  const words: string[] = [];
  for (const part of parts) {
    if (/^\d+$/.test(part)) break; // the numeric index ends the name
    words.push(part);
  }
  return normalize(words.join(" "));
}

/** Last token of a name, which is the stable half when a first name is wrong. */
function surnameOf(name: string): string {
  const tokens = normalize(name).split(" ").filter(Boolean);
  return tokens.length ? tokens[tokens.length - 1] : "";
}

function displayNameOf(p: SGOPlayer): string {
  // Candidate order, same defensive pattern as bdlStatMap: the documented field
  // first, then reconstruct, rather than assuming one shape is always populated.
  if (p.name) return p.name;
  const joined = [p.firstName, p.lastName].filter(Boolean).join(" ");
  return joined || p.playerID;
}

export interface PlayerIdDiagnosis {
  /** True when the playerID IS attached to this event, so the miss is a market gap. */
  playerOnEvent: boolean;
  /** Players on this event sharing the surname implied by the requested playerID. */
  candidates: { playerID: string; name: string; teamID?: string }[];
  /** Ready-to-return explanation. */
  message: string;
}

/**
 * Diagnose a playerID that produced no market. Costs nothing: `event.players`
 * arrived on the fetch that already happened.
 */
export function diagnosePlayerIdMiss(
  event: SGOEvent,
  playerID: string,
  marketDescription?: string
): PlayerIdDiagnosis {
  const roster = Object.values(event.players ?? {});
  const market = marketDescription ? `"${marketDescription}"` : "this market";

  // ---- Case 1: the player IS here. Then the ID is fine and the MARKET is not. ----
  //
  // Worth separating. "Your ID is wrong" and "no book posted this prop" call for
  // completely different next actions, and collapsing them is how a correct ID
  // gets doubted and a genuinely unposted market gets retried forever.
  const onEvent = (event.players ?? {})[playerID];
  if (onEvent) {
    return {
      playerOnEvent: true,
      candidates: [],
      message:
        `${displayNameOf(onEvent)} IS attached to this event under ${playerID}, so the playerID is correct ` +
        `and ${market} simply has no posted line for him here. That is a market gap, not a lookup failure. ` +
        `Player props appear close to game time, so retry nearer kickoff, or use tkb_get_prop_board to see ` +
        `every market that IS priced on this event.`,
    };
  }

  // ---- Case 2: not here. Is someone with this surname? ----
  const wanted = nameFromPlayerID(playerID);
  const wantedSurname = surnameOf(wanted);

  const candidates = roster
    .filter((p) => {
      const display = displayNameOf(p);
      if (normalize(display) === wanted) return true;
      // EXACT token equality, never containment. Williams must not match Williamson.
      return wantedSurname.length > 0 && surnameOf(display) === wantedSurname;
    })
    .map((p) => ({ playerID: p.playerID, name: displayNameOf(p), teamID: p.teamID }));

  if (candidates.length) {
    const list = candidates.map((c) => `  ${c.playerID}  ->  "${c.name}"`).join("\n");
    return {
      playerOnEvent: false,
      candidates,
      message:
        `NO SUCH playerID ON THIS EVENT: ${playerID} is not attached to this game, so ${market} could not ` +
        `be looked up. This is very likely a WRONG ID rather than a missing market.\n\n` +
        `The event DOES carry ${candidates.length === 1 ? "a player" : "players"} with that surname:\n${list}\n\n` +
        `SGO's ID stem does not always match a player's current first name. Measured 2026-09-13: Caleb ` +
        `Williams is carried as CHRIS_WILLIAMS_1_NFL, right display name, wrong ID, with his passing line ` +
        `posted the whole time. Confirm the name above is the player you meant and re-run with that ID. ` +
        `This tool deliberately does NOT substitute it for you.`,
    };
  }

  // ---- Case 3: nobody by that surname. Say how many ARE here. ----
  return {
    playerOnEvent: false,
    candidates: [],
    message:
      `NO SUCH playerID ON THIS EVENT: ${playerID} is not attached to this game, and no player on it shares ` +
      `that surname. ${roster.length} player(s) are attached overall. ` +
      (roster.length === 0
        ? `The event carries NO players at all, which usually means props are not posted yet rather than that ` +
          `the roster is empty - retry closer to game time.`
        : `Run tkb_get_players on this event with nameContains to see who is actually here. Do not construct a ` +
          `playerID from a name; SGO's ID stem does not reliably match it.`),
  };
}
