# v2.8.6 — CFB hit rates never worked, and the book filter was three copies applied to half the tools

No tools added or removed. Still **27**. Twelve source files changed, one test file added.

Everything here came from building the 2026-09-03 CFB threads live and reading the code
that produced them, not from review.

---

## 1. Every CFB hit rate ever requested returned NO SAMPLE

### What was measured, 2026-09-02

`tkb_get_player_hit_rate`, Julian Lewis, `teamID: "COLORADO_NCAAF"`, `passing_yards`:

```
sampleWarning: 'NO SAMPLE. "Julian Lewis" was not found on COLORADO_NCAAF
                in any scanned week.'
cfbdPlayerID:      null
teamGamesScanned:  0
matchedFields:     []
```

Read as a data answer that is "this quarterback has no history." It is not. It is the
tool echoing a string mismatch back at the caller.

### The cause

`tools/hitRate.ts`:

```ts
const cfbdResult = await getCfbdPlayerHitRate(cfbd, {
  teamName: params.teamID,      // <-- an SGO teamID, handed to a CFBD name matcher
```

SGO teamIDs are `COLORADO_NCAAF`. CFBD box scores say `Colorado`. `resolveCfbdPlayer`
compares them with an **exact normalised match**, so `colorado_ncaaf` never equalled
`colorado`, `playerID` stayed null through every scanned week, and the aggregator
returned its NO SAMPLE branch.

The input schema made this the documented behaviour, not an edge case:

> "The player's current team ID (SGO teamID). Get this from tkb_get_odds or
> tkb_get_schedule output."

Follow that instruction and the tool cannot work.

### Why nothing caught it for four releases

`tools/screenProps.ts` passes `teamNames[player.teamID]`, the **display name**, so it was
never affected. The one path that works is the one the nightly CFB task explicitly
forbids on cost grounds, and the path it mandates is the broken one.

Nothing errored. An empty CFB sample also looks entirely ordinary in the opening weeks,
when every sample is prior-season by construction and `includePriorSeason` is easy to
forget — so the symptom had a plausible innocent explanation sitting right next to it.

Same family as the `p_k` batting/pitching collision (v2.0.1), the reversed newest-first
array (v2.1.0), and the year-stale window (v2.6.1). Right values, wrong story, no
guardrail with anything to fire on.

### The fix

`tkb_get_player_hit_rate` takes an optional **`teamName`**, used for CFB and ignored
elsewhere. An explicit name always wins.

When only a teamID is given, `deriveCfbdTeamName()` converts it — exported and pure, with
an override table for the names title-casing cannot reach (`Ole Miss`, `Texas A&M`,
`UMass`, `UConn`, `Miami (OH)`, `Hawai'i`) and an all-caps set for `BYU`, `UAB`, `TCU`
and their peers.

**The derivation is a fallback and says so.** It cannot cover 137 programs, and pretending
otherwise would trade a loud failure for a quiet one. So whenever a CFB lookup returns
`cfbdPlayerID: null`, the response now names the string it actually searched:

```
TEAM SEARCHED: "Colorado" - DERIVED from teamID "COLORADO_NCAAF" because no
teamName was passed. CollegeFootballData keys box scores by team NAME. If that
derived name is wrong for this program, pass teamName explicitly and retry BEFORE
concluding this player has no history.
```

`cfbdTeamNameSearched` and `cfbdTeamNameWasDerived` ride along in `structuredContent`, so
a consumer reading only the JSON gets the same distinction. That is the v2.8.0 lesson from
`tkb_get_mlb_matchup`: careful prose in the text content is invisible to anything parsing
the object.

---

## 2. `tkb_screen_props` spent ~60 entities a game on a CFB probe that cannot work

`probeTeamAvailability` reads player-level entries out of `event.results` across 30
finalized SGO events **per team**. SGO carries no CFB player box scores outside the
playoff — the exact fact that made v2.7.0 remove the SGO fallback from the CFB hit-rate
path, after it reported Dante Moore at a 0.2 play rate for a season he started all 15
games of.

So on CFB the probe walks two full team histories and can only ever return an empty map.
Roughly **60 entities per game**, about **2,160 across a 36-game Saturday**, spent to
learn nothing and then print `AVAILABILITY UNAVAILABLE`.

v2.7.0 fixed the hit-rate path. The probe, added back in v2.4.0, never got the same
treatment. Per v2.6.0: *the fixes were correct, the audits were scoped to the file the
symptom appeared in.*

**CFB now skips the probe**, and the routing line distinguishes a skipped probe from a
failed one, because "unavailable" invites a retry and this never will be:

```
Availability: NOT PROBED for CFB, deliberately. SportsGameOdds carries no CFB player
box scores outside the playoff, so the probe can only ever return empty - it cost ~60
entities per game to learn nothing. CFB availability must be confirmed from a published
depth chart, which CollegeFootballData also cannot substitute for (it lists a player only
where he recorded a stat, so a quiet game and a DNP look identical). Run
tkb_verify_roster to catch a stale team field before you do.
```

---

## 3. The book filter was three copies applied to half the tools

