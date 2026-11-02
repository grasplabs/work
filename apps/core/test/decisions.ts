/**
 * The approval workflow the decision tests run, and how they drive it:
 * start it, read whom it asked, and wait on its decisions.
 */
import type { DecisionAnswerInput } from "@grasp-os/shared/decisions";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import { release } from "./apps.ts";
import { finished } from "./runs.ts";
import type { signedInApi } from "./sign-in.ts";
import { sampleCall } from "./workflow-apps.ts";

/** Someone signed in, with their API. */
export type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * The approval App, of spec 8's layout: it keeps whom each ask went to,
 * with their links, as a workflow that mails them would
 * (`approvals.remember`, once per ask: the first and the reminder are
 * calls of their own), and answers them (`approvals.asks`).
 */
export const approvalFiles: Record<string, string> = {
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
export const remember = `        const remembered = (await env.APP.callFunction({ contractId: "approvals.remember", kind: "mutation" }, { recipients: recipients.map(({ userId, name, email, link }) => ({ userId, name, email, link })), reminder })) as { ok: true } | { ok: false; error: { message: string; code: string } };
        if (!remembered.ok) {
          throw Object.assign(new Error(remembered.error.message), { code: remembered.error.code });
        }`;

/** A workflow that waits for one decision and returns how it ended. */
export const approval = `import { type Person, workflow, z } from "@grasp-os/sdk/workflow";

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

export const approvalTests = `import { workflowTests } from "@grasp-os/sdk/testing";

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

export const week = 7 * 86_400_000;

/** Who released each approval App (`approvalApp`), who reads its asks. */
const builders = new Map<string, Person>();

/**
 * A new approval App with `workflows`, released by `builder`, whose asks
 * `asksOf` reads.
 */
export const approvalAppWith = async (
  builder: Person,
  workflows: Record<string, string>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Approvals" });
  await release(builder, id, { ...approvalFiles, ...workflows });
  builders.set(id, builder);
  return id;
};

/** A new App with the approval workflow, released by `builder`. */
export const approvalApp = async (builder: Person): Promise<string> =>
  await approvalAppWith(builder, {
    "workflows/approval.ts": approval,
    "workflows/approval.workflow-tests.ts": approvalTests,
  });

export const askSchema = z.array(
  z.object({
    recipients: z.array(
      z.object({
        userId: z.string(),
        name: z.string(),
        email: z.string(),
        link: z.url(),
      })
    ),
    reminder: z.boolean(),
  })
);
export type Ask = z.infer<typeof askSchema>[number];

/**
 * The asks the approval App kept, as the builder who released it reads
 * them, once there are `count` of them.
 */
export const asksOf = async (app: string, count = 1): Promise<Ask[]> => {
  const builder = builders.get(app);
  if (builder === undefined) {
    throw new Error("Not an approval App of these tests");
  }
  return await vi.waitFor(
    async () => {
      const kept = await sampleCall(
        builder,
        app,
        "approvals.asks",
        "query",
        {}
      );
      if (!Array.isArray(kept)) {
        throw new TypeError(`The asks didn't read: ${String(kept)}`);
      }
      const asks = askSchema.parse(
        kept.map((body: unknown): unknown => {
          const parsed: unknown = JSON.parse(String(body));
          return parsed;
        })
      );
      if (asks.length < count) {
        throw new Error(`${asks.length} of ${count} asks so far`);
      }
      return asks;
    },
    { timeout: 20_000, interval: 100 }
  );
};

/** Starts the approval workflow and waits until it has asked. */
export const asking = async (
  builder: Person,
  input: { from: string; timeout: number; remindAfter?: number },
  source = approval
) => {
  const app = await approvalAppWith(builder, {
    "workflows/approval.ts": source,
    "workflows/approval.workflow-tests.ts": approvalTests,
  });
  const run = await builder.api.workflows.start(app, "approval", input);
  const [ask] = await asksOf(app);
  if (!ask) {
    throw new Error("No ask");
  }
  const decision = await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        "SELECT id FROM workflow_decisions WHERE run_id = ?"
      )
        .bind(run.id)
        .first<{ id: string }>();
      if (!row) {
        throw new Error("No decision yet");
      }
      return row.id;
    },
    { timeout: 10_000 }
  );
  return { app, run, ask, decision };
};

/** What the run returned, once it has ended. */
export const outputOf = async (
  builder: Person,
  run: string
): Promise<unknown> => {
  await finished(run);
  const { output } = await builder.api.workflows.status(run);
  return output;
};

/** An answer to a decision, as a person gives it. */
type Answer = DecisionAnswerInput;

/**
 * `person`'s answer to `decision` through the trusted host decision UI,
 * as the decision's page gives it: reviewed, confirmed, then answered with
 * that confirmation. Nothing more is asked once it is recorded.
 */
export const confirmedAnswer = async (
  person: Person,
  decision: string,
  answer: Answer
) => {
  const review = await person.api.decisions.review(decision, answer);
  if (review.state === "recorded") {
    return review.decision;
  }
  const { confirmation } = await person.api.decisions.confirm(
    decision,
    review.decision.revision,
    review.response
  );
  return await person.api.decisions.answer(
    decision,
    review.response,
    confirmation
  );
};
