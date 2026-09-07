# v2.8.3 — the closing line was the final score, and three docs were wrong about the tier

No tools added or removed. Still **26**. Eight files touched, one behavioural fix in a
grading path, one in a diagnostic, and a set of messages that had been actively
misdirecting anyone who read them.

Everything here came from running live probes against BALLDONTLIE, SportsGameOdds and
CollegeFootballData on 2026-08-31, not from review.

---

## 1. `closingLine` was reporting the final score

### What was measured

`tkb_grade_pick` on Red Sox @ Yankees, 2026-08-30, final **16-1**:

```
"actualValue": 17,
"closingLine": 17.5,
"lineMismatch": true
```

**No MLB total closes at 17.5.** Totals live between roughly 7 and 12. The number is
half a run off the final score because it *is* the final score, arrived at from the
other direction.

### The cause

Both graders read:

```ts
const closeRaw = odd.closeOverUnder ?? odd.closeSpread ?? odd.bookOverUnder;
```

Per SGO's docs, `closeOverUnder` and `closeSpread` are **not top-level fields on an
odd**. They live under `byBookmaker.<book>` and only appear when
`includeOpenCloseOdds=true` is requested, which neither grader does. So the chain fell
through to `bookOverUnder` every single time. On a settled blowout that field carries
the last LIVE value, which climbs as the game gets out of hand.

The fallback was never exercised as a fallback. It was the only branch that ever ran.

### What it invalidates

`docs/results-tracking-workflow` records these as evidence that the feed stores closing
lines that differ from posted:

> Mabrey points posted 16.5 / closed 34.5; Cardoso rebounds posted 8.5 / closed 12.5;
> Tidwell Ks posted 3.5 / closed 5.5

Those are not line moves. Mabrey did not have a 34.5 point line. She scored near 34.
Every one of those is this artifact, and `lineMismatch` has been firing on essentially
every total and prop ever graded.

**Grades themselves were never wrong**, because the workflow already mandates passing
`postedLine`. Only the mismatch warning was noise.

### The fix

`closingLine` now returns **null**, and `lineMismatch` is always false, until the
`byBookmaker` path is verified live. That follows this connector's oldest rule: a value
that cannot be resolved returns null, never a plausible substitute.

The feed's line is still used to grade when no `postedLine` is supplied, but it is
renamed `feedLine`, never presented as a close, and never compared against anything.
The slate summary now says closing lines are unavailable rather than warning about a
comparison it cannot make.

**Still open:** whether the real close is reachable at
`byBookmaker.<book>.closeOverUnder` with `includeOpenCloseOdds=true`. The docs say so.
Not verified, and deliberately not built on. Same reason v2.8.1 shipped broken: a fix
written from documentation alone is a guess wearing a citation.

---

## 2. `tkb_get_line_movement` is half-broken, and is NOT fixed here

Measured 2026-08-31 on Orioles @ Rockies, total, over:

```
"openingOdds": "-110",     <- resolved
"openingLine": null,       <- did not
"description": "Price moved but the line itself is unavailable."
```

So `odd.openOdds` **does** exist top-level. `odd.openOverUnder` and `odd.openSpread`
do not. The docs are incomplete in one direction and right in the other.

The half that is missing is the half the tool exists for. Its own docstring says the
point is *"this total opened at 8.5 and it's 10 now."* What it can actually produce is
"opened at -110, now -110," which is not a postable sentence. And it reports this as a
coverage gap rather than a defect, so it reads like SGO's fault.

**Third problem, found in the same call:** the price came back from `betonline`. This
tool accepts no `preferredBookmakers` and passes none, so both the current price and
line come from an arbitrary book. That is the v2.5.3 problem, in a tool that never got
the v2.5.3 fix.

**Deliberately not fixed in this release.** The fix depends on the same unverified
`byBookmaker` question as section 1. One live call with `includeOpenCloseOdds=true`
settles both at once, and both fixes should ship together, after it.

---

## 3. Three separate strings told you the subscription was broken. It is not.

### What was verified

Every row measured live on 2026-08-31 against the production key:

