/**
 * The sample invoice App the workflow-on-screens tests run, of spec 8's
 * layout: invoices in the App's store, which its screen shows live, and an
 * intake workflow the screen starts, which marks the invoice received,
 * waits for its reviewer's decision and books it (or rejects it) through
 * the App's own `setStatus` mutation, in the release the run is pinned to.
 * The reviewer is a parameter, all admins until someone sets it.
 *
 * The screen starts, follows and answers the run through the string
 * `useWorkflow` of `@grasp-os/sdk/screen`: a screen of the React SDK has no
 * way to answer a decision until GRA-371 brings `workflow.respond`.
 */

const schema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  invoices: defineTable({ invoice: v.string().min(1).max(64), status: v.string().min(1).max(32) }).index(
    "by_invoice",
    ["invoice"]
  ),
});
`;

const operations = `import { v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

const invoice = v.object({ id: v.string(), status: v.string() });

export const list = query({
  args: {},
  returns: v.array(invoice),
  handler: async (ctx) =>
    (await ctx.db.query("invoices").withIndex("by_invoice").take(100)).map((row) => ({
      id: row.invoice,
      status: row.status,
    })),
});

/** Sets an invoice's status, adding the invoice the first time. */
export const setStatus = mutation({
  args: { invoice: v.string().min(1).max(64), status: v.string().min(1).max(32) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const [found] = await ctx.db
      .query("invoices")
      .withIndex("by_invoice", (range) => range.eq("invoice", args.invoice))
      .take(1);
    if (found === undefined) {
      await ctx.db.insert("invoices", args);
    } else {
      await ctx.db.patch("invoices", found._id, { status: args.status }, { expectedRevision: found._rev });
    }
    return null;
  },
});
`;

const registration = `import { app } from "@grasp-os/sdk";
import { list, setStatus } from "./operations/invoices.ts";
import schema from "./schema.ts";

export default app({
  name: "Invoices",
  schema,
  access: { tables: { invoices: { read: "appMembers", write: "appMembers" } } },
  operations: { invoices: { list, setStatus } },
  internalOperations: {},
  screens: [{ name: "intake", path: "/", source: "screens/intake.tsx" }],
  uses: [],
});
`;

const intakeCode = `import { person, workflow, z } from "@grasp-os/sdk/workflow";

/** The App's \`setStatus\`, as a step names it. */
const setStatus = { contractId: "invoices.setStatus", kind: "mutation" } as const;

export default workflow(
  "invoice-intake",
  {
    params: { reviewer: person({ label: "Reviewer", default: "role:admin" }) },
    input: z.object({ invoice: z.string() }),
  },
  async (step, { input, params, env }) => {
    await step.do("receive", { description: "Mark the invoice received", input: input.invoice }, async ({ input: invoice }) => {
      const answered = (await env.APP.callFunction(setStatus, { invoice, status: "received" })) as { ok: true } | { ok: false; error: unknown };
      if (!answered.ok) {
        throw answered.error;
      }
    });
    const review = await step.decision("review", {
      description: \`Approve \${input.invoice}\`,
      from: params.reviewer,
      ask: async () => {},
      timeout: "7 days",
    });
    const status = !review.timedOut && review.approved ? "booked" : "rejected";
    await step.do(
      "book",
      { description: "Book the invoice", sideEffect: true, input: { invoice: input.invoice, status } },
      async ({ input: booking }) => {
        const answered = (await env.APP.callFunction(setStatus, booking)) as { ok: true } | { ok: false; error: unknown };
        if (!answered.ok) {
          throw answered.error;
        }
      }
    );
    return { status };
  }
);
`;

const intakeTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import intake from "./invoice-intake.ts";

export default workflowTests(intake, [
  {
    name: "books an invoice the reviewer approves",
    input: { invoice: "INV-7" },
    mocks: { receive: null },
    decisions: { review: { approved: true, by: "anna" } },
    expect: { output: { status: "booked" } },
  },
]);
`;

const screenCode = `import { useQuery } from "@grasp-os/sdk/react";
import { useWorkflow } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "#grasp";

export default function Intake() {
  const invoices = useQuery(api.invoices.list, {}) ?? [];
  const intake = useWorkflow("invoice-intake");
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-medium">Invoices</h1>
      <Button onClick={() => void intake.start({ invoice: "INV-7" })}>Start intake</Button>
      <ul aria-label="Invoices">
        {invoices.map((invoice) => (
          <li key={invoice.id}>{\`\${invoice.id}: \${invoice.status}\`}</li>
        ))}
      </ul>
      <ul aria-label="Runs">
        {intake.runs.map((run) => (
          <li key={run.id} className="flex items-center gap-2">
            <span>{run.status}</span>
            {run.waitingFor.map((decision) => (
              <Button
                key={decision.name}
                onClick={() => void intake.decide(run.id, decision.name, { approved: true })}
                variant="outline"
              >
                {\`Approve \${decision.name}\`}
              </Button>
            ))}
          </li>
        ))}
      </ul>
    </main>
  );
}
`;

/** The App's files. */
export const invoiceAppFiles: Record<string, string> = {
  "schema.ts": schema,
  "operations/invoices.ts": operations,
  "app.ts": registration,
  "workflows/invoice-intake.ts": intakeCode,
  "workflows/invoice-intake.workflow-tests.ts": intakeTests,
  "screens/intake.tsx": screenCode,
};
