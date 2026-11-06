import { appDefinition } from "../apps/core/test/app-definitions.ts";

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
 * The tally's server code, its count saying `label` after the number,
 * reading `limit` records: past 100 it fails its type check.
 */
export const tallyServer = (
  label: string,
  limit = 100
): string => `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const count = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const added = await ctx.db.query("tally").take(${String(limit)});
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
`;

/**
 * A tally of spec 8's layout: a table, a query and a mutation, and a
 * screen on the React SDK that reads the count live through the host's
 * references (`@server/_generated/api`). `label` says whose count it is: the App's, or
 * the draft's preview.
 */
export const tallyFiles = (label: string): Record<string, string> => ({
  ...appDefinition({
    name: "Tally",
    tables: {
      tally: {
        fields: { added: "v.boolean()" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
  }),
  "server/tally.ts": tallyServer(label),
  "screens.ts": `export default {
  screens: [{ name: "tally", path: "/", source: "screens/tally.tsx" }],
};
`,
  "screens/tally.tsx": tallyScreen("Add one"),
});
