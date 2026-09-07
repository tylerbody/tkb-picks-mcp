# v2.5.3 — price against your books, and see when a sample is stale

One new file, three edited, plus the version bump. No tools added, removed or renamed.
Every change is additive: with no new arguments passed, behaviour is identical to v2.5.2.

---

## 1. `preferredBookmakers` on `tkb_screen_props`

**The problem, measured 2026-08-19.** `screen_props` never sent `bookmakerID` on its event
fetch, and `firstAvailableBook()` in `oddsPricing.ts` simply takes the first entry it finds in
`byBookmaker` with no preference ordering. So the price attached to every screened prop was
effectively arbitrary. Five of the top six MLB props came back priced by Bovada, Hard Rock,
ESPN Bet and Fliff.

**Why that is worse than cosmetic.** Edge is computed from that price, so the RANKING is built
on numbers you will never bet. Re-pulling the same two props at the regulated books:

| Prop | screen showed | your books | effect |
|---|---|---|---|
| Chisholm TB U1.5 | -182 (Fliff) | -179 (Caesars) | negligible |
| Rice TB U1.5 | -145 (Fliff) | **-128 (DraftKings)** | edge **understated** by 3 pts |

Note the direction. The Underdog case in v2.5.0 inflated edge; this one deflated it. An
unbettable price does not bias the board consistently, it just makes the sort untrustworthy.

**The change.** Optional comma-separated `preferredBookmakers`, threaded into the event fetch.
Odds, break-even and edge then all reflect an obtainable number, the mandatory re-pull becomes
a confirmation rather than a correction, and the candidate list shrinks, which speeds up the
sweep and buys back headroom against the 60s tool ceiling.

Recommended: `"draftkings,fanduel,betmgm,caesars"`. FanDuel is kept in the list deliberately -
every single WNBA prop screened on 2026-08-19 was priced by FanDuel, so dropping it would have
emptied that board.

**Existing callers are unaffected.** Omit the argument and the fetch is unchanged.

## 2. Within-season staleness (`services/sampleRecency.ts`, new file)

`seasonBoundary.ts` catches a sample reaching into a PRIOR season. It cannot see a sample that
is stale inside the current one, because every date belongs to the same year.

**Caught live.** Chris Bassitt screened 8 of 10 on strikeout unders with `seasonWarning: null`.
His counted starts: 8/14, then 6/03, 5/28, 5/22, 5/16, 5/10. One start inside the last 30 days,
a 72-day hole in the middle, a 96-day span for what a healthy starter covers in about 50. Every
number correct, the story three months out of date. Same failure class as the reversed-array
bug in v2.1.0.

**Four signals, because one is not enough.** A plain "how many in the last 30 days" misses a
player who played last night but has a six-week hole mid-sample. Each catches a different shape,
and the warning names which fired:

- `appearancesLast30Days` vs total counted — sample is mostly old
- `largestGapDays` — sample straddles an absence
- `daysSinceMostRecent` — has not been in a game lately
- `sampleSpanDays` — context, never flags on its own

Starting pitchers get widened tolerances (30-day gap, 14 days since last) so normal rotation
rest does not false-positive, the same exemption logic the availability probe already uses.

**A WARNING, NOT A FILTER**, per the account owner's call. A stale sample is not automatically
a bad bet. Bassitt's under may well be right; what it cannot be is written as "in his last 10
games" without saying when those were. `screen_props` surfaces `sampleIsStale`, `stalenessNote`
and `daysSinceMostRecentGame`; both aggregators append the prose to `sampleWarning`.

**Costs nothing.** Every date was already in the log. Pure post-processing, no extra request,
no entity spend.

**Verified against six cases before shipping**, four of them real players from live testing:

| Case | flagged | correct |
|---|---|---|
| Bassitt, 1 of 6 in 30d, 72-day gap | STALE | yes |
| Collier, 21 DNPs but 9 straight since returning | clean | yes, counted games are current |
| McBride, 10 of 15 in 30d | clean | yes |
| Grisham, everyday player | clean | yes |
| Mid-sample 46-day hole, played last night | STALE | yes, gap check alone caught it |
| Healthy starter on normal 5-day rest | clean | yes, no false positive |

The Collier case is the important one: staleness and the IRREGULAR play-rate flag answer
different questions. IRREGULAR asks "will she play tonight". Staleness asks "is this sample
describing now". She fails the first and passes the second, correctly.

Note one deliberate gap: a player who is available but simply has not featured for about a week
(the Azzi Fudd case, 12 of 15 while not having played in seven days) will not trip the 10-day
threshold. That case is already covered by the availability probe's IRREGULAR flag, and lowering
this threshold further would false-positive on ordinary off-day stretches.

## 3. `availabilityNote` nullish-coalescing bug

```ts
availabilityNote: avail?.note ?? rate.recentAvailability.note,   // WRONG
```

A player the probe covered and found healthy has `note === null`, so `??` fell straight through
to the BDL disclaimer. Every healthy MLB position player displayed "Playing-time risk is NOT
assessed on this path" while simultaneously being flagged OK. Cosmetic, but it teaches the
writer to distrust a safeguard that is working, which is how a real IRREGULAR eventually gets
ignored. Now picks the source first, then its note.

## 4. Fliff blocked in `oddsPricing.ts`

The publishing rules name Fliff alongside Underdog, PrizePicks and Sleeper. The code's
`PICKEM_APPS` set did not include it, so a Fliff price was accepted as a real book price, and
two of six MLB props were sourced from it.

Fliff is placed in a SEPARATE set with its own comment, because it is not a pick'em app. It
posts genuinely juiced two-way lines (-182, -145 above), so unlike a flat +100/+100 board it
does not corrupt the maths. It is blocked because it is unbettable for this audience, not
because the number is fake. Keeping the two categories distinct matters: if a future book needs
blocking, the reason determines where it goes.

## Deploy and verify

1. `/health` must report **2.5.3**.
2. Run `tkb_screen_props` on an MLB event **with** `preferredBookmakers="draftkings,fanduel,betmgm,caesars"`.
   Every returned prop's `bookmaker` should be one of those four. Before this change, five of
   six were not.
3. Run the same screen **without** the argument and confirm it still behaves as it did.
4. Look for `sampleIsStale: true` on any player returning from a layoff, and confirm everyday
   players come back false.
5. Confirm healthy position players no longer carry the "not assessed on this path" note.
6. Re-run a WNBA screen and confirm it is still fast, since candidate count should now be lower.

## Follow-ups not in this build

- The nightly prompts still need `preferredBookmakers` added to their `screen_props` call.
  Until then the parameter is available but unused, which is safe.
- The `UNCOUNTABLE_STATIDS` comment in `screenProps.ts` still describes combos as BDL-only,
  inaccurate since v2.5.2 but with no runtime effect.
- A market scorecard that feeds published results back into screening remains the highest-value
  remaining item, and needs a longer tracker export than one month before thresholds are set.