v2.6.2 called `preferredBookmakers` "a policy rather than a parameter" and moved it into
code. It then declared that policy **three times** and applied it to **three of six** odds
tools.

| Tool | Before v2.8.6 |
|---|---|
| `screenProps.ts` | local `DEFAULT_BOOKMAKERS` const |
| `propBoard.ts` | identical local const |
| `gameLines.ts` | third copy, inline in the zod `.default()` |
| `odds.ts` | `.optional()`, **no default at all** |
| `yesNoProps.ts` | **no book parameter** |
| `lineMovement.ts` | **no book parameter** |

Three copies of a value that must agree is the drift that put `SERVER_VERSION` out of step
with `/health` three separate times, and is why v2.5.4 collapsed
`STARTING_PITCHER_THRESHOLDS` into one constant.

`DEFAULT_BOOKMAKERS` now lives in `src/constants.ts` and all six import it. The three
tools that never had it get it as a real default.

### `hardrockbet` added, and it is a judgement call rather than a bug fix

v2.5.3 and v2.6.2 both measured Hard Rock among the venues polluting an unfiltered board
and left it out on **audience-reach** grounds. It is regulated; it is live in far fewer
states than the other four.

**What changed is CFB.** Measured 2026-09-02 on the Week 1 Thursday slate:

| Game | 4-book default | + hardrockbet |
|---|---|---|
| UAB @ Illinois | 18 priced rows, **0 two-sided** | 36 rows, **22 two-sided** |
| Colorado @ Georgia Tech | 12 priced rows, **4 two-sided** | 27 rows, **17 two-sided** |

Hard Rock is posting essentially every two-way CFB player market this early; the other
four post one-sided touchdown longshots at +2200 and worse. Without it a CFB player-prop
thread has **no publishable two-way number to build on at all**, which is a larger problem
than the reach caveat. Revisit when CFB boards fill out later in the season — it is now
one string in one file.

Note on the ID: SGO's public bookmakers page does not list Hard Rock Bet, but live
responses return `hardrockbet`. Live data beats the doc page, which omits other keys the
API demonstrably returns.

---

## 4. Offshore books were never blocked, only filtered around

`betonline` and `bovada` appear in **none** of the three blocklists in `oddsPricing.ts`,
so `isRealBookmaker` has always accepted them as publishable. They stayed out of threads
only because three tools happened to send a `preferredBookmakers` filter that excluded
them **server-side, before they ever reached the pricing layer.**

That is protection by convention rather than by construction, and it has already failed
once: v2.8.3 recorded `tkb_get_line_movement` returning a BetOnline price and filed it as
a missing-argument problem. The argument was half of it. The other half is that with no
filter, the pricing layer was the last line of defence and had no opinion about offshore
books at all.

**`OFFSHORE_BOOKS` is now a fourth set**, and v2.8.6 deliberately does both things — adds
the missing defaults *and* the set. A default can be overridden, forgotten on a future
tool, or switched off with `"all"` for diagnosis. The set cannot be bypassed by any call
site. Same argument that moved "never publish fair odds" out of prose and into
`extractPricedLine`.

Kept separate from the other three because, per this file's own convention, **the reason
decides the set**:

- Pick'em apps distort by being **flat**
- Fliff is real but **unbettable for this audience** (sweepstakes)
- Prediction markets price **contracts not comparable to an over/under**
- Offshore books post **real two-way prices a US follower cannot legally bet**

`prophetexchange` stays deliberately unblocked and is pinned in a test: realistic two-way
prices, and a TKB affiliate partner.

IDs from SGO's published bookmakers list, checked 2026-09-02.

---

## 5. `tkb_count_tweet_chars` now answers both ceilings in one call

X's 280 limit is the **weighted** count. But a post carrying media can be cut off with
"Show more" well before that, so the CFB and NFL thread formats impose a second, tighter
ceiling on the opener: **200 plain characters**, emoji counted as 1 and URLs at their real
length. A completely different number.

Measured while building the 2026-09-03 CFB threads: **the opener took six round trips**,
because this tool answered the 280 question and the 200 question had to be answered by
writing the text to a file and running
`python3 -c "print(len(open('f.txt').read()))"` after every edit.

New optional **`rawLimit`**. `rawLength` is always returned; passing `rawLimit` makes a
post fail unless it clears both, and the header reports `280 weighted / 200 raw`.

The counts genuinely differ. The real 9/3 Georgia Tech opener is **182 raw, 188 weighted** —
pinned as a regression test against the python reference count, since the whole value of
the field is that it reproduces that number exactly.

---

## 6. Version drift

`package.json` said **2.8.2** while `index.ts` and `/health` said 2.8.5. The v2.8.3, v2.8.4
and v2.8.5 notes each ended with "bump `version` in `package.json`" and none of them
happened. Both now say 2.8.6.

`README.md` also said v2.8.2, claimed 26 tools, and documented neither `tkb_verify_roster`
(added v2.8.5) nor `tkb_get_mlb_matchup` at all. Corrected, and the new CFB gaps recorded
in Known gaps.

---

## Files changed

