import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin } from "@grasp-os/shared/roles";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowResourceRun,
  WorkflowRunStatus,
} from "@grasp-os/shared/workflow-resources";
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";
import { namedError } from "@grasp-os/workerflow/errors";
import { writeJson } from "@grasp-os/workflow-expressions/bounded-json";
import { evaluatorLimits } from "@grasp-os/workflow-expressions/limits";
import { jqProvenance } from "@grasp-os/workflow-expressions/provenance";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import {
  workflowResourceRunTerminations,
  workflowResourceVersions,
  workflowResourceRuns,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import { requireNotStaff } from "../sharing.ts";
import { loadWorkflowBuild } from "../workflow-builds.ts";
import { requireWorkflowRole, versionContract } from "../workflow-resources.ts";
import { runDequeued } from "./admission.ts";
import { afterCpuKill, trackAttemptCalls } from "./attempt-calls.ts";
import type { AttemptCall } from "./attempt-calls.ts";
import { loadRunIsolate } from "./code.ts";
import type { Settled, StepError } from "./code.ts";
import { runEngine } from "./engine.ts";
import type { PinnedResourceRun } from "./engine.ts";
import { countedStep, fromIsolate, settle, stepLimitOf } from "./host.ts";
import type { RunStep } from "./host.ts";
import { admitAttempt, quotaPolicy } from "./quotas.ts";
import type { ResourceAttemptHost } from "./resource-attempt-host.ts";
import { callingRunOf } from "./resource-authority.ts";
import {
  maxResultBytes,
  openRunMain,
  openRunModule,
  resourceAttemptMethods,
  ResourceRunHost,
} from "./resource-host.ts";
import type { HostedResourceRun, ResourceHostHooks } from "./resource-host.ts";
import { detailsRemoved, removedText } from "./retention.ts";
import { tellQueryFollowers } from "./run-changes.ts";
import type { EngineStatus } from "./runs.ts";

// Runs of independent workflows (platform specification 13.1, 14, 24):
// a start's receipt admits its run, under the receipt's own ID, in the
// same statement (workflow-starts.ts), for a version with an executable
// build (workflow-builds.ts). The run is pinned to that version, its
// manifest and its build, and acts for the person the start acted for,
// with the parameter values and bindings the start froze; nothing about
// it is read again from the workflow as it is now.
//
// Whose word the row takes, and whose clock, at each transition: one rule,
// so the row and the engine never disagree about a run in time.
//
// - Until the engine has the run (`starting`), core alone knows of it, so
//   core decides: a terminate ends it cancelled, and a start the engine
//   never confirmed ends failed (`workflow.start_unconfirmed`, kept as
//   the row's `failureCode`, as the engine has no error of it), both at
//   core's time. Each is written before anything is asked of the engine,
//   and every activation reads the row first (`loadedRun`), so an
//   instance a late start makes runs nothing of an ended run.
// - Once the engine has it, the engine decides: the row takes the
//   engine's notifications, each with the engine's sequence and time
//   (`projectResourceRun`), as an App run's row does. Core's repair, which
//   asks the engine's status, only moves a row off `starting`, never ends
//   it: the status says nothing of when, and the end's own notification
//   follows. A terminate asks the engine, and takes the end the engine
//   confirms in answer, at once, as a cancel of an App run does.
// - Readers go by the row and the deployment's retention as it is now
//   (`detailsRemoved`), never by what the engine still holds.
//
// Threat model, and how each is closed:
//
// - A run with other authority than its start's. Its version, manifest,
//   build and principal are its row's, written with its receipt and
//   pinned by the database (migration 0089); its parameters and input are
//   the receipt's, frozen as the start was admitted. A parameter edit,
//   a new version or a changed grant after the start changes nothing it
//   runs; the engine's pin names the same manifest, and every activation
//   checks the row, the receipt and the pin agree before anything runs.
// - Code that isn't the version's. The build is loaded from the sealed
//   manifest the pin names, every hash checked (workflow-builds.ts), and
//   must be the identity the run was admitted for.
// - A start lost between its receipt and the engine. The run's row says
//   `starting` until the engine's first notification; a start sent again
//   under the same key, and the cron's repair, send it again, which the
//   engine takes once (its admission is keyed by the run's ID).
// - Output the workflow doesn't declare. The run's result must match its
//   version's output schema, by the SDK's own validator, or the run fails
//   (`workflow.output_invalid`).
// - A run getting past the quotas an App's run is held to. Each run is the
//   root of its own lineage (quotas.ts), in the same tables, and each of
//   its steps' attempts is admitted by the same admission, against the
//   lineage's active time, host calls, age and steps and the client's
//   shares of attempts running at once (resource-host.ts): a retry, a
//   restart or a replay counts on, never afresh. An independent run
//   starts no runs, so its lineage has no descendants. A workflow's own
//   `limits` lower those: `maxSteps` the step limit and `maxModelCalls`
//   the model requests a lineage may make (the lower of each and the
//   host's, `loadedRun`, one request per call). A `maxActiveMs` isn't
//   lowered (generate.ts).

/** The statuses of a run that hasn't ended. */
const unended: WorkflowRunStatus[] = ["starting", "running"];

/** Where the engine says a run is, as its row has it. */
const projected: Record<InstanceStatus["status"], WorkflowRunStatus> = {
  queued: "running",
  running: "running",
  waiting: "running",
  waitingForPause: "running",
  rollingBack: "running",
  paused: "running",
  complete: "completed",
  errored: "failed",
  terminated: "cancelled",
};

/**
 * Whose runs a run's isolate is among, for the sandbox's share; and whose
 * App share of the client's attempts running at once its attempts take
 * (admission.ts): the workflow's own, as an App's runs take their App's.
 */
const ownerOf = (workflow: string): string => `workflow-resource:${workflow}`;

/**
 * Whose person share of the attempts running at once a run's attempts
 * take (admission.ts), from its receipt, never its input: the person it
 * acts for, whose App runs take the same share; for a trigger's start, the
 * trigger's own (`trigger:<id>`), as an App's triggers take theirs, so
 * the events that fire it never take its principal's.
 */
const admissionSubjectOf = (
  row: Pick<RunRow, "principalId">,
  receipt: { invokerType: string; invokerId: string }
): string =>
  receipt.invokerType === "trigger"
    ? `trigger:${receipt.invokerId}`
    : row.principalId;

/** What a start's run is admitted as: its pins, from the authorization. */
export interface RunAdmission {
  receipt: string;
  workflowId: string;
  version: number;
  manifestHash: string;
  buildHash: string;
  principal: string;
  /** Whether its start was decided in restricted mode: pinned with it. */
  restricted: boolean;
  createdAt: number;
}

/**
 * The statement that admits a start's run, for the receipt's own batch:
 * the run's row, only once the receipt was written.
 */
export const runAdmitted = (db: DrizzleD1Database, run: RunAdmission) =>
  db.insert(workflowResourceRuns).select(
    sql`SELECT ${run.receipt}, ${run.workflowId}, ${run.version}, ${run.manifestHash}, ${run.buildHash}, ${run.principal}, 'starting', 0, ${run.createdAt}, NULL, 0, NULL, NULL, 0, ${run.restricted ? 1 : 0}
        WHERE EXISTS (SELECT 1 FROM ${workflowStartReceipts} WHERE ${workflowStartReceipts.id} = ${run.receipt})`
  );

type RunRow = typeof workflowResourceRuns.$inferSelect;

const runOf = async (env: Env, id: string): Promise<RunRow | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(workflowResourceRuns)
    .where(eq(workflowResourceRuns.id, id))
    .get();

/** The input and frozen parameters a run reads from its receipt. */
const receiptOf = async (env: Env, id: string) =>
  await drizzle(env.DB)
    .select({
      manifestHash: workflowStartReceipts.manifestHash,
      input: workflowStartReceipts.input,
      params: workflowStartReceipts.params,
      invokerType: workflowStartReceipts.invokerType,
      invokerId: workflowStartReceipts.invokerId,
    })
    .from(workflowStartReceipts)
    .where(eq(workflowStartReceipts.id, id))
    .get();

const jsonObjectSchema = z.record(z.string(), z.json());

/** A run's audit entry of `action`, its pins named. */
const runEntry = (row: RunRow, action: string): AuditEntry => ({
  actor: { type: "system" },
  action,
  target: { type: "workflow_run", id: row.id },
  detail: {
    workflow: row.workflowResourceId,
    version: row.version,
    manifestHash: row.manifestHash,
    buildHash: row.buildHash,
  },
});

const endActions: Partial<Record<WorkflowRunStatus, string>> = {
  completed: "workflow.run.completed",
  failed: "workflow.run.failed",
  cancelled: "workflow.run.cancelled",
};

/**
 * Makes run `id`'s row say where the engine says it is: a notification no
 * newer than the last the row took changes nothing, and an ended run never
 * changes again. Its end is audited with the change, once. A failed end
 * keeps the engine's error code (`failureCode`), which outlives the
 * engine's record of the run.
 */
export const projectResourceRun = async (
  env: Env,
  id: string,
  engine: EngineStatus,
  failureCode: string | null = null
): Promise<void> => {
  const row = await runOf(env, id);
  if (row === undefined || !unended.includes(row.status)) {
    return;
  }
  const status = projected[engine.status];
  const ended = !unended.includes(status);
  const action = endActions[status];
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(workflowResourceRuns)
      .set({
        status,
        ...(engine.sequence === undefined
          ? {}
          : { engineSequence: engine.sequence }),
        ...(ended ? { endedAt: new Date(engine.at) } : {}),
        ...(status === "failed" && failureCode !== null ? { failureCode } : {}),
      })
      .where(
        and(
          eq(workflowResourceRuns.id, id),
          inArray(workflowResourceRuns.status, unended),
          engine.sequence === undefined
            ? undefined
            : lt(workflowResourceRuns.engineSequence, engine.sequence)
        )
      ),
    ...(action === undefined
      ? []
      : [outboxedIfChanged(db, runEntry(row, action))]),
    // Ended, it waits in the admission queue for nothing more: its places
    // go now, rather than keep others waiting until they lapse. After the
    // audit entry, which reads what the row's update changed.
    ...(ended
      ? [
          runDequeued(
            db,
            id,
            sql`EXISTS (SELECT 1 FROM ${workflowResourceRuns} WHERE ${workflowResourceRuns.id} = ${id} AND ${workflowResourceRuns.status} = ${status})`
          ),
        ]
      : []),
  ]);
  if (status !== row.status) {
    await tellQueryFollowers(env, id);
  }
};

