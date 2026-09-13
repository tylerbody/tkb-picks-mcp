# v2.8.10 - the v2.8.9 fix was unreachable in the one tool it was reported against

No tools added or removed. Still **27**. Two files changed, one new test file.

This release exists because v2.8.9 shipped a correct function into a dead branch and
its nine passing tests could not see it.

---

## 1. What broke

v2.8.9 added `diagnosePlayerIdMiss` and wired it into four tools. Verified against the
live build on 2026-09-13:

```
tkb_get_line_movement  playerID=CALEB_WILLIAMS_1_NFL
  -> "NO SUCH playerID ON THIS EVENT ... CHRIS_WILLIAMS_1_NFL -> Caleb Williams"   WORKS

tkb_get_odds           playerID=CALEB_WILLIAMS_1_NFL
  -> "No market found for CALEB_WILLIAMS_1_NFL OVER Passing Yards on this event.
      It may not be offered for this game."                                        DEAD
```

Three of four worked. `tkb_get_odds`, the tool the bug was originally reported
against and the one most likely to be called, was the one that did not.

### The cause

```ts
const detail = unpricedReasons.length
  ? unpricedReasons.join("\n\n")
  : (idDiagnosis ?? "No market found for this selection on this event.");
```

The diagnosis sat in the else-branch of `unpricedReasons.length`. **That branch never
runs on the case it was built for.** A missing market pushes one unpricedReason PER
SIDE, over and under, so the list is always non-empty and the diagnosis was
unreachable in exactly the situation it exists to answer.

### The fix

Appended rather than substituted. The per-side reasons and the ID diagnosis answer
different questions - "this side is unpriced" versus "this player is not on this
event" - so the reader gets both rather than whichever branch happened to win.

---

## 2. The real lesson, and the new test file

`test/playerResolution.test.ts` had nine passing tests over the pure function, and
every one of them still passed against the broken build. **The function was fine. The
call site was not, and nothing in the suite could see a call site.**

This repo has repeatedly drawn one conclusion from its failures: extract the pure
logic so it can be asserted without a network. v2.6.1 stated it, and v2.6.3, v2.7.0,
v2.8.4 and v2.8.5 each restated it. v2.8.4 went as far as writing:

> "None ship here, since `searchPlayers` needs an HTTP client and the suite is
> network-free."

**Extracting the pure part is necessary and it is not sufficient.** A perfect function
called in an unreachable branch produces exactly the bug it was written to prevent,
and leaves a green suite behind while doing it.

### `test/toolWiring.test.ts`

The seam every previous release left bare, covered for the first time. A tool's
`register*` function takes an McpServer and a client, and both are just objects:

- a fake server that captures the handler
- a fake client that returns one fixed event
- call the handler, assert on what a caller actually receives

No network, no SDK, no mocking framework. Five tests: all four tools must name
`CHRIS_WILLIAMS_1_NFL` on a wrong-ID lookup, plus a control asserting that a CORRECT
playerID still returns the real 229.5 line and is never intercepted by the diagnosis
path. That control is the one that matters most, because an over-eager diagnosis
would block every prop pull rather than one.

The event fixture is the real Bears @ Panthers roster, not an invention.

**One deliberate wrinkle, recorded because it will bite the next person:** calling a
handler directly bypasses Zod, so schema defaults are NOT applied. `odds.ts` and
`lineMovement.ts` both call `.trim()` on `preferredBookmakers` unconditionally, which
throws when the default is absent. The test supplies defaults explicitly rather than
working around it, which keeps it honest about what the tool actually depends on.

### Mutation-tested

Restoring the exact v2.8.9 wiring fails the suite:

| Mutation | Result |
|---|---|
| Diagnosis as the else-branch (the shipped v2.8.9 bug) | **1 of 5 fails** |

That is the assertion this release is really about: the test now catches the thing
that got past everything else.

Suite is now **224 tests, 224 passing**.

---

## Files changed

```
src/tools/odds.ts             diagnosis appended, not a fallback
test/toolWiring.test.ts       NEW
src/index.ts                  SERVER_VERSION 2.8.10
package.json / package-lock.json
```

---

## Deploy

1. Commit, redeploy. `npm test` must read 224 passing first.

### Verify

**Control first.** A correct playerID must be untouched:

```
tkb_get_odds sport="nfl" eventID="Nw0i5lD1IafZ0HlX842y" marketType="player_prop"
             playerID="CHRIS_WILLIAMS_1_NFL" marketLabel="Passing Yards"
```

Must return 229.5 at -112. If this errors, stop.

**Then the case:**

```
tkb_get_odds sport="nfl" eventID="Nw0i5lD1IafZ0HlX842y" marketType="player_prop"
             playerID="CALEB_WILLIAMS_1_NFL" marketLabel="Passing Yards"
```

Must now name `CHRIS_WILLIAMS_1_NFL` and "Caleb Williams". On 2.8.9 it said only
"No market found ... It may not be offered for this game."

---

## Still open, carried forward

- **A real closing line exists and is still not built on.** `closeOverUnder` and
  `openOverUnder` under `byBookmaker.<book>`; `closeBookOverUnder` and
  `openBookOverUnder` at top level. NAMES confirmed, VALUES not.
- **Other tool wiring is still untested.** This file covers four handlers. The same
  three-line fake-server pattern would cover `screenProps`, `propBoard`, `hitRate`
  and the rest, and on this evidence that is worth doing before the next feature
  rather than after the next bug.
- The four dead tool files, `DEPLOY-CHECK.md`, the duplicated changelogs and the
  stale root `index.ts` declaring 2.5.3.
