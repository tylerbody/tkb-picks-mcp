# v2.8.4 — player search never paginated, and v2.8.3 shipped a wrong explanation for it

No tools added or removed. Still **26**. Two files changed. One real bug in a method
that has been wrong since v2.0.0, and one retraction of a claim this project shipped
into its own connector eight hours earlier.

Found by the live verification pass on v2.8.3, by a change that shipped in v2.8.3.

---

## 1. `searchPlayers` requested one page and stopped

### What was measured, 2026-08-31

`tkb_debug_bdl_stats sport="cfb" playerName="Bryson Washington"` returned **exactly
100 candidates**, ids ascending from 197 to 29711. No Bryson Washington.

The same tool on `playerName="Cobb"` returned **80** candidates — and among them:

```json
{ "bdlPlayerID": 54445, "name": "Jeremiah Cobb", "team": "Auburn Tigers" }
```

Correct, current, and correctly attributed. The only structural difference between the
two queries is that 80 fits in a page and 100 is a page.

### The cause

```ts
const response = await this.throttle(() => this.http.get(
  this.buildPath(sport, "players"), { params: { search: term, per_page: 100 } }
));
all = response.data.data ?? [];
```

One request. No cursor. **BDL returns players ASCENDING BY ID**, so page one of a
cumulative all-time index is the oldest entries in it. Any surname with more than 100
historical entries had every current player sitting past the cutoff, permanently
unreachable.

Bryson Washington transferred to Auburn in January 2026 and carries an id above 50000.
He was never in the response to be found.

### Why nothing caught it for eight releases

The failure was absorbed by a guardrail working correctly. A truncated page yields no
exact match, so `searchPlayers` returns the full candidate list, and the aggregator's
refusal-to-guess rule (v2.0.1, the "Marte" case) declines to pick. The caller reports an
ambiguous or missing name. **That reads like a naming problem, which is exactly what
v2.4.1 concluded** when it looked at a stubborn 12.5% fallback rate and wrote:

> the remaining cases are a different problem: most likely players BALLDONTLIE
> genuinely does not carry (recent callups, minor-league debuts) or names that are
> honestly ambiguous.

Recent callups have high ids. That is the same bug, diagnosed as a data-coverage
limitation and closed as not worth chasing.

### This is v2.0.3's bug, in a method v2.0.3 did not audit

v2.0.3 fixed ascending-page truncation in `getAllPlayerGameStats` and `getAllGames`, and
stated the principle plainly:

> Pagination stopping silently after page 1 is **indistinguishable from "there was only
> one page"** — and because rows are ascending, a silent stop means only old games are
> ever seen.

Every word applies here. Per v2.6.0: *the fixes were correct, the audits were scoped to
the file the symptom appeared in.*

### The fix

`searchPlayers` now follows `meta.next_cursor` via the existing `nextCursorOf` helper,
checking for an exact accent-insensitive match **after every page** and exiting the
moment one is found.

**Cost is unchanged in the common case.** A name resolved on page one still costs
exactly one request. Only surnames that genuinely span multiple pages pay more, bounded
by `MAX_SEARCH_PAGES = 6` (~600 rows), matching the ceiling `getAllPlayerGameStats`
already uses.

`truncated` is now returned when the cap is reached with a cursor still pending. It is
an additive optional field, so existing callers are unaffected. The distinction it
carries is the whole point: **"not in the index" and "not in the pages we read" are
different answers**, and only one of them justifies giving up on a player.

---

## 2. Retraction: v2.8.3's NCAAF warning was wrong

v2.8.3 shipped this into `tkb_debug_bdl_stats`, where every future reader would see it:

> NOTE ON NCAAF: the players index is HISTORICAL, not a current roster. Verified
> 2026-08-31 - an Auburn roster pull returned the 2004 team (Cadillac Williams, Jason
> Campbell, Ronnie Brown)... Do NOT use it to answer "which team is this player on now".

**That is false.** The index is cumulative and all-time, and it contains current players.
The Auburn pull returned the 2004 team because it read the first forty rows of an
ascending list and generalised from them. The conclusion was drawn from the very bug
section 1 fixes.

Corrected to describe the ordering rather than the contents. Recorded here rather than
quietly edited, because a wrong claim published into the connector's own output is worse
than a wrong claim in a changelog, and the correction should be as findable as the error.

Worth noting **what caught it**: the hoisted `resolved` block added in v2.8.3 section 3,
which reports the resolved candidates instead of discarding them on a tier gate. Before
that change the tool printed "tier gate" and swallowed the list, and neither the 100-row
cutoff nor the presence of Jeremiah Cobb would have been visible. The fix that exposed
the error shipped in the same build as the error.

