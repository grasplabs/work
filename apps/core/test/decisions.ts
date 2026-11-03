/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
/**
 * The approval workflow the decision tests run, and how they drive it:
 * start it, read whom it asked, and wait on its decisions.
 */
import { v } from "@grasp-os/sdk";
import type { DecisionAnswerInput } from "@grasp-os/shared/decisions";
import { runFileContentPath } from "@grasp-os/shared/run-files";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import { finished } from "./runs.ts";
import type { signedInApi } from "./sign-in.ts";
import { routed, unique } from "./sign-in.ts";

/** Someone signed in, with their API. */
export type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * The approval workflow's own action, which tells the people its decision
 * asks (the decision's `ask`): it keeps whom each ask went to, with their
 * links, as a file of its run's (`ask.json`, then `reminder.json`), as an
 * action that mails them would send each once.
 */
const askModule = `import { action, resource, v } from "@grasp-os/sdk/action";

const files = resource.files("files", { operations: ["write"] });
const recipient = v.object({ userId: v.string(), name: v.string(), email: v.string(), link: v.string() });

export const ask = action({
  args: { recipients: v.array(recipient), reminder: v.boolean() },
  returns: v.null(),
  uses: [files],
  handler: async (ctx, args) => {
    await ctx.resources.files.write({
      name: args.reminder ? "reminder.json" : "ask.json",
      type: "application/json",
      content: JSON.stringify(args),
    });
    return null;
  },
});
`;

/**
 * What a person may answer: nothing, or a comment, with a total and a
 * nested value besides (what decision-confirmations.test.ts sends).
 */
const answers = v.union(
  v.null(),
  v.object({
    comment: v.string(),
    total: v.number().optional(),
    nested: v.object({ a: v.null(), b: v.number() }).optional(),
  })
);

/** `answers`, as the workflow's output schema has it. */
const responseSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      properties: {
        comment: { type: "string" },
        total: { type: "number" },
        nested: {
          type: "object",
          properties: { a: { type: "null" }, b: { type: "number" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
      },
      required: ["comment"],
      additionalProperties: false,
    },
  ],
};

/** A JSON object schema of `properties`, each required, and nothing else. */
const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** How the approval workflow asks: whom, for how long, when it reminds. */
export interface Asking {
  /** Who decides: `person:<id>`, `team:<id>` or `role:<name>`. */
  from: string;
  /** How long it takes answers, in ms. */
  timeout: number;
  /** How long after asking it asks once more, in ms. */
  remindAfter?: number;
}

/**
 * The definition of approval workflow `name`: it asks `from` to approve
 * the invoice, telling them by its own action (`ask`), reminding them
 * `remindAfter` after asking, if given, and waiting `timeout` at most,
 * then ends with the decision's answer. Its bindings: the decision
 * contract `contract`, the action, and the run's files under the files
 * contract `files`.
 */
const approvalOf = (
  name: string,
  { contract, files }: { contract: string; files: string },
  { from, timeout, remindAfter }: Asking
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: {
            approval: { kind: "decision", contract },
            ask: { kind: "operation", contract: "local:code/ask.ts#ask" },
            files: { kind: "files", contract: files },
          },
        },
      },
    },
    input: { schema: objectSchema({ invoice: { type: "string" } }) },
    output: {
      schema: objectSchema({
        answered: { type: "boolean" },
        approved: { type: "boolean" },
        by: { type: "string" },
        value: responseSchema,
      }),
    },
    do: [
      {
        review: {
          call: "grasp.decision",
          with: {
            binding: "approval",
            recipients: [from],
            prompt: "Approve the invoice",
            input: { invoice: "${ $workflow.input.invoice }" },
            ask: "ask",
            ...(remindAfter === undefined
              ? {}
              : { remindAfter: { milliseconds: remindAfter } }),
          },
          timeout: { after: { milliseconds: timeout } },
        },
      },
    ],
  });

export const week = 7 * 86_400_000;

/**
 * A decision a test acts on while it waits for the reminder: the reminder
 * is due five seconds after the ask, which leaves a slow runner room for
 * what a test does first (change a team, stop the run). The deadline, ten
 * seconds after the decision opened, leaves room after it.
 */
export const reminding = { timeout: 10_000, remindAfter: 5000 };

/**
 * A new approval workflow asking as `asking` says, published by
 * `builder`, its decision contract and files published and its bindings
 * approved by `admin`, the decision's for `asking.from`: its ID.
 */
