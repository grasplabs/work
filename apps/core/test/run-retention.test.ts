import { v } from "@grasp-os/sdk";
import type { Identity } from "@grasp-os/shared/rpc";
import { stepIdempotencyKey } from "@grasp-os/shared/workflows";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  answerDecision,
  confirmDecision,
  decisionFor,
  reviewDecision,
} from "../src/decisions/decisions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { workflowStateOf, writeWorkflowState } from "../src/workflow-state.ts";
import {
  startDetailsPerSweep,
  sweepRunDetails,
  sweepWorkflowStartDetails,
} from "../src/workflows/retention.ts";
import { mockIdp } from "./idp.ts";
import {
  definitionOf,
  endedRun,
  endLiveResourceRuns,
  greetingTasks,
  jsonWorkflowAppsOf,
  objectSchema,
  publishedWorkflow,
  runFor,
  runOnce,
  settles,
  startedBy,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import { runQuarterHourTasks } from "./maintenance.ts";
import { racingDb } from "./racing-db.ts";
import { runObject, sleeping, stopped, woken } from "./runs.ts";
import { unique } from "./sign-in.ts";

// Retention of independent (JSON) workflow runs, from its threat model
// (src/workflows/retention.ts, `sweepWorkflowStartDetails`): a run reads
// what its person may read and keeps it, as its input and parameters on
// its start receipt, in what it returned or why it failed with the engine,
// and in what its decisions asked and were answered. Once the run has
// ended for the run retention (30 days), the engine purges its record
// (every run is admitted with the retention as its own), and the 15-minute
// clock empties the receipt and the decisions and marks the receipt; the
// run's row stays. Each case below is a way that could go wrong:
// - details removed too early, or while the run still waits on them
//   (paused, or asleep), or taken from a run that goes on after a sweep;
// - a reader handed a swept run as if nothing were missing;
// - a sweep stopped half-way, or two at once, leaving a run half swept or
//   marked twice;
// - a sweep that takes everything due at once.
//
// Runs are real, on the engine. Time is the clock's own: each sweep runs
// for a time that many days on, as the clock would run it then.
//
// What App runs' retention alone does (the engine instance of a cancel it
// couldn't terminate; a row marked after its receipts in two batches) has
// no JSON counterpart: a JSON run's cancel ends its row only as the engine
// confirms, or owes the engine its termination (resource-runs.ts), and its
// details go in one batch. Covered elsewhere for JSON runs:
// workflow-resource-runs.test.ts (a live run's receipt kept),
// workflow-resource-run-quotas.test.ts (attempt receipts removed, one
// still held settled), workflow-resource-run-clock.test.ts (reads past
// retention, swept or not) and workflow-bindings.test.ts (a swept start sent again is the
// same start). The sweep found by an index with nothing read whole:
// covered by GRA-1460's tests.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

const day = 24 * 60 * 60 * 1000;

/** What a run reads, that must not outlive its retention. */
const transcript = "TRANSCRIPT the guest said the margin is 12%";

/** What readers say in place of a swept run's words. */
const removedWords =
  "The details of this run were removed: they are kept for 30 days after a run ends.";

/** The time `days` from now, for the clock to run at. */
const daysOn = (days: number): Date => new Date(Date.now() + days * day);

/** A definition that fails on what the run read: a text this short has no ten-thousandth letter. */
const failing = (): string =>
  definitionOf([], {
    status: { $expr: 'args.who.split("")[9999].toUpperCase()' },
  });

/** What run `id`'s start receipt keeps of it. */
const receiptOf = async (id: string) =>
  await env.DB.prepare(
    "SELECT input, params, details_removed_at AS removed FROM workflow_start_receipts WHERE id = ?"
  )
    .bind(id)
    .first<{
      input: string | null;
      params: string | null;
      removed: number | null;
    }>();

/** What run `id`'s start receipt keeps of its input. */
const inputOf = async (id: string): Promise<string | null> => {
  const receipt = await receiptOf(id);
  return receipt?.input ?? null;
};

/** What run `runId` of workflow `workflow` returned, as `by` reads it. */
const outputOf = async (by: Person, workflow: string, runId: string) => {
  const run = await runFor(by, workflow, runId);
  return run.result;
};

/**
 * A run of a workflow of `by`'s running `tasks` (or the definition they
 * make), reading the transcript, once ended.
 */
const endedReading = async (by: Person, tasks: unknown[] | (() => string)) => {
  const { id } = await publishedWorkflow(by, tasks);
  const runId = await startedBy(by, id, { who: transcript });
  await endedRun(by, id, runId);
  return { workflow: id, runId };
};

/** What a read of a run says of its details. */
const detailsOf = ({
  status,
  result,
  error,
}: {
  status: string;
  result?: unknown;
  error?: { code: string | null; message: string };
}) => ({ status, output: result, error });

/** What a reviewer may answer with: a comment, or nothing. */
const response = v.union(v.null(), v.object({ comment: v.string() }));

/**
 * A workflow that asks its reviewer param to approve what it read (the
 * `approval` decision binding of `contract`), its prompt quoting it.
 */
const approvalDefinition = (contract: string): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: {
      status: {
        $expr: '!review.timedOut && review.approved ? "approved" : "rejected"',
      },
    },
    params: {
      reviewer: {
        label: "Reviewer",
        type: { kind: "person", default: "role:admin" },
        sensitive: false,
      },
    },
    permissions: { decisions: { approval: { contract } } },
    steps: [
      {
        id: "review",
        type: "decide",
        decision: "approval",
        recipients: { $expr: "[params.reviewer]" },
        prompt: { $expr: '"Approve: " + args.who' },
        input: { $expr: "args" },
      },
    ],
  });

