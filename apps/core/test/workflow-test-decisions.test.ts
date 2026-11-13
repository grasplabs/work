import { v } from "@grasp-os/runtime/app";
import { declaredWorkflows } from "@grasp-os/runtime/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { fixtureHostFor } from "../src/app-tests.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appKind, findApp, releaseIdsOf } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { rollback } from "../src/publish.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { resumed, stopped, whileEngineRefuses } from "./runs.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// A decision a run an App's test started waits for (`identity.start`,
// workflows/fixture-decisions.ts), from its threat model first: answered
// by a principal it doesn't ask, or by the run's own; a recipient the
// start's binding doesn't cover; a second answer; an answer to a run
// that was cancelled; a replay asking or taking twice; a decline or no
// answer taken for an approval; the decision reaching the organization's
// own decisions. Then the run taking the branch its answer chose.

const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** The review: asks `recipients` (the reviewer parameter's) about `input`. */
const reviewOf = ({
  recipients = { $expr: "[params.reviewer]" },
  input = { $expr: "args" },
  timeout,
}: { recipients?: unknown; input?: unknown; timeout?: string } = {}) => ({
  id: "review",
  type: "decide",
  decision: "invoiceApproval",
  recipients,
  prompt: "Approve this invoice?",
  input,
  ...(timeout === undefined ? {} : { timeout }),
});

/** Fails the run when nobody answered `review` in time. */
const unanswered = {
  id: "unanswered",
  type: "raise",
  if: { $expr: "review.timedOut" },
  error: { code: "test.unanswered", message: "Failed." },
};

/** The approval: its review, then the status its answer chose. */
const approvalSteps = (review = reviewOf()): unknown[] => [review, unanswered];

/** What an approval ends with: approved, unless its review declined it. */
const approvalStatus = {
  $expr: '!review.timedOut && review.approved ? "approved" : "rejected"',
};

/** A review of each of two invoices, in turn. */
const loopSteps = [
  {
    id: "eachInvoice",
    type: "forEach",
    items: { $expr: "[100, 200]" },
    do: [reviewOf({ input: { amount: { $expr: "item" } } })],
  },
];

/**
 * The approval workflow of `steps`, its decision binding on `contract`,
 * its person parameter `reviewer`, ending with `status`.
 */
const definitionOf = (
  contract: string,
  steps: unknown[],
  status: unknown
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ amount: { kind: "number" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status },
    params: {
      reviewer: {
        label: "Reviewer",
        type: { kind: "person", default: "role:admin" },
        sensitive: false,
      },
    },
    permissions: { decisions: { invoiceApproval: { contract } } },
    steps,
  });

/** What an answer carries: a comment, or nothing. */
const response = v.union(v.null(), v.object({ comment: v.string() }));

/** What each test's start gives the approval workflow. */
interface Given {
  /** Whom the run asks, by identity name. */
  reviewer?: string;
  /** Who the binding lets answer, by identity name. */
  deciders?: string[];
}

/** The start options `given` makes: the reviewer a parameter, the deciders. */
const optionsOf = ({
  reviewer = "approver",
  deciders = ["approver"],
}: Given) => ({
  params: { reviewer: `person:${reviewer}` },
  deciders: { invoiceApproval: deciders },
});

