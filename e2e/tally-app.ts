import { testApp } from "../apps/core/test/app-definitions.ts";
import type { TestApp } from "../apps/core/test/app-definitions.ts";

/**
 * A tally App the e2e tests build: in a chat's draft written straight
 * into its Workspace (chat-preview.e2e.ts), or by the scripted model
 * (model-scripts.ts).
 */

/** The tally's page, its button saying `button`. */
export const tallyPage = (
  button: string
): string => `import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@grasp-os/sdk/react";
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

export const Route = createFileRoute("/")({ component: Tally });
`;

/**
 * The tally's server code, its count saying `label` after the number.
 * With `builds: false` it asks for a count that isn't a number, so it
 * fails its type check.
 */
export const tallyServer = (
  label: string,
  { builds = true }: { readonly builds?: boolean } = {}
): string => `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const count = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const added = await ctx.db.query("tally").take(${builds ? "100" : '"all"'});
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
 * page on the React SDK that reads the count live through the host's
 * references (`@server/_generated/api`). `label` says whose count it is: the App's, or
 * the draft's preview.
 */
export const tallyFiles = (label: string): TestApp =>
  testApp(
    {
      name: "Tally",
      tables: {
        tally: {
          fields: { added: "v.boolean()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
    },
    {
      "server/tally.ts": tallyServer(label),
      "src/routes/index.tsx": tallyPage("Add one"),
    }
  );
