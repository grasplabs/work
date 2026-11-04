/**
 * A tally App the e2e tests build: in a chat's draft written straight
 * into its Workspace (chat-preview.e2e.ts), or by the scripted model
 * (model-scripts.ts).
 */

/**
 * A tally of spec 8's layout: a table, a query and a mutation, and a
 * screen on the React SDK that reads the count live through the host's
 * references (`#grasp`). `label` says whose count it is: the App's, or
 * the draft's preview.
 */
export const tallyFiles = (label: string): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  tally: defineTable({ added: v.boolean() }),
});
`,
  "operations/tally.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

export const count = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => \`\${String((await ctx.db.query("tally").take(100)).length)} ${label}\`,
});

export const add = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.db.insert("tally", { added: true });
    return null;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { add, count } from "./operations/tally.ts";
import schema from "./schema.ts";

export default app({
  name: "Tally",
  schema,
  access: { tables: { tally: { read: "appMembers", write: "appMembers" } } },
  operations: { tally: { add, count } },
  internalOperations: {},
  screens: [{ name: "tally", path: "/", source: "screens/tally.tsx" }],
  uses: [],
});
`,
  "screens/tally.tsx": `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "#grasp";

export default function Tally() {
  const count = useQuery(api.tally.count, {});
  const add = useMutation(api.tally.add);
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button onClick={() => { void add({}); }} variant="outline">
        Add one
      </Button>
      <output>{count ?? "Loading"}</output>
    </main>
  );
}
`,
});
