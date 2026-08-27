# v2.6.5 — reading the docs, and finding three things we already paid for

Three tools added, 21 to **24**. One latent parser bug hardened across two tools.
One fetch path batched. No existing behaviour changed.

The whole release came out of actually reading BALLDONTLIE's and SportsGameOdds'
current documentation rather than the assumptions baked in when each integration
was written. Two of the three findings are things this account has been paying for
and not using.

---

## 1. `tkb_get_rankings` — the manual step that was never necessary

`tkb_get_schedule` has always demanded a `rankedTeams` list pasted in from a live
web search. Its own error message argued the case:

> SportsGameOdds does not reliably expose team rankings, and hardcoding a Top 25
> into this server would go stale within a week and then silently return wrong
> results all season.

Both halves of that are true. The conclusion did not follow, because it assumed
SGO was the only source.

**BALLDONTLIE publishes the AP poll at `/ncaaf/v1/rankings`, on the ALL-STAR tier
this account already holds for NCAAF.** Rank, first-place votes, points,
week-over-week trend, record. The manual step was never necessary; it was a gap in
what the connector knew about its own subscriptions.

And it does not go stale, which was the actual objection. A hardcoded list rots. A
live endpoint returns the current week every time.

`namesOnly: true` returns a bare comma-separated string that pastes straight into
`tkb_get_schedule`'s `rankedTeams`.

**Zero SGO entities.** Different provider, no object cap.

Gated to CFB. MLB, WNBA and NFL have no poll, and accepting the call to return an
empty list would be a plausible-looking wrong answer.

---

## 2. `tkb_get_standings` — the whole table, and the answer to a rule we wrote

The stale-fact process added on 2026-08-27 splits every researched fact into two
buckets, and puts records, streaks, standings position and games back firmly in
the DECAYING one that must never be taken from an article. The mechanical test is
"has this team played since this was published", and for MLB or WNBA the answer is
usually yes within hours.

Before this the connector could answer that one team at a time, through
`tkb_get_team_split`. Now it answers it for a whole conference or league in one
call, which is the shape the rule actually demands.

Returns overall, home, road and conference records, win percentage, games back,
streak, and point differential where the provider carries it. Sorted best record
first.

**Point differential is the field worth reading.** An analysis of 26 seasons of
play-by-play found that after roughly six games it was as predictive as any
advanced metric tested. It is far stronger material for a moneyline bullet than a
raw record, which hides margin completely.

**Zero SGO entities.** NCAAF standings sit on BDL's FREE tier.

**CFB requires a conference, and that is not a quirk to paper over.** BDL
documents `conference_id` as required for NCAAF and absent for the league-wide
sports. There are 25 conferences; looping them to answer a question about one
would be 25 throttled requests of waste. Omitting it returns the valid list rather
than an empty table.

`getConferences` is cached for the process lifetime rather than on a TTL.
Conference membership changes at most once a year during realignment, so a TTL
here would be theatre.

---

## 3. `tkb_probe_event_fields` — settling the lineups question

`src/types.ts` states:

> no `lineups` field exists on the event object - confirmed via live test against
> an upcoming game. SGO does not expose probable/confirmed starting pitchers or
> lineups pre-game. Starting pitcher info must come from web search.

SGO's own schema browser describes an Event as carrying "basic information, odds,
results, team info, and **lineups**".

One of those is out of date, and which one matters a great deal. The confirmed
starting-pitcher check is currently a MANDATORY live web search per game per date,
and it exists because a thread once shipped built around Chris Sale on a night he
had been pushed back a day. If `lineups` is real and populated pre-game, that
manual step becomes a connector call. If it is absent, the note is confirmed and
the rule stands exactly as written.

**Either answer is a result.** That is why this probes rather than assumes.

### Why this is not `tkb_debug_raw_event` reborn

v2.0.0 deleted that tool and called it a quota footgun, correctly. It dumped the
event including its odds map, which near first pitch runs past 1,000 markets, and
had to cap the dump at five entries to avoid blowing response limits. It answered
"show me everything", and everything was too much.

This answers a narrower question: which keys exist and what shape are they. It
**never returns the odds map contents, only its size**, and never returns a player
list, only a count. Bounded by construction rather than by a truncation guess.

The verdict is stated three ways, because they mean different things: ABSENT
confirms the note; PRESENT AND POPULATED contradicts it; PRESENT BUT EMPTY means
the key exists and has no data for this event yet, which is not the same as absent
and warrants re-probing closer to kickoff.

---

## 4. The oddID parser was one API change away from lying

SGO documents the oddID structure as:

```
{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}-{bookmakerID}
```

**Six segments.** Every parser here was written against five and slices from the
right, so `parts[last]` is read as the side. `screenProps` has carried that
assumption since it was written, and `propBoard` inherited it in v2.6.4.

Nothing has broken. The keys inside `event.odds` come back in the five-segment
form in every response observed, most recently a correct 27-row CFB board on
2026-08-27. This is latent, not live.

