# v2.4.1 — the availability probe was measuring the wrong thing

## What v2.4.0's new reporting exposed

The coverage line added in 2.4.0 immediately paid for itself:

```
Availability: 629 player(s) covered across 2 team(s), 613 flagged IRREGULAR
```

**629 players on two rosters. 97% flagged.** Both numbers are impossible, and they pointed at two separate bugs that the old "probed across 2 team(s)" wording had been hiding completely.

## Bug 1: it counted opponents

An event's `results` object holds **both teams'** players. Fetching by teamID and tallying every key therefore counted every opponent who appeared in any of those games — each showing up once or twice across the window, each landing under the 0.7 play-rate threshold, each flagged IRREGULAR.

The flags on the *screened* players were still directionally right, since they do appear in their own team's games. But the coverage number was noise, and the flag count was meaningless.

**Fixed:** the probe now takes the team's roster IDs and tallies only those.

## Bug 2: `limit` is page size, not a total

`getAllEvents` treats `limit` as the **per-page** size and defaults to `maxPages: 10`. So `limit: 30` could pull **up to 300 events**.

The tell was in the flag text itself:

> "appeared in only 18 of the last **51** team games"

The window was supposed to be 30.

**Fixed:** the probe passes `maxPages: 1`, so 30 means 30. Thirty games is ample for a play-rate signal and bounds the cost at ~30 entities per team.

## Why this one is worth flagging

The probe was **never wrong about the players being screened** — Ke'Bryan Hayes really has played 18 of Cincinnati's recent games, and that flag was correct and useful.

What was wrong was everything around it: the sample size it claimed, the entity cost it incurred, and a coverage statistic that would have made a total probe failure indistinguishable from a healthy one. The reporting added in 2.4.0 is the only reason any of it surfaced.

## Still open, deliberately

**Name resolution: 28 fallbacks of 224 rates (~12.5%).**

The v2.4.0 accent and compound-surname fixes did work — Heriberto Hernández now resolves cleanly. But the failure count did not move, which means the remaining cases are a different problem: most likely players BALLDONTLIE genuinely does not carry (recent callups, minor-league debuts) or names that are honestly ambiguous.

Not chasing it further right now, because the economics no longer justify it. Each fallback costs a cached SGO team-history read rather than a fresh one, and the screen already runs at ~600 entities against an original ~1,195. Another instrument-and-deploy cycle to recover a few percent is worse value than leaving it.

If it matters later, the fix is to log the failing player names rather than just the bucket counts.

## Verify after deploy

1. `/health` reports **2.4.1**
2. Run a full-roster screen
3. Coverage should read roughly **30-60 players across 2 teams**, not 629
4. IRREGULAR count should be a **handful**, not hundreds
5. Flag text should say "of the last **30** team games"
