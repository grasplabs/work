/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { v } from "@grasp-os/sdk";
import { declaredWorkflows, workflowFingerprint } from "@grasp-os/sdk/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { activateVersion } from "../src/app-activation.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { fixtureHostFor } from "../src/app-tests.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { findApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { resumed, stopped } from "./runs.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";

// A decision a run an App's test started waits for (`workflowTest`,
// workflows/fixture-decisions.ts), from its threat model first: answered
// by a principal it doesn't ask, or by the run's own; a recipient the
// fixture's binding doesn't cover; a second answer; an answer to a run
// that was cancelled; a replay asking or taking twice; a decline or no
// answer taken for an approval; the decision reaching the organization's
// own decisions. Then the run taking the branch its answer chose.

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** The review task: asks `$params.reviewer` about the invoice. */
const requestReview = (timeout?: { seconds: number }) => ({
  "request-review": {
    call: "grasp.decision",
    with: {
      binding: "invoiceApproval",
      recipients: "${ [$params.reviewer] }",
      prompt: "Approve this invoice?",
      input: "${ $workflow.input }",
    },
    ...(timeout === undefined ? {} : { timeout: { after: timeout } }),
    export: { as: "${ $context + {review: .} }" },
  },
});

/** Approval, then the branch its answer takes. */
const approvalTasks = (timeout?: { seconds: number }) => [
  requestReview(timeout),
  {
    "review-route": {
      switch: [
        {
          accepted: {
            when: "${ $context.review.approved == true }",
            then: "approved",
          },
        },
        { declined: { then: "rejected" } },
      ],
    },
  },
  { approved: { set: { status: "approved" }, then: "end" } },
  { rejected: { set: { status: "rejected" }, then: "end" } },
];

/** The approval workflow `name`, its decision binding on `contract`. */
const definitionOf = (
  name: string,
  contract: string,
  tasks: unknown[]
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
          params: {
            reviewer: {
              schema: { type: "string", "x-grasp-value": { kind: "person" } },
              label: "Reviewer",
              required: true,
              sensitive: false,
            },
          },
          bindings: { invoiceApproval: { kind: "decision", contract } },
        },
      },
    },
    input: { schema: objectSchema({ amount: { type: "number" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

/** What an answer carries: a comment, or nothing. */
const response = v.union(v.null(), v.object({ comment: v.string() }));

/** What each test's fixture gives the approval workflow. */
interface Given {
  /** Whom the run asks, by principal name. */
  reviewer?: string;
  /** Who the binding lets answer, by principal name. */
  deciders?: string[];
}

/**
 * The App's files: it binds `approval`, its fixture `desk` naming
 * `desk-user` (who starts runs), `approver` and `other`, with `tests`.
 */
const filesWith = (
  { reviewer = "approver", deciders = ["approver"] }: Given,
  tests: Record<string, string> = {}
): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  invoices: defineTable({ amount: v.number() }),
});
`,
  "operations/invoices.ts": `import { resource, v } from "@grasp-os/sdk";

export const approval = resource.workflow("approval", {
  input: v.object({ amount: v.number() }),
  output: v.object({ status: v.string() }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { approval } from "./operations/invoices.ts";
import schema from "./schema.ts";

export default app({
  name: "Invoices",
  schema,
  access: { tables: { invoices: { read: "appMembers", write: "appMembers" } } },
  operations: {},
  screens: [],
  uses: [approval],
});
`,
  "tests/fixtures/desk.json": JSON.stringify({
    principals: {
      "desk-user": { role: "user" },
      approver: { role: "user" },
      other: { role: "user" },
    },
    workflows: {
      approval: {
        params: { reviewer },
        deciders: { invoiceApproval: deciders },
      },
    },
  }),
  ...tests,
});

/** The Invoices App, binding the approval workflow of `tasks`. */
const invoicesApp = async (
  given: Given = {},
  {
    tasks = approvalTasks(),
    tests = {},
  }: { tasks?: unknown[]; tests?: Record<string, string> } = {}
) => {
  const admin = await person("admin");
  const builder = await person("builder");
  const contract = `invoice-approval-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "decision",
    input: JSON.stringify(v.object({ amount: v.number() }).descriptor),
    response: JSON.stringify(response.descriptor),
  });
  const files = filesWith(given, tests);
  const fixture = await appWith(files, "Invoices", builder);
  const workflow = await createWorkflowResource(
    env,
    builder,
    `approve-${unique()}`
  );
  await publishWorkflowVersion(env, builder, workflow.id, {
    definition: definitionOf(workflow.name, contract, tasks),
    basedOn: null,
  });
  await bindWorkflowToApp(env, builder, workflow.id, {
    app: fixture.app,
    alias: "approval",
    version: 1,
  });
  await seal(fixture);
  const release = await loadRelease(env, fixture.app, 1);
  return { builder, app: fixture.app, release, files };
};

/** A start of `approval` on an invoice of `amount`, as the SDK sends it. */
const startOf = async (release: Release, amount: number): Promise<string> => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    ({ alias }) => alias === "approval"
  );
  if (declared === undefined) {
    throw new Error("No approval");
  }
  return JSON.stringify({
    workflow: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: "workflows.approval",
      fingerprint: await workflowFingerprint(declared),
      kind: "workflow",
    },
    command: "start",
    input: { amount },
    idempotencyKey: "0".repeat(32),
  });
};

const resultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
]);

/** What a session's call answered: `ok`, or the refusal's code. */
const codeOf = (answer: string): string => {
  const result = resultSchema.parse(JSON.parse(answer));
  return result.ok ? "ok" : result.error.code;
};

/** A test session on `app`'s release, and a run of it `desk-user` started. */
const runningIn = async (app: Awaited<ReturnType<typeof invoicesApp>>) => {
  const host = fixtureHostFor(env, app.release, app.files);
  const session = await host.open("desk", `test-${unique()}`);
  const started = resultSchema.parse(
    JSON.parse(
      await session.start("desk-user", await startOf(app.release, 5000))
    )
  );
  if (!started.ok) {
    throw new Error(`The start was refused: ${started.error.code}`);
  }
  const { run } = z.object({ run: z.number() }).parse(started.value);
  const row = await env.DB.prepare(
    "SELECT run_id AS id FROM app_test_runs WHERE app_id = ?"
  )
    .bind(app.app)
    .first<{ id: string }>();
  if (row === null) {
    throw new Error("No test run recorded");
  }
  return { session, run, runId: row.id };
};

type Session = Awaited<ReturnType<typeof runningIn>>["session"];

/** `who`'s answer to the run's review, as `respond` sends it. */
const respond = async (
  session: Session,
  who: string,
  run: number,
  answer: { approved: boolean; value?: unknown }
): Promise<string> =>
  codeOf(
    await session.respond(
      who,
      run,
      JSON.stringify({ task: "request-review", ...answer })
    )
  );

/**
 * How run `run` of `session` ended, as the test is told: its failure by
 * its code alone, whose words are the platform's.
 */
const endOf = async (session: Session, run: number): Promise<unknown> => {
  const ended = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(await session.runOutcome(run)));
  const { message: _words, ...rest } = ended;
  return rest;
};

/** The test's decisions of run `runId`, as their rows have them. */
const decisionsOf = async (runId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT recipient, status, decided_by AS decidedBy FROM app_test_decisions WHERE run_id = ?"
  )
    .bind(runId)
    .all<{ recipient: string; status: string; decidedBy: string | null }>();
  return results;
};

/** How many decisions run `runId` opened. */
const decisionCount = async (runId: string): Promise<number> => {
  const rows = await decisionsOf(runId);
  return rows.length;
};

/** The organization's own decisions of run `runId`. */
const organizationDecisionsOf = async (runId: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM workflow_decisions WHERE resource_run_id = ? OR run_id = ?"
  )
    .bind(runId, runId)
    .first<{ n: number }>();
  return row?.n ?? -1;
};

/** Once run `runId` has opened its decision. */
const asked = async (runId: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(decisionsOf(runId)).resolves.toHaveLength(1);
    },
    { timeout: 20_000, interval: 100 }
  );
};

