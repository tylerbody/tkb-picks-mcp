/**
 * ODDID PARSING, hardened against the SIXTH SEGMENT.
 *
 * WHAT THE DOCS ACTUALLY SAY. SportsGameOdds documents the oddID structure as:
 *
 *   {statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}-{bookmakerID}
 *
 * SIX segments. Every parser in this connector was written against FIVE and
 * slices from the right, so `parts[last]` is read as the side.
 *
 * WHY NOTHING HAS BROKEN YET. The keys inside `event.odds` come back in the
 * five-segment form in every response observed to date, most recently on
 * 2026-08-27 when tkb_get_prop_board returned a correct 27-row CFB board. The
 * bookmaker suffix appears in the documented format but not in the payload we
 * read. So this is a latent risk, not a live bug.
 *
 * WHY IT IS WORTH HARDENING ANYWAY. If a six-segment key ever arrives, the naive
 * parser reads the BOOKMAKER as the side, the SIDE as the bet type, and the BET
 * TYPE as the period. Every one of those is a plausible-looking string. Nothing
 * would be malformed, no guardrail downstream would fire, and the board would
 * silently drop or mislabel markets. That is the exact "right values, wrong
 * story" failure class this connector has now rediscovered four separate times:
 * the p_k batting/pitching collision, the reversed newest-first array, the
 * unpaginated ascending pages, and the year-stale hit-rate window.
 *
 * HOW IT DECIDES, without guessing. betTypeID and sideID are both drawn from
 * small CLOSED sets. So rather than counting segments, this anchors on those two
 * known vocabularies:
 *
 *   - if parts[n-2] is a bet type and parts[n-1] is a side  -> five-segment form
 *   - if parts[n-3] is a bet type and parts[n-2] is a side  -> six-segment form,
 *     and the trailing segment is a bookmakerID
 *
 * A key matching neither shape returns null rather than a best guess, for the
 * same reason the BDL name resolver refuses to pick between two players named
 * Marte: a confident wrong answer is worse than no answer.
 */

/** Every betTypeID this connector constructs or reads. Closed set, per SGO docs. */
const BET_TYPES = new Set(["ou", "yn", "ml", "sp", "ml3way"]);

/** Every sideID SGO uses. Closed set, per SGO docs. */
const SIDES = new Set(["over", "under", "yes", "no", "home", "away", "draw"]);

export interface ParsedOddID {
  statID: string;
  entity: string;
  period: string;
  betType: string;
  side: string;
  /** Present only when the oddID carried the documented trailing bookmakerID. */
  bookmakerID?: string;
}

export function parseOddID(oddID: string): ParsedOddID | null {
  const parts = oddID.split("-");
  if (parts.length < 5) return null;

  const n = parts.length;

  // ---- Five-segment form: statID-entity-period-betType-side ----
  if (BET_TYPES.has(parts[n - 2] ?? "") && SIDES.has(parts[n - 1] ?? "")) {
    const statID = parts.slice(0, n - 4).join("-");
    if (!statID) return null;
    return {
      statID,
      entity: parts[n - 4] ?? "",
      period: parts[n - 3] ?? "",
      betType: parts[n - 2] ?? "",
      side: parts[n - 1] ?? "",
    };
  }

  // ---- Six-segment form: ...-betType-side-bookmakerID ----
  if (
    n >= 6 &&
    BET_TYPES.has(parts[n - 3] ?? "") &&
    SIDES.has(parts[n - 2] ?? "")
  ) {
    const statID = parts.slice(0, n - 5).join("-");
    if (!statID) return null;
    return {
      statID,
      entity: parts[n - 5] ?? "",
      period: parts[n - 4] ?? "",
      betType: parts[n - 3] ?? "",
      side: parts[n - 2] ?? "",
      bookmakerID: parts[n - 1] ?? "",
    };
  }

  // Neither shape. Refuse rather than guess.
  return null;
}
