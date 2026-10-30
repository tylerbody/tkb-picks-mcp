import type { SportKey } from "../constants.js";
import { OU_PROP_MARKETS } from "./marketCatalog.js";

/**
 * STAT ID ALIASES. ADDED v2.20.0.
 *
 * MEASURED 2026-10-28: tkb_get_player_hit_rate(sport="nfl", statID="receptions") was
 * REFUSED with "no ESPN game-log mapping", so runs fell back to dataSource="sgo" and spent
 * quota. Receptions ARE mapped; the SGO statID is "receiving_receptions" and the market
 * LABEL is "Receptions". A refusal for a spelling, not a missing stat.
 *
 * Resolution, in order, against this sport's catalogued markets only:
 *   1. the exact statID
 *   2. the statID with punctuation and case ignored ("receivingYards" -> receiving_yards)
 *   3. the market LABEL ("Receptions", "Rushing Yards", "Shots On Goal")
 *   4. the part after the category ("receptions" -> receiving_receptions)
 * A step that matches more than one market is AMBIGUOUS and resolves nothing, so an
 * alias can never silently pick the wrong stat.
 */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+]/g, "");

export interface StatResolution {
  statID: string;
  aliasedFrom: string | null;
  /** Up to 5 catalogued statIDs that look close, for a refusal message. */
  suggestions: string[];
}

export function resolveStatID(sport: SportKey, input: string): StatResolution {
  const markets = OU_PROP_MARKETS[sport] ?? [];
  if (!input || markets.some((m) => m.statID === input)) {
    return { statID: input, aliasedFrom: null, suggestions: [] };
  }
  const want = norm(input);
  const steps: ((m: { statID: string; label: string; aliases?: string[] }) => boolean)[] = [
    (m) => norm(m.statID) === want,
    (m) => norm(m.label) === want || (m.aliases ?? []).some((a) => norm(a) === want),
    (m) => {
      const tail = m.statID.includes("_") ? m.statID.split("_").slice(1).join("_") : null;
      return tail !== null && norm(tail) === want;
    },
  ];
  for (const step of steps) {
    const hits = [...new Set(markets.filter(step).map((m) => m.statID))];
    if (hits.length === 1) return { statID: hits[0]!, aliasedFrom: input, suggestions: [] };
    if (hits.length > 1) return { statID: input, aliasedFrom: null, suggestions: hits.slice(0, 5) };
  }
  const suggestions = markets
    .filter((m) => norm(m.statID).includes(want) || norm(m.label).includes(want) || want.includes(norm(m.label)))
    .map((m) => m.statID)
    .slice(0, 5);
  return { statID: input, aliasedFrom: null, suggestions };
}