/** Sends `row`'s start to the engine; throws when the engine didn't take it. */
const sendStart = async (env: Env, row: RunRow): Promise<void> => {
  const receipt = await receiptOf(env, row.id);
  if (receipt?.input === null || receipt?.input === undefined) {
    // Nothing to start it with: the repair marks it failed.
    throw new Error(`Run ${row.id}'s receipt holds no input`);
  }
  await runEngine(env).createResource({
    id: row.id,
    pinned: {
      workflow: workflowResourceIdSchema.parse(row.workflowResourceId),
      version: row.version,
      manifest: row.manifestHash,
    },
    input: z.json().parse(JSON.parse(receipt.input)),
  });
};

/**
 * Sends the start of the run receipt `id` admitted to the engine, while
 * its row says it is still starting: the engine takes a start once, so
 * sending it again is safe. Answers the run's ID; null when the receipt
 * admitted no run (its version has no executable build). A start the
 * engine didn't take is left to the repair (`repairResourceStarts`).
 */
export const startResourceRun = async (
  env: Env,
  id: string
): Promise<string | null> => {
  const row = await runOf(env, id);
  if (row === undefined) {
    return null;
  }
  if (row.status === "starting") {
    try {
      await sendStart(env, row);
    } catch (error) {
      log.error("workflow.resource_run_start_failed", {
        runId: row.id,
        ...errorFields(error),
      });
    }
  }
  return row.id;
};