| Endpoint | Result | Meaning |
|---|---|---|
| `/mlb/v1/stats` | 200 | ALL-STAR includes player stats here |
| `/nfl/v1/stats` | 200 | Same |
| `/wnba/v1/player_stats` | 401 | GOAT only for this sport |
| `/ncaaf/v1/player_stats` | 401 | GOAT only for this sport |
| `/ncaaf/v1/players` | 200 | Free tier |
| `/ncaaf/v1/teams` | 200 | Free tier |
| `/ncaaf/v1/team_season_stats` | 401 | GOAT only |
| `/ncaaf/v1/player_injuries` | **404** | **Endpoint does not exist** |
| `/ncaaf/v1/injuries` | **404** | Not a path-naming problem |
| `/mlb/v1/player_injuries` | 200 | Same path shape, so the shape is right |

**MLB, NFL, WNBA and NCAAF are all active at ALL-STAR.** Nothing is misconfigured.

### 404 is not 401, and the difference is money

`formatBDLError` had no 404 branch, so a missing endpoint fell through to the generic
message and read like a transient failure. A 401 means *you could buy this*. A 404
means *you cannot, at any price*. NCAAF injuries are the second. A 404 branch is added
that says so outright.

### The 401 message was blaming the wrong thing

It read:

> This usually means the NCAAF subscription on this BALLDONTLIE account isn't at
> ALL-STAR tier or above. Check the account dashboard.

That sent a debugging session chasing a subscription problem that did not exist. The
correct message already existed twenty lines away in `tierGateMessage()`, but that one
only fires once the TTL memo is set — and `getRawPlayerGameStats` is deliberately
un-memoised so `tkb_debug_bdl_stats` always does a real network check. **The one tool
built to answer "what tier do we hold" was structurally guaranteed to hit the wrong
message.** Both now say the same thing.

### `tkb_debug_bdl_stats` was throwing away the answer

Step 1 resolves the player *and their team*. Step 2 fetches stats and may 401. The
`candidates` array holding the team was scoped inside the `try`, so on a gated sport
the catch reported only "tier gate" and discarded it. That made "this player does not
exist" and "this player resolved fine, stats are gated" indistinguishable.

`resolved` is now hoisted and reported in the tier-gate branch.

The same catch also said *"Do not build the migration until this is resolved."* The
migration shipped in v2.0.0 and serves MLB and NFL today. On a CFB probe the tool was
telling the reader not to do a thing that was already done. Removed, and the file
header now carries the verified table instead of the third-party article it used to
cite.

---

## 4. NCAAF players is a historical index, not a roster

Worth recording because it kills an obvious idea before someone else has it.

`/ncaaf/v1/players` is free tier and returns `team` with a stable numeric **id**, which
looks like exactly the roster cross-check needed to catch SGO's team-attribution errors
(SGO lists Bryson Washington under Baylor; he transferred to Auburn in January).

It is not. Pulling Auburn's roster returns **the 2004 team**: Cadillac Williams, Jason
Campbell, Ronnie Brown, Carlos Rogers. A surname search returns roughly fifty
Washingtons — O.J., Otis, Waverly — and no Bryson. Every `height`, `weight` and
`jersey_number` is null.

A roster source that confidently returned Washington on Baylor would have *agreed* with
SGO's wrong answer and manufactured confidence in it. That is worse than no source.

**The remaining candidate is CFBD `/roster?year=2026`**, which would fit the existing
permanent-cache design. Not scoped here. Until then, depth-chart confirmation for CFB
stays manual, exactly as the README already says.

---

## 5. The CFBD budget is an unverified planning number

`cfbdClient.ts` sizes its entire architecture around "1,000 requests a month." CFBD's
docs decline to state limits at all:

> The API tiers page is the source for current access levels, limits, and pricing.
> Those details can change, so they are not duplicated here.

So the constant this design is built on is precisely the kind of decaying fact this repo
forbids quoting from a secondary source. The design survives being wrong about it —
one request returns a whole week — but the comment now says the figure is an assumption
rather than a fact.

