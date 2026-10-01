import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  devig,
  assessEdge,
  parseAmerican,
  type DevigResult,
  type EdgeResult,
} from "../services/devig.js";
import { flexIntOptional, asNumber } from "../services/flexibleInput.js";

const DevigInputSchema = z
  .object({
    prices: z
      .array(z.string())
      .min(2)
      .max(8)
      .describe(
        "EVERY side of the market, from the SAME book, as American odds strings: ['+103','-140'] or ['+800','-2800']. A one-sided price cannot be devigged and is refused, because the hold is only visible in how far the sides sum past 100%. Decimal odds are rejected by name rather than silently misread."
      ),
    offeredPrice: z
      .string()
      .optional()
      .describe(
        "Optional. A price you can actually get, to compare against fair. Usually the best number across your books. Returns EV per method rather than one figure."
      ),
    sideIndex: flexIntOptional(0, 7).describe(
      "Which side offeredPrice is on, 0-based against `prices`. Defaults to 0, the first side you listed."
    ),
    label: z
      .string()
      .optional()
      .describe("Optional label for the output, e.g. \"Olson Any HR\". Cosmetic only."),
  })
  .strict();

type DevigInput = z.infer<typeof DevigInputSchema>;

const pct = (p: number) => `${(p * 100).toFixed(2)}%`;

function renderDevig(res: DevigResult, label?: string): string {
  const head = label ? `${label}\n\n` : "";
  if (!res.ok) return `${head}CANNOT DEVIG.\n\n${res.reason}`;

  const lines: string[] = [];
  lines.push(
    `RAW: ${res.impliedProbs!.map(pct).join(" + ")} = ` +
      `${pct(res.impliedTotal!)}  ->  hold ${res.holdPct!.toFixed(2)}%`
  );
  lines.push("");
  lines.push("FAIR BY METHOD:");
  for (const m of res.methods ?? []) {
    if (!m.ok) {
      lines.push(`  ${m.method.padEnd(15)} unavailable: ${m.reason}`);
      continue;
    }
    lines.push(
      `  ${m.method.padEnd(15)} ${m.probs.map(pct).join("  /  ")}` +
        `   ->  ${m.fairAmerican.join("  /  ")}`
    );
  }
  if (res.methodsDisagree) {
    lines.push("");
    lines.push(
      `METHODS DISAGREE (spread ${((res.methodSpread! - 1) * 100).toFixed(0)}%). ` +
        `No single fair number should be published for this market.`
    );
  }
  for (const w of res.warnings ?? []) {
    lines.push("");
    lines.push(`WARNING: ${w}`);
  }
  return head + lines.join("\n");
}

function renderEdge(res: EdgeResult): string {
  if (!res.ok) return `\n\nEDGE: not assessed. ${res.reason}`;
  const lines: string[] = ["", `AGAINST ${res.offered}:`];
  for (const a of res.assessments ?? []) {
    const sign = a.evPct >= 0 ? "+" : "";
    lines.push(
      `  ${a.method.padEnd(15)} fair ${a.fairPrice.padEnd(7)} ` +
        `(${pct(a.fairProb)})   EV ${sign}${a.evPct.toFixed(2)}%   ${a.verdict}`
    );
  }
  for (const w of res.warnings ?? []) {
    lines.push("");
    lines.push(`WARNING: ${w}`);
  }
  return lines.join("\n");
}

export function registerDevigTool(server: McpServer) {
  server.registerTool(
    "tkb_devig",
    {
      title: "Devig a Market and Measure Edge",
      description: `Strip a book's margin off a two-sided market to get the fair probability and
fair price, then optionally compare a price you can actually get against it.

THE METHOD CHOICE IS THE SUBSTANCE. There is no single "the" devig, so this returns
multiplicative, additive and power side by side rather than one confident number. On a
near-even market they agree within a fraction of a point. On a longshot they can differ
by better than 2x, because books load their margin onto the long side, and that
difference decides whether a price looks like free money or like fair value.

Measured 2026-09-29 on real prices: Carrier anytime goal at +800/-2800 devigs to 10.32%
multiplicative, 7.28% additive, 4.75% power. DraftKings was showing +2000, which implies
4.76%. Multiplicative calls that a +117% edge. Power calls it fair. Power is the better
behaved of the three on long prices.

Args:
  - prices: EVERY side, same book, American odds. ['+103','-140']
  - offeredPrice: optional, a price you can get, for an EV comparison
  - sideIndex: which side offeredPrice is on, default 0
  - label: cosmetic

REFUSES rather than guessing: a one-sided market (nothing to measure the hold from),
decimal odds pasted into an American field, and prices that sum at or below 100%, which
means they came from different books or one is stale.

Flags an edge above 5% as probably bad data. On a market eight books price, a double
digit edge is a stale number far more often than it is value.

Examples:
  - "what is fair on +103/-140" -> prices=['+103','-140']
  - "is FanDuel's +116 any good" -> prices=['+103','-140'], offeredPrice='+116'
  - "devig the anytime goal" -> prices=['+800','-2800'], offeredPrice='+2000'`,
      inputSchema: DevigInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: DevigInput) => {
      try {
        // Resolved in code, not only in the schema: a direct handler call skips zod.
        const sideIndex = asNumber(input.sideIndex) ?? 0;

        const base = devig(input.prices);
        if (!base.ok) {
          return {
            content: [{ type: "text" as const, text: renderDevig(base, input.label) }],
            structuredContent: { ok: false, reason: base.reason },
          };
        }

        let edge: EdgeResult | undefined;
        if (input.offeredPrice !== undefined && input.offeredPrice !== "") {
          edge = assessEdge(input.prices, input.offeredPrice, sideIndex);
        }

        const text =
          renderDevig(base, input.label) + (edge ? renderEdge(edge) : "");

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: {
            ok: true,
            label: input.label,
            prices: input.prices,
            impliedProbs: base.impliedProbs,
            impliedTotal: base.impliedTotal,
            holdPct: base.holdPct,
            methods: base.methods,
            methodSpread: base.methodSpread,
            methodsDisagree: base.methodsDisagree,
            ...(edge
              ? {
                  offeredPrice: input.offeredPrice,
                  sideIndex,
                  offeredImpliedProb: parseAmerican(input.offeredPrice).prob,
                  edge: edge.assessments,
                  bestEvPct: edge.bestEvPct,
                  worstEvPct: edge.worstEvPct,
                }
              : {}),
            warnings: [...(base.warnings ?? []), ...(edge?.warnings ?? [])].filter(
              (w, i, arr) => arr.indexOf(w) === i
            ),
            note:
              `Fair prices are this ONE book's opinion with its margin removed, not the ` +
              `market's consensus. A stronger version weights a sharp book or several ` +
              `books together; that is not built yet, so do not read these as truth.`,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error devigging: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
