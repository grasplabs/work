import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// The side panel of a chat shows the App being built: a version up for
// review, with what core says it changes, and a builder making it
// current from there. The local stack reaches no model, so the version is
// proposed through the builder's own API, as the chat's agent proposes
// one (`env.build.propose`); the agent's drafts, checks and proposals
// themselves are core's tests (apps/core/test/agent-builds.test.ts).

/** A weekly workflow on a schedule, whose one step books: it acts. */
const weekly = {
  "workflows/weekly.ts": `import { schedule, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "weekly",
  { params: { every: schedule({ label: "Runs", default: "0 8 * * 1" }) }, triggers: [{ type: "schedule", param: "every" }] },
  async (step) => await step.do("book", { description: "Book the week", sideEffect: true, input: "week" }, async () => "booked")
);
`,
  "workflows/weekly.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./weekly.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { book: "booked" }, expect: { output: "booked" } }]);
`,
};

/**
 * The desk's data and functions, of spec 8's layout: an invoices table,
 * and a mutation that books one, which changes the App's data.
 */
const invoices = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  invoices: defineTable({ total: v.number() }),
});
`,
  "operations/invoices.ts": `import { v } from "@grasp-os/sdk";
import { mutation } from "#grasp/server";

export const book = mutation({
  args: { total: v.number() },
  returns: v.id("invoices"),
  handler: async (ctx, args) => await ctx.db.insert("invoices", args),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { book } from "./operations/invoices.ts";
import schema from "./schema.ts";

export default app({
  name: "Invoice desk",
  schema,
  access: { tables: { invoices: { read: "appMembers", write: "appMembers" } } },
  operations: { invoices: { book } },
  internalOperations: {},
  screens: [{ name: "desk", path: "/", source: "screens/desk.tsx" }],
  uses: [],
});
`,
};

const screen = `import { Button } from "@grasp-os/ui/components/button";

export default function Desk() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button variant="outline">Approve</Button>
    </main>
  );
}
`;

test("the side panel shows an App being built, and a builder makes its version current", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatBuilds");
  const { core, api } = apiOf(builder);
  const tag = crypto.randomUUID().slice(0, 8);
  const name = `Invoice desk ${tag}`;
  try {
    const app = await api.apps.create({ name });
    const { version } = await api.apps.files.commit(
      app.id,
      {
        "screens/desk.tsx": screen,
        ...weekly,
        ...invoices,
      },
      "An invoice desk for invoices@"
    );
    await api.apps.versions.propose(app.id, version);
    const chat = await api.chats.create(`Build ${tag}`);

    const page = await pageOf(builder);
    await page.goto(`/?chat=${chat.id}`);
    await page.getByRole("button", { name: "Side panel" }).click();
    const built = page
      .getByRole("complementary", { name: "Side panel" })
      .getByRole("region", { name: "Being built" });
    await expect(built).toContainText(
      `${name}: version ${version} waiting for review`
    );
    await expect(built.getByRole("region", { name: "Files" })).toHaveText(
      /Added screens\/desk\.tsx/u
    );
    await expect(built).toContainText(
      "Nothing runs yet: this would be the domain's first current version."
    );
    // Who proposed it, and the proposer's own words, labelled as such.
    await expect(built).toContainText("Committed by a person.");
    await expect(built.getByRole("blockquote")).toHaveText(
      "In the proposer's wordsAn invoice desk for invoices@"
    );
    await expect(built.getByRole("region", { name: "Tests" })).toContainText(
      "All workflow tests pass."
    );
    // Its workflow runs on its own now, and can change things.
    const workflows = built.getByRole("region", { name: "Workflows" });
    await expect(workflows).toContainText("Added workflow weekly");
    await expect(workflows).toContainText(
      "Now runs on a schedule (its parameter every)"
    );
    await expect(workflows).toContainText("May change something outside Grasp");
    // The App's functions its workflow may use are flagged as changed.
    await expect(workflows).toContainText(
      "Code it may use changed: app.ts, operations/invoices.ts, and schema.ts"
    );
    const makeCurrent = built.getByRole("button", {
      name: `Make version ${version} current`,
    });
    await expect(makeCurrent).toBeEnabled();

    await makeCurrent.click();
    await expect(built).toHaveCount(0);
    await expect
      .poll(async () => {
        const listed = await api.apps.list();
        return listed.find(({ id }) => id === app.id)?.currentVersion;
      })
      .toBe(version);
  } finally {
    core[Symbol.dispose]();
  }
});
