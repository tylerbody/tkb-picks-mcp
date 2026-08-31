import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCfbdStat,
  lookupCfbdStat,
  isCfbdStatSupported,
  type CfbdCategory,
} from "../src/services/cfbdStatMap.js";

/**
 * A box score in CollegeFootballData's documented shape.
 *
 * The nesting here is taken from the OpenAPI schema, which pins it exactly:
 * categories[].name -> types[].name -> athletes[]{id,name,stat}. What the schema
 * does NOT pin is the LITERALS, since both name fields are typed as bare strings
 * with no enum - which is the entire reason cfbdStatMap uses candidate arrays and
 * ships with a probe tool.
 *
 * Note "9" is Dante Moore (QB) and "22" is a running back, deliberately: the same
 * type name "YDS" appears under passing, rushing AND receiving, and matching a type
 * without its category would resolve a receiver's prop to a quarterback's passing
 * yards. That is the p_k collision (v2.0.1) on a bigger surface.
 */
const boxScore: CfbdCategory[] = [
  {
    name: "passing",
    types: [
      { name: "C/ATT", athletes: [{ id: "9", name: "Dante Moore", stat: "24/35" }] },
      { name: "YDS", athletes: [{ id: "9", name: "Dante Moore", stat: "285" }] },
      { name: "TD", athletes: [{ id: "9", name: "Dante Moore", stat: "3" }] },
    ],
  },
  {
    name: "rushing",
    types: [
      {
        name: "CAR",
        athletes: [
          { id: "9", name: "Dante Moore", stat: "4" },
          { id: "22", name: "Jordon Davison", stat: "18" },
        ],
      },
      {
        name: "YDS",
        athletes: [
          { id: "9", name: "Dante Moore", stat: "12" },
          { id: "22", name: "Jordon Davison", stat: "104" },
        ],
      },
    ],
  },
  {
    name: "receiving",
    types: [
      { name: "REC", athletes: [{ id: "22", name: "Jordon Davison", stat: "3" }] },
      { name: "YDS", athletes: [{ id: "22", name: "Jordon Davison", stat: "1,024" }] },
    ],
  },
];

describe("parseCfbdStat returns null, never 0", () => {
  test("plain integers", () => assert.equal(parseCfbdStat("285"), 285));
  test("thousands separators", () => assert.equal(parseCfbdStat("1,024"), 1024));
  test("decimals", () => assert.equal(parseCfbdStat("12.5"), 12.5));
  test("leading plus", () => assert.equal(parseCfbdStat("+7"), 7));

  test("an empty stat is null, NOT zero", () => {
    assert.equal(parseCfbdStat(""), null);
    assert.equal(parseCfbdStat("-"), null);
    assert.equal(parseCfbdStat("--"), null);
  });

  test("a compound C/ATT splits into completions and attempts", () => {
    assert.equal(parseCfbdStat("24/35", "first"), 24);
    assert.equal(parseCfbdStat("24/35", "second"), 35);
  });

  test("THE HAZARD: a compound value read whole is null rather than NaN-to-zero", () => {
    // Number("24/35") is NaN. Anything that coerces NaN to 0 reports a quarterback
    // who threw 35 times as having thrown 0.
    assert.equal(parseCfbdStat("24/35"), null);
    assert.notEqual(parseCfbdStat("24/35"), 0);
  });

  test("a compound field that stops being compound refuses rather than guesses", () => {
    assert.equal(parseCfbdStat("24", "second"), null);
  });
});

describe("lookupCfbdStat matches on the (category, type) PAIR", () => {
  test("passing yards resolves for the quarterback", () => {
    const r = lookupCfbdStat(boxScore, "9", "passing_yards");
    assert.equal(r.kind, "value");
    if (r.kind === "value") {
      assert.equal(r.value, 285);
      assert.equal(r.matchedCategory, "passing");
      assert.equal(r.matchedType, "YDS");
    }
  });

  test("THE COLLISION: rushing yards for the same player is 12, not his 285 passing yards", () => {
    const r = lookupCfbdStat(boxScore, "9", "rushing_yards");
    assert.equal(r.kind, "value");
    if (r.kind === "value") {
      assert.equal(r.value, 12);
      assert.equal(r.matchedCategory, "rushing");
    }
  });

  test("receiving yards resolves under receiving, not rushing", () => {
    const r = lookupCfbdStat(boxScore, "22", "receiving_yards");
    assert.equal(r.kind, "value");
    if (r.kind === "value") {
      assert.equal(r.value, 1024);
      assert.equal(r.matchedCategory, "receiving");
    }
  });

  test("completions and attempts split out of one C/ATT string", () => {
    const c = lookupCfbdStat(boxScore, "9", "passing_completions");
    const a = lookupCfbdStat(boxScore, "9", "passing_attempts");
    assert.equal(c.kind === "value" && c.value, 24);
    assert.equal(a.kind === "value" && a.value, 35);
  });

  test("a player absent from a category reports player_absent, not a zero", () => {
    // The running back has no passing line at all.
    const r = lookupCfbdStat(boxScore, "22", "passing_yards");
    assert.equal(r.kind, "player_absent");
  });

  test("an unmapped statID refuses by name rather than substituting", () => {
    const r = lookupCfbdStat(boxScore, "9", "batting_hits");
    assert.equal(r.kind, "stat_not_mapped");
    assert.equal(isCfbdStatSupported("batting_hits"), false);
  });

  test("case differences in the provider's literals still resolve", () => {
    const shouty: CfbdCategory[] = [
      { name: "Passing", types: [{ name: "yards", athletes: [{ id: "9", name: "X", stat: "301" }] }] },
    ];
    const r = lookupCfbdStat(shouty, "9", "passing_yards");
    assert.equal(r.kind === "value" && r.value, 301);
  });
});

describe("composite markets are all-or-nothing", () => {
  test("passing+rushing yards sums when both components resolve", () => {
    const r = lookupCfbdStat(boxScore, "9", "passing+rushing_yards");
    assert.equal(r.kind, "value");
    if (r.kind === "value") assert.equal(r.value, 285 + 12);
  });

  test("A PARTIAL SUM IS REFUSED, because it is a plausible wrong number", () => {
    // The receiver has rushing yards but no passing line, so the composite must
    // refuse rather than quietly return the rushing half.
    const r = lookupCfbdStat(boxScore, "22", "passing+rushing_yards");
    assert.notEqual(r.kind, "value");
    if (r.kind !== "value") assert.match(r.note, /partial sum/i);
  });

  test("rushing+receiving sums for a player who has both", () => {
    const r = lookupCfbdStat(boxScore, "22", "rushing+receiving_yards");
    assert.equal(r.kind === "value" && r.value, 104 + 1024);
  });
});
