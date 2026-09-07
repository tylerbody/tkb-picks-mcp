# v2.0.0 — cost fix, content tools, cleanup

19 tools (was 18). Four removed, five added, hit rates rerouted.

---

## 1. Hit rates now run on BALLDONTLIE

**The measured problem:** one thread cost **211 SGO entities**, a 15-game slate ~3,000, and daily multi-sport builds projected to **~114,000 against a 100,000 monthly cap**. Roughly 95% of that was team-history fetches — SGO bills per *event object*, so reading one player's line meant pulling 100+ team games.

**Why BDL fixes it structurally:** no monthly object cap at all, only requests per minute (60 on ALL-STAR, 600 on GOAT). Its stats endpoint also returns rows for **one player directly**, so the work is both uncapped and fundamentally smaller.

**Projected:** ~200 entities per thread → **~10**. Monthly ~114,000 → **~5,000**.

**Routing:** `tkb_get_player_hit_rate` tries BDL first, falls back to SGO on any failure, and **says which path served it**. A BDL outage degrades cost, never correctness. Force either side with `dataSource: "bdl" | "sgo"`.

### The field-mapping problem, and how it's handled

BDL's stat field names aren't reliably documented. This codebase has shipped a wrong BDL field assumption **twice** — both times failing *silently*, returning "unknown" or an empty result that read as a clean answer.

A wrong stat mapping would be worse: a missing field reads as `0`, indistinguishable from a real 0 hits, producing a confident and completely wrong hit rate.

`bdlStatMap.ts` therefore uses the same defensive pattern that eventually fixed the injuries bug — **candidate arrays checked in order**, reporting which field actually matched, and returning `null` (not 0) when nothing resolves.

**Two things it computes that the SGO path never could:**
- **Total bases**, derived from hit components when no direct field exists
- **WNBA combo stats** (Pts+Reb, Pts+Reb+Ast, Reb+Ast, Blk+Stl) — previously excluded outright, since SGO's `results` carries no per-component breakdown

**One thing it does worse, stated plainly in the output:** BDL returns only games a player *appeared in*, so DNPs are invisible. The playing-time risk flag that caught Brionna Jones at 7-of-30 games only works on the SGO path. The BDL response says so rather than reporting a false "OK".

---

## 2. `tkb_grade_slate` — batch grading

`tkb_grade_pick` handles one pick per call. A real day is 50-60 picks reconciled by hand across multiple sources — the largest recurring manual cost in the operation, and unlike thread-building it produces nothing new.

Takes the whole slate, **groups picks by event so each game is fetched once** (12 picks across 4 games = 4 fetches, not 12), returns everything graded plus a record summary.

Carries over the single-pick grader's two right decisions: grades against **your posted line** when supplied and flags mismatches loudly, and returns `NOT_FINAL` rather than guessing on unfinished games.

---

## 3. `tkb_scan_streaks` — non-pick content

**The gap this fills:** every other tool here produces a pick. Published growth guidance for handicapper accounts puts the healthy mix nearer 40% picks / 30% engagement / 30% personal, and warns that broadcast-only accounts get deprioritised and read as bots. The connector had no way to produce anything *but* picks.

Finds active streaks (3+ consecutive games clearing a threshold) and standout games meaningfully above a player's own baseline. Runs on BDL — **zero SGO quota**.

Deliberately conservative: ordinary production isn't surfaced, and it returns "nothing is notable today" honestly. A scanner that flags everything gets ignored.

---

## 4. `tkb_get_line_movement`

"This total opened at 8.5 and it's 10 now" is postable with no pick attached, and strengthens a reasoning bullet in a way a hit rate can't. **Costs no extra requests** — opening odds ride along on the same event fetch via `includeOpenCloseOdds`.

Reports movement as fact and explicitly declines to frame it as a signal to follow: by the time a number moves, the value that caused it is largely gone.

---

## 5. `tkb_monitor_live_picks` — early cashout detection

Your `💸 EARLY CASHOUT` format exists but the window is short — once a game ends it's just a normal CASHED reply.

**Enforces the over/under asymmetry that got three grades stated wrong in one manual pass:**
- **OVER past its line → CLEARED.** A counting stat can't go back down. Safe to post mid-game.
- **UNDER below its line → ON_TRACK, never "won."** It can still be broken. The tool refuses to call it cashed until the game is final.

---

## 6. Removed

| Tool | Why |
|---|---|
| `tkb_debug_raw_event` | `tkb_get_players` replaced its real use; it's a quota footgun |
| `tkb_debug_raw_injuries` | The bug it existed to find is fixed |
| `tkb_get_futures` | Its own code said the futures event type was never confirmed — it may never have worked |
| `tkb_get_team_record` | `tkb_get_team_split` returns overall record *plus* point differential and streak |

Three of the four could actively mislead. All stale cross-references cleaned.

---

## Full tool list (19)

**Picks:** `tkb_get_schedule`, `tkb_get_odds`, `tkb_screen_props`, `tkb_get_player_hit_rate`, `tkb_get_yes_no_prop`, `tkb_get_period_odds`, `tkb_get_injuries`, `tkb_get_team_split`, `tkb_get_game_weather`, `tkb_get_players`

**Content:** `tkb_scan_streaks`, `tkb_get_line_movement`, `tkb_get_cover_player`, `tkb_count_tweet_chars`

**Results:** `tkb_grade_pick`, `tkb_grade_slate`, `tkb_monitor_live_picks`

**Ops:** `tkb_get_api_usage`, `tkb_debug_bdl_stats`

---

## Verify after deploy, in this order

**1. Confirm BDL tier access:**
```
tkb_debug_bdl_stats  sport="mlb"  playerName="Ketel Marte"
```
Field list = ALL-STAR covers it. A 401 means stats need GOAT and the economics change — hit rates would keep falling back to SGO.

**2. Confirm the field mapping is right.** Cross-check one hit rate both ways:
```
tkb_get_player_hit_rate ... dataSource="bdl"
tkb_get_player_hit_rate ... dataSource="sgo"
```
**The counts should match.** If they don't, the mapping is wrong — check `statSource` in the BDL output to see which field it read.

**3. Measure the saving.** `tkb_get_api_usage` before and after a thread. Target is **~10 entities, down from 211**.

Run step 2 before trusting BDL numbers in a published thread. A candidate field that exists but means something slightly different is the one failure mode the guardrails can't catch on their own.
