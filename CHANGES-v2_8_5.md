# v2.8.5 — `tkb_verify_roster`, because the odds feed had a player on the wrong sideline

One tool added, **26 to 27**. One new file plus registration. No existing behaviour
changed, nothing removed or renamed.

---

## The bug this exists to catch

Measured 2026-08-31 on the Baylor @ Auburn board. `tkb_get_prop_board` returned a
priced Touchdowns market for **Bryson Washington under team "Baylor"**. He transferred
to Auburn in January 2026 and is on Auburn's published depth chart. Screening that
market and writing it up would have put a player on the wrong sideline in a published
thread.

## Why every existing guardrail passed

This is the part that makes it worth a tool rather than a rule.

1. `tkb_get_prop_board` reports SGO's team field verbatim. It has no second opinion.
2. `tkb_get_player_hit_rate` keyed to **Baylor** returns a clean, fully populated,
   `sampleSufficient: true` sample — 12 games summing to exactly 788 rushing yards,
   matching independent reporting. Because he really did play there last season.
3. Keyed to **Auburn** it returns `NO SAMPLE`, which is the correct refusal. But that
   only fires if you already knew the right team, which is the thing being asked.

So SGO's stale field and CFBD's season-keyed history **agree with each other**, and the
agreement is a coincidence of the player having genuinely played at the named school.
Nothing is malformed. Nothing errors. Same family as the `p_k` collision and the
reversed newest-first array: right values, wrong story.

---

## Set membership, not identity resolution

BALLDONTLIE returned **three** exact "Bryson Washington" matches: ids 43426 (Western
Kentucky), 47333 (Oklahoma), 54512 (Auburn). Deciding which is the right person is the
"Marte" problem from v2.0.1, and this connector's standing answer is to refuse rather
than guess.

**This tool asks an easier question and therefore does not need to.** Does *any* player
by this name appear on the team the feed claims? SGO said Baylor. None of the three rows
says Baylor. That is a flag, and it is correct without ever resolving identity.

That reframing is why the tool is buildable at all. My earlier scoping treated it as a
roster-join problem, which on two providers with no shared ID space is genuinely hard
and is what v2.8.2 spent three releases getting wrong on MLB.

---

## Exact matching only. No containment.

`findStandingForTeam` falls back to substring containment, which is right there — a miss
only blanks a column. Here a false CONFIRMED **hides** a wrong-team pick, so the trade
runs the other way.

Containment is specifically lethal in college football. "Miami" contains and is
contained by "Miami (OH)". "Texas" by "Texas State" and "Texas Tech". "Washington" by
"Washington State". Every one of those is two different programs that play each other,
and two of those pairs are on the current Week 1 board.

So matching is exact against a normalised candidate set: `college`, `name`, `full_name`,
`short_display_name`, `abbreviation`, `location`, and both composed forms. `college` is
the load-bearing one for NCAAF, where SGO says "Baylor" and BDL's `full_name` is
"Baylor Bears".

---

## What it deliberately will not do

**It never rewrites the team.** It reports a disagreement and stops. v2.8.2 is the
precedent: a roster-resolution feature took three consecutive releases to stop producing
confident wrong answers, each one right about its own case and wrong about the case
beside it. A silent correction that is itself wrong is worse than the error it replaces.

**It never confirms availability.** CONFIRMED means "a player by this name is listed on
this team." Not that he starts, is healthy, or will play. CFB depth-chart confirmation
stays manual, because CFBD lists a player only where he recorded a stat and cannot
separate a DNP from a quiet game.

**It distinguishes truncation from absence.** `searchPlayers` returns `truncated`
(v2.8.4), and a truncated search returns `INCONCLUSIVE_TRUNCATED`, never `MISMATCH`.
Absence is not evidence of absence when the pages read are the oldest ones. Getting this
wrong is precisely how v2.8.3 shipped a false claim about the NCAAF index.

---

## Verdicts

| Verdict | Meaning |
|---|---|
| `CONFIRMED` | A player by this name is listed on that team. Team field only. |
| `MISMATCH` | Nobody by this name on that team, but the name exists elsewhere. Do not publish. |
| `NAME_NOT_FOUND` | Not in the index on any team. Usually a spelling difference. |
| `INCONCLUSIVE_TRUNCATED` | Page cap reached. Proves nothing either way. |

