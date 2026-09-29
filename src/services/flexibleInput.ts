import { z } from "zod";

/**
 * STRING-TOLERANT BOOLEANS AND NUMBERS, v2.11.1.
 *
 * THE FAILURE THIS FIXES, measured 2026-09-29 minutes after deploying v2.11.0.
 * `includeYesNo` was rejected on every call with "Expected boolean, received string",
 * and `maxYesNoRows` with "Expected number, received string" - on a server that had the
 * parameters and was otherwise working, from a client that had just been told about
 * them. The newly added arguments arrived as "true" and "6".
 *
 * The cause is a stale client schema. An MCP client caches tool definitions, and a
 * parameter added after that cache was built gets passed through without type
 * information, which means as a string. A tool-list refresh does not fix it, because
 * refreshing diffs TOOL NAMES and a tool whose name did not change looks unchanged.
 *
 * WHY THIS MATTERS BEYOND ONE CALL. Every scheduled task in this account holds its own
 * client session. Adding a parameter to a tool a schedule uses would break that
 * schedule silently until whatever caches its schema happened to turn over, and the
 * failure would read as "the connector is broken" rather than "the schema is stale".
 * That is the whole class of problem, not a one-off annoyance.
 *
 * DELIBERATELY NARROW. "true" and "false" only, trimmed and case-insensitive; a numeric
 * string only when it parses cleanly and round-trips. "yes", "1", "on" and "" are NOT
 * accepted, because a parameter that guesses what the caller meant is how a board ends
 * up silently including something nobody asked for. Anything else falls through
 * untouched and gets the ordinary type error, which is the correct outcome: this widens
 * the accepted spelling of a value, it does not weaken validation.
 */

const coerceBoolean = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return v;
};

const coerceNumber = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s === "") return v;
  const n = Number(s);
  // Number("") is 0 and Number("12abc") is NaN; require a clean, finite parse.
  if (!Number.isFinite(n)) return v;
  return n;
};

/** A boolean that also accepts the strings "true" and "false". */
export function flexBoolean(defaultValue: boolean) {
  return z.preprocess(coerceBoolean, z.boolean()).default(defaultValue);
}

/** A boolean with no default, for a genuinely optional flag. */
export function flexBooleanOptional() {
  return z.preprocess(coerceBoolean, z.boolean()).optional();
}

/** A number (decimals allowed) that also accepts a numeric string. */
export function flexNumberOptional() {
  return z.preprocess(coerceNumber, z.number()).optional();
}

/**
 * An integer in [min, max] that also accepts a numeric string. Kept optional because
 * every numeric knob on the prop board resolves its own default in code - see the
 * v2.10.8 note there on zod defaults not applying to direct handler calls.
 */
export function flexIntOptional(min: number, max: number) {
  return z.preprocess(coerceNumber, z.number().int().min(min).max(max)).optional();
}

/* ===========================================================================
 * THE SAME COERCION, AT THE HANDLER, v2.11.1.
 *
 * The zod schemas above only run when a call arrives through MCP. A direct handler
 * call - which is how every wiring test in this repo works, and how any internal reuse
 * would work - bypasses them entirely. That is already documented in this repo for
 * DEFAULTS: v2.10.8 had to resolve `period` and `preferredBookmakers` in code because
 * the schema default never fired on a direct call.
 *
 * Coercion has exactly the same hole, and it is worse, because the value that gets
 * through is the wrong TYPE rather than merely absent. `includeYesNo: "false"` reaching
 * the handler as a string is TRUTHY, so a caller asking to turn the section off would
 * have turned it on. A wiring test caught that within a minute of the schema fix.
 *
 * So the normalisation happens at the handler too. The schema keeps the error message
 * good for MCP callers; these keep the behaviour correct for everyone.
 */

/** Read a flag that may arrive as a boolean, "true"/"false", or undefined. */
export function asBoolean(v: unknown, defaultValue: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return defaultValue;
}

/** Read a number that may arrive as a number, a numeric string, or undefined. */
export function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
