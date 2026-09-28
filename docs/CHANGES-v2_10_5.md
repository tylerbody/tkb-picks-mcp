# v2.10.5

The books were there the whole time. Two separate things made a fully priced book look
absent, and the second was caught by comparing the board against the Hard Rock app.

---

## 1. The default book list was missing three regulated books

`DEFAULT_BOOKMAKERS` went from five to eight:

```
draftkings,fanduel,betmgm,caesars,hardrockbet,betrivers,espnbet,ballybet
```

BetRivers, ESPN Bet and Bally Bet are regulated US books and were in **no block list**.
They were simply absent from the string, so every prop tool filtered them out silently.

### Measured, NHL Boston at Florida, eventID `QRDNo27CIPW3UiHjAzAV`

| Book filter | Priced rows |
|---|---|
| old five | 80 |
| disabled | **102** |

Not just a row count. `Goals` at line 0.5, which is anytime goalscorer in over/under
form, came back **one-sided** under the old list (longshot overs, no under, so the devig
gate could never run) and **two-sided** once ESPN Bet was visible, because ESPN Bet is
what prices the under.

The four block lists are untouched. Pick'em apps, Fliff, prediction markets and offshore
books each stay blocked for their own documented reason. This adds regulated venues that
were never blocked; it does not relax a block.

---

## 2. THE REAL ONE: `firstAvailableBook` discards the rest of the market

`extractPricedLine` reports ONE price per side, chosen by `firstAvailableBook`, which is
whichever entry SGO returned first among the books that pass the filter. **It is not the
best price and it is not a stable choice.**

### The Hard Rock case, measured

Filtered to `hardrockbet` alone, that same NHL event produced **89 rows across 15
players and six markets**: Assists, Goals, Points, Power Play Points, Shots On Goal,
Saves. On the multi-book board Hard Rock appeared on almost nothing.

Nothing was missing from the data. Other books kept winning the display slot. The board
implied Hard Rock had no NHL prices while those prices were visible in the Hard Rock app,
which is the more misleading of the two problems here and was reported from exactly that
observation.

### The second consequence: the account was accepting worse prices

Taking an arbitrary book instead of the best available one is a standing drag on every
pick, and it interacts with the -125 to -200 band in gates draft 10933588: whether a prop
clears the floor at all could depend on which book happened to be returned first.

### What shipped

New `allBookPrices(odd)` in `oddsPricing.ts`, returning every real book's price on an
odd, **ordered by value to the bettor** (American odds descending, since a longer price
is better on either side of an over/under). Every entry still passes `isRealBookmaker`,
so no blocked venue can appear even when it holds the best number. Entries flagged
`available: false` and entries with no price are skipped, and the line comes from the
same book as the price.

`tkb_get_prop_board` now reports per side, always:

| Field | Meaning |
|---|---|
| `bestPrice` | the best price any real book has, with its book and line |
| `betterPriceAvailable` | true when the displayed book is not the best one |
| `bookCount` | how many real books priced this side |

And on request, via the new `includeAllBooks` flag, the full `allBooks` array. It is off
by default only because it multiplies payload size; the three fields above are always
present, so a caller can never accidentally publish a worse number without the data
saying so.

### What deliberately did NOT change

**The selected price is untouched.** Flipping the default selection to best-price would
change the output of every tool at once, and that is the owner's call rather than a side
effect of a visibility fix. There is a regression test asserting the selection is
unchanged; if that decision is ever made, that test is the one that fails and forces it
to be explicit.

---

## Tests

`test/v2_10_5.test.ts`, 16 tests. Suite goes 615 to 631, all passing.

### Mutation tested

| Mutation | Result |
|---|---|
| Revert the book list to five | 2 of 16 fail |
| Make `allBookPrices` ignore the block list | 2 of 16 fail |
| Drop the best-first sort | 1 of 16 fail |
| Always emit `allBooks`, ignoring the flag | 1 of 16 fail |
| Restored | 16 of 16 pass, all three files byte-identical |

### A test-only mistake worth recording

The first version of the book-list test used `DEFAULT_BOOKMAKERS.includes("betr")` and
reported that the pick'em app `betr` was in the default list, because **"betr" is a
substring of "betrivers"**. The list is a comma-separated set of exact bookmakerIDs and
has to be compared as tokens. The source was never affected: the block lists are Sets and
use `.has()`, which is exact.

It is the same substring-versus-exact confusion behind the market-label failures in
`claude/market-label-contract.md`, so the reason is written into the test file rather than
quietly fixed.