/** The App's files: it binds `approval`, with `tests`. */
const filesWith = (tests: Record<string, string> = {}): TestApp =>
  testApp(
    {
      name: "Invoices",
      tables: {
        invoices: {
          fields: { amount: "v.number()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
      permissions: [
        'permission.workflow("approval", {\n  args: v.object({ amount: v.number() }),\n  returns: v.object({ status: v.string() }),\n})',
      ],
      // Its decision, as the version bound asks it.
      contracts: {
        approval: {
          events: {},
          listens: {},
          decisions: {
            invoiceApproval: {
              value: response.descriptor,
              context: v.object({ amount: v.number() }).descriptor,
            },
          },
        },
      },
    },
    {
      "server/invoices.ts": `import { v } from "@grasp-os/sdk";
import { permissions } from "../grasp.config.ts";

export const approval = permissions.approval;
`,

      ...tests,
    }
  );

/**
 * The Invoices App, binding the approval workflow of `steps`, ending with
 * `status`.
 */
const invoicesApp = async (
  given: Given = {},
  {
    steps = approvalSteps(),
    status = approvalStatus,
    tests = {},
  }: {
    steps?: unknown[];
    status?: unknown;
    tests?: Record<string, string>;
  } = {}
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
  const files = filesWith(tests);
  const fixture = await appWith(files, "Invoices", builder);
  const workflow = await createWorkflowResource(
    env,
    builder,
    `approve-${unique()}`
  );
  await publishDefinition(
    env,
    builder,
    workflow.id,
    definitionOf(contract, steps, status)
  );
  await bindWorkflowToApp(env, builder, workflow.id, {
    app: fixture.app,
    alias: "approval",
  });
  await seal(fixture);
  const release = await loadRelease(env, fixture.app, 1);
  return { builder, app: fixture.app, release, options: optionsOf(given) };
};

/** A start of `approval` on an invoice of `amount`, as the SDK sends it. */
const startOf = async (release: Release, amount: number): Promise<string> => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    ({ alias }) => alias === "approval"
  );
  if (declared === undefined) {
    throw new Error("No approval");
  }
  return await Promise.resolve(
    JSON.stringify({
      reference: {
        name: "workflows.approval.mutations.start",
        kind: "mutation",
      },
      args: { args: { amount } },
    })
  );
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

/**
 * A test session on `app`'s release, acting as `desk-user` (who starts
 * runs), `approver` and `other`, and a run of it `desk-user` started.
 */
const runningIn = async (app: Awaited<ReturnType<typeof invoicesApp>>) => {
  const host = fixtureHostFor(
    env,
    app.release,
    await releaseIdsOf(env, app.release)
  );
  const session = await host.open(`test-${unique()}`);
  for (const name of ["desk-user", "approver", "other"]) {
    // oxlint-disable-next-line no-await-in-loop -- one after another, as a test names them
    await session.identify(JSON.stringify({ name, role: "user", teams: [] }));
  }
  const started = resultSchema.parse(
    JSON.parse(
      await session.start(
        "desk-user",
        await startOf(app.release, 5000),
        JSON.stringify(app.options)
      )
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
  answer: { approved: boolean; value?: unknown; run?: number }
): Promise<string> =>
  codeOf(
    await session.respond(
      who,
      run,
      JSON.stringify({ task: "review", ...answer })
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
    "SELECT recipients, status, decided_by AS decidedBy FROM app_test_decisions WHERE run_id = ?"
  )
    .bind(runId)
    .all<{ recipients: string; status: string; decidedBy: string | null }>();
  return results;
};

/** The statuses of run `runId`'s decisions, by the item each asked of. */
const answersInOrder = async (runId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT status FROM app_test_decisions WHERE run_id = ? ORDER BY step"
  )
    .bind(runId)
    .all<{ status: string }>();
  return results.map(({ status }) => status);
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
    await rollback(env, appKind, by, app, 1);
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
        end: { status: "completed", result: { status: "approved" } },
        decisions: [
          {
            recipients: '["approver"]',
            status: "approved",
            decidedBy: "approver",
          },
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
        end: { status: "completed", result: { status: "rejected" } },
      });
      await session.close();
    });

    it("refuses an answer by a principal it doesn't ask, or by the run's own, leaving the run waiting for its recipient", async () => {
      const app = await invoicesApp();
      const { session, run, runId } = await runningIn(app);
      const other = await respond(session, "other", run, { approved: true });
      const own = await respond(session, "desk-user", run, { approved: true });
      const meanwhile = await decisionsOf(runId);
      // The decision's row is written inside the step that asks it, before
      // the engine parks the run on its answer: until then the run still
      // reads as running, a gap a loaded runner widens. Refused answers
      // must leave it to settle into waiting, not move it on.
      const status = await vi.waitFor(
        async () => {
          const now = await runEngine(env).status(runId);
          expect(now?.status).not.toBe("running");
          return now;
        },
        { timeout: 10_000, interval: 50 }
      );
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
        meanwhile: [
          { recipients: '["approver"]', status: "open", decidedBy: null },
        ],
        waiting: "waiting",
        answered: "ok",
        end: { status: "completed", result: { status: "rejected" } },
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
        end: { status: "completed", result: { status: "approved" } },
      });
      await session.close();
    });

    it("opens nothing for a recipient the start's binding doesn't cover, nor for the run's own person", async () => {
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

    it("is answered by any one of the principals it asks, never with the run's own among them", async () => {
      const asking = (names: string[]) =>
        approvalSteps(
          reviewOf({ recipients: names.map((name) => `person:${name}`) })
        );
      const both = await invoicesApp(
        { deciders: ["approver", "other"] },
        { steps: asking(["approver", "other"]) }
      );
      const first = await runningIn(both);
      const answered = await respond(first.session, "other", first.run, {
        approved: true,
      });
      const withOwn = await invoicesApp(
        { deciders: ["approver", "desk-user"] },
        { steps: asking(["approver", "desk-user"]) }
      );
      const second = await runningIn(withOwn);
      expect({
        answered,
        end: await endOf(first.session, first.run),
        decisions: await decisionsOf(first.runId),
        withOwn: await endOf(second.session, second.run),
        withOwnDecisions: await decisionsOf(second.runId),
      }).toStrictEqual({
        answered: "ok",
        end: { status: "completed", result: { status: "approved" } },
        decisions: [
          {
            recipients: '["approver","other"]',
            status: "approved",
            decidedBy: "other",
          },
        ],
        withOwn: { status: "failed", code: "workflow.call_invalid" },
        withOwnDecisions: [],
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
        end: { status: "completed", result: { status: "approved" } },
        decisions: [
          {
            recipients: '["approver"]',
            status: "approved",
            decidedBy: "approver",
          },
        ],
      });
      await session.close();
    });

    it("goes on with an answer whose wake was lost, reading it from the decision", async () => {
      const app = await invoicesApp();
      const { session, run, runId } = await runningIn(app);
      await asked(runId);
      // The engine can't be reached as the answer comes in: the answer is
      // kept, and the wake it sends is lost.
      const answered = await whileEngineRefuses(
        (method) => method === "sendEvent",
        async () => await respond(session, "approver", run, { approved: true })
      );
      expect({
        answered,
        end: await endOf(session, run),
        decisions: await decisionsOf(runId),
      }).toStrictEqual({
        answered: "ok",
        end: { status: "completed", result: { status: "approved" } },
        decisions: [
          {
            recipients: '["approver"]',
            status: "approved",
            decidedBy: "approver",
          },
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
        decisions: [
          { recipients: '["approver"]', status: "open", decidedBy: null },
        ],
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
        completed: await session.completedCount(run, "review"),
      }).toStrictEqual({
        answered: "ok",
        end: { status: "completed", result: { status: "approved" } },
        decisions: 1,
        completed: 1,
      });
      await session.close();
    });

    it("fails the run when nobody answers before the step's timeout: no outcome is made up", async () => {
      const app = await invoicesApp(
        {},
        { steps: approvalSteps(reviewOf({ timeout: "2 seconds" })) }
      );
      const { session, run, runId } = await runningIn(app);
      expect({
        end: z.unknown().parse(JSON.parse(await session.runOutcome(run))),
        decisions: await decisionsOf(runId),
        late: await respond(session, "approver", run, { approved: true }),
      }).toStrictEqual({
        // Its raise, as the workflow declares it: its code and its words.
        end: {
          status: "failed",
          code: "test.unanswered",
          message: "Failed.",
        },
        decisions: [
          { recipients: '["approver"]', status: "timed_out", decidedBy: null },
        ],
        late: "decision.closed",
      });
      await session.close();
    });

    it("times a decision out once its test's clock passes its timeout, with no wall-clock wait, and then takes no answer", async () => {
      const app = await invoicesApp(
        {},
        { steps: approvalSteps(reviewOf({ timeout: "1 day" })) }
      );
      const { session, run, runId } = await runningIn(app);
      await asked(runId);
      await expect(session.runWaits(run)).resolves.toBeTruthy();
      const began = Date.now();
      // Half its timeout: still asked, and still answerable.
      await session.advanceClock(12 * 60 * 60 * 1000);
      await expect(decisionsOf(runId)).resolves.toMatchObject([
        { status: "open" },
      ]);
      // Past it.
      await session.advanceClock(12 * 60 * 60 * 1000);
      expect({
        end: await endOf(session, run),
        decisions: await decisionsOf(runId),
        late: await respond(session, "approver", run, { approved: true }),
      }).toStrictEqual({
        end: { status: "failed", code: "test.unanswered" },
        decisions: [
          { recipients: '["approver"]', status: "timed_out", decidedBy: null },
        ],
        late: "decision.closed",
      });
      expect(Date.now() - began).toBeLessThan(30_000);
      await session.close();
    });

    it("answers the item of a loop an answer names, waiting until the run asks it", async () => {
      const app = await invoicesApp({}, { steps: loopSteps, status: "asked" });
      const { session, run, runId } = await runningIn(app);
      // The second item's answer first: it waits for the run to ask it,
      // which it does only once the first is answered.
      const [second, first] = await Promise.all([
        respond(session, "approver", run, { approved: false, run: 1 }),
        respond(session, "approver", run, { approved: true, run: 0 }),
      ]);
      expect({
        first,
        second,
        again: await respond(session, "approver", run, {
          approved: false,
          run: 0,
        }),
        end: await endOf(session, run),
        decisions: await answersInOrder(runId),
      }).toStrictEqual({
        first: "ok",
        second: "ok",
        again: "decision.closed",
        end: { status: "completed", result: { status: "asked" } },
        decisions: ["approved", "rejected"],
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
            "tests/approval.test.ts": `import { appTest } from "@grasp-os/sdk/testing";
import { workflows } from "@server/_generated/api";
import { expect } from "vitest";
import schema from "../server/schema.ts";

export default appTest(schema, {
  "an approver's approval takes the approved branch": async (t) => {
    const desk = t.withIdentity({ name: "desk-user" });
    const approver = t.withIdentity({ name: "approver" });
    const run = await desk.start(
      workflows.approval,
      { amount: 5000 },
      {
        params: { reviewer: "person:approver" },
        deciders: { invoiceApproval: [approver] },
      }
    );
    await expect(
      desk.respond(run, "review", { approved: true })
    ).rejects.toMatchObject({ code: "decision.forbidden" });
    await approver.respond(run, "review", {
      approved: true,
      value: { comment: "Fine" },
    });
    expect(await t.runs.untilTerminal(run)).toEqual({
      status: "completed",
      result: { status: "approved" },
    });
    await expect(
      approver.respond(run, "review", { approved: false })
    ).rejects.toMatchObject({ code: "decision.closed" });
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
