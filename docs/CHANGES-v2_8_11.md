# v2.8.11 - two of twenty-seven tools had no top-level error handling

No tools added or removed. Still **27**. Two behavioural fixes, both found by a test
that did not exist a day ago.

---

## 1. What the sweep found

`tkb_screen_props` and `tkb_get_cover_player` had **no top-level try/catch**. Their
first upstream call sat outside any guard:

```ts
async (input) => {
  ...
  const events = await sgo.getAllEvents({ leagueID, eventIDs: input.eventID });
```

So an SGO failure did not become a message. It escaped the handler, and the caller
got a protocol-level error with nothing actionable in it. Every other one of the 27
tools wraps its body; these two were the exceptions, and nothing had ever exercised
the path.

**This is a condition that happens, not a hypothetical.** This repo's own notes
record CFBD returning 502 on two consecutive calls, and BDL rate-limiting 217 of 235
requests in a single screen. `tkb_screen_props` is the most-used tool in the
thread-building workflow, so it is the worst one to lose silently.

Both now return a readable refusal that says what failed, states that nothing has
been established about the event, and points at `tkb_get_api_usage` for a quota wall.
The distinction matters: an outage and an empty board look identical from the outside,
and only one of them means "there are no markets here".

---

## 2. The test that found it

v2.8.10 added `toolWiring.test.ts` covering four handlers after a correct function
shipped into a dead branch. This extends it to **all 27**, under three conditions.

**Inputs go through each tool's own Zod schema.** `inputSchema.parse()` runs before
the handler, so defaults apply exactly as in production. v2.8.10's harness supplied
defaults by hand and would not have noticed one being renamed or removed. Parsing
also asserts the example input is something a caller could really send, which caught
five of my own examples being invalid before any of them reached a handler.

| Sweep | Condition | Asserts |
|---|---|---|
| 1 | Normal responses | No crash leaks, non-empty answer |
| 2 | **Every upstream call throws** | Same. This is the one that found the bug |
| 3 | Event exists with no odds and no players | Same |

The universal assertion is that **no tool may surface an internal crash to its
caller**. A response reading `Cannot read properties of undefined (reading 'trim')`
is not an answer, it is a stack trace wearing a sentence, and this connector's whole
premise is that an unanswerable question gets a refusal instead of a plausible-looking
wrong one. A TypeError is neither.

Suite is now **305 tests, 305 passing**, of which 86 are wiring.

### Mutation-tested, including one that failed to catch

| Mutation | Result |
|---|---|
| Remove the `screenProps` guard (the shipped state) | **1 of 86 fails** |
| A reached code path returns an empty message | **3 of 86 fail**, one per sweep |
| An empty message on an UNREACHED branch | **not caught** |

That third row is recorded deliberately rather than omitted. **The sweep is breadth,
not branch coverage.** It drives one input per tool against three client conditions,
so it will catch a handler that cannot survive an outage and will NOT catch a wrong
string in a branch that one input never reaches. Claiming otherwise would make it the
kind of test that produces false confidence, which is worse than a gap you can see.

It also found a gap in itself: the non-empty assertion originally lived only in
sweep 2, so an empty happy-path response would have shipped. It now lives in the
shared runner and all three sweeps inherit it.

---

## Files changed

```
src/tools/screenProps.ts     top-level try/catch
src/tools/coverPlayer.ts     top-level try/catch
test/toolWiring.test.ts      three sweeps across all 27 tools
src/index.ts                 SERVER_VERSION 2.8.11
package.json / package-lock.json
```

---

## Deploy

1. Commit, redeploy. `npm test` must read 305 passing first.

### Verify, control FIRST

A guard that is too broad swallows real results, and that failure looks like a dead
tool rather than a strict one.

```
tkb_screen_props sport="mlb" eventID="<a real event>"
```

Must return a normal board. **If it now returns an error on a working event, stop.**

```
tkb_get_cover_player sport="nfl" eventID="<a real event>"
```

Must return a normal cover-player answer.

The outage path cannot be triggered on demand. It is asserted in the suite instead,
which is the point of having the suite.

---

## Still open, carried forward

- **The closing line.** `closeOverUnder` and `openOverUnder` exist under
  `byBookmaker.<book>`; `closeBookOverUnder` and `openBookOverUnder` at top level.
  NAMES confirmed, VALUES not. One probe on two events settles it and unblocks both
  the graders and `tkb_get_line_movement`.
- **Branch coverage inside handlers.** The sweep proves every tool survives three
  conditions; it does not prove every branch is correct. The empty-result branches in
  particular carry a lot of this connector's meaning and are reached by only some
  inputs.
- The four dead tool files, `DEPLOY-CHECK.md`, the duplicated changelogs, the stale
  root `index.ts` at 2.5.3, and a `_to_delete/` folder this session could not remove.