/** The decision run `runId` opened, as its row has it, once it has. */
const decisionOf = async (runId: string) =>
  await vi.waitFor(async () => {
    const row = await env.DB.prepare(
      "SELECT id, description, payload, input FROM workflow_decisions WHERE resource_run_id = ?"
    )
      .bind(runId)
      .first<Record<string, string | null>>();
    if (row === null) {
      throw new Error("No decision yet");
    }
    return row;
  }, settles);

/**
 * `by`'s answer to `decision` through the trusted host decision UI:
 * reviewed, confirmed, then answered with that confirmation.
 */
const confirmedAnswer = async (
  by: Identity,
  decision: string,
  answer: { approved: boolean; payload?: { comment: string } }
) => {
  const review = await reviewDecision(env, by, decision, answer);
  if (review.state === "recorded") {
    return review.decision;
  }
  const { confirmation } = await confirmDecision(
    env,
    by,
    decision,
    review.decision.revision,
    review.response
  );
  return await answerDecision(env, by, decision, review.response, confirmation);
};

/**
 * Start receipts that admitted no run, `count` of them, each a copy of
 * receipt `of` under its own ID and key, the first admitted `daysAgo`
 * days ago and each next a millisecond later: their IDs, oldest first.
 */
const oldReceipts = async (
  of: string,
  count: number,
  daysAgo: number
): Promise<string[]> => {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const statement = env.DB.prepare(
    `INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input, input_hash, params, params_revision, bindings, bindings_hash, created_at)
      SELECT ?, invoker_type, invoker_id, ?, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input, input_hash, params, params_revision, bindings, bindings_hash, ?
      FROM workflow_start_receipts WHERE id = ?`
  );
  const createdAt = Date.now() - daysAgo * day;
  await env.DB.batch(
    ids.map((id, index) =>
      statement.bind(id, `old-${id}`, createdAt + index, of)
    )
  );
  return ids;
};

/** Of start receipts `ids`, the ones the sweep hasn't marked. */
const unsweptOf = async (ids: readonly string[]): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT id FROM workflow_start_receipts WHERE details_removed_at IS NOT NULL"
  ).all<{ id: string }>();
  const swept = new Set(results.map(({ id }) => id));
  return ids.filter((id) => !swept.has(id));
};