/** How long a run may say `starting` before the repair sends it again. */
const repairAfterMs = 60_000;
/** Most runs one repair looks at. */
const repairsPerRun = 50;
/** The most times the repair sends one run's start. */
const maxStartAttempts = 8;
/** The longest wait before the repair sends a run's start again. */
const maxStartBackoffMs = 30 * 60_000;
/**
 * How long a run may say `starting` before it is marked failed: well under
 * the shortest run retention a deployment may set (a day), so the engine
 * still holds the record or tombstone of any instance a start created, and
 * a start sent again can't make a second one.
 */
const maxStartingMs = 6 * 3_600_000;

/**
 * The termination core owes the engine for run `id`, which core ended
 * while it was starting (as `ended`), as a statement for the batch that
 * ends it: written only if the row did end so, and kept until the engine
 * confirms (`repairResourceTerminations`). The row, ended, never changes
 * again, so it can't hold it; and the engine may have made an instance
 * the row never heard of (a start sent again as core ended it), which
 * would otherwise run on behind it.
 */
const owedTermination = (
  db: DrizzleD1Database,
  id: string,
  ended: "cancelled" | "failed",
  now: Date
) =>
  db
    .insert(workflowResourceRunTerminations)
    .select(
      db
        .select({
          runId: workflowResourceRuns.id,
          attempts: sql<number>`0`.as("attempts"),
          nextAt: sql<Date>`${now.getTime()}`.as("next_at"),
        })
        .from(workflowResourceRuns)
        .where(
          and(
            eq(workflowResourceRuns.id, id),
            eq(workflowResourceRuns.status, ended)
          )
        )
    )
    .onConflictDoNothing();

/**
 * Marks a run that never started failed, from `now`, once: it holds its
 * workflow's deletion no more, and its receipt's input goes with run
 * retention like any ended run's. The engine is owed a termination with
 * it: a start sent again just after the repair asked the engine may have
 * made an instance since, which reads the row before this commits.
 */
