/**
 * Wrangler's JSONC, parsed: kept apart from wrangler-config-rules.ts, which
 * loads the names module, so a config loaded by Vite's Cloudflare plugin
 * (apps/admin/cloudflare.config.ts) pulls in nothing the Worker loads too.
 */

// Strings are matched first, so a `//` or `,}` inside one is kept.
const COMMENT = /(?<string>"(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu;
const TRAILING_COMMA = /(?<string>"(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/gu;

const keepStrings = (_match: string, string?: string): string => string ?? "";

/** Wrangler's JSONC: JSON with comments and trailing commas. */
export const parseJsonc = (text: string): unknown =>
  JSON.parse(
    text.replace(COMMENT, keepStrings).replace(TRAILING_COMMA, keepStrings)
  );
