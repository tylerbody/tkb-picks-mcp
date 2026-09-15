# v2.9.6 - the second-source check was gated on a string that never appears

No tools added or removed. Still **28**. Tests: **453 -> 461**.

Found by reading the slate output while verifying v2.9.5. Both fixes in that release
were confirmed working, and the same output showed a third bug underneath them.

---

## The gate

Both graders asked BALLDONTLIE only when:

```ts
finality.label === "unknown"
```

That label is produced **only when `displayShort` is absent**. Measured 2026-09-15 on
an upcoming UFC bout and an upcoming EPL fixture, SGO sends:

```
"statusLabel": ""
```

An EMPTY STRING, not a missing field. So the gate compared `"" === "unknown"`, never
opened, and **the entire second-source cross-check added in v2.8.12 was unreachable
on the exact shape it was built for** - an event SGO has ingested but not yet
labelled.

This is the same empty-string blindness as the cancelled label fixed in v2.9.5, in a
second place, found ten minutes later. `""` and "absent" are not the same value and
this codebase has now conflated them twice.

## And it should never have fired on an upcoming game anyway

Fixing the gate alone would have made things worse. **An unlabelled status is most
commonly an upcoming game**, because nothing has happened yet. Opening the gate on
label alone would spend a BDL request on every future event anyone graded, which on a
slate is dozens of pointless calls, and asking a second feed whether Saturday's fight
is final is a category error rather than a lag.

So the decision moved out of the callers and into `assessFinality`, as
`crossCheckable`, true only when the refusal is genuinely "we cannot tell":

- not final, and
- not cancelled, and
- not affirmatively live, and
- the start time is in the **past**, or unknown, where refusing to guess is the house
  rule.

An upcoming event now also says so in its own refusal - "This event has NOT STARTED
YET (scheduled ...)" - instead of reciting an ingest-lag explanation about a game
that has not kicked off.

**Also fixed:** the refusal printed `status ""` for an unlabelled event. It now reads
`status "none"`.

---

## v2.9.5 verified on the deployed build first

Both fixes confirmed against the real cancelled bouts that produced them:

```
Young vs Steele (displayShort "CANC")   -> result VOID, statusLabel "CANC"
Santos vs Wood  (displayShort "")       -> result VOID, statusLabel "cancelled"
```

The machine-readable field now agrees with the prose, the blank label is gone, and
the slate's `voids` counter reads 1 where it used to read 0 while holding a voided
pick.

The distinction held in both directions, which was the risk worth testing:

| | result |
|---|---|
| cancelled bout | **VOID** |
| upcoming bout (Pantoja vs Van, Sep 19) | **NOT_FINAL** |
| finished bout (de Ridder vs Dolidze) | **WIN** |

Same on the soccer side: an upcoming Brighton vs Arsenal 1X2 stayed NOT_FINAL while
the finished Leeds 4-1 Newcastle graded WIN. No VOID creep onto real pending picks.

Neither cancelled grade spent a BALLDONTLIE request.

---

## Testing

Eight new cases. Mutation-tested, two mutations, two killed:

| mutation | caught by |
|---|---|
| gate always closed | six cases, including the measured empty-string shape |
| upcoming games get cross-checked | the NOT STARTED YET case |
