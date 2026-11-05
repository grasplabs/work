/**
 * A tally App the e2e tests build: in a chat's draft written straight
 * into its Workspace (chat-preview.e2e.ts), or by the scripted model
 * (model-scripts.ts).
 */

/** The tally's screen, its button saying `button`. */
export const tallyScreen = (
  button: string
): string => `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "@server/_generated/api";

const Tally = () => {
  const count = useQuery(api.tally.count, {});
  const add = useMutation(api.tally.add);
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button onClick={() => { void add({}); }} variant="outline">
        ${button}
      </Button>
      <output>{count ?? "Loading"}</output>
    </main>
  );
};

export default Tally;
`;

/**
 * A tally of spec 8's layout: a table, a query and a mutation, and a
 * screen on the React SDK that reads the count live through the host's
 * references (`@server/_generated/api`). `label` says whose count it is: the App's, or
 * the draft's preview.
 */
export const tallyFiles = (label: string): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  tally: defineTable({ added: v.boolean() }),
});
`,
  "server/tally.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const count = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const added = await ctx.db.query("tally").take(100);
    return \`\${String(added.length)} ${label}\`;
  },
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
import schema from "./schema.ts";

export default app({
  name: "Tally",
  schema,
  access: { tables: { tally: { read: "appMembers", write: "appMembers" } } },
  screens: [{ name: "tally", path: "/", source: "screens/tally.tsx" }],
});
`,
  "screens/tally.tsx": tallyScreen("Add one"),
});
