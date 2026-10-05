import type { EspnRosterEntry } from "./espnClient.js";

/**
 * ============================================================================
 * BRIDGING SGO IDs TO ESPN IDs, WITHOUT A MAINTAINED TABLE
 * ============================================================================
 *
 * SGO says `ALEXANDER_ISAK_1_EPL`. ESPN says `235662`. There is no shared key, and
 * there is no public crosswalk. This is the same wall recorded for WNBA in
 * espn-gamelog-free-research-source.md (`AJA_WILSON_1_WNBA` against `3149391`).
 *
 * TWO HOPS, BOTH FREE AND BOTH CACHEABLE:
 *
 *   1. SGO team display name  ->  ESPN team id    (the league's teams endpoint)
 *   2. ESPN team id           ->  ESPN athlete id (that team's roster)
 *
 * Deliberately NOT a hardcoded team map. A table of 32 NFL plus 30 NBA plus 20 EPL
 * clubs is 82 rows to maintain across relocations, rebrands and promotion and
 * relegation, and EPL turns over three clubs every single season. The teams endpoint
 * already knows the answer and costs nothing to ask.
 *
 * ============================================================================
 * THE RULE THAT MATTERS: AMBIGUITY IS A REFUSAL, NEVER A COIN FLIP
 * ============================================================================
 *
 * resolveNhlPlayer in nhlHitRateAggregator.ts states this and the reason:
 * containment matching "turns one string into two players", and "Sebastian Aho" is
 * two active NHL players. The same hazard is already live in this connector's own
 * data: the Buffalo roster carries Josh Allen the QUARTERBACK (espnId 3918298),
 * while SGO's NFL player index returned a SECOND Josh Allen on Arizona. A resolver
 * that picks one produces a hit rate for the wrong human being, with no error.
 *
 * So: whole normalised names only, never containment. Surname fallback fires only
 * when exactly one player on that ONE roster carries the surname.
 */

/**
 * Fold a name to a comparison key.
 *
 * ACCENTS ARE NOT COSMETIC HERE. Every one of these is live in data this connector
 * has already pulled: Doncic/Doncic, Araujo/Araujo, Jeremie Frimpong,
 * Alexis Lafreniere, Dominik Szoboszlai. SGO and ESPN do not agree on whether to
 * carry the diacritic, so both sides get folded.
 *
 * SUFFIXES COME OFF for the same reason. SGO writes `JAMES_COOK_1_NFL` while ESPN
 * writes "James Cook III", and `JEDRICK_WILLS` against "Jedrick Wills Jr.".
 *
 * PUNCTUATION COMES OFF because of `C.J. Stroud` against `CJ_STROUD_1_NFL`, and
 * `A.J. Brown` against `AJ_BROWN_1_NFL`.
 */
export function normaliseEspnName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'`’-]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** An SGO playerID stem turned into a comparable name: ALEXANDER_ISAK_1_EPL -> alexander isak. */
export function nameFromSgoPlayerID(playerID: string): string {
  const stem = playerID.replace(/_\d+_[A-Z]+$/, "");
  return normaliseEspnName(stem.replace(/_/g, " "));
}

/**
 * Team names get a SECOND pass that strips club-form tokens.
 *
 * MEASURED MISMATCH: SGO writes "Liverpool FC" and ESPN writes "Liverpool"; SGO
 * writes "AFC Bournemouth" and ESPN writes "Bournemouth". Normalised without this,
 * "liverpool fc" never equals "liverpool", and the last-word fallback would then try
 * to match on "fc", which belongs to half the league and correctly refuses. So the
 * whole sport would be one long refusal over a suffix.
 *
 * ONLY standalone club-form tokens come off. "United" and "City" stay, because
 * Manchester United and Manchester City are different clubs and collapsing them is
 * precisely the wrong kind of helpfulness.
 *
 * Kept separate from normaliseEspnName so player names are untouched by it.
 */