describe("JSON run retention", { timeout: 60_000 }, () => {
  afterEach(endLiveResourceRuns);

  it("removes what an ended run read and returned once its retention is over, not a day before, says so when read, and keeps the run", async () => {
    const builder = await signedIn("builder");
    const by = builder;
    const done = await endedReading(by, greetingTasks());
    const failed = await endedReading(by, failing);
    const read = async () => ({
      done: detailsOf(await runFor(by, done.workflow, done.runId)),
      failed: detailsOf(await runFor(by, failed.workflow, failed.runId)),
    });
    const before = await read();

    await runQuarterHourTasks({}, daysOn(29));
    const within = {
      read: await read(),
      receipt: await inputOf(done.runId),
    };
    const at = daysOn(31);
    await runQuarterHourTasks({}, at);
    // Read now, well within the run's retention by its row's own time: the
    // sweep's mark alone says its details went.
    const after = await read();
    const receipts = [
      await receiptOf(done.runId),
      await receiptOf(failed.runId),
    ];

    expect({
      before,
      within,
      after,
      receipts,
    }).toStrictEqual({
      before: {
        done: {
          status: "completed",
          output: { status: `Hello, ${transcript}` },
          error: undefined,
        },
        failed: {
          status: "failed",
          output: undefined,
          error: {
            code: "expression.failed",
            message: "The expression failed.",
          },
        },
      },
      within: { read: before, receipt: JSON.stringify({ who: transcript }) },
      after: {
        // The run as it ended, without what it returned.
        done: { status: "completed", output: undefined, error: undefined },
        // How it failed, by its code, without the engine's own words.
        failed: {
          status: "failed",
          output: undefined,
          error: { code: "expression.failed", message: removedWords },
        },
      },
      receipts: [
        { input: null, params: null, removed: at.getTime() },
        { input: null, params: null, removed: at.getTime() },
      ],
    });
  });

  it("never touches a run that hasn't ended, paused or not, and one a sweep passed goes on to keep all it did", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks("1 hour"));
    const runId = await startedBy(builder, id, { who: transcript });
    await sleeping(runId, "hold:task");
    const started = await receiptOf(runId);

    // While it sleeps, long after it started.
    await runQuarterHourTasks({}, daysOn(400));
    const asleep = await receiptOf(runId);
    // While it is paused, as by a deploy or a crash.
    await stopped(runId);
    const paused = await runOnce(
      builder,
      id,
      runId,
      ({ status }) => status === "paused"
    );
    await runQuarterHourTasks({}, daysOn(400));
    const whilePaused = await receiptOf(runId);
    // Resumed, it finishes as if no sweep had come by.
    await woken(runId, "hold:task");
    const ended = await endedRun(builder, id, runId);

    expect({
      asleep,
      paused: paused.status,
      whilePaused,
      ended: { status: ended.status, output: ended.result },
      kept: await receiptOf(runId),
    }).toStrictEqual({
      asleep: started,
      paused: "paused",
      whilePaused: started,
      ended: {
        status: "completed",
        output: { status: `Hello, ${transcript}` },
      },
      kept: {
        input: JSON.stringify({ who: transcript }),
        params: JSON.stringify({}),
        removed: null,
      },
    });
  });

  it("has the engine keep each run's record for the retention, and no longer", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks());
    const runId = await startedBy(builder, id, { who: transcript });
    const asked = await vi.waitFor(
      async () =>
        await runInDurableObject(runObject(runId), (_object, state) =>
          state.storage.sql
            .exec<{ success: number; error: number }>(
              "SELECT success_retention_ms AS success, error_retention_ms AS error FROM run"
            )
            .one()
        ),
      settles
    );
    await endedRun(builder, id, runId);
    expect(asked).toStrictEqual({ success: 30 * day, error: 30 * day });
  });

  it("leaves a decision a run still waits for as it was asked, and empties it once the run has ended for its retention, keeping who decided", async () => {
    const admin = await signedIn("admin");
    const owner = await signedIn("builder");
    const reviewer = await signedIn("user");
    const contract = `approval-${unique()}`;
    await publishCatalogContract(env, admin.acting, {
      key: contract,
      kind: "decision",
      input: JSON.stringify(v.object({ who: v.string() }).descriptor),
      response: JSON.stringify(response.descriptor),
    });
    const workflow = await createWorkflowResource(
      env,
      owner.acting,
      `approve-${unique()}`
    );
    await publishWorkflowVersion(env, owner.acting, workflow.id, {
      definition: approvalDefinition(contract),
      basedOn: null,
    });
    await approveWorkflowBinding(env, admin.acting, workflow.id, {
      alias: "approval",
      target: { kind: "decision", deciders: [`person:${reviewer.userId}`] },
      reviewed: { version: 1 },
    });
    await setWorkflowParams(env, owner.acting, workflow.id, {
      values: { reviewer: `person:${reviewer.userId}` },
      expectedRevision: 0,
    });
    const runId = await startedBy(owner, workflow.id, {
      who: transcript,
    });
    const asked = await decisionOf(runId);
    const decision = asked.id ?? "";

    // Long after it started, while it still waits.
    await sweepRunDetails(env, daysOn(400));
    const waiting = await decisionOf(runId);
    const open = await decisionFor(env, reviewer.acting, decision);
    await confirmedAnswer(reviewer.acting, decision, {
      approved: true,
      payload: { comment: transcript },
    });
    const ended = await endedRun(owner, workflow.id, runId);
    const answered = await decisionOf(runId);
    await runQuarterHourTasks({}, daysOn(31));
    const after = await decisionFor(env, reviewer.acting, decision);
    const kept = await decisionOf(runId);

    expect({
      waiting,
      open: { description: open.description, status: open.status },
      ended: ended.result,
      answered: answered.payload,
      after: {
        description: after.description,
        input: after.input,
        status: after.status,
        by: after.decided?.by.userId,
      },
      kept,
      inRow: JSON.stringify(kept).includes("TRANSCRIPT"),
    }).toStrictEqual({
      waiting: asked,
      open: { description: `Approve: ${transcript}`, status: "open" },
      ended: { status: "approved" },
      answered: JSON.stringify({ comment: transcript }),
      // Who decided, and how, stays; what was asked and sent doesn't.
      after: {
        description: removedWords,
        input: undefined,
        status: "approved",
        by: reviewer.userId,
      },
      kept: { id: decision, description: "", payload: null, input: null },
      inRow: false,
    });
  });

  it("marks a run once when two sweeps run at once, and changes nothing when one runs again", async () => {
    const builder = await signedIn("builder");
    const { runId } = await endedReading(builder, greetingTasks());
    const [early, late] = [daysOn(31), daysOn(32)];

    await Promise.all([
      sweepRunDetails(env, early),
      sweepRunDetails(env, late),
    ]);
    const once = await receiptOf(runId);
    await runQuarterHourTasks({}, daysOn(60));

    expect({
      at: [early.getTime(), late.getTime()].includes(Number(once?.removed)),
      again: await receiptOf(runId),
    }).toStrictEqual({ at: true, again: once });
  });

  it("finishes a sweep that stopped before it marked the run, which until then reads in full", async () => {
    const builder = await signedIn("builder");
    const by = builder;
    const { workflow, runId } = await endedReading(by, greetingTasks());

    // The database fails as the run's details are removed, as D1 can.
    let broken = true;
    const db = racingDb(() => {
      if (broken) {
        throw new Error("D1_ERROR: broken for the test");
      }
    });
    const first = await sweepRunDetails({ ...env, DB: db }, daysOn(31)).catch(
      (error: unknown) => error
    );
    const between = {
      receipt: await receiptOf(runId),
      output: await outputOf(by, workflow, runId),
    };
    broken = false;
    await sweepRunDetails({ ...env, DB: db }, daysOn(31));

    expect({
      first: first instanceof Error && first.message,
      between,
      after: {
        receipt: await inputOf(runId),
        output: await outputOf(by, workflow, runId),
      },
    }).toStrictEqual({
      first: "D1_ERROR: broken for the test",
      // Not marked, so still there in full.
      between: {
        receipt: {
          input: JSON.stringify({ who: transcript }),
          params: JSON.stringify({}),
          removed: null,
        },
        output: { status: `Hello, ${transcript}` },
      },
      after: { receipt: null, output: undefined },
    });
  });

  it("sweeps a bounded number of starts at a time, oldest first, and the rest the next time", async () => {
    const builder = await signedIn("builder");
    const { runId } = await endedReading(builder, greetingTasks());
    const starts = await oldReceipts(runId, startDetailsPerSweep + 1, 40);
    const now = new Date();

    await sweepWorkflowStartDetails(env, now, now);
    const first = await unsweptOf(starts);
    await sweepWorkflowStartDetails(env, now, now);

    expect({ first, second: await unsweptOf(starts) }).toStrictEqual({
      // All but the one admitted last.
      first: starts.slice(startDetailsPerSweep),
      second: [],
    });
  });
});

