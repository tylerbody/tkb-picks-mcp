import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * TEMPORARY diagnostic tool - dumps the raw SGO event JSON for direct field
 * inspection. This exists purely to verify real field names/shapes against
 * live data (several fields were built against documentation assumptions
 * that need confirming). Safe to remove once the real schema is confirmed
 * and the other tools are corrected to match it.
 */
const DebugEventInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]),
    eventID: z.string(),
  })
  .strict();

type DebugEventInput = z.infer<typeof DebugEventInputSchema>;

export function registerDebugEventTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_debug_raw_event",
    {
      title: "[DEBUG] Get Raw Event JSON",
      description:
        "TEMPORARY diagnostic tool. Returns the raw, unprocessed SGO event JSON for direct field inspection. Use this to verify real field names against live data, not for normal thread-building use.",
      inputSchema: DebugEventInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: DebugEventInput) => {
      try {
        const leagueID = sgo.leagueIDFor(params.sport);
        const events = await sgo.getEvents({
          leagueID,
          eventIDs: params.eventID,
        });

        if (!events.data.length) {
          return {
            content: [{ type: "text" as const, text: "No event found." }],
          };
        }

        const event = events.data[0] as unknown as Record<string, unknown>;

        // The `odds` object can contain hundreds of markets (each with per-bookmaker
        // pricing), which is almost certainly what was blowing past response size
        // limits and causing hard failures. Cap it hard here - we mainly need
        // field SHAPES and NAMES for diagnostics, not every market's full pricing.
        const oddsRaw = event.odds;
        let oddsSummary: unknown = oddsRaw;
        if (oddsRaw && typeof oddsRaw === "object") {
          const oddsEntries = Object.entries(oddsRaw as Record<string, unknown>);
          oddsSummary = {
            totalMarketCount: oddsEntries.length,
            sampleFirst5: Object.fromEntries(oddsEntries.slice(0, 5)),
            note: `Showing 5 of ${oddsEntries.length} total odds markets. Full list omitted to keep response size manageable.`,
          };
        }

        const trimmedEvent = { ...event, odds: oddsSummary };

        let raw: string;
        try {
          raw = JSON.stringify(trimmedEvent, null, 2);
        } catch (stringifyErr) {
          // Circular reference or non-serializable value somewhere in the payload
          return {
            content: [
              {
                type: "text" as const,
                text: `Event data could not be serialized to JSON: ${stringifyErr instanceof Error ? stringifyErr.message : String(stringifyErr)}. Top-level keys present: ${Object.keys(event).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        const truncated = raw.length > 12000 ? raw.slice(0, 12000) + "\n...[truncated]" : raw;

        return {
          content: [{ type: "text" as const, text: truncated }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}. ${err instanceof Error && err.stack ? "Stack: " + err.stack.split("\n").slice(0, 3).join(" | ") : ""}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
