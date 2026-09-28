# v2.10.6

One fix, to a bug introduced in v2.10.5 and caught on the first live call.

## `allBookPrices` returned nothing on any settled event

v2.10.5 added `bestPrice`, `betterPriceAvailable` and `bookCount` to every prop board
side. The first live call, NHL Boston at Florida, came back like this on every row:

```
over: { americanOdds: "-125", bookmaker: "betmgm",
        bestPrice: null, betterPriceAvailable: false, bookCount: 0 }
```

A selected price, and simultaneously "no books priced this". Hard Rock demonstrably
priced that exact market: filtered to `hardrockbet` alone the same event returns 89 rows.

### Cause

`firstAvailableBook`, which chooses the displayed price, is **two-tier**: it prefers a
book flagged available and falls back to any book carrying odds when none is.

`allBookPrices` had only one tier. It skipped `available === false` unconditionally. On a
**finished market every book is flagged unavailable**, so the fallback tier is the only
one with anything in it, and the new function returned an empty array while the old one
returned betmgm.

### Fix

Mirror the two tiers. Prefer available books; if none are available, fall back to every
book carrying odds. The block list applies on both tiers, so a stale offshore price still
cannot appear.

The invariant that matters: **the candidate pool must match the pool the selected price
came from.** Otherwise `bestPrice` is computed against a smaller set than
`americanOdds`, which is exactly how you get a null best price sitting next to a real
one. There is now a wiring test asserting the book `extractPricedLine` selects is always
present in `allBookPrices` output for the same odd.

## Why the v2.10.5 tests missed it

They hand-built `byBookmaker` entries with `available: true` and asserted on the helper,
and the board test supplied `allBooks` directly rather than letting the push site compute
it. So the helper was correct and **the seam was never exercised.**

That is precisely the failure `test/toolWiring.test.ts` exists to document, repeated by
the author of this changelog one release later. The lesson stands as written there: a
perfect function called in an untested seam produces exactly the bug it was written to
prevent.

## Tests

Four added to `test/v2_10_5.test.ts`, covering a fully-unavailable market, the block list
on the fallback tier, mixed availability (a stale longer price must NOT win bestPrice),
and the pool-matches-selection wiring invariant. Suite 631 to 635, all passing.

| Mutation | Result |
|---|---|
| Restore the unconditional `available` skip (the shipped bug) | 2 of 20 fail |
| Always use the fallback tier, ignoring availability | 3 of 20 fail |
| Restored | 20 of 20 pass, file byte-identical |
