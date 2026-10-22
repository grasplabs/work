import { valueDepth } from "@grasp-os/shared/value-depth";

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
export const deepFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

// A leaf in ${String(fieldDepth - 1)} arrays: ${String(fieldDepth)} levels, as deep as a table's field may be.
const level0 = v.string();\n${Array.from({ length: fieldDepth - 1 }, (_value, index) => `const level${String(index + 1)} = v.array(level${String(index)});`).join("\n")}

export default defineSchema({
  deep: defineTable({ value: level${String(fieldDepth - 1)} }),
});
`,
  "operations/deep.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

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
  "app.ts": `import { app } from "@grasp-os/sdk";
import { put, read } from "./operations/deep.ts";
import schema from "./schema.ts";

export default app({
  name: "Deep",
  schema,
  access: { tables: { deep: { read: "owner", write: "owner" } } },
  operations: { deep: { put, read } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
};