export const approvalWorkflow = async (
  { admin, builder }: { admin: Person; builder: Person },
  asking: Asking
): Promise<string> => {
  const contract = `approval-${unique()}`;
  const files = `asks-${unique()}`;
  await admin.api.workflowResources.publishContract({
    key: contract,
    kind: "decision",
    input: JSON.stringify(v.object({ invoice: v.string() }).descriptor),
    response: JSON.stringify(answers.descriptor),
  });
  await admin.api.workflowResources.publishContract({
    key: files,
    kind: "files",
  });
  const { id, name } = await builder.api.workflowResources.create(
    `approval-${unique()}`
  );
  await builder.api.workflowResources.publish(id, {
    definition: approvalOf(name, { contract, files }, asking),
    basedOn: null,
    modules: { "code/ask.ts": askModule },
  });
  await admin.api.workflowResources.approveBinding(id, {
    alias: "approval",
    target: { kind: "decision", deciders: [asking.from] },
    reviewed: { version: 1 },
  });
  await admin.api.workflowResources.approveBinding(id, {
    alias: "files",
    target: { kind: "files" },
    reviewed: { version: 1 },
  });
  return id;
};

/** A run of approval workflow `workflow`, started by `by`. */
export interface ApprovalRun {
  workflow: string;
  run: string;
  by: Person;
}

/** Starts a run of approval workflow `workflow` as `by`: its ID. */
export const startedApproval = async (
  by: Person,
  workflow: string
): Promise<ApprovalRun> => {
  const { runId } = await by.api.workflowResources.start(workflow, {
    version: 1,
    input: { invoice: "INV-7" },
    key: unique(),
  });
  return { workflow, run: z.string().parse(runId), by };
};

export const askSchema = z.object({
  recipients: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      email: z.string(),
      link: z.url(),
    })
  ),
  reminder: z.boolean(),
});
export type Ask = z.infer<typeof askSchema>;

/**
 * The asks approval run `run` made, as the person who started it
 * downloads its files from its run sheet, in the order they were made,
 * once there are `count` of them.
 */
export const asksOf = async (
  { workflow, run, by }: ApprovalRun,
  count = 1
): Promise<Ask[]> =>
  await vi.waitFor(
    async () => {
      const listed =
        (await by.api.workflowResources.runFiles(workflow, run)) ?? [];
      if (listed.length < count) {
        throw new Error(`${listed.length} of ${count} asks so far`);
      }
      return await Promise.all(
        listed
          .toSorted((a, b) => a.finishedAt.localeCompare(b.finishedAt))
          .map(async ({ id }) => {
            const response = await routed(
              runFileContentPath(workflow, run, id),
              {
                headers: {
                  cookie: by.session,
                  "sec-fetch-site": "same-origin",
                },
              }
            );
            return askSchema.parse(await response.json());
          })
      );
    },
    { timeout: 20_000, interval: 100 }
  );

/**
 * The decision approval run `run` opened, once the run has asked its
 * people and waits on it: its ID.
 */
export const decisionOfRun = async (run: ApprovalRun): Promise<string> => {
  await asksOf(run);
  return await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        "SELECT id FROM workflow_decisions WHERE resource_run_id = ?"
      )
        .bind(run.run)
        .first<{ id: string }>();
      if (!row) {
        throw new Error("No decision yet");
      }
      return row.id;
    },
    { timeout: 10_000 }
  );
};

/**
 * A run of a new approval workflow asking as `asking` says, started by
 * `owners.builder`, once it has asked: the run, its first ask and its
 * decision.
 */
export const asking = async (
  owners: { admin: Person; builder: Person },
  input: Asking
) => {
  const workflow = await approvalWorkflow(owners, input);
  const run = await startedApproval(owners.builder, workflow);
  const decision = await decisionOfRun(run);
  const [ask] = await asksOf(run);
  if (!ask) {
    throw new Error("No ask");
  }
  return { run, ask, decision };
};

/** How approval run `run` ended: its output, or its error's code. */
export const outputOf = async ({
  workflow,
  run,
  by,
}: ApprovalRun): Promise<unknown> => {
  await finished(run);
  const ended = await by.api.workflowResources.run(workflow, run);
  return ended.status === "completed"
    ? ended.output
    : { status: ended.status, code: ended.error?.code };
};

/** Whether `decision`'s deadline has passed, by the database's clock. */
export const deadlinePassed = async (decision: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT (julianday('now') - 2440587.5) * 86400000 > expires_at AS past FROM workflow_decisions WHERE id = ?"
  )
    .bind(decision)
    .first<{ past: number }>();
  return row?.past === 1;
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