/** The hash of the snapshot run `runId`'s receipt names. */
const hashOf = async (runId: string): Promise<string | null> => {
  const row = await env.DB.prepare(
    "SELECT state_hash AS hash FROM workflow_start_receipts WHERE id = ?"
  )
    .bind(runId)
    .first<{ hash: string | null }>();
  return row?.hash ?? null;
};

describe("the snapshots of a workflow's state its runs froze", () => {
  afterEach(endLiveResourceRuns);

  it("drops a run's state write receipts with its details, once no step of it can replay, and keeps what it wrote", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks());
    const writer = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input_hash, created_at) VALUES (?, 'person', ?, ?, ?, 1, 'manifest', ?, 0, 'input', ?)"
      ).bind(
        writer,
        builder.acting.userId,
        unique(),
        id,
        builder.acting.userId,
        Date.now()
      ),
      env.DB.prepare(
        "INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at) VALUES (?, ?, 1, 'manifest', 'build', ?, 'running', ?)"
      ).bind(writer, id, builder.acting.userId, Date.now()),
    ]);
    await writeWorkflowState(
      env,
      writer,
      stepIdempotencyKey(writer, "a:task"),
      { seen: "Ada" }
    );
    await env.DB.prepare(
      "UPDATE workflow_resource_runs SET status = 'completed', ended_at = ? WHERE id = ?"
    )
      .bind(Date.now(), writer)
      .run();
    const receipts = async (): Promise<number | undefined> => {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM workflow_state_writes WHERE run_id = ?"
      )
        .bind(writer)
        .first<{ n: number }>();
      return row?.n;
    };
    const before = await receipts();
    const later = daysOn(1);
    await sweepWorkflowStartDetails(env, later, later);
    expect({
      before,
      after: await receipts(),
      state: await workflowStateOf(env, id),
    }).toStrictEqual({ before: 1, after: 0, state: { seen: "Ada" } });
  });

  it("stores a snapshot once for the starts that froze it, and removes it once retention reached every one of them", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks());
    // Something only this workflow keeps, written by a run of its own.
    const writer = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input_hash, created_at) VALUES (?, 'person', ?, ?, ?, 1, 'manifest', ?, 0, 'input', ?)"
      ).bind(
        writer,
        builder.acting.userId,
        unique(),
        id,
        builder.acting.userId,
        Date.now()
      ),
      env.DB.prepare(
        "INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at) VALUES (?, ?, 1, 'manifest', 'build', ?, 'running', ?)"
      ).bind(writer, id, builder.acting.userId, Date.now()),
    ]);
    await writeWorkflowState(
      env,
      writer,
      stepIdempotencyKey(writer, "a:task"),
      { seen: unique() }
    );
    await env.DB.prepare(
      "UPDATE workflow_resource_runs SET status = 'completed', ended_at = ? WHERE id = ?"
    )
      .bind(Date.now(), writer)
      .run();
    const first = await startedBy(builder, id);
    const { endedAt } = await endedRun(builder, id, first);
    // A moment past the first run's end, before the second starts.
    const between = new Date(Date.parse(endedAt ?? "") + 1);
    await vi.waitFor(() => {
      expect(Date.now()).toBeGreaterThan(between.getTime());
    });
    const second = await startedBy(builder, id);
    await endedRun(builder, id, second);
    const shared = (await hashOf(first)) ?? "";
    const stored = async (): Promise<number | undefined> => {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM workflow_state_snapshots WHERE hash = ?"
      )
        .bind(shared)
        .first<{ n: number }>();
      return row?.n;
    };
    const sameHash = (await hashOf(second)) === shared;
    const both = await stored();
    await sweepWorkflowStartDetails(env, between, between);
    const oneLeft = await stored();
    const later = daysOn(1);
    await sweepWorkflowStartDetails(env, later, later);
    expect({
      sameHash,
      both,
      oneLeft,
      none: await stored(),
    }).toStrictEqual({ sameHash: true, both: 1, oneLeft: 1, none: 0 });
  });
});