---

## 3. What this reopens

**A roster cross-check may now be buildable.** The premise for abandoning it was that
BDL's NCAAF index could not answer "which team is this player on in 2026." That premise
was the truncation artifact. The index carries current players with a stable numeric
`team.id`, which is the join key v2.8.2 argued for over fuzzy name matching.

**Not built here, and not to be built on this evidence alone.** The control case has to
pass first:

```
tkb_debug_bdl_stats sport="cfb" playerName="Bryson Washington"
```

- Returns him on **Auburn** → the index is current and correct, and a roster check that
  catches SGO's team-attribution errors becomes possible.
- Returns him on **Baylor** → the index is stale, and a roster check would have
  *confirmed* SGO's wrong answer rather than catching it. That is worse than no check.
- Still absent, with `truncated: true` → raise the cap and retry before concluding.

The middle outcome is the one to fear, and it is the reason this stays unbuilt until the
call is made.

---

## Files changed

```
src/services/bdlClient.ts
src/tools/bdlStatsProbe.ts
docs/CHANGES-v2_8_4.md
```

`SERVER_VERSION` in `src/index.ts` and `version` in `package.json` need bumping to
`2.8.4` by hand.

---

## Tests to add

None ship here, since `searchPlayers` needs an HTTP client and the suite is
network-free. The honest options, in order of preference:

1. **Extract the page loop into a pure function** taking a fetch callback, per the rule
   v2.6.1 learned and v2.6.3 and v2.7.0 restated: logic that changes which data reaches
   the user is correctness logic and cannot live inside a function that needs an API
   client. Then assert: exact match on page one costs one call; a match on page three
   costs three; hitting the cap sets `truncated`.
2. **Mutation test it.** Reverting to a single request must fail those assertions. If it
   does not, the test proves nothing — see v2.6.4, where a combo-statID test passed
   against a deliberately broken parser and had to be rewritten.

---

## Deploy

1. Copy the two source files over the repo.
2. Bump `SERVER_VERSION` and `package.json` to `2.8.4`.
3. `npm test`. **149 expected**, unchanged — nothing here touches an asserted path.
4. Commit, redeploy.

### Verify, control case FIRST

The v2.8.2 rule: verifying only the cases you expect to fail is how v2.8.1 passed its
own checklist while broken for the entire league. In this release the control matters
more than usual, because the change is to a resolution path every BDL rate depends on.

**Control 1 — a name that already worked must still work, at the same cost.**

```
tkb_debug_bdl_stats sport="mlb" playerName="Ketel Marte"
```

Must resolve as before. If MLB resolution slows noticeably, the early-exit check is not
firing on page one and every hit rate just got slower.

**Control 2 — MLB rates unchanged.**

```
tkb_get_player_hit_rate sport="mlb" ... dataSource="bdl"
```

Same counts as before this deploy. Player search feeds every BDL rate; if the numbers
move, the resolution changed and that was not the intent.

**Then the case this release exists for.**

```
tkb_debug_bdl_stats sport="cfb" playerName="Bryson Washington"
```

He should now resolve. Whichever team comes back is the answer to section 3.

Do not confirm the deploy by reading `/health` — per v2.6.6 it reported 2.6.4 with 21
tools while the server was serving 24, because the response was cached upstream. Call a
tool that only exists in this build.

---

## Still open, carried forward

- **`tkb_get_line_movement` is half-broken.** `odd.openOdds` resolves; `openOverUnder`
  and `openSpread` do not, so it returns an opening price with no opening number, which
  is useless for the totals and spreads it exists to describe. It also accepts no
  `preferredBookmakers` and priced a test off BetOnline. Both fixes wait on one live
  call with `includeOpenCloseOdds=true` to confirm whether the values sit under
  `byBookmaker.<book>`. That same call also settles the real closing line for the
  graders (v2.8.3 section 1).
- **`preferredBookmakers` is still not passed by the nightly prompts.** Open since
  v2.5.3, six releases. One argument in three scheduled tasks, no code, no deploy, and
  until it is done every nightly screen ranks against arbitrary books.
- **The four dead tool files** (`debugEvent.ts`, `debugInjuries.ts`, `futures.ts`,
  `teamRecord.ts`) and `DEPLOY-CHECK.md` still need deleting; the three cumulative
  2.8.x changelogs still need collapsing.
- **CFBD usage is unobservable.** `getStats()` counts this process only and Render cold
  starts reset it. The authoritative figure is CFBD's `/api/info`.
