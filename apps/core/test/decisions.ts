/**
 * The approval workflow the decision tests run, and how they drive it:
 * start it, and wait on its decision.
 */
import { v } from "@grasp-os/sdk";
import type { DecisionAnswerInput } from "@grasp-os/shared/decisions";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import { finished, liveStatus } from "./runs.ts";
import type { signedInApi } from "./sign-in.ts";
import { unique } from "./sign-in.ts";

/** Someone signed in, with their API. */
export type Person = Awaited<ReturnType<typeof signedInApi>>;

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
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** How the approval workflow asks: whom, and for how long. */
export interface Asking {
  /** Who decides: `person:<id>`, `team:<id>` or `role:<name>`. */
  from: string;
  /** How long it takes answers, in ms: whole seconds. */
  timeout: number;
}

/** What the approval's decision answered, as its output reads it. */
const answered = "steps.review.output";

/**
 * The approval workflow's definition: it asks `from` to approve the
 * invoice through decision binding `approval` (contract `contract`),
 * waiting `timeout` at most, and ends with the answer. A decision nobody
 * answered in time fails the run (`urn:grasp:error:unanswered`): its
 * output is never made up.
 */
const approvalOf = (contract: string, { from, timeout }: Asking): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectSchema({ invoice: { type: "string" } }),
    output: {
      schema: objectSchema({
        answered: { type: "boolean" },
        approved: { type: "boolean" },
        by: { type: "string" },
        value: responseSchema,
      }),
      value: {
        answered: true,
        approved: { $expr: `${answered}.approved` },
        by: { $expr: `${answered}.by` },
        value: { $expr: `${answered}.payload` },
      },
    },
    bindings: { approval: { kind: "decision", contract } },
    steps: [
      {
        id: "review",
        type: "decision",
        binding: "approval",
        recipients: [from],
        prompt: "Approve the invoice",
        input: { invoice: { $expr: "input.invoice" } },
        timeout: `${timeout / 1000} seconds`,
      },
      {
        id: "unanswered",
        type: "raise",
        if: { $expr: `${answered}.timedOut` },
        error: { type: "urn:grasp:error:unanswered", status: 408 },
      },
    ],
  });

export const day = 86_400_000;
export const week = 7 * day;

/**
 * A new approval workflow asking as `asking` says, published by
 * `builder`, its decision contract published and its binding approved by
 * `admin`, for `asking.from`: its ID.
 */
export const approvalWorkflow = async (
  { admin, builder }: { admin: Person; builder: Person },
  asking: Asking
): Promise<string> => {
  const contract = `approval-${unique()}`;
  await admin.api.workflowResources.publishContract({
    key: contract,
    kind: "decision",
    input: JSON.stringify(v.object({ invoice: v.string() }).descriptor),
    response: JSON.stringify(answers.descriptor),
  });
  const { id } = await builder.api.workflowResources.create(
    `approval-${unique()}`
  );
  await builder.api.workflowResources.publish(id, {
    definition: approvalOf(contract, asking),
    basedOn: null,
  });
  await admin.api.workflowResources.approveBinding(id, {
    alias: "approval",
    target: { kind: "decision", deciders: [asking.from] },
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

/**
 * The decision approval run `run` opened, once the run waits on it: its
 * ID.
 */
export const decisionOfRun = async (run: ApprovalRun): Promise<string> =>
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        "SELECT id FROM workflow_decisions WHERE resource_run_id = ?"
      )
        .bind(run.run)
        .first<{ id: string }>();
      if (!row) {
        throw new Error("No decision yet");
      }
      if ((await liveStatus(run.run)) !== "waiting") {
        throw new Error("Not waiting on its decision yet");
      }
      return row.id;
    },
    { timeout: 20_000, interval: 100 }
  );

/**
 * A run of a new approval workflow asking as `asking` says, started by
 * `owners.builder`, once it waits on its decision: the run and its
 * decision.
 */
export const asking = async (
  owners: { admin: Person; builder: Person },
  input: Asking
) => {
  const workflow = await approvalWorkflow(owners, input);
  const run = await startedApproval(owners.builder, workflow);
  const decision = await decisionOfRun(run);
  return { run, decision };
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
