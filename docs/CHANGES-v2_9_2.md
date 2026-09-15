# v2.9.2 - two soccer bugs, both found by grading one real Premier League result

No tools added or removed. Still **28**. Tests: **415 -> 426**.

Both of these were found the same way: deploy v2.9.1, point it at a match that had
actually been played, and read what came back.

---

## 1. A THREE-WAY MONEYLINE HAS NO LINE

Leeds United 4-1 Newcastle United, `marketType="moneyline_3way"`, `side="home"`:

```
NOT GRADED - no postedLine was supplied for this moneyline_3way.
```

A 1X2 price does not have a line. The postedLine guard exempted `"moneyline"` by
exact string match, and the new market type fell on the wrong side of it.

**Every soccer three-way grade through `tkb_grade_pick` was impossible**, which is
the main thing the soccer work in v2.9.0 was built for, while every unit test on the
grading maths passed. The maths was never wrong. It was unreachable, sitting behind
a guard written before the market type existed.

Same shape as the v2.8.9 regression that `test/toolWiring.test.ts` was created for:
a correct function in a branch that cannot be reached. That file now covers this
case too, including the control that a TOTAL still demands its line.

**Also fixed alongside it:** `moneyline_3way` on a sport with no draw outcome now
refuses **by name**. It previously fell through to the postedLine check and was
refused for the wrong reason, sending the reader hunting for a line that does not
exist on a market that does not exist.

---

## 2. SOCCER WRITES "FT", AND THE FINALITY CHECK COULD NOT READ IT

Every finished match measured live across EPL and UCL on 2026-09-14:

```
FT        a normal result
F (ET)    decided in extra time
```

`displaySaysFinal` matched `"f"`, `"f "`, `"f/"` and `"final"`. So `F (ET)` matched
on the `"f "` prefix and **`FT` matched nothing at all**.

It did not break grading on the day - the Leeds total graded correctly, WIN on
actual 5 goals against 2.5 - because SGO also set `completed: true` on those events.

**That is precisely why it was worth fixing rather than noting.** `completed` is the
field this entire file exists because SGO was measured LAGGING: on 2026-09-12 an
in-progress CFB game came back from a finalized-only query with the flag unset. On a
soccer match where it lagged the same way, the status string would have been the only
remaining evidence the match had ended, and it was unreadable. The failure would then
have been a refusal to grade finished matches - visible, but on a Saturday, at
volume.

`FT` and `AET` now match, anchored exactly like every other pattern here, so
`"Forfeit pending"` and `"Draft"` still do not.

---

## What the live check CONFIRMED working

The v2.9.1 fix landed. `tkb_check_league_access` on the deployed build:

```
EPL   recent 25  upcoming 10  -> reachable
UCL   recent 25  upcoming  0  -> reachable (calendar gap)
UFC   recent 25  upcoming 16  -> reachable
CBB   recent  0  upcoming  0  -> nothing either direction
```

- **EPL**: 21 fixtures with venues, and real prices on `points-home-reg-ml-home`.
- **UCL**: 30 events including the Sep 8-10 league-phase matchday (Real Madrid 2-1
  Inter, Liverpool 2-1 Atletico, Bayern 5-0 Bodø/Glimt). The empty forward window is
  a genuine calendar gap between matchdays, which is now distinguishable from an
  access problem rather than guessed at.
- **UFC**: real cards, venues and fighter names.
- **CBB**: silent, which is correct. The season tips in November.

The period routing is confirmed end to end: match lines resolved on `reg`, and an
EPL total settled correctly from a `reg` market.
