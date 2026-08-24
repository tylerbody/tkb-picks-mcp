# v2.1.0 — making array ordering impossible to misread

## What happened

`tkb_screen_props` returned `recentValues` as a bare number array sorted **newest first**. Gunnar Henderson came back as `[7, 0, 0, 0, 0, 0]` — a 7-total-base game **last night**, then five zeros before it.

It got read left-to-right as oldest-to-newest and published as *"held to zero in five consecutive starts."* The exact inverse of the truth, and it ran in the opener line where it was the first thing anyone would read.

## Why every guardrail passed

Nothing in the data was wrong. The odds were real and book-priced. The sample was real. The 13-of-15 hit rate was computed correctly. **The pick itself was fine.**

The error lived entirely in prose describing the array — and no data-integrity check can catch a reading error. That is a different failure class from every bug this connector has caught before (`p_k` collisions, unpaginated pages, fair-odds leakage), all of which were wrong *values*. This was a right value, wrongly narrated.

## The fix

Replace the ambiguous array with self-describing data:

**Before**
```json
"recentValues": [7, 0, 0, 0, 0, 0]
```

**After**
```json
"mostRecentGame": { "date": "2026-08-11", "value": 7 },
"recentGamesNewestFirst": [
  { "date": "2026-08-11", "value": 7 },
  { "date": "2026-08-10", "value": 0 },
  ...
]
```

Two changes, both deliberate:

1. **`mostRecentGame` is named outright**, so "what did he do last night" never depends on inferring position.
2. **Every value carries its own date**, so a sequence can be described from dates rather than from array order.

The field is also renamed to `recentGamesNewestFirst` — the direction is now in the name itself.

## Also

`HitRateResult.log` ordering is now documented in the type, and `tkb_get_player_hit_rate`'s description carries an explicit warning to cite dates rather than positions.

## The principle

Same one behind the `bdlStatMap` candidate arrays: **make the wrong reading impossible rather than merely discouraged.** A comment saying "sorted newest first" would have been ignored the same way the ordering was. Dated pairs cannot be misread.