The highest BDL id among candidates is surfaced as **context only**, since ids are
assigned in ingest order and Auburn's 2026 intake clusters around 54xxx (Jeremiah Cobb
54445, Bryson Washington 54512). It is explicitly not used to decide the verdict.

---

## Cost

One paginated player search, throttled at 1100ms per page, exiting on the first page
with an exact match. Cached 15 minutes per name by `BDLClient`, so re-checking inside one
build is free. **Zero SportsGameOdds entities.**

---

## Tests

`assessRosterMatch` is exported and pure — it takes candidate rows and a team string and
returns a verdict, with no API client anywhere near it. That follows the rule v2.6.1
learned and v2.6.3, v2.7.0 and v2.8.4 restated: logic that decides which data reaches the
user is correctness logic and must be assertable without a network.

Cases worth pinning, built from the real 2026-08-31 rows rather than fixtures:

- Three Bryson Washingtons, expected "Baylor" → `MISMATCH`
- Same three, expected "Auburn" → `CONFIRMED`
- Expected "Miami" against a "Miami (OH)" row → `MISMATCH`, **not** confirmed. This is
  the containment trap and is the single most important assertion here.
- Empty candidates with `truncated: true` → `INCONCLUSIVE_TRUNCATED`
- Empty candidates with `truncated: false` → `NAME_NOT_FOUND`

**Mutation test:** swapping exact matching for `includes()` must fail the Miami case. If
it does not, the test proves nothing — see v2.6.4, where a combo-statID test passed
against a deliberately broken parser.

---

## Deploy

`src/index.ts` here is built from the **2.8.2** file, with two additions (the import and
the registration) and `SERVER_VERSION` set to `2.8.5`. If you edited `index.ts` for the
2.8.3 or 2.8.4 version bumps, diff before overwriting — the only difference should be
that constant.

1. Copy both source files over the repo.
2. Bump `version` in `package.json` to `2.8.5`.
3. `npm test`. 149 expected, unchanged — nothing here touches an asserted path.
4. Commit, redeploy.

### Verify, control case FIRST

**Control — a correct attribution must NOT flag.** A false positive here is not a safe
error; it trains the reader to ignore the flag, which is the v2.5.0 argument about the
IRREGULAR flag firing on Cam Schlittler.

```
tkb_verify_roster sport="cfb" playerName="Jeremiah Cobb" expectedTeam="Auburn"
```

Must return `CONFIRMED`. If a correctly-attributed player flags, stop.

**Then the case this exists for.**

```
tkb_verify_roster sport="cfb" playerName="Bryson Washington" expectedTeam="Baylor"
```

Must return `MISMATCH`, listing Western Kentucky, Oklahoma and Auburn.

```
tkb_verify_roster sport="cfb" playerName="Bryson Washington" expectedTeam="Auburn"
```

Must return `CONFIRMED` on the same data. Both directions, same input, opposite answers —
that pair is the real proof.

`/health` should report **27 tools**. Per v2.6.6, confirm behaviourally rather than by
reading the version string, since `/health` has been served stale from cache before.

---

## Workflow change this enables

Run `tkb_verify_roster` on any CFB or NFL prop where the player's team has not been
independently confirmed, before the hit rate rather than after. In early-season college
football that is effectively every prop: boards are built from last season's rosters and
portal movement is heavy. Auburn alone had more than 30 players enter the portal this
offseason.

It does **not** replace the manual depth-chart check. It answers "is he on this team",
which is a different question from "will he play", and only the first one is automatable
right now.

---

## Still open, carried forward

- **`tkb_get_line_movement` is half-broken.** `openOdds` resolves, `openOverUnder` and
  `openSpread` do not, so it returns an opening price with no opening number. It also
  accepts no `preferredBookmakers` and priced a test off BetOnline. Both wait on one live
  call with `includeOpenCloseOdds=true`, which also settles the real closing line for the
  graders (v2.8.3 section 1).
- **`preferredBookmakers` is still not passed by the nightly prompts.** Open since
  v2.5.3, seven releases. One argument in three scheduled tasks, no code, no deploy.
- **Whether the three Bryson Washington rows are three people or one ingested three
  times.** Set membership works either way, but it decides whether a stale row could ever
  make a MISMATCH read as CONFIRMED. Worth settling before this check is trusted
  unattended in a nightly job.
- The four dead tool files, `DEPLOY-CHECK.md`, and the three cumulative 2.8.x changelogs
  still need cleaning up.