**It is worth hardening anyway.** A six-segment key would make the naive parser
read the BOOKMAKER as the side, the SIDE as the bet type, and the BET TYPE as the
period. All three are plausible strings. Nothing would be malformed and no
guardrail downstream would fire. That is the same "right values, wrong story"
failure this connector has now rediscovered four separate times: the `p_k`
batting/pitching collision, the reversed newest-first array, the unpaginated
ascending pages, and the year-stale hit-rate window.

### How it decides, without counting

`betTypeID` and `sideID` are both drawn from small CLOSED sets. So the new shared
parser in `services/oddIdParser.ts` anchors on those vocabularies instead of
position:

- `parts[n-2]` is a bet type and `parts[n-1]` is a side → five-segment form
- `parts[n-3]` is a bet type and `parts[n-2]` is a side → six-segment, trailing
  segment is the bookmakerID

Matching neither returns `null` rather than a best guess, for the same reason the
BDL name resolver refuses to choose between two players named Marte.

**Both `screenProps` and `propBoard` now share it.** Five-segment behaviour is
byte-identical; six-segment is newly correct.

---

## 5. `tkb_get_game_lines` batches its eventIDs path

v2.6.4 fetched one event at a time there and flagged comma-separated `eventIDs` as
unverified. SGO's best-practices doc settles it outright:

> Use `eventID` by itself for direct lookups. When you already know which event(s)
> you want, query by `eventID` or `eventIDs` — this is the fastest query path.

N requests become 1.

**The documented caveat is worth knowing and is now in the code comment:** when
`eventIDs` is supplied, every other filter is ignored — `leagueID`, `live`,
`startsAfter`, all of it. Only the response-shaping params (`oddID`,
`bookmakerID`, `playerID`) still apply. So you cannot combine `eventIDs` with a
date bound and expect the date to do anything.

Any requested ID that does not come back is now named rather than silently
producing a shorter list than was asked for.

---

## 6. Tests

**9 new, suite now 86.** `parseOddID` is exported and pure, per the v2.6.1 rule.

Five-segment cases are real oddIDs observed live. Six-segment cases are built from
the documented format, since none has appeared in a payload yet — which is exactly
why they need to exist before one does.

**Mutation-tested:** reverting the anchor check to a naive right-slice fails 4
tests.

Also covered: hyphenated statIDs in both forms, combo statIDs (which join with `+`
rather than `-` and are therefore unaffected), yes/no and 3-way sides, and refusal
on unknown bet types and sides rather than inventing a reading.

---

## Deploy

`tsconfig.json` is unchanged and deliberately **not** included. Keep yours.

1. Copy `src/`, `test/`, `docs/`, `README.md` and `package.json` over the repo.
2. `npm test`. **86 passing** before you push.
3. Commit, let Render redeploy.
4. `node scripts/verify-deploy.mjs --expect 2.6.5`

`/health` should report **24 tools**.

Then, in this order, because each answers something the next one depends on:

5. **`tkb_get_rankings sport="cfb"`.** A 401 means the NCAAF BDL subscription is
   not what we think it is and the rankings plan needs rethinking. Anything else
   means the manual `rankedTeams` step is over.
6. **`tkb_get_standings sport="cfb" conference="ACC"`.** Confirms the free-tier
   conference path and the conference-id resolution.
7. **`tkb_probe_event_fields`** on an upcoming MLB game a few hours from first
   pitch. This is the one that could change a standing rule, so use a game close
   to start time — a lineup would not be posted days out even if the field exists.
   Confirm against a SECOND game before changing anything.

Step 7 is the interesting one. Steps 5 and 6 are expected to just work.

---

## Still open, carried forward

- **Tennis is built and blocked upstream**, not missing. SGO's Rookie tier does not
  carry the ATP or WTA leagueIDs; verified live again on 2026-08-27. BALLDONTLIE
  sells ATP and WTA separately with rankings, head-to-head and odds, which is a
  plausible route around SGO entirely for the account's two best-performing lanes
  (WTA 79.4%, ATP 67.6%). Which BDL tier carries odds and H2H needs checking
  before buying.
- **NCAAF player stats remain GOAT-gated** ($39.99/mo). That subscription is what
  ends the early-season CFB no-hit-rate problem, and `team_season_stats` there
  carries `opp_passing_yards` and `opp_rushing_yards` for defensive-matchup
  reasoning.
- **Query parameter count.** SGO says queries are optimised for 1 to 3 params and
  that `startsAfter`/`startsBefore` degrade specifically when combined with
  `bookmakerID`. Several call sites here send five. Worth measuring, not panicking
  about.
- **Period codes** remain unverified for halves and quarters; only `1ix5` was ever
  confirmed.
- **The MLB availability probe may not cover bench players** (Ben Rortvedt, v2.5.4).
- **A market scorecard** feeding published results back into screening is still the
  highest-value remaining item.
