# v2.9.5 - a cancelled event is VOID, and the response used to say both

No tools added or removed. Still **28**. Tests: **445 -> 453**.

One labelling bug, found by grading a real cancelled UFC bout while verifying v2.9.4.

---

## The response contradicted itself

Measured 2026-09-15, Young vs Steele, a bout that was cancelled off the
August 22 card:

```
result: "NOT_FINAL"
detail: "This event is marked CANCELLED. There is no result to grade and the
         pick had no action, so it belongs in the tracker as Void rather than
         as a Hit or a Miss."
```

The prose was right. The machine-readable field disagreed with it.

**Anything consuming `result` files that pick as ungraded and waits for a game that
is never coming** - a tracker, a rollup, the slate summary's own `voids` counter,
which sat at 0 while a voided pick was in the response. A human reading the sentence
underneath files it correctly. One response, two answers, and the wrong one is the
one a machine reads.

`NOT_FINAL` means "ask again later". A cancelled event will never be final, so it
was never the right verdict. `assessFinality` now carries a `cancelled` flag and both
graders map it to **VOID**.

The distinction is the point, and it is tested in both directions: widening VOID to
cover every ungraded event would log real pending picks as no-action, so an ordinary
unfinished game still returns NOT_FINAL.

**Also fixed:** an empty `displayShort` reported a blank status label. The fallback
only caught the literal string `"unknown"`, and a cancelled fight measured the same
day carried `displayShort: ""`. An empty label is as unlabelled as a missing one.

---

## What the v2.9.4 verification actually proved

`status.finalized` is live and firing, and the proof is an absence.

The new `ended` branch grades but attaches a note saying the result is not yet
finalised and can still be revised. Across five graded MLB picks and four UFC picks
on finished events, **not one carried that note**. The only path that produces a
clean grade with an empty reason is `finalized === true`. So SGO does populate the
field, it was true on every settled event tested, and the branch that reads it is
reached before the older display-string matching.

A probe of a settled MLB event confirms the shape: `status` carries **18 keys**,
which is exactly the documented set including `finalized`.

Also verified on the deployed build:

- **MLB**: 5 picks across 3 events, moneylines and totals all correct, 3 event
  fetches for 5 picks.
- **UFC**: moneylines grade correctly off the winner's score of 1. A cancelled bout
  refused, and **spent no BALLDONTLIE request** - `secondSourceChecked: false` -
  because the cross-check is only allowed to move an unknown status, never to
  overturn affirmative information.
- **CFBD quota text** corrected in `tkb_get_api_usage`, now naming the published
  1,000/3,000 figures and pointing at `GET /info` for `remainingCalls` and `resetAt`.

---

## One deploy item, unrelated to this release

`tkb_get_api_usage` reports **`CBBD_API_KEY` is not set**. College basketball hit
rates will refuse until it is added to the Render environment. That is by design - a
missing key refuses rather than falling back to a source that cannot answer - but the
season tips in November and the key is free at collegebasketballdata.com/key.

---

## Testing

Eight new cases. Mutation-tested, three mutations, three killed:

| mutation | caught by |
|---|---|
| drop the `cancelled` flag | four cases, service and both graders |
| every ungraded event becomes VOID | the still-NOT_FINAL case |
| empty label falls back to blank again | the empty-displayShort case |