export function normaliseEspnTeamName(raw: string): string {
  return normaliseEspnName(raw)
    .replace(/\b(fc|afc|cf|sc|cp|ac|as|ss|sv|bk|if)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface EspnTeamEntry {
  id: string;
  displayName: string;
  abbreviation?: string;
}

/**
 * Pull team id and display name out of ESPN's teams payload.
 *
 * The response nests as sports[].leagues[].teams[].team, and a team object is
 * distinguished from everything else by carrying BOTH an id and an abbreviation.
 * Walking by shape rather than by path, like extractRoster does, so a nesting change
 * does not silently return nothing.
 */
export function extractTeams(payload: unknown): EspnTeamEntry[] {
  const out: EspnTeamEntry[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (
      typeof obj.id === "string" &&
      typeof obj.displayName === "string" &&
      typeof obj.abbreviation === "string" &&
      typeof obj.firstName !== "string"
    ) {
      if (!seen.has(obj.id)) {
        seen.add(obj.id);
        out.push({
          id: obj.id,
          displayName: obj.displayName,
          abbreviation: obj.abbreviation,
        });
      }
    }
    for (const v of Object.values(obj)) walk(v, depth + 1);
  };
  walk(payload, 0);
  return out;
}

export type Resolution<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; candidates?: string[] };

/**
 * SGO team display name -> ESPN team.
 *
 * Exact normalised match first. Then a LAST-WORD match, which carries "Buffalo
 * Bills" to "Bills" and "Manchester City" to "Man City", and only when it is
 * unambiguous across the whole league. Two clubs sharing a last word - Manchester
 * United and Manchester City do not, but Nottingham Forest and Forest Green would -
 * produce a refusal rather than a guess.
 */
export function resolveEspnTeam(
  teams: EspnTeamEntry[],
  sgoTeamName: string
): Resolution<EspnTeamEntry> {
  const wanted = normaliseEspnTeamName(sgoTeamName);
  if (!wanted) {
    return { ok: false, reason: `Empty team name supplied, so no ESPN team can be resolved.` };
  }

  const exact = teams.filter((t) => normaliseEspnTeamName(t.displayName) === wanted);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      reason: `"${sgoTeamName}" matched ${exact.length} ESPN teams exactly, which is ambiguous.`,
      candidates: exact.map((t) => `${t.displayName} (${t.id})`),
    };
  }

  const lastWord = wanted.split(" ").pop() ?? "";
  if (!lastWord) {
    return { ok: false, reason: `No ESPN team matched "${sgoTeamName}".` };
  }
  const byLastWord = teams.filter((t) => {
    const parts = normaliseEspnTeamName(t.displayName).split(" ");
    return parts[parts.length - 1] === lastWord;
  });
  if (byLastWord.length === 1) return { ok: true, value: byLastWord[0] };

  return {
    ok: false,
    reason:
      byLastWord.length > 1
        ? `"${sgoTeamName}" is ambiguous against ESPN's team list on the name "${lastWord}". ` +
          `Refusing rather than picking one.`
        : `No ESPN team matched "${sgoTeamName}". Checked ${teams.length} teams by full ` +
          `name and by last word.`,
    candidates: byLastWord.map((t) => `${t.displayName} (${t.id})`),
  };
}

/**
 * SGO player name -> ESPN athlete on ONE roster.
 *
 * Scoped to a single team's roster on purpose. A league-wide index is what makes two
 * Josh Allens collide; inside one locker room they cannot.
 */
export function resolveEspnAthlete(
  roster: EspnRosterEntry[],
  playerName: string
): Resolution<EspnRosterEntry> {
  const wanted = normaliseEspnName(playerName);
  if (!wanted) {
    return { ok: false, reason: `Empty player name supplied.` };
  }

  const exact = roster.filter((p) => normaliseEspnName(p.displayName) === wanted);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      reason:
        `"${playerName}" matches ${exact.length} players on this ESPN roster. Refusing ` +
        `rather than picking one: a wrong pick here produces a complete, plausible hit ` +
        `rate for a different person.`,
      candidates: exact.map((p) => `${p.displayName} (${p.id})`),
    };
  }

  const parts = wanted.split(" ");
  if (parts.length < 2) {
    return {
      ok: false,
      reason:
        `No exact match for "${playerName}" on this ESPN roster, and the name is a ` +
        `single word, so a surname fallback would match too broadly.`,
    };
  }
  const surname = parts[parts.length - 1];
  const bySurname = roster.filter((p) => {
    const pp = normaliseEspnName(p.displayName).split(" ");
    return pp[pp.length - 1] === surname;
  });
  if (bySurname.length === 1) return { ok: true, value: bySurname[0] };

  return {
    ok: false,
    reason:
      bySurname.length > 1
        ? `"${playerName}" did not match exactly, and the surname "${surname}" belongs to ` +
          `${bySurname.length} players on this roster. Refusing rather than guessing.`
        : `"${playerName}" is not on this ESPN roster (${roster.length} players checked, ` +
          `by full name and by surname). The player may have changed teams, or SGO and ` +
          `ESPN may spell the name differently.`,
    candidates: bySurname.map((p) => `${p.displayName} (${p.id})`),
  };
}
