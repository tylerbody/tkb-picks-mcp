import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * TWEET LENGTH COUNTER
 *
 * X does not count characters the way `String.length` does, and the gap is large
 * enough to matter on every post this account publishes:
 *
 *   - Any URL counts as a flat 23 characters regardless of its real length, because
 *     X rewrites it through t.co. `nxtbets.com/playtkb/` is 20 real characters but
 *     costs 23. Longer links cost the same 23.
 *   - Most emoji count as 2, not 1. A header line like "⚾ TIGERS @ GIANTS ⚾"
 *     costs 2 more than it looks like it should. Threads here use 2-4 emoji per
 *     post, so the drift compounds.
 *   - Variation selectors (U+FE0F, the invisible codepoint that makes ⬇️ render in
 *     colour) count as 0.
 *
 * WHY THIS IS A TOOL RATHER THAN MENTAL MATH: on 2026-08-09 six standalone posts
 * were drafted and four of them were over the 280 limit once counted properly -
 * one by 87 characters. Every one of them looked short enough by eye. Guessing at
 * this wastes a full revision cycle per post.
 *
 * Practical consequence worth knowing: with a header, a promo line carrying the
 * link, and the CTA, the real body budget is roughly 190 characters.
 */

// Matches bare domains and full URLs the way X's entity parser broadly does.
const URL_PATTERN =
  /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;

const TCO_LENGTH = 23;

export function weightedTweetLength(text: string): {
  weighted: number;
  urlsFound: string[];
  emojiCount: number;
} {
  const urlsFound: string[] = [];

  // Replace each URL with a fixed-cost placeholder before counting.
  const withoutUrls = text.replace(URL_PATTERN, (match) => {
    urlsFound.push(match);
    return "\u0000".repeat(TCO_LENGTH);
  });

  let weighted = 0;
  let emojiCount = 0;

  // Iterate by codepoint, not by UTF-16 unit, or surrogate pairs double-count.
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0;

    if (cp === 0xfe0f || cp === 0xfe0e) continue; // variation selectors are free
    if (cp === 0x200d) continue; // zero-width joiner

    if (cp === 0) {
      weighted += 1; // URL placeholder unit
      continue;
    }

    const isEmoji =
      (cp >= 0x1f000 && cp <= 0x1ffff) ||
      (cp >= 0x2600 && cp <= 0x27bf) ||
      (cp >= 0x2b00 && cp <= 0x2bff) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff);

    if (isEmoji) {
      weighted += 2;
      emojiCount++;
    } else {
      weighted += 1;
    }
  }

  return { weighted, urlsFound, emojiCount };
}

export function registerTweetCharsTool(server: McpServer) {
  server.registerTool(
    "tkb_count_tweet_chars",
    {
      title: "Count X-weighted characters for one or more posts",
      description:
        "Returns the TRUE X character count for each post, applying X's rules: " +
        "URLs cost a flat 23 regardless of length, most emoji cost 2, variation " +
        "selectors cost 0. ALWAYS run this on opener tweets and standalone posts " +
        "before delivering them - posts routinely look short enough by eye and " +
        "come back 20-80 characters over the 280 limit.",
      inputSchema: {
        posts: z
          .array(z.string())
          .min(1)
          .max(25)
          .describe("Post texts to measure. Pass a whole thread at once."),
        limit: z
          .number()
          .int()
          .default(280)
          .describe("Character ceiling. 280 standard, 25000 for X Premium long posts."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const results = input.posts.map((text, i) => {
        const { weighted, urlsFound, emojiCount } = weightedTweetLength(text);
        const over = weighted - input.limit;
        return {
          index: i + 1,
          weighted,
          limit: input.limit,
          status: over > 0 ? `OVER by ${over}` : "OK",
          remaining: over > 0 ? 0 : -over,
          urlsCounted: urlsFound.length,
          urlCostEach: urlsFound.length > 0 ? TCO_LENGTH : 0,
          emojiCount,
          preview: text.slice(0, 60).replace(/\n/g, " ⏎ "),
        };
      });

      const overCount = results.filter((r) => r.status !== "OK").length;
      const header =
        overCount === 0
          ? `All ${results.length} post(s) within ${input.limit}.`
          : `${overCount} of ${results.length} post(s) OVER the ${input.limit} limit. Trim before publishing.`;

      return {
        content: [
          { type: "text" as const, text: `${header}\n\n${JSON.stringify(results, null, 2)}` },
        ],
        structuredContent: { results, overCount },
      };
    }
  );
}
