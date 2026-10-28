/**
 * WHAT A `date` MEANS. ADDED v2.19.1.
 *
 * THE BUG. tkb_get_schedule and tkb_get_game_lines turned `date: "2026-10-28"` into
 * 2026-10-28T00:00:00Z to 2026-10-28T23:59:59Z, a UTC day. A US slate is not a UTC day.
 * UTC midnight is 5 PM Pacific / 8 PM Eastern, so the window:
 *   - DROPPED every game tipping 8 PM Eastern or later. Measured 2026-10-28: NBA
 *     date=2026-10-28 returned 6 games, missing Spurs @ Jazz, Thunder @ Mavericks and
 *     Lakers @ Clippers, which date=2026-10-29 returned instead. NHL date=2026-10-28
 *     returned 1 of that night's games.
 *   - PULLED IN the previous night's late games (Trail Blazers @ Lakers, 03:00Z, which is
 *     8 PM Pacific on Oct 27).
 * It looked like a complete answer, which is why it hid games instead of erroring.
 *
 * THE FIX. A `date` is a calendar day in SLATE_TIME_ZONE (Pacific), the same day every
 * scheduled run already computes by hand ("Pacific midnight to Pacific midnight"). A
 * Pacific day contains every US game of that date, including Hawaii kickoffs and 10:30 PM
 * Eastern tips, which an Eastern day would cut.
 *
 * WHAT IS NOT CHANGED, ON PURPOSE. Explicit startsAfter / startsBefore are passed through
 * untouched, and the "no date given" defaults are untouched. Every scheduled run uses
 * explicit bounds (audited 2026-10-28, 22 tasks), so none of them sees any difference.
 */

export const SLATE_TIME_ZONE = "America/Los_Angeles";

/** Offset of `tz` from UTC at instant `at`, in minutes (Pacific in October is -420). */
export function zoneOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUTC - at.getTime()) / 60_000);
}

/** The UTC instant of local midnight starting `ymd` in `tz`. DST-correct. */
export function zonedMidnight(ymd: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`Date must be YYYY-MM-DD, got "${ymd}".`);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // One pass is exact for US zones: UTC midnight of `ymd` is the previous afternoon
  // locally, and US DST changes happen at 2 AM, so the offset there equals the offset at
  // local midnight. Pinned by the DST tests in test/v2_19_1.test.ts.
  return new Date(naive - zoneOffsetMinutes(new Date(naive), tz) * 60_000);
}

/**
 * PURE. The UTC window for one calendar day in `tz`: local midnight to one second before
 * the next local midnight. 24 hours normally, 23 or 25 on a DST change day.
 */
export function slateDayBounds(
  ymd: string,
  tz: string = SLATE_TIME_ZONE
): { startsAfter: string; startsBefore: string; timeZone: string } {
  const start = zonedMidnight(ymd, tz);
  const [y, mo, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y!, mo! - 1, d! + 1)).toISOString().slice(0, 10);
  const end = new Date(zonedMidnight(next, tz).getTime() - 1000);
  return { startsAfter: start.toISOString(), startsBefore: end.toISOString(), timeZone: tz };
}