```
src/constants.ts                          DEFAULT_BOOKMAKERS
src/index.ts                              SERVER_VERSION 2.8.6
src/services/cfbdHitRateAggregator.ts     deriveCfbdTeamName
src/services/oddsPricing.ts               OFFSHORE_BOOKS
src/tools/hitRate.ts                      teamName param + the fix
src/tools/screenProps.ts                  CFB probe skip, shared const
src/tools/propBoard.ts                    shared const
src/tools/gameLines.ts                    shared const
src/tools/odds.ts                         default added (was optional, none)
src/tools/yesNoProps.ts                   book param added (was absent)
src/tools/lineMovement.ts                 book param added (was absent)
src/tools/tweetChars.ts                   rawLimit
test/v2_8_6.test.ts                       17 tests, no network
package.json                              2.8.6
README.md                                 version, tool count, CFB gaps
```

`tsconfig.json` is unchanged and deliberately **not** included — keep yours.

---

## Tests

**17 new, network-free.** Built from the real 2026-09-02 build rather than fixtures: the
Julian Lewis teamID case, the actual published opener at 182 raw / 188 weighted, and the
live book keys observed on that slate.

**Mutation-tested before shipping**, per v2.6.4, where a combo-statID test passed against a
deliberately broken parser and proved nothing:

| Mutation | Result |
|---|---|
| Stop stripping the `_NCAAF` suffix | **5 tests fail** |
| Drop `betonline` from `OFFSHORE_BOOKS` | **2 tests fail** |
| Revert `hardrockbet` out of the default list | **1 test fails** |

All three restore to 17/17.

---

## Deploy

1. Copy the twelve source files, `test/v2_8_6.test.ts`, `package.json` and `README.md` over
   the repo.
2. `npm test`. Your existing suite plus these 17.
3. `npx tsc --noEmit` — this build typechecks clean under strict + `noUnusedLocals`.
4. Commit, let Render redeploy.

### Verify, control case FIRST

The v2.8.2 rule: verifying only the cases you expect to fail is how v2.8.1 passed its own
checklist while broken for an entire league. Two of these changes alter which price is
returned, so the control matters more than usual.

**Control 1 — MLB pricing must not move.**

```
tkb_get_game_lines sport="mlb" date="<today>"
```

Same books, same numbers as before this deploy. `odds.ts` gained a default it never had,
so if MLB prices shift, the default is reaching a call that was deliberately unfiltered.

**Control 2 — a real book must still be publishable.**

```
tkb_get_odds sport="mlb" teamName="<any>" marketType="total"
```

Must return a DraftKings/FanDuel/BetMGM/Caesars price. An empty result means the offshore
set caught something it should not have.

**Then the cases this release exists for.**

```
tkb_get_player_hit_rate sport="cfb" teamID="COLORADO_NCAAF" teamName="Colorado"
  playerID="<any>" playerName="Kaidon Salter" statID="passing_yards"
  line=217.5 direction="over" includePriorSeason=true
```

Must return a real counted sample. Before this build it returned NO SAMPLE for every CFB
player regardless of who was asked for.

Then drop `teamName` and confirm the derived path also resolves, and that the response
names the team it searched.

```
tkb_get_prop_board sport="cfb" eventID="<a CFB game>"
```

Should now surface Hard Rock two-way markets that were invisible yesterday. Compare the
`oneSidedCount` against a run with `preferredBookmakers="draftkings,fanduel,betmgm,caesars"`.

```
tkb_count_tweet_chars posts=["<an opener>"] rawLimit=200
```

Must report both counts and fail the post if either ceiling is breached.

Do **not** confirm the deploy by reading `/health` alone — per v2.6.6 it reported 2.6.4
with 21 tools while the server was correctly serving 24, because the response was cached
upstream. Call a tool that only behaves this way in the new build.

---

## Still open, carried forward

- **The nightly CFB task needs its own edit, and this release does not do it.** Four
  changes belong in the stored prompt rather than the code: the ban on
  `tkb_screen_props` is calibrated to a pre-v2.6 connector that cost ~1,080 entities a
  game rather than ~56; nothing passes `includePriorSeason`, so every early-season CFB
  rate is empty even after this fix; `tkb_verify_roster` should be mandatory on any CFB
  player prop given portal churn; and the build fires ~20 hours before kickoff while
  player props post ~4 hours before, so a late prop-fill pass is needed before a prop
  format can be relied on.
- **`tkb_get_line_movement` is still half-broken.** `openOdds` resolves, `openOverUnder`
  and `openSpread` do not. It now prices against the right books, but it still returns an
  opening price with no opening number. Waits on one live call with
  `includeOpenCloseOdds=true` to confirm whether those sit under `byBookmaker.<book>` —
  the same call that settles the real closing line for the graders (v2.8.3 §1).
- **`deriveCfbdTeamName` covers the programs this account posts, not all 137.** Add to the
  override table as misses surface; the response names the searched string precisely so a
  miss is a one-line fix rather than a debugging session.
- **The four dead tool files** (`debugEvent.ts`, `debugInjuries.ts`, `futures.ts`,
  `teamRecord.ts`) and `DEPLOY-CHECK.md` still need deleting; the cumulative 2.8.x
  changelogs still need collapsing.
