# v2.10.3

One fix. `tkb_get_line_movement` silently refused to find moneylines and spreads
that were present in the data, because its single `side` parameter defaults to a
value that is meaningless for those two market types.

## The defect

`side` is one parameter serving four market types with two different vocabularies:

| marketType | sided by | valid `side` |
|---|---|---|
| `total` | over/under | `over`, `under` |
| `player_prop` | over/under | `over`, `under` |
| `moneyline` | team | `home`, `away` |
| `spread` | team | `home`, `away` |

The schema default is `"over"`. For ml and sp the handler derives `entity` from
`side`, so a defaulted moneyline call built the oddID:

```
points-over-game-ml-over
```

No such market exists, so SGO answered `No market found for
points-over-game-ml-over`. That message names the oddID, but it reads as "this
event has no moneyline" and a caller moves on. The moneyline was there.

### Measured

NHL Boston at Florida, eventID `QRDNo27CIPW3UiHjAzAV`, a finalized 2026-04-02
event, reachable because the SGO key is now on the Pro plan and SGO gates
historical data to Pro and AllStar.

```
marketType="moneyline", no side    -> "No market found for points-over-game-ml-over"
marketType="moneyline", side=home  -> openingOdds +120, openingBookmaker draftkings
                                      currentOdds -20000
```

**SPREAD HAD THE SAME DEFECT** and had never been reported, because a spread is the
market a caller is most likely to hand a side to anyway. The same guard fixes it.

## The fix

A guard in the handler, running in both directions, before the oddID is built:

- `moneyline` or `spread` with `side` of `over` or `under` is refused, naming
  `home` and `away`, and saying explicitly that this is a bad argument and NOT
  evidence the event lacks that market. When the offending value is `over` the
  message also says it is the schema default, so the caller knows why they hit it.
- `total` or `player_prop` with `side` of `home` or `away` is refused the same way,
  naming `over` and `under`.

The `side` description in the schema now states the per-marketType vocabulary.

### Why a guard rather than a smarter default

Defaulting a moneyline to `home` answers a question the caller did not ask, and on
a two-sided market that is a coin flip dressed as an answer. This repo refuses
rather than returning a plausible wrong answer. One retry costs the caller almost
nothing; a wrong side costs a pick.

## What this release deliberately does NOT change

**The oddID construction is untouched.** SGO's `llms-full.txt` gives a spread
example as `points-home-game-sp-ov`, while this connector builds
`points-home-game-sp-home`, which is what `gameLines.ts` has used against live data
since v2.8.x and which works. That discrepancy is real and unresolved. The guard
rejects bad arguments before an oddID is built, so this fix does not depend on
resolving it, and the question stays open rather than being silently decided by a
change made for another reason.

Also unchanged: pricing, book filtering, the block lists, and the v2.10.2 rule that
a line and its price come from the same bookmaker.

## Tests

`test/v2_10_3.test.ts`, 8 tests. Suite goes 589 to 597, all passing.

Coverage includes both refusal directions, the message content a caller depends on,
the real attributed open on the fixed path, that `away` is accepted as readily as
`home`, that a total on the default side is untouched, and that the pre-existing
`player_prop` argument guard is not shadowed by the new one.

### Mutation tested

| Mutation | Result |
|---|---|
| Delete the team-sided guard | 2 of 8 fail |
| Disable the over/under guard | 2 of 8 fail |
| Restored | 8 of 8 pass, file byte-identical to the shipped version |
