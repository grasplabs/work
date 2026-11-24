import { describe, expect, it } from "vite-plus/test";

import { oxcWasmModule } from "../oxc-wasm/wasm.ts";
import { apiCallsOf, exportedFunctionsOf, indexReadsOf } from "./index-uses.ts";
import { startOxc } from "./oxc.ts";
import { parsed } from "./syntax.ts";

startOxc(await oxcWasmModule());

// What an App's code reads of its indexes, found in the compile's own
// parse: what the Data view says uses each index, and which nothing uses.

describe("an App's index uses, as its build finds them", () => {
  it("names each exported function's index and search, by table", () => {
    const reads = indexReadsOf(
      "server/deals.ts",
      parsed(
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
const hidden = () => ctx.db.query("deals").withIndex("by_owner");
`
      )
    );
    expect(reads).toStrictEqual([
      { table: "deals", index: "by_stage", query: "deals.byStage" },
      { table: "deals", index: null, query: "deals.find" },
    ]);
  });

  it("names the queries and mutations a server file exports, never an action, an internal one or a helper", () => {
    const functions = exportedFunctionsOf(
      "server/deals/open.ts",
      parsed(
        "server/deals/open.ts",
        `import { action, internalMutation, mutation, query } from "@server/_generated/server";
export const list = query({ args: {}, handler: async () => [] });
export const create = mutation({ args: {}, handler: async () => null });
export const sync = action({ args: {}, handler: async () => null });
export const tidy = internalMutation({ args: {}, handler: async () => null });
export const limit = 50;
const hidden = query({ args: {}, handler: async () => [] });
`
      )
    );
    expect(functions).toStrictEqual(["deals.open.list", "deals.open.create"]);
  });

  it("names the functions a page calls through `api`", () => {
    const calls = apiCallsOf(
      parsed(
        "src/routes/pipeline.tsx",
        `import { api } from "@server/_generated/api";
export const Pipeline = () => {
  const rows = useQuery(api.deals.byStage, { stage: "Lead" });
  const found = useQuery(api.deals.find, {});
  return <p>{rows.length + found.length}</p>;
};`
      )
    );
    expect(calls).toStrictEqual(["deals.byStage", "deals.find"]);
  });
});