const startAbandoned = async (
  env: Env,
  row: RunRow,
  now: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(workflowResourceRuns)
      .set({
        status: "failed",
        endedAt: now,
        failureCode: "workflow.start_unconfirmed",
      })
      .where(
        and(
          eq(workflowResourceRuns.id, row.id),
          eq(workflowResourceRuns.status, "starting")
        )
      ),
    outboxedIfChanged(db, {
      ...runEntry(row, "workflow.run.failed"),
      detail: {
        ...runEntry(row, "workflow.run.failed").detail,
        reason: "workflow.start_unconfirmed",
        attempts: row.startAttempts,
      },
    }),
    owedTermination(db, row.id, "failed", now),
  ]);
  await tellQueryFollowers(env, row.id);
};

/**
 * One repair of run `row`, still starting: the engine asked first. A run
 * it has is the engine's from then on: its row moves off `starting`, and
 * nothing more. Even one the engine says has ended waits for that end's
 * notification, which carries when it ended (the status doesn't): ended
 * now, its row would say the repair's time, and never change again.
 * Otherwise its start is sent again, counted, the next try backing off;
 * past {@link maxStartAttempts} tries or {@link maxStartingMs}, it is
 * marked failed.
 */
const repairStart = async (env: Env, row: RunRow, now: Date): Promise<void> => {
  const backoff = Math.min(
    repairAfterMs * 2 ** row.startAttempts,
    maxStartBackoffMs
  );
  const pastStarting = now.getTime() - row.createdAt.getTime() > maxStartingMs;
  let live: Awaited<ReturnType<ReturnType<typeof runEngine>["status"]>>;
  try {
    live = await runEngine(env).status(row.id);
  } catch (error) {
    // Past its time to start, the run is abandoned all the same: the
    // termination that owes the engine (`startAbandoned`) ends any instance
    // it had, so an engine whose lookup keeps failing never keeps a run
    // starting, or its workflow undeletable, for good.
    if (pastStarting) {
      await startAbandoned(env, row, now);
      throw error;
    }
    // The engine couldn't say: the run may well be there, so it is neither
    // sent again nor counted, but it yields its place in the queue until
    // its backoff is over, so runs whose lookup keeps failing never keep
    // the others from their repair.
    await drizzle(env.DB)
      .update(workflowResourceRuns)
      .set({ nextStartAt: new Date(now.getTime() + backoff) })
      .where(
        and(
          eq(workflowResourceRuns.id, row.id),
          eq(workflowResourceRuns.status, "starting"),
          eq(workflowResourceRuns.startAttempts, row.startAttempts)
        )
      );
    throw error;
  }
  if (live !== undefined) {
    await drizzle(env.DB)
      .update(workflowResourceRuns)
      .set({ status: "running" })
      .where(
        and(
          eq(workflowResourceRuns.id, row.id),
          eq(workflowResourceRuns.status, "starting")
        )
      );
    await tellQueryFollowers(env, row.id);
    return;
  }
  if (row.startAttempts >= maxStartAttempts || pastStarting) {
    await startAbandoned(env, row, now);
    return;
  }
  // Claimed by its count, so two repairs never send it at once.
  const claimed = await drizzle(env.DB)
    .update(workflowResourceRuns)
    .set({
      startAttempts: row.startAttempts + 1,
      nextStartAt: new Date(now.getTime() + backoff),
    })
    .where(
      and(
        eq(workflowResourceRuns.id, row.id),
        eq(workflowResourceRuns.status, "starting"),
        eq(workflowResourceRuns.startAttempts, row.startAttempts)
      )
    )
    .returning({ id: workflowResourceRuns.id });
  if (claimed.length > 0) {
    await sendStart(env, row);
  }
};

/**
 * Repairs runs still `starting` a minute after their receipt (core
 * stopped between the receipt and the engine, or the engine refused),
 * those due first: each backs off on its own, so runs that can't start
 * don't keep newer ones from their turn, and end failed (`repairStart`).
 * From the cron, at `now`.
 */
export const repairResourceStarts = async (
  env: Env,
  now: Date = new Date()
): Promise<void> => {
  const stale = await drizzle(env.DB)
    .select()
    .from(workflowResourceRuns)
    .where(
      and(
        eq(workflowResourceRuns.status, "starting"),
        lt(
          workflowResourceRuns.createdAt,
          new Date(now.getTime() - repairAfterMs)
        ),
        or(
          isNull(workflowResourceRuns.nextStartAt),
          lte(workflowResourceRuns.nextStartAt, now)
        )
      )
    )
    .orderBy(
      asc(
        sql`coalesce(${workflowResourceRuns.nextStartAt}, ${workflowResourceRuns.createdAt})`
      )
    )
    .limit(repairsPerRun);
  for (const row of stale) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one start at a time
      await repairStart(env, row, now);
    } catch (error) {
      log.error("workflow.resource_run_repair_failed", {
        runId: row.id,
        ...errorFields(error),
      });
    }
  }
};

/** How the run's code ended: as it reports it, or as loading it failed. */
const settledRun = async (
  run: () => Promise<unknown>
): Promise<Settled<unknown>> => {
  const outer = await settle(run);
  return outer.ok ? fromIsolate(outer.value) : outer;
};

