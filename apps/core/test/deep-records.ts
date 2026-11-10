import { valueDepth } from "@grasp-os/shared/value-depth";

import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";

// An App that keeps a record as deep as a table may declare one, for the
// tests that hold every bound on its way to the store to it: the
// operation channel's, workerd's and the on-prem sandbox session's.

/**
 * How deep a table's field may be declared: a schema nests at most
 * `valueDepth` levels, the table's own object among them.
 */
export const fieldDepth = valueDepth - 1;

/**
 * An App whose `deep.put` keeps a field as deep as a table may declare
 * one (`fieldDepth`, within `documentMaxDepth`), built in the function,
 * and whose `deep.read` reads it back: every level crosses the operation
 * channel to the store and back.
 */
export const deepFiles: TestApp = testApp(
  {
    name: "Deep",
    tables: {
      deep: {
        // A leaf in `fieldDepth - 1` arrays: `fieldDepth` levels, as deep
        // as a table's field may be.
        fields: {
          value: `${"v.array(".repeat(fieldDepth - 1)}v.string()${")".repeat(fieldDepth - 1)}`,
        },
        access: { read: "owner", write: "owner" },
      },
    },
  },
  {
    "server/deep.ts": `import { v } from "@grasp-os/runtime";
import { mutation, query } from "@server/_generated/server";

const nested = (): unknown => {
  let value: unknown = "leaf";
  for (let level = 1; level < ${String(fieldDepth)}; level += 1) {
    value = [value];
  }
  return value;
};

export const put = mutation({
  args: {},
  returns: v.id("deep"),
  // SAFETY-free: the schema checks the value it holds.
  handler: async (ctx) => await ctx.db.insert("deep", { value: nested() as never }),
});

export const read = query({
  args: { id: v.id("deep") },
  returns: v.number(),
  handler: async (ctx, args) => {
    let value: unknown = (await ctx.db.get("deep", args.id))?.value;
    let levels = 0;
    while (Array.isArray(value)) {
      levels += 1;
      value = value[0];
    }
    return value === "leaf" ? levels + 1 : 0;
  },
});
`,
  }
);
