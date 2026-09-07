# v2.0.1 — two real bugs caught by the live probe

Run `tkb_debug_bdl_stats` immediately after deploying any BDL change. It caught both of these before either reached a published thread.

## ✅ Confirmed: BDL ALL-STAR includes player game stats

No 401. The migration is viable at **zero additional cost**.

## 🐛 Bug 1: pitching stats collided with batting stats

BDL returns batting and pitching values **on the same row**, and prefixes the pitching counterparts with `p_`:

| Batting | Pitching |
|---|---|
| `k` (batter Ks) | `p_k` |
| `hits` | `p_hits` |
| `bb` | `p_bb` |
| `runs` | `p_runs` |
| `hr` | `p_hr` |

My `pitching_strikeouts` resolver listed `["pitching_strikeouts", "strikeouts_pitched", "pitcher_strikeouts", "strikeouts", "so", "k"]`. None of the first five exist — so it would have fallen through to **`k`, the batter strikeout field**, which is populated on every row.

A pitcher strikeout prop would have returned how many times that player *struck out as a hitter*. Fully populated, plausible, completely wrong.

**Fixed:** every pitching resolver now maps to exactly one confirmed field, with `k`/`so`/`strikeouts` explicitly excluded and a comment explaining why they must never be added back.

## 🐛 Bug 2: full-name search returned nothing

BDL's `search` matches **last name only**.

- `"Ketel Marte"` → **0 results**
- `"Marte"` → **18 results**

Every full-name lookup would have failed, fallen back to SGO silently, and the entire entity saving would never have materialised — with nothing indicating why.

**Fixed:** search on the last token, then filter locally on the full name.

## What worked as designed

- **Candidate arrays** — every batting field resolved on the first try (`hits`, `total_bases`, `rbi`, `hr`, `doubles`, `triples`, `bb`, `stolen_bases`, `runs`)
- **`total_bases` exists directly** — no derivation needed, though the fallback remains
- **Ambiguity refusal** — 18 "Marte" matches, and it declined to guess. Starling, Noelvi and Yunior Marte are all real active players.

## Verify after deploying this

```
tkb_debug_bdl_stats  sport="mlb"  playerName="Ketel Marte"
```
Should now resolve (it failed before this fix).

Then cross-check one rate both ways — **the counts must match**:
```
tkb_get_player_hit_rate ... dataSource="bdl"
tkb_get_player_hit_rate ... dataSource="sgo"
```

Then probe WNBA, whose field names are still unverified:
```
tkb_debug_bdl_stats  sport="wnba"  playerName="A'ja Wilson"
```
