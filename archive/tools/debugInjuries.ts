import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BDLClient } from "../services/bdlClient.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * TEMPORARY diagnostic tool - dumps raw BALLDONTLIE injuries JSON to find the
 * real field shape. Our "team" field assumption has been wrong twice (assumed
 * nested in player, then assumed sibling field) - this stops guessing and shows
 * the actual response directly. Safe to remove once the real shape is confirmed
 * and tkb_get_injuries is corrected to match it.
 */
const DebugInjuriesInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]),
  })
  .strict();

type DebugInjuriesInput = z.infer<typeof DebugInjuriesInputSchema>;

export function registerDebugInjuriesTool(server: McpServer, bdl: BDLClient) {
  server.registerTool(
    "tkb_debug_raw_injuries",
    {
      title: "[DEBUG] Get Raw BALLDONTLIE Injuries JSON",
      description:
        "TEMPORARY diagnostic tool. Returns raw, unprocessed BALLDONTLIE injuries JSON (first 3 records) for direct field inspection. Use this to find the real team-field shape, not for normal use.",
      inputSchema: DebugInjuriesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: DebugInjuriesInput) => {
      try {
        const raw = await bdl.getRawInjuries(params.sport);
        const text = JSON.stringify(raw, null, 2);
        const truncated = text.length > 10000 ? text.slice(0, 10000) + "\n...[truncated]" : text;

        return {
          content: [{ type: "text" as const, text: truncated }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