/** Activates version 1: `current`, or the refusal's failures. */
const activated = async (
  by: Acting & Identity,
  app: string
): Promise<unknown> => {
  try {
    await activateVersion(env, by, app, 1);
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    return error.details?.failures ?? error.code;
  }
  const found = await findApp(env, app);
  return found.currentVersion === 1 ? "current" : found.currentVersion;
};

describe(
  "a decision a workflow test's run waits for",
  { timeout: 120_000 },
  () => {
    it("is answered by the principal it asks: the run takes the approved branch, and the organization's decisions never hear of it", async () => {
      const app = await invoicesApp();
      const { session, run, runId } = await runningIn(app);
      const answered = await respond(session, "approver", run, {
        approved: true,
        value: { comment: "Fine" },
      });
      expect({
        answered,
        end: await endOf(session, run),
        decisions: await decisionsOf(runId),
        organization: await organizationDecisionsOf(runId),
      }).toStrictEqual({
        answered: "ok",
        end: { status: "completed", output: { status: "approved" } },
        decisions: [
          { recipient: "approver", status: "approved", decidedBy: "approver" },
        ],
        organization: 0,
      });
      await session.close();
    });

    it("takes a decline to the rejected branch, never to approved", async () => {
      const app = await invoicesApp();
      const { session, run } = await runningIn(app);
      expect({
        answered: await respond(session, "approver", run, { approved: false }),
        end: await endOf(session, run),
      }).toStrictEqual({
        answered: "ok",
        end: { status: "completed", output: { status: "rejected" } },
      });
      await session.close();
    });

    it("refuses an answer by a principal it doesn't ask, or by the run's own, leaving the run waiting for its recipient", async () => {
      const app = await invoicesApp();
      const { session, run, runId } = await runningIn(app);
      const other = await respond(session, "other", run, { approved: true });
      const own = await respond(session, "desk-user", run, { approved: true });
      const meanwhile = await decisionsOf(runId);
      const status = await runEngine(env).status(runId);
      const answered = await respond(session, "approver", run, {
        approved: false,
      });
      expect({
        other,
        own,
        meanwhile,
        waiting: status?.status,
        answered,
        end: await endOf(session, run),
      }).toStrictEqual({
        other: "decision.forbidden",
        own: "decision.forbidden",
        meanwhile: [{ recipient: "approver", status: "open", decidedBy: null }],
        waiting: "waiting",
        answered: "ok",
        end: { status: "completed", output: { status: "rejected" } },
      });
      await session.close();
    });

    it("refuses an answer its contract doesn't take, leaving the decision open for one it does", async () => {
      const app = await invoicesApp();
      const { session, run, runId } = await runningIn(app);
      const wrong = await respond(session, "approver", run, {
        approved: true,
        value: { comment: 42 },
      });
      const meanwhile = await decisionsOf(runId);
      expect({
        wrong,
        meanwhile: meanwhile.map(({ status }) => status),
        answered: await respond(session, "approver", run, { approved: true }),
        end: await endOf(session, run),
      }).toStrictEqual({
        wrong: "decision.invalid",
        meanwhile: ["open"],
        answered: "ok",
        end: { status: "completed", output: { status: "approved" } },
      });
      await session.close();
    });

    it("opens nothing for a recipient the fixture's binding doesn't cover, nor for the run's own principal", async () => {
      const uncovered = await invoicesApp({ reviewer: "other" });
      const first = await runningIn(uncovered);
      const own = await invoicesApp({
        reviewer: "desk-user",
        deciders: ["approver", "desk-user"],
      });
      const second = await runningIn(own);
      expect({
        uncovered: await endOf(first.session, first.run),
        uncoveredDecisions: await decisionsOf(first.runId),
        own: await endOf(second.session, second.run),
        ownDecisions: await decisionsOf(second.runId),
      }).toStrictEqual({
        uncovered: {
          status: "failed",
          code: "workflow.call_denied",
        },
        uncoveredDecisions: [],
        own: {
          status: "failed",
          code: "workflow.call_invalid",
        },
        ownDecisions: [],
      });
      await first.session.close();
      await second.session.close();
    });

    it("takes the first answer only: a second is refused, and the first stands", async () => {
      const app = await invoicesApp();
      const { session, run, runId } = await runningIn(app);
      await asked(runId);
      // Held while it waits, so the second answer meets an open run.
      await stopped(runId);
      const first = await respond(session, "approver", run, { approved: true });
      const second = await respond(session, "approver", run, {
        approved: false,
      });
      await resumed(runId);
      expect({
        first,
        second,
        end: await endOf(session, run),
        decisions: await decisionsOf(runId),
      }).toStrictEqual({
        first: "ok",
        second: "decision.closed",
        end: { status: "completed", output: { status: "approved" } },
        decisions: [
          { recipient: "approver", status: "approved", decidedBy: "approver" },
        ],
      });
      await session.close();
    });

    it("refuses an answer once the run was cancelled, recording nothing", async () => {
      const app = await invoicesApp();
      const { session, run, runId } = await runningIn(app);
      await asked(runId);
      await runEngine(env).terminate(runId);
      expect({
        answered: await respond(session, "approver", run, { approved: true }),
        end: await endOf(session, run),
        decisions: await decisionsOf(runId),
      }).toStrictEqual({
        answered: "decision.closed",
        end: { status: "cancelled" },
        decisions: [{ recipient: "approver", status: "open", decidedBy: null }],
      });
      await session.close();
    });

    it("asks once and takes the answer once when the run stops while it waits and starts again", async () => {
      const app = await invoicesApp();
      const { session, run, runId } = await runningIn(app);
      await asked(runId);
      // Down while it waits, answered meanwhile, then back: the workflow
      // runs again from its start, its finished steps replayed.
      await stopped(runId);
      const answered = await respond(session, "approver", run, {
        approved: true,
      });
      await resumed(runId);
      expect({
        answered,
        end: await endOf(session, run),
        decisions: await decisionCount(runId),
        completed: await session.completedCount(run, "request-review"),
      }).toStrictEqual({
        answered: "ok",
        end: { status: "completed", output: { status: "approved" } },
        decisions: 1,
        completed: 1,
      });
      await session.close();
    });

    it("fails the run when nobody answers before the task's timeout: no outcome is made up", async () => {
      const app = await invoicesApp(
        {},
        { tasks: approvalTasks({ seconds: 2 }) }
      );
      const { session, run, runId } = await runningIn(app);
      expect({
        end: await endOf(session, run),
        decisions: await decisionsOf(runId),
        late: await respond(session, "approver", run, { approved: true }),
      }).toStrictEqual({
        end: {
          status: "failed",
          code: "workflow.decision_timed_out",
        },
        decisions: [
          { recipient: "approver", status: "timed_out", decidedBy: null },
        ],
        late: "decision.closed",
      });
      await session.close();
    });

    it("goes with its run's record when the test ends", async () => {
      const app = await invoicesApp();
      const { session, runId } = await runningIn(app);
      await asked(runId);
      await session.close();
      await expect(decisionsOf(runId)).resolves.toStrictEqual([]);
    });

    it("is answered from a suite through respond, a version activated only once its suite passes", async () => {
      const app = await invoicesApp(
        {},
        {
          tests: {
            "tests/approval.test.ts": `import { workflowTest } from "@grasp-os/sdk/testing";
import { workflows } from "#grasp";

export default workflowTest({
  fixtures: "desk",
  tests: {
    "an approver's approval takes the approved branch": async (t) => {
      const desk = await t.as("desk-user");
      const approver = await t.as("approver");
      const run = await desk.start(workflows.approval, { amount: 5000 });
      await t.rejectsCode(
        desk.respond(run, "request-review", { approved: true }),
        "decision.forbidden"
      );
      await approver.respond(run, "request-review", {
        approved: true,
        value: { comment: "Fine" },
      });
      t.equal(await t.runs.untilTerminal(run), {
        status: "completed",
        output: { status: "approved" },
      });
      await t.rejectsCode(
        approver.respond(run, "request-review", { approved: false }),
        "decision.closed"
      );
    },
  },
});
`,
          },
        }
      );
      await expect(activated(app.builder, app.app)).resolves.toBe("current");
    });
  }
);