/** What an activation of a run is given by its object (run-object.ts). */
export interface ResourceRunMemory {
  leaseOf: ResourceHostHooks["leaseOf"];
  /** What the run keeps of its tried-once attempts (`TriedOnceMarks`). */
  triedOnce?: ResourceHostHooks["triedOnce"];
  /** The model calls its actions made (`ActionModelCalls`). */
  modelCalls?: ResourceHostHooks["modelCalls"];
  /** Aborts once the activation running the run is over. */
  over?: AbortSignal;
  /** Whether the run is still this activation's. */
  current?: () => boolean;
}

/**
 * What an activation of run `runId` loads, checked against each other and
 * the pin: its row, its receipt's input and frozen parameters, its
 * version's sealed build (the identity it was admitted for) and contract.
 */
const loadedRun = async (
  env: Env,
  pin: PinnedResourceRun,
  runId: string
): Promise<{ run: HostedResourceRun; output: string; subject: string }> => {
  const row = await runOf(env, runId);
  if (
    row === undefined ||
    row.workflowResourceId !== pin.workflow ||
    row.version !== pin.version ||
    row.manifestHash !== pin.manifest
  ) {
    throw new Error(`Run ${runId} doesn't match its record`);
  }
  if (!unended.includes(row.status)) {
    throw new Error(`Run ${runId} has ended: ${row.status}`);
  }
  const receipt = await receiptOf(env, runId);
  if (
    receipt?.manifestHash !== pin.manifest ||
    receipt.input === null ||
    receipt.params === null
  ) {
    throw new Error(`Run ${runId}'s receipt doesn't admit it`);
  }
  // The expressions run only under the evaluator the version was published
  // with: the platform ships one, so a deploy that changed it fails runs of
  // versions sealed under another, saying so, rather than evaluate them
  // under rules they weren't published with (or keep old evaluators).
  const sealed = await drizzle(env.DB)
    .select({ evaluatorHash: workflowResourceVersions.evaluatorHash })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, pin.workflow),
        eq(workflowResourceVersions.version, pin.version)
      )
    )
    .get();
  if (sealed === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  if (sealed.evaluatorHash !== jqProvenance.sha256) {
    throw workflowResourceErrors.create("workflow.evaluator_changed");
  }
  const build = await loadWorkflowBuild(
    env,
    pin.workflow,
    pin.version,
    pin.manifest
  );
  if (build.hash !== row.buildHash) {
    log.error("workflow.build_corrupt", {
      workflow: pin.workflow,
      version: pin.version,
      what: "run's build",
    });
    throw workflowResourceErrors.create("workflow.version_corrupt");
  }
  const contract = await versionContract(env, pin.workflow, pin.version);
  if (contract === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  const { limits } = await quotaPolicy(env);
  const calling = await callingRunOf(env, pin.workflow, runId);
  if (calling === undefined) {
    throw new Error(`Run ${runId} has ended`);
  }
  return {
    run: {
      runId,
      workflowId: pin.workflow,
      version: pin.version,
      principal: row.principalId,
      input: z.json().parse(JSON.parse(receipt.input)),
      params: jsonObjectSchema.parse(JSON.parse(receipt.params)),
      createdAt: row.createdAt.getTime(),
      build,
      calling,
      // The workflow's own limit only ever lowers the host's ceiling.
      maxModelCalls: Math.min(
        limits.lineageModelRequests,
        build.limits.maxModelCalls ?? limits.lineageModelRequests
      ),
    },
    output: JSON.stringify(contract.output),
    subject: admissionSubjectOf(row, receipt),
  };
};

/**
 * `value` as plain JSON if it is within what a step's result may take:
 * written once by the bounded writer, so nothing larger is walked, then
 * read back from that text. `undefined` otherwise.
 */
const resultJson = (value: unknown): Json | undefined => {
  const written = writeJson(value, {
    maxBytes: maxResultBytes,
    maxDepth: evaluatorLimits.maxJsonDepth + 2,
    maxNodes: maxResultBytes,
    sortKeys: false,
    safeIntegers: false,
  });
  return written.ok
    ? z.json().safeParse(JSON.parse(written.text)).data
    : undefined;
};

/**
 * `value`, from the isolate, if it is what the version's output schema
 * (`descriptor`) takes, by the SDK's own validator, and within what a
 * step's result may take, before and after its defaults are filled in:
 * the module's own result, never read past that bound, as a task's isn't
 * (resource-host.ts). `workflow.output_invalid` otherwise.
 */
const acceptedOutput = (descriptor: string, value: unknown): unknown => {
  const bounded = resultJson(value);
  if (bounded === undefined) {
    throw workflowResourceErrors.create("workflow.output_invalid");
  }
  const checked =
    schemaFromDescriptor(descriptor)["~standard"].validate(bounded);
  if ("then" in checked || checked.issues !== undefined) {
    throw workflowResourceErrors.create("workflow.output_invalid");
  }
  // As the validator answered it: its defaults filled in.
  if (resultJson(checked.value) === undefined) {
    throw workflowResourceErrors.create("workflow.output_invalid");
  }
  return checked.value;
};

/**
 * Runs (or resumes) one activation of a run of an independent workflow,
 * as `pin` names it (`loadedRun`): the build's generated module run in an
 * isolate of its own against a host of the run (resource-host.ts).
 * Answers the run's output, once it matches its version's output schema.
 */
export const runResourceWorkflow = async (
  env: Env,
  pin: PinnedResourceRun,
  runId: string,
  engineStep: RunStep,
  memory: ResourceRunMemory
): Promise<unknown> => {
  const { run, output, subject } = await loadedRun(env, pin, runId);
  // The workflow's own step limit only ever lowers the host's.
  const ceiling = await stepLimitOf(env);
  const step = countedStep(
    engineStep,
    Math.min(ceiling, run.build.limits.maxSteps ?? ceiling)
  );
  const calls: AttemptCall[] = [];
  let tampered: StepError | undefined;
  // The run's own sandbox session on-prem, its actions' parent.
  let sessionId: string | undefined;
  const host = new ResourceRunHost(env, step, run, {
    sessionId: () => sessionId,
    leaseOf: memory.leaseOf,
    ...(memory.triedOnce === undefined ? {} : { triedOnce: memory.triedOnce }),
    ...(memory.modelCalls === undefined
      ? {}
      : { modelCalls: memory.modelCalls }),
    attemptCall: trackAttemptCalls(calls),
    tampered: (error) => {
      tampered ??= error;
    },
    // The root of its own lineage: an independent run starts no runs.
    admitAttempt: async (attempt) =>
      await admitAttempt(
        env,
        { run: runId, root: runId, subject, resource: ownerOf(pin.workflow) },
        attempt
      ),
  });
  const code = loadRunIsolate<ResourceAttemptHost>(
    env,
    {
      owner: ownerOf(pin.workflow),
      mainModule: openRunModule,
      modules: async () =>
        await Promise.resolve({
          ...run.build.sdk,
          ...run.build.modules,
          [openRunModule]: openRunMain,
        }),
      attemptMethods: resourceAttemptMethods,
    },
    {
      onSession: (id) => {
        sessionId = id;
      },
      ...(memory.over === undefined ? {} : { over: memory.over }),
      ...(memory.current === undefined ? {} : { current: memory.current }),
    }
  );
  const result = await settledRun(async () => {
    try {
      return await code.run(host, { input: run.input });
    } catch (error) {
      return await afterCpuKill(error, calls);
    }
  });
  if (!result.ok && memory.current?.() === false) {
    throw new Error(`Run ${runId} is no longer this activation's`);
  }
  // The refusal that caught the isolate asking for what generated code
  // never does: the run fails with it, whatever the code made of it.
  const failed = tampered ?? (result.ok ? undefined : result.error);
  if (failed !== undefined) {
    throw namedError(failed.name, failed.message, failed.code);
  }
  return acceptedOutput(output, result.ok ? result.value : undefined);
};

/** Where the engine has a run's result: its output, or why it failed. */
const engineResultOf = async (
  env: Env,
  id: string
): Promise<Pick<WorkflowResourceRun, "output" | "error">> => {
  const live = await runEngine(env).status(id);
  if (live?.status === "complete") {
    return { output: live.output };
  }
  if (live?.status === "errored") {
    return {
      error: { code: live.error.code ?? null, message: live.error.message },
    };
  }
  return {};
};

/**
 * Why a run failed as its row keeps it (`failureCode`): core's own reason
 * for a run the engine never had, or the engine's code once the engine no
 * longer holds the run.
 */
const keptFailureOf = (code: string): WorkflowResourceRun["error"] => {
  const known = workflowResourceErrors.codeOf({ code });
  return {
    code,
    message:
      known === undefined
        ? "The run failed."
        : workflowResourceErrors.create(known).message,
  };
};

/**
 * What run `row` returned or why it failed: where the engine has its
 * result, or else why its row says it failed (its `failureCode`: core's
 * reason, or the engine's code, kept as it ended). Once its retention, as
 * the deployment has it now, is over, or the sweep removed them from its
 * receipt (`detailsRemoved`, by the rows alone, as every reader of a run),
 * nothing of what it returned, and of why it
 * failed only the code: the engine keeps a run for the retention it was
 * admitted with, which may since have been shortened, or lengthened.
 */
const resultOf = async (
  env: Env,
  row: RunRow
): Promise<Pick<WorkflowResourceRun, "output" | "error">> => {
  // The sweep's mark on its receipt too: details removed once stay removed,
  // whatever the retention says after.
  const receipt = await drizzle(env.DB)
    .select({ detailsRemovedAt: workflowStartReceipts.detailsRemovedAt })
    .from(workflowStartReceipts)
    .where(eq(workflowStartReceipts.id, row.id))
    .get();
  const removed = detailsRemoved(env, {
    endedAt: row.endedAt,
    detailsRemovedAt: receipt?.detailsRemovedAt ?? null,
  });
  // Only what the row's own end says: an output for a completed run, why
  // for a failed one, nothing for any other, whatever the engine holds (a
  // late start of a run core ended runs on to a failure of its own). A
  // completed run past its retention keeps nothing to say: the engine
  // isn't asked for an output nobody may read.
  if (
    (row.status !== "completed" && row.status !== "failed") ||
    (removed && row.status === "completed")
  ) {
    return {};
  }
  // Past its retention, a failed run says only the code its row kept, if
  // any: the engine, which may be unreachable, or no longer hold it, isn't
  // asked.
  if (removed) {
    return { error: { code: row.failureCode, message: removedText(env) } };
  }
  let engine: Pick<WorkflowResourceRun, "output" | "error">;
  try {
    engine = await engineResultOf(env, row.id);
  } catch (error) {
    // The engine unreachable: a failure its row keeps the code of is read
    // from the row, a start core abandoned the same as any.
    if (row.status === "failed" && row.failureCode !== null) {
      return { error: keptFailureOf(row.failureCode) };
    }
    throw error;
  }
  if (row.status === "completed") {
    return engine.output === undefined ? {} : { output: engine.output };
  }
  // Core's reason for a run it ended, or the engine's code once the engine
  // no longer has the run: as the row keeps it.
  if (row.failureCode !== null && engine.error?.code !== row.failureCode) {
    return { error: keptFailureOf(row.failureCode) };
  }
  return engine.error === undefined ? {} : { error: engine.error };
};

/**
 * Run `runId` of workflow `id`, for `by`, who must have a role in it. What
 * it returned or why it failed only for the person it acts for and the
 * organization's admins: it can hold what the run read for them.
 */
export const resourceRunFor = async (
  env: Env,
  by: Acting,
  id: unknown,
  runId: unknown
): Promise<WorkflowResourceRun> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const row = typeof runId === "string" ? await runOf(env, runId) : undefined;
  if (row?.workflowResourceId !== workflow.id) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  // Someone else's run, only to its workflow's builders (admins among
  // them): a user sees their own, and learns nothing of others'.
  if (row.principalId !== by.userId) {
    try {
      await requireWorkflowRole(env, by, workflow.id, "builder");
    } catch (error) {
      if (!isExpectedError(error)) {
        throw error;
      }
      throw workflowResourceErrors.create("workflow.run_unavailable");
    }
  }
  const run: WorkflowResourceRun = {
    id: row.id,
    workflowId: row.workflowResourceId,
    version: row.version,
    manifestHash: row.manifestHash,
    buildHash: row.buildHash,
    principal: row.principalId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
  const seesDetails = by.userId === row.principalId || isAdmin(by.role);
  return seesDetails && row.endedAt !== null
    ? { ...run, ...(await resultOf(env, row)) }
    : run;
};

/** `by`'s terminate of run `row`, as audited, the row then `status`. */
const terminatedEntry = (
  by: Acting,
  row: RunRow,
  status: WorkflowRunStatus
): AuditEntry => ({
  ...runEntry(row, "workflow.run.terminated"),
  actor: actorOf(by),
  detail: { ...runEntry(row, "workflow.run.terminated").detail, status },
});

/**
 * Cancels run `row` while it is still `starting`, the engine yet to
 * confirm it, so core's to end: its row first, audited with it, before
 * anything is asked of the engine. Whether it was still starting.
 */
const cancelStarting = async (
  env: Env,
  by: Acting,
  row: RunRow
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const now = new Date();
  const [cancelled] = await auditedBatch(env, db, [
    db
      .update(workflowResourceRuns)
      .set({ status: "cancelled", endedAt: now })
      .where(
        and(
          eq(workflowResourceRuns.id, row.id),
          eq(workflowResourceRuns.status, "starting")
        )
      )
      .returning({ id: workflowResourceRuns.id }),
    outboxedIfChanged(db, terminatedEntry(by, row, "cancelled")),
    owedTermination(db, row.id, "cancelled", now),
  ]);
  if (cancelled.length > 0) {
    await tellQueryFollowers(env, row.id);
  }
  return cancelled.length > 0;
};

/**
 * Tells the engine to terminate run `runId`, which core cancelled while it
 * was starting, and settles what it owed: once the engine confirms (it
 * terminates an instance it has, and has nothing to do for one it hasn't
 * or that has ended), the termination is no longer kept. Throws as the
 * engine refuses, the termination kept for the repair.
 */
const sendTermination = async (env: Env, runId: string): Promise<void> => {
  await runEngine(env).terminate(runId);
  await drizzle(env.DB)
    .delete(workflowResourceRunTerminations)
    .where(eq(workflowResourceRunTerminations.runId, runId));
};

/** Most owed terminations one repair sends. */
const terminationsPerRepair = 50;

/**
 * Sends again the terminations core still owes the engine, those due
 * first, each backing off on its own as the engine refuses it (claimed by
 * its count, so two repairs never send one at once). Never given up: an
 * instance made before its cancel would otherwise keep its lease, or
 * sleep on to its alarm. From the cron, at `now`.
 */
export const repairResourceTerminations = async (
  env: Env,
  now: Date = new Date()
): Promise<void> => {
  const db = drizzle(env.DB);
  const owed = await db
    .select()
    .from(workflowResourceRunTerminations)
    .where(lte(workflowResourceRunTerminations.nextAt, now))
    .orderBy(asc(workflowResourceRunTerminations.nextAt))
    .limit(terminationsPerRepair);
  for (const { runId, attempts } of owed) {
    const backoff = Math.min(repairAfterMs * 2 ** attempts, maxStartBackoffMs);
    // oxlint-disable-next-line no-await-in-loop -- one at a time
    const claimed = await db
      .update(workflowResourceRunTerminations)
      .set({
        attempts: attempts + 1,
        nextAt: new Date(now.getTime() + backoff),
      })
      .where(
        and(
          eq(workflowResourceRunTerminations.runId, runId),
          eq(workflowResourceRunTerminations.attempts, attempts)
        )
      )
      .returning({ runId: workflowResourceRunTerminations.runId });
    if (claimed.length === 0) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await sendTermination(env, runId);
    } catch (error) {
      log.error("workflow.resource_run_terminate_failed", {
        runId,
        ...errorFields(error),
      });
    }
  }
};

