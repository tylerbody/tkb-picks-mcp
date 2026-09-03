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

/**
 * PLAIN CODEPOINT COUNT - the OTHER ceiling, and the one nothing here measured.
 *
 * WHY IT EXISTS (v2.8.6). X's 280 limit is the WEIGHTED count above. But a post
 * carrying MEDIA can be cut off with "Show more" well before 280, and the CFB and
 * NFL thread formats therefore impose a second, tighter ceiling on the opener -
 * currently 200 PLAIN characters, counted with emoji as 1 and URLs at their real
 * length, which is a completely different number from the weighted one.
 *
 * MEASURED 2026-09-02 while building the Week 1 CFB threads: the opener needed six
 * separate round trips, because tkb_count_tweet_chars answered the 280 question and
 * the 200 question had to be answered by writing the text to a file and running
 * `python3 -c "print(len(open('f.txt').read()))"` after every single edit. Two
 * ceilings, two tools, and a guess-and-check loop between them.
 *
 * Python's len() on a str counts CODEPOINTS, and JavaScript's spread iterates a
 * string by codepoint, so [...text].length reproduces that reference count exactly
 * - including counting a variation selector (U+FE0F, the invisible codepoint that
 * makes an emoji render in colour) as its own character, which the weighted count
 * deliberately treats as free.
 */
export function rawCharacterLength(text: string): number {
  return [...text].length;
}

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
        "come back 20-80 characters over the 280 limit. " +
        "PASS rawLimit TO CHECK BOTH CEILINGS AT ONCE: a post carrying MEDIA can be " +
        "cut off with 'Show more' well before 280, so thread openers with a cover " +
        "photo also have a PLAIN-codepoint ceiling (200 in the CFB and NFL formats). " +
        "rawLength is always returned; passing rawLimit makes a post fail unless it " +
        "clears both. Without it the raw count has to be computed separately, which " +
        "on 2026-09-02 turned one opener into six round trips.",
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
          .describe("Weighted character ceiling. 280 standard, 25000 for X Premium long posts."),
        rawLimit: z
          .number()
          .int()
          .optional()
          .describe(
            "OPTIONAL SECOND CEILING, counted as PLAIN CODEPOINTS rather than X-weighted - emoji count 1, URLs count their real length, variation selectors count 1. This is the 'Show more' ceiling that applies to a post carrying MEDIA, which can be truncated well before 280. Pass 200 when checking a thread OPENER that will have a cover photo attached. Both counts are returned and a post is only OK when it clears BOTH."
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const results = input.posts.map((text, i) => {
        const { weighted, urlsFound, emojiCount } = weightedTweetLength(text);
        const over = weighted - input.limit;
        const raw = rawCharacterLength(text);
        const rawOver = input.rawLimit !== undefined ? raw - input.rawLimit : 0;
        // A post is OK only when it clears BOTH ceilings. Reporting them
        // separately but judging them together is the whole point - the six-round
        // -trip loop this replaces came from clearing one and discovering the other.
        const failsRaw = input.rawLimit !== undefined && rawOver > 0;
        return {
          index: i + 1,
          weighted,
          limit: input.limit,
          weightedStatus: over > 0 ? `OVER by ${over}` : "OK",
          rawLength: raw,
          ...(input.rawLimit !== undefined
            ? {
                rawLimit: input.rawLimit,
                rawStatus: rawOver > 0 ? `RAW OVER by ${rawOver}` : "OK",
                rawRemaining: rawOver > 0 ? 0 : -rawOver,
              }
            : {}),
          status:
            over > 0
              ? `OVER by ${over}`
              : failsRaw
                ? `RAW OVER by ${rawOver}`
                : "OK",
          remaining: over > 0 ? 0 : -over,
          urlsCounted: urlsFound.length,
          urlCostEach: urlsFound.length > 0 ? TCO_LENGTH : 0,
          emojiCount,
          preview: text.slice(0, 60).replace(/\n/g, " ⏎ "),
        };
      });

      const overCount = results.filter((r) => r.status !== "OK").length;
      const limitLabel =
        input.rawLimit !== undefined
          ? `${input.limit} weighted / ${input.rawLimit} raw`
          : `${input.limit}`;
      const header =
        overCount === 0
          ? `All ${results.length} post(s) within ${limitLabel}.`
          : `${overCount} of ${results.length} post(s) OVER ${limitLabel}. Trim before publishing.`;

      return {
        content: [
          { type: "text" as const, text: `${header}\n\n${JSON.stringify(results, null, 2)}` },
        ],
        structuredContent: { results, overCount },
      };
    }
  );
}
