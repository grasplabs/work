import { describe, expect, test } from "vite-plus/test";

import { indexUsesOf } from "../src/definition-entry.ts";

// Which index each of an App's functions reads, and the pages that call
// it, read from its code: what the Data view says each index is used by,
// and which indexes nothing uses.

const files = new Map([
  [
    "server/deals.ts",
    `import { query } from "@server/_generated/server";
export const byStage = query({
  args: {},
  handler: async (ctx, args) =>
    await ctx.db.query("deals").withIndex("by_stage", (range) => range.eq("stage", args.stage)).take(50),
});
export const find = query({
  args: {},
  handler: async (ctx, args) => await ctx.db.search("deals", args.text).take(20),
});
export const all = query({ args: {}, handler: async (ctx) => await ctx.db.query("deals").take(50) });
`,
  ],
  [
    "server/_generated/server.ts",
    `export const x = ctx.db.query("deals").withIndex("generated");`,
  ],
  [
    "src/routes/pipeline.tsx",
    `import { api } from "@server/_generated/api";
const rows = useQuery(api.deals.byStage, { stage: "Lead" });`,
  ],
  [
    "src/routes/index.tsx",
    `import { api } from "@server/_generated/api";
useQuery(api.deals.byStage, {}); useQuery(api.deals.find, {});`,
  ],
  ["server/broken.ts", "export const = ("],
]);

describe("an App's index uses", () => {
  test("names each function's index, by table, with the pages that call it", () => {
    expect(indexUsesOf(files)).toStrictEqual([
      {
        table: "deals",
        index: "by_stage",
        query: "deals.byStage",
        pages: ["/", "/pipeline"],
      },
      { table: "deals", index: null, query: "deals.find", pages: ["/"] },
    ]);
  });
});