/**
 * Stops run `runId` of workflow `id` for `by`, a builder of it (an admin
 * builds every workflow) who isn't Grasp staff, audited under `by`. The
 * way to end a run that waits long, or never started, before the workflow
 * can be deleted. `workflow.run_ended` for a run that has ended already.
 *
 * A run still starting is core's to end: its row ends cancelled first,
 * and only then is the engine told, so a start sent before the cancel
 * that makes an instance since is terminated, and one that makes it later
 * still runs nothing: each activation reads the row first (`loadedRun`).
 * The engine told first, a start between its answer and the row's write
 * would run on behind a row about to say cancelled. The termination the
 * engine is told is kept with the cancel until it confirms, the repair
 * sending it again (`repairResourceTerminations`), so an instance made
 * before the cancel never keeps its lease or alarm. A run the engine has
 * is the engine's to end: it terminates it, and the row takes the end the
 * engine confirms.
 */
export const terminateResourceRun = async (
  env: Env,
  by: Acting,
  id: unknown,
  runId: unknown
): Promise<WorkflowResourceRun> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const row = typeof runId === "string" ? await runOf(env, runId) : undefined;
  if (row?.workflowResourceId !== workflow.id) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  if (!unended.includes(row.status)) {
    throw workflowResourceErrors.create("workflow.run_ended");
  }
  if (row.status === "starting" && (await cancelStarting(env, by, row))) {
    try {
      await sendTermination(env, row.id);
    } catch (error) {
      // Cancelled all the same: the repair tells the engine.
      log.error("workflow.resource_run_terminate_failed", {
        runId: row.id,
        ...errorFields(error),
      });
    }
    return await resourceRunFor(env, by, workflow.id, row.id);
  }
  await runEngine(env).terminate(row.id);
  // The engine took the terminate: audited below whatever this lookup
  // does, the row left to the end's notification if it can't be read.
  let live: Awaited<ReturnType<ReturnType<typeof runEngine>["status"]>>;
  try {
    live = await runEngine(env).status(row.id);
  } catch (error) {
    log.error("workflow.resource_run_status_failed", {
      runId: row.id,
      ...errorFields(error),
    });
  }
  if (live?.status === "terminated") {
    // The end the engine confirms in answer to this, at once (no
    // sequence): an ended run never changes again, so no later
    // notification can be newer. A run that ended on its own first is
    // left to its end's notification, which carries when it ended: the
    // status doesn't, and taken now its row would say this call's time.
    await projectResourceRun(env, row.id, {
      status: live.status,
      at: Date.now(),
    });
  }
  const now = await runOf(env, row.id);
  // Whoever asked, whatever the row took: the engine tells the run's
  // projection of the termination as it happens, so the row may say
  // cancelled before the statement above does.
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, terminatedEntry(by, row, now?.status ?? row.status)),
  ]);
  return await resourceRunFor(env, by, workflow.id, row.id);
};
