import { actorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { isAdmin } from "@grasp-os/shared/roles";
import {
  maxItemTestItems,
  workflowItemTestStartSchema,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowCandidateRun,
  WorkflowItemTest,
  WorkflowItemTestItem,
} from "@grasp-os/shared/workflow-resources";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import {
  workflowItemTests,
  workflowResourceRuns,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import { requireNotStaff } from "../sharing.ts";
import { draftCheckpoint } from "../workflow-drafts.ts";
import { requireWorkflowRole } from "../workflow-resources.ts";
import { candidateRunFor, startCandidateRun } from "./candidate-runs.ts";
import { detailsRemoved } from "./retention.ts";

// A test of a draft's checkpoint over recent real items (GRA-513): the
// checkpoint runs once on the input of each of the tester's most recent
// runs, each as a test run of its own (candidate-runs.ts), and the test
// records which run each item came from and what became of it. Threat
// model, each tried in workflow-item-tests.test.ts:
//
// - A test with an effect outside. Each item runs as a test run, which
//   calls nothing: every call it makes, a read as much as a write, is
//   answered from the start's fixtures before any binding, authority or
//   receipt is looked at (resource-calls.ts, `makeCall`), so none reaches
//   connect, a model, an App, a store or Knowledge. Nothing of the source
//   run is touched: its input is read, never its bindings or parameters.
// - Reading an input the tester may not see. Only runs whose details the
//   tester sees are taken, as `resourceRunFor` decides it: their own runs,
//   or every run for the organization's admins. Never a restricted run's
//   (restricted.ts): what it read stays where it was read. Never a run
//   whose input retention removed, or whose retention, as the deployment
//   has it now, is over.
// - Handing an input to another builder. A test run of an item is read
//   only by its tester (`candidateRunFor`): its row is written with the
//   test run's own, so no other builder reads it even for a moment, though a test
//   run of the workflow's is otherwise its builders' to read.
// - Draft code reading a secret through the item. Parameters are the
//   start's own or their defaults, as any test run's, never the values the
//   source run froze.
// - Load. A test takes at most `maxItemTestItems` items, each a test run
//   under the limits any test run is: an item past them is refused as a
//   test run's start is, and the test says so for that item.
// - Its record. Each item is a row written once with the others, never
//   changed (migration 0161), and the start is audited with them. Rows go
//   with the test runs, after a week (`sweepCandidateRuns`).

/** How many of the newest runs one test looks through for items. */
const runsLookedAt = 50;

/** A run whose input an item takes. */
interface SourceRun {
  id: string;
  version: number;
  status: WorkflowItemTestItem["sourceStatus"];
  createdAt: Date;
  input: unknown;
}

/**
 * The newest runs of `workflow` whose input `by` may test the draft on,
 * at most `items`: their own (any run for an admin), not restricted, with
 * their input still kept.
 */
const recentRuns = async (
  env: Env,
  by: Acting,
  workflow: string,
  items: number
): Promise<SourceRun[]> => {
  const runs = workflowResourceRuns;
  const receipts = workflowStartReceipts;
  const rows = await drizzle(env.DB)
    .select({
      id: runs.id,
      version: runs.version,
      status: runs.status,
      createdAt: runs.createdAt,
      endedAt: runs.endedAt,
      input: receipts.input,
      detailsRemovedAt: receipts.detailsRemovedAt,
    })
    .from(runs)
    .innerJoin(receipts, eq(receipts.id, runs.id))
    .where(
      and(
        eq(runs.workflowResourceId, workflow),
        isAdmin(by.role) ? undefined : eq(runs.principalId, by.userId),
        eq(runs.restricted, false),
        eq(receipts.restricted, false),
        isNotNull(receipts.input),
        isNull(receipts.detailsRemovedAt)
      )
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(runsLookedAt);
  const kept: SourceRun[] = [];
  for (const row of rows) {
    if (kept.length >= items) {
      break;
    }
    if (row.input !== null && !detailsRemoved(env, row)) {
      kept.push({
        id: row.id,
        version: row.version,
        status: row.status,
        createdAt: row.createdAt,
        input: z.json().parse(JSON.parse(row.input)),
      });
    }
  }
  return kept;
};

type ItemRow = typeof workflowItemTests.$inferInsert;

/** An item's test run as its tester reads it; null once it was removed. */
const itemRunOf = async (
  env: Env,
  by: Acting,
  workflow: string,
  runId: string
): Promise<WorkflowCandidateRun | null> => {
  try {
    return await candidateRunFor(env, by, workflow, runId);
  } catch (error) {
    if (
      isExpectedError(error) &&
      error.code === "workflow.candidate_unavailable"
    ) {
      return null;
    }
    throw error;
  }
};

/**
 * Test `testId` of workflow `id`, item by item, for its tester alone, who
 * must still build the workflow: anyone else, and a test of another
 * workflow, is refused as one that doesn't exist
 * (`workflow.item_test_unavailable`).
 */
export const itemTestFor = async (
  env: Env,
  by: Acting,
  id: unknown,
  testId: unknown
): Promise<WorkflowItemTest> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const db = drizzle(env.DB);
  const rows =
    typeof testId === "string"
      ? await db
          .select()
          .from(workflowItemTests)
          .where(
            and(
              eq(workflowItemTests.testId, testId),
              eq(workflowItemTests.workflowResourceId, workflow.id),
              eq(workflowItemTests.principalId, by.userId)
            )
          )
          .orderBy(asc(workflowItemTests.position))
      : [];
  const [first] = rows;
  if (first === undefined) {
    throw workflowResourceErrors.create("workflow.item_test_unavailable");
  }
  const sourceRows = await db
    .select({
      id: workflowResourceRuns.id,
      version: workflowResourceRuns.version,
      status: workflowResourceRuns.status,
      createdAt: workflowResourceRuns.createdAt,
    })
    .from(workflowResourceRuns)
    .where(
      inArray(
        workflowResourceRuns.id,
        rows.map(({ sourceRunId }) => sourceRunId)
      )
    );
  const sources = new Map(sourceRows.map((source) => [source.id, source]));
  const items = await Promise.all(
    rows.map(async (row): Promise<WorkflowItemTestItem> => {
      const source = sources.get(row.sourceRunId);
      if (source === undefined) {
        throw new Error(`Run ${row.sourceRunId} of a test isn't there`);
      }
      return {
        sourceRunId: source.id,
        sourceVersion: source.version,
        sourceStatus: source.status,
        sourceCreatedAt: source.createdAt.toISOString(),
        run:
          row.candidateRunId === null
            ? null
            : await itemRunOf(env, by, workflow.id, row.candidateRunId),
        refusal: row.refusalCode,
      };
    })
  );
  return {
    id: first.testId,
    workflowId: workflow.id,
    draftRevision: first.draftRevision,
    principal: first.principalId,
    createdAt: first.createdAt.toISOString(),
    items,
  };
};

/**
 * Tests workflow `id`'s draft checkpoint for `by`, one of its builders,
 * over their recent real runs (`workflowItemTestStartSchema`): one test
 * run of the checkpoint at exactly the revision named for each run's
 * input, every call answered from the start's fixtures. The test, item by
 * item; an item whose test run was refused says why.
 */
export const startItemTest = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowItemTest> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const {
    revision,
    items = maxItemTestItems,
    params,
    fixtures,
  } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowItemTestStartSchema,
    input
  );
  // A checkpoint that can't be run refuses the test, not each item.
  await draftCheckpoint(env, workflow.id, revision);
  const sources = await recentRuns(env, by, workflow.id, items);
  if (sources.length === 0) {
    throw workflowResourceErrors.create("workflow.item_test_empty");
  }
  const testId = crypto.randomUUID();
  const createdAt = new Date();
  const itemRow = (
    position: number,
    source: SourceRun,
    outcome: { candidateRunId: string } | { refusalCode: string }
  ): ItemRow => ({
    id: crypto.randomUUID(),
    testId,
    workflowResourceId: workflow.id,
    principalId: by.userId,
    draftRevision: revision,
    position,
    sourceRunId: source.id,
    candidateRunId: null,
    refusalCode: null,
    createdAt,
    ...outcome,
  });
  // Each started item's row is written with its test run's
  // (`startCandidateRun`); a refused item's after, with the test's entry,
  // which is written even when an item failed unexpectedly, so no test
  // run of a real item goes unrecorded.
  const refused: ItemRow[] = [];
  let started = 0;
  const recorded = async (): Promise<void> => {
    const db = drizzle(env.DB);
    await auditedBatch(env, db, [
      outboxed(db, {
        actor: by.actor ?? actorOf(by),
        action: "workflow.item_test.started",
        target: { type: "workflow_resource", id: workflow.id },
        // Never an input, parameter or fixture: counts only.
        detail: {
          test: testId,
          candidate: true,
          revision,
          items: sources.length,
          started,
        },
      }),
      ...(refused.length === 0
        ? []
        : [db.insert(workflowItemTests).values(refused)]),
    ]);
  };
  for (const [position, source] of sources.entries()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each item counts against the limits the next is held to
      await startCandidateRun(
        env,
        by,
        workflow.id,
        { revision, input: source.input, params, fixtures },
        undefined,
        (candidateRunId) => itemRow(position, source, { candidateRunId })
      );
      started += 1;
    } catch (error) {
      if (!isExpectedError(error)) {
        // oxlint-disable-next-line no-await-in-loop -- once, as the test stops
        await recorded();
        throw error;
      }
      refused.push(itemRow(position, source, { refusalCode: error.code }));
    }
  }
  await recorded();
  return await itemTestFor(env, by, workflow.id, testId);
};
