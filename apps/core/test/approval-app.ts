/**
 * An App with a workflow of its own (`approval`, which waits for a
 * decision), for the tests that need a released App whose workflow a
 * screen follows and the RPC walk reaches: until App-owned TypeScript
 * workflows go (GRA-1367). Decisions themselves are tested on JSON
 * workflows (decisions.ts).
 */
import { release } from "./apps.ts";
import type { signedInApi } from "./sign-in.ts";

/** Someone signed in, with their API. */
type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * The approval App, of spec 8's layout: it keeps whom each ask went to,
 * with their links, as a workflow that mails them would
 * (`approvals.remember`, once per ask: the first and the reminder are
 * calls of their own), and answers them (`approvals.asks`).
 */
const approvalFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ asks: defineTable({ body: v.string() }) });
`,
  "operations/approvals.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

const recipient = v.object({ userId: v.string(), name: v.string(), email: v.string(), link: v.string() });

export const remember = mutation({
  args: { recipients: v.array(recipient), reminder: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("asks", { body: JSON.stringify(args) });
    return null;
  },
});

export const asks = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("asks").take(100)).map(({ body }) => body),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";

import { asks, remember } from "./operations/approvals.ts";
import schema from "./schema.ts";

export default app({
  name: "Approvals",
  schema,
  access: { tables: { asks: { read: "appMembers", write: "appMembers" } } },
  operations: { approvals: { remember, asks } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
};

/**
 * An ask's code that keeps its recipients and whether it is the reminder
 * in the approval App (`approvals.remember`), failing as it refuses.
 */
const remember = `        const remembered = (await env.APP.callFunction({ contractId: "approvals.remember", kind: "mutation" }, { recipients: recipients.map(({ userId, name, email, link }) => ({ userId, name, email, link })), reminder })) as { ok: true } | { ok: false; error: { message: string; code: string } };
        if (!remembered.ok) {
          throw Object.assign(new Error(remembered.error.message), { code: remembered.error.code });
        }`;

/** A workflow that waits for one decision and returns how it ended. */
const approval = `import { type Person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "approval",
  {
    params: {},
    input: z.object({ from: z.string(), timeout: z.number(), remindAfter: z.number().optional() }),
  },
  async (step, { input, env }) =>
    await step.decision("review", {
      description: "Approve the invoice",
      from: input.from as Person,
      ask: async ({ recipients, reminder }) => {
${remember}
      },
      timeout: input.timeout,
      ...(input.remindAfter === undefined ? {} : { remindAfter: input.remindAfter }),
    })
);
`;

const approvalTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import approval from "./approval.ts";

export default workflowTests(approval, [
  {
    name: "ends with the answer",
    input: { from: "role:admin", timeout: 1000 },
    decisions: { review: { approved: true, by: "anna" } },
    expect: { output: { timedOut: false, approved: true, by: "anna", payload: null } },
  },
]);
`;

/** A new App with the approval workflow, released by `builder`. */
export const approvalApp = async (builder: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Approvals" });
  await release(builder, id, {
    ...approvalFiles,
    "workflows/approval.ts": approval,
    "workflows/approval.workflow-tests.ts": approvalTests,
  });
  return id;
};
