import { BDLClient } from "./bdlClient.js";

/**
 * ============================================================================
 * RUNNING WITHOUT BALLDONTLIE (v2.16.0)
 * ============================================================================
 *
 * WHY THIS FILE EXISTS RATHER THAN A `BDLClient | null` EVERYWHERE.
 *
 * Before v2.16.0 index.ts treated BDL exactly like SGO:
 *
 *     if (!BDL_API_KEY) { console.error("FATAL: ..."); process.exit(1); }
 *
 * So an empty BDL_API_KEY took all 31 tools down, including every tool that
 * never touches BDL. That is the opposite of the rule index.ts already states
 * for CFBD one screen further down: "Exiting here would take all 24 existing
 * tools down over a key that only CFB hit rates need."
 *
 * THE OBVIOUS FIX WAS WORSE. Widening the type to `BDLClient | null` means
 * touching twelve register signatures plus bdlHitRateAggregator, pickGrader and
 * the screenProps path, and adding a null branch at every call site. Twelve
 * files of mechanical edits to express one fact, with twelve chances to add the
 * branch in a place it cannot run - which is the v2.8.9 unreachable-else bug
 * this repo has already paid for once.
 *
 * WHAT THIS DOES INSTEAD. A Proxy over a real BDLClient that turns every
 * network method into a rejected promise carrying one clear message. The type
 * stays `BDLClient`, so not one tool signature changes, and every tool's
 * existing catch block surfaces the message as its own refusal. Verified
 * 2026-10-01 that all six BDL-exclusive tools (injuries, standings, rankings,
 * streakScan, verifyRoster, bdlStatsProbe) already catch and print
 * `err.message`, which is why this works without editing them.
 *
 * IT IS ALSO FUTURE-PROOF BY CONSTRUCTION. A Proxy intercepts the whole
 * prototype, so a method added to BDLClient later is covered the day it is
 * added. A hand-written stub would need remembering, and would not be.
 *
 * ---- SWAPPING BACK IS SETTING ONE ENV VAR ----
 *
 * Nothing about BDL is deleted. The client, the aggregator, the stat maps and
 * every tool route still ship byte-for-byte. Put BDL_API_KEY back in Render and
 * index.ts constructs the real client again on the next boot. There is no code
 * change to undo, which is the whole point: the account decision and the code
 * are decoupled.
 *
 * ---- THE ONE METHOD THAT MUST NOT REJECT ----
 *
 * `statsTierGated()` is synchronous and pure: it reads an in-memory Map and
 * makes no request. bdlHitRateAggregator.ts:199 calls it to decide whether to
 * skip a known-401 sport. Rejecting it would be a type lie (it returns boolean,
 * not a promise) and would throw inside a branch written to be safe. It passes
 * through to the real implementation, which returns false on an empty gate map,
 * and the fetch that follows is what rejects. Honest ordering: the failure
 * surfaces at the network boundary, where it actually is.
 */

export const BDL_UNAVAILABLE_MESSAGE =
  `BALLDONTLIE IS NOT CONFIGURED on this server, so this request cannot be served. ` +
  `BDL_API_KEY is unset in the environment.\n\n` +
  `This is a DELIBERATE state as of v2.16.0, not a misconfiguration to work around. ` +
  `The connector runs on SportsGameOdds; BDL became optional once SGO Pro removed the ` +
  `entity cap that made BDL the cheaper stat source, and SGO's box scores were verified ` +
  `against ESPN on 2026-10-01.\n\n` +
  `WHAT HAS NO SUBSTITUTE: the injury feed. SGO publishes none, so confirm injuries and ` +
  `inactives against the league's official report or the team's own release before posting ` +
  `any player prop. Do not infer availability from a hit-rate sample - a DNP and a healthy ` +
  `scratch look identical in a box score.\n\n` +
  `WHAT MOVED TO SGO ALREADY: player hit rates and box scores (dataSource "sgo", the ` +
  `default since v2.14.0), game lines, odds, props, period odds, schedules and grading. ` +
  `Those are unaffected by this.\n\n` +
  `TO RESTORE BDL: set BDL_API_KEY in the Render environment and redeploy. No code change ` +
  `is needed - the client, the aggregators and every BDL route still ship intact.`;

/**
 * Methods that must pass through to the real client because they are synchronous
 * and make no request. Everything else becomes a rejected promise.
 *
 * Keep this list as short as it can possibly be. A method belongs here ONLY if it
 * performs no I/O; anything that could reach the network must reject, or the
 * connector starts answering from a client that cannot answer.
 */
const PURE_PASSTHROUGH_METHODS = new Set<string>(["statsTierGated"]);

/**
 * Every client this module created, tracked BY IDENTITY.
 *
 * ---- WHY A WeakSet AND NOT A MARKER PROPERTY, FIXED BEFORE SHIPPING v2.16.0 ----
 *
 * The first cut of this file exported a marker string and had the predicate read
 * `bdl["__tkbBdlUnavailable"]`. test/v2_14_0.test.ts builds its BDL spy as a
 * CATCH-ALL Proxy - `new Proxy({}, { get: () => countingFn })` - so the marker
 * lookup returned a function, a function is truthy, and the predicate declared a
 * live BDL client unavailable.
 *
 * That is a false negative in the DANGEROUS direction. A false positive merely
 * lets a doomed request fail at the network boundary with a real error. A false
 * negative silently disables a provider that was working, and reports a
 * configuration problem that does not exist. Any object shaped to answer every
 * property - a spy, a logging wrapper, a mock - would have tripped it.
 *
 * Identity cannot be answered by a `get` trap. A client is unavailable if and
 * only if THIS module made it. Anything else is treated as configured, which is
 * the safe default: a real failure then surfaces where it actually happens.
 * WeakSet rather than Set so a discarded client is still collectable.
 */
const UNAVAILABLE_CLIENTS = new WeakSet<object>();

/**
 * True when the client passed in is a real, keyed BDLClient.
 *
 * Tools use this to refuse UP FRONT with a precise message instead of firing a
 * request that is certain to reject. Preferred wherever a tool knows before
 * calling that BDL is the only possible source.
 */
export function isBdlConfigured(bdl: BDLClient): boolean {
  return !UNAVAILABLE_CLIENTS.has(bdl as unknown as object);
}

/**
 * A BDLClient-shaped object that refuses every network call by name.
 *
 * The constructor argument is a sentinel rather than an empty string so that if a
 * method ever escapes the Proxy, the resulting request fails loudly with a
 * traceable Authorization header instead of looking like a blank-key typo.
 */
export function createUnavailableBDLClient(): BDLClient {
  const target = new BDLClient("BDL_API_KEY_NOT_SET");

  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      if (PURE_PASSTHROUGH_METHODS.has(String(prop))) {
        return (value as (...a: unknown[]) => unknown).bind(obj);
      }

      /* A REJECTED PROMISE, not a synchronous throw. Every network method on
       * BDLClient is async, so callers `await` them inside a try block. Rejecting
       * keeps that contract exact: a caller that stores the promise and awaits it
       * later still lands in its own catch, where a sync throw at call time would
       * have escaped. */
      return () => Promise.reject(new Error(BDL_UNAVAILABLE_MESSAGE));
    },
  }) as BDLClient;

  UNAVAILABLE_CLIENTS.add(proxy);
  return proxy as BDLClient;
}