**Worse, the counter cannot see the budget.** `getStats()` counts requests *this
process*. Render's free tier spins down when idle, so several cold starts a day means
`tkb_get_api_usage` can report near zero while real monthly usage climbs. A budget you
cannot observe is a budget you are assuming, which is the stated reason every other
counter in this connector exists. The usage line now says so and points at CFBD's own
`/api/info` operation as the authoritative number.

---

## 6. Two changelog premises that no longer hold

Recorded rather than silently edited, since both are cited as reasoning elsewhere.

**The six-segment oddID.** v2.6.5 hardened `oddIdParser.ts` against a documented
`{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}-{bookmakerID}` form. Both
SGO's oddID data-type page and its AI-context page state **five** segments today, with
the bookmaker at the nested path `odds.<oddID>.byBookmaker.<bookmakerID>` rather than as
a suffix. The parser is harmless — it tries five first and refuses rather than guessing
— and anchoring on closed vocabularies is good design regardless. But its stated premise
is currently unsupported and the six-segment tests assert a shape that may not exist.

**`includeOpposingOdds`.** v2.6.4 cites it as "a parameter SGO quietly ignored,
corrected 8 Aug 2026." SGO's docs now document it as functional. Either it was added
since, or the original diagnosis was wrong.

---

## Files changed

```
src/constants.ts
src/services/bdlClient.ts
src/services/cfbdClient.ts
src/tools/bdlStatsProbe.ts
src/tools/gradePicks.ts
src/tools/gradeSlate.ts
src/tools/injuries.ts
src/tools/usage.ts
docs/CHANGES-v2_8_3.md
```

`SERVER_VERSION` in `src/index.ts` and `version` in `package.json` still need bumping
to `2.8.3` by hand. That string has drifted three times before.

---

## Also do, not included here

**Delete the dead files.** `src/tools/debugEvent.ts`, `debugInjuries.ts`, `futures.ts`
and `teamRecord.ts` are the four tools removed in v2.0.0 and archived in v2.6.0, with an
explicit instruction to delete them from `src/tools/`. Seven releases later they are
still there. `futures.ts` still tells the reader to run `tkb_debug_raw_event`, which no
longer exists. Also delete `DEPLOY-CHECK.md`, superseded by `scripts/verify-deploy.mjs`
and still telling the reader `/health` should report 2.0.3.

**Collapse the changelogs.** `CHANGES-v2_8_0.md`, `v2_8_1.md` and `v2_8_2.md` are
cumulative, not incremental — the first 503 lines are byte-identical across all three,
so `docs/` holds three copies of v2.7.0 and v2.7.1. Keep `v2_8_2.md` and delete the
other two, or split them properly.

---

## Deploy

1. Copy the eight source files over the repo.
2. Bump `SERVER_VERSION` in `src/index.ts` and `version` in `package.json` to `2.8.3`.
3. `npm test`. **Expect failures** — any test asserting a populated `closingLine` or a
   firing `lineMismatch` is asserting the bug. Update those tests to expect `null` and
   `false`, and pin the 16-1 / 17.5 case as a regression.
4. Commit, redeploy.

### Verify, control case FIRST

v2.8.2's lesson: verifying only the cases you expect to fail is how v2.8.1 passed its
own checklist while broken for the entire league.

**Control.** Grade a settled total with a `postedLine`:

```
tkb_grade_pick sport="mlb" eventID="<a final game>" marketType="total"
               side="over" postedLine="<real line>"
```

Must still return the correct WIN/LOSS, with `closingLine: null` and
`lineMismatch: false`. **If the result flips, stop** — the grading logic was not
supposed to move.

**Then the failure cases.**

- `tkb_get_injuries sport="cfb"` — the refusal must now say the endpoint does not exist
  and cannot be bought, not that it is missing from the plan.
- `tkb_debug_bdl_stats sport="cfb" playerName="Cobb"` — must report the resolved player
  and team alongside the tier gate, plus the warning that the NCAAF index is historical.
- `tkb_get_api_usage` — the CFBD line must state the counter is process-local.

Do **not** confirm the deploy by reading `/health`. Per v2.6.6 it reported 2.6.4 with 21
tools while the server was correctly serving 24, because the response was cached
upstream. Call a tool that only exists in the new build.
