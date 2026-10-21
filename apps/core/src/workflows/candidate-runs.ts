import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  maxCandidateLifetimeMs,
  maxCandidateWaitMs,
  maxKeptCandidateRuns,
  maxLiveCandidateRuns,
  workflowCandidateStartSchema,
  workflowNamespace,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowCandidateRun,
  WorkflowRunStatus,
} from "@grasp-os/shared/workflow-resources";
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";
import { jqProvenance } from "@grasp-os/workflow-expressions/provenance";
import { and, eq, inArray, lt, lte, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import {
  runLineageAttempts,
  runLineages,
  workflowCandidateRuns,
  workflowResources,
} from "../db/core/schema.ts";
import { notNullFailed } from "../db/d1.ts";
import { requireNotStaff } from "../sharing.ts";
import {
  loadCandidateBuild,
  releaseBuild,
  storeBuild,
} from "../workflow-builds.ts";
import { draftCheckpoint } from "../workflow-drafts.ts";
import { candidateParams } from "../workflow-params.ts";
import {
  candidateBuildOf,
  liveWorkflow,
  requireWorkflowRole,
} from "../workflow-resources.ts";
import { acceptedInput } from "../workflow-starts.ts";
import { runDequeued } from "./admission.ts";
import { runEngine, runRetentionDays } from "./engine.ts";
import type { PinnedCandidateRun } from "./engine.ts";
import type { RunStep } from "./host.ts";
import { quotaPolicy } from "./quotas.ts";
import type { HostedResourceRun } from "./resource-host.ts";
import {
  engineResultOf,
  keptFailureOf,
  runLoadedResource,
} from "./resource-runs.ts";
import type { ResourceRunMemory } from "./resource-runs.ts";
import type { EngineStatus } from "./runs.ts";

// Test runs of a workflow's draft checkpoint, never published (GRA-815,
// spec 13.10 and 22.7): a builder runs the exact checkpoint they checked,
// before anyone else's runs can, to see what it does. Threat model, each
// tried in candidate-runs.test.ts:
//
// - A test with an effect. A test run calls nothing: every named call it
//   makes, a task's or an action's (connector, operation, model,
//   Knowledge, template), is answered from the start's `fixtures` by the
//   binding it goes through, in `makeCall` before any binding, authority
//   or receipt is looked at (resource-calls.ts); a call through a binding
//   with no answer fails the run (`workflow.candidate_unfixtured`). Its
//   compute and action code runs in the same sandbox as a version's.
// - Draft code reading a secret. Its parameters are the start's own values,
//   else the defaults (`candidateParams`), never the values set on the
//   workflow: its builder wrote its code, and a sensitive value they can't
//   read could otherwise be handed back to them in its output.
// - Running what wasn't checked. Only the latest draft revision, once it
//   passed, and only at the revision the start names
//   (`draftCheckpoint`): compiled as a publication would compile it,
//   pinned by its manifest's hash, and verified on every load as a
//   version's build is (`loadCandidateBuild`).
// - Someone else's draft. Only the workflow's builders start, read or
//   stop one, never Grasp staff.
// - A test that starts or schedules anything. It is no run of a version:
//   nothing binds it, no trigger, schedule or App can start it, and a
//   sealed build has no task that starts a run. Its row is no
//   `workflow_resource_runs` row, so nothing lists or counts it as one.
// - Load. Its attempts are admitted under the same quotas as any run's,
//   as its person's, in its workflow's test runs' own queue, never its
//   runs'. A person has at most `maxLiveCandidateRuns` going and
//   `maxKeptCandidateRuns` kept of a workflow; a test run waits at most
//   `maxCandidateWaitMs` at a time and goes on at most
//   `maxCandidateLifetimeMs` in all, and its builders can stop it. Its rows and builds
//   are kept a week, or the deployment's run retention if shorter
//   (`sweepCandidateRuns`, release-retention.ts).
// - Its record. Every row of its own is immutable but its status
//   (migration 0110), and what the audit log keeps of it says it was a
//   test run (`candidate: true`).

/** How long a test run is kept once it started, at most. */
const candidateKeptMs = 7 * 24 * 60 * 60 * 1000;

/**
 * How long the deployment keeps a test run: a week, or less when it keeps
 * runs for less (`RUN_RETENTION_DAYS`), so its row never outlives what the
 * engine keeps of it, and nothing of it is kept longer than the client
 * chose.
 */
const keptMsOf = (env: Env): number => {
  const days = runRetentionDays(env);
  return days === undefined
    ? candidateKeptMs
    : Math.min(candidateKeptMs, days * 24 * 60 * 60 * 1000);
};

/** How long past its lifetime a test run still `running` is let be. */
const overdueGraceMs = 15 * 60 * 1000;

/** How long a test run may stay `starting` before the sweep settles it. */
const startGraceMs = 10 * 60 * 1000;

/** Most test runs one batch of the sweep takes. */
const candidatesPerSweep = 100;

/** How long one sweep goes on removing test runs, batch after batch. */
const sweepBudgetMs = 20_000;

/** A test run's statuses that haven't ended. */
const unended: WorkflowRunStatus[] = ["starting", "running"];

/** Where the engine says a run is, as a test run's row has it. */
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

/** The audit action of each way a test run ends, as a run's ends are. */
const endActions: Partial<Record<WorkflowRunStatus, string>> = {
  completed: "workflow.run.completed",
  failed: "workflow.run.failed",
  cancelled: "workflow.run.cancelled",
};

/**
 * The audit entry of test run `run` ending `status`, against its
 * workflow and marked a test run's, naming the failure's code when it has
 * one; none for a status that isn't an end. Its row is swept after a week
 * (`sweepCandidateRuns`), so this is what records how it ended after that.
 */
const endEntry = (
  run: { id: string; workflowResourceId: string },
  status: WorkflowRunStatus,
  failureCode: string | null
): AuditEntry | undefined => {
  const action = endActions[status];
  if (action === undefined) {
    return undefined;
  }
  return {
    actor: { type: "system" },
    action,
    target: { type: "workflow_resource", id: run.workflowResourceId },
    detail: {
      run: run.id,
      candidate: true,
      ...(status === "failed" && failureCode !== null ? { failureCode } : {}),
    },
  };
};

/**
 * Ends test run `run` failed at core's word (`failureCode`), at `at`, if
 * its row is still `from`; audited with the change, once.
 */
const failedByCore = async (
  env: Env,
  run: { id: string; workflowResourceId: string },
  from: WorkflowRunStatus,
  failureCode: string,
  at: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  const entry = endEntry(run, "failed", failureCode);
  await auditedBatch(env, db, [
    db
      .update(workflowCandidateRuns)
      .set({ status: "failed", failureCode, endedAt: at })
      .where(
        and(
          eq(workflowCandidateRuns.id, run.id),
          eq(workflowCandidateRuns.status, from)
        )
      ),
    ...(entry === undefined ? [] : [outboxedIfChanged(db, entry)]),
  ]);
};

/** Whose build artifacts a test run's are: its own. */
const reservationOf = (workflow: string, run: string): string =>
  `${workflow}~candidate~${run}`;

/**
 * Whose a test run's isolates and admissions are: its workflow's test
 * runs', never its runs', so test runs never wait in its runs' queue.
 */
const candidateOwnerOf = (workflow: string): string => `candidate:${workflow}`;

/** How many of `person`'s test runs of `workflow` are going, and kept, as SQL. */
const countsOf = (workflow: string, person: string) => ({
  going: sql<number>`(SELECT COUNT(*) FROM ${workflowCandidateRuns}
    WHERE ${workflowCandidateRuns.workflowResourceId} = ${workflow}
      AND ${workflowCandidateRuns.principalId} = ${person}
      AND ${workflowCandidateRuns.status} IN ('starting', 'running'))`,
  kept: sql<number>`(SELECT COUNT(*) FROM ${workflowCandidateRuns}
    WHERE ${workflowCandidateRuns.workflowResourceId} = ${workflow}
      AND ${workflowCandidateRuns.principalId} = ${person})`,
});

/**
 * Refuses another test run of `workflow` for `person` past either limit:
 * `workflow.candidate_limit` while `maxLiveCandidateRuns` are going,
 * `workflow.candidate_kept_limit` while `maxKeptCandidateRuns` are kept.
 */
const requireUnderLimits = async (
  env: Env,
  workflow: string,
  person: string
): Promise<void> => {
  const { going, kept } = countsOf(workflow, person);
  const counts = await drizzle(env.DB).get<{ going: number; kept: number }>(
    sql`SELECT ${going} AS going, ${kept} AS kept`
  );
  if ((counts?.kept ?? 0) >= maxKeptCandidateRuns) {
    throw workflowResourceErrors.create("workflow.candidate_kept_limit", {
      limit: maxKeptCandidateRuns,
    });
  }
  if ((counts?.going ?? 0) >= maxLiveCandidateRuns) {
    throw workflowResourceErrors.create("workflow.candidate_limit", {
      limit: maxLiveCandidateRuns,
    });
  }
};

/** What a test run's manifest seals beside its build. */
const candidateManifestSchema = z.object({
  evaluatorHash: z.string(),
  contract: z.object({ input: z.json(), output: z.json() }),
  bindings: z.array(
    z.object({
      alias: z.string(),
      kind: z.string(),
      contractId: z.string(),
      fingerprint: z.string(),
    })
  ),
});

type CandidateRow = typeof workflowCandidateRuns.$inferSelect;

const jsonObjectSchema = z.record(z.string(), z.json());

const rowOf = async (env: Env, id: string): Promise<CandidateRow | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(workflowCandidateRuns)
    .where(eq(workflowCandidateRuns.id, id))
    .get();

/**
 * Starts a test run of workflow `id`'s draft checkpoint for `by`, one of
 * its builders, from `input` (`workflowCandidateStartSchema`): the
 * checkpoint at exactly the revision it names, compiled now into a build
 * of its own and pinned to it; its input and parameters checked against
 * the checkpoint's contract; every call it will make answered from the
 * start's fixtures. Its run's ID.
 */
export const startCandidateRun = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<{ runId: string }> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  // A cheap refusal before anything is compiled; the row's own write
  // checks again, atomically (`allowed`).
  await requireUnderLimits(env, workflow.id, by.userId);
  const {
    revision,
    input: given,
    params = {},
    fixtures,
  } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowCandidateStartSchema,
    input
  );
  const checkpoint = await draftCheckpoint(env, workflow.id, revision);
  const built = await candidateBuildOf(
    env,
    by,
    workflow,
    checkpoint.source,
    checkpoint.modules
  );
  if (!built.compiled.build.executable) {
    throw workflowResourceErrors.create("workflow.candidate_unexecutable");
  }
  const inputText = acceptedInput(JSON.stringify(built.contract.input), given);
  const paramsText = candidateParams(built.contract, params);
  const runId = crypto.randomUUID();
  const reservation = reservationOf(workflow.id, runId);
  const manifest = canonicalJson({
    formatVersion: 1,
    target: "workflow-candidate",
    resourceId: workflow.id,
    draftRevision: revision,
    namespace: workflowNamespace,
    name: workflow.name,
    definitionVersion: built.checked.identity.version,
    profile: built.checked.profile,
    definitionHash: built.definitionHash,
    evaluatorHash: jqProvenance.sha256,
    contract: built.contract,
    // What each binding was checked against, by catalog contract: every
    // answer the run is given is checked against it (`makeCall`).
    bindings: built.bindings.map(
      ({ alias, kind, contractId, fingerprint }) => ({
        alias,
        kind,
        contractId,
        fingerprint,
      })
    ),
    build: built.compiled.build,
  });
  const manifestHash = await sha256Hex(manifest);
  const db = drizzle(env.DB);
  const createdAt = new Date();
  // Written only while the workflow is live and its person is under both
  // limits: otherwise NULL, which fails the batch (`allowed`).
  const { going, kept } = countsOf(workflow.id, by.userId);
  const allowed = sql<string>`(SELECT ${workflowResources.id} FROM ${workflowResources}
    WHERE ${workflowResources.id} = ${workflow.id} AND ${workflowResources.deletedAt} IS NULL
      AND ${going} < ${maxLiveCandidateRuns} AND ${kept} < ${maxKeptCandidateRuns})`;
  try {
    // Its build's bytes, reserved for this run and stored before the row
    // that names them; given back, as is any part stored, if the row
    // isn't written.
    await storeBuild(env, { id: reservation, version: 1 }, built.compiled);
    await auditedBatch(env, db, [
      db.insert(workflowCandidateRuns).values({
        id: runId,
        workflowResourceId: allowed,
        draftRevision: revision,
        manifest,
        manifestHash,
        buildHash: built.compiled.build.hash,
        reservation,
        principalId: by.userId,
        input: inputText,
        params: paramsText,
        fixtures: canonicalJson(fixtures),
        status: "starting",
        createdAt,
      }),
      outboxed(db, {
        actor: by.actor ?? actorOf(by),
        action: "workflow.candidate.started",
        target: { type: "workflow_resource", id: workflow.id },
        // Never its input, parameters or fixtures: names and counts only.
        detail: {
          run: runId,
          candidate: true,
          revision,
          build: built.compiled.build.hash,
          fixtures: Object.keys(fixtures).length,
        },
      }),
    ]);
  } catch (error) {
    await releaseBuild(
      env,
      { id: reservation, version: 1 },
      built.compiled
    ).catch((releaseError: unknown) => {
      log.warn("workflow.build_release_failed", errorFields(releaseError));
    });
    if (notNullFailed(error, "workflow_candidate_runs.workflow_resource_id")) {
      if ((await liveWorkflow(env, workflow.id)) === undefined) {
        throw workflowResourceErrors.create("workflow.resource_unavailable");
      }
      // Another start took the last place meanwhile: refused as it is.
      await requireUnderLimits(env, workflow.id, by.userId);
    }
    throw error;
  }
  const pinned: PinnedCandidateRun = {
    workflow: workflowResourceIdSchema.parse(workflow.id),
    manifest: manifestHash,
  };
  try {
    // Its input is its row's: the engine is given none.
    await runEngine(env).createCandidate({ id: runId, pinned, input: {} });
  } catch (error) {
    // Never started: ended failed, saying so, rather than left starting.
    await failedByCore(
      env,
      { id: runId, workflowResourceId: workflow.id },
      "starting",
      "workflow.start_unconfirmed",
      new Date()
    );
    throw error;
  }
  return { runId };
};

/**
 * What an activation of test run `runId` runs, checked against its pin:
 * its row, its build (`loadCandidateBuild`), the input and parameters its
 * start froze, and a calling context whose every call is answered from its
 * fixtures.
 */
const loadedCandidateRun = async (
  env: Env,
  pin: PinnedCandidateRun,
  runId: string
): Promise<{
  run: HostedResourceRun;
  output: string;
  subject: string;
  owner: string;
}> => {
  const row = await rowOf(env, runId);
  if (
    row === undefined ||
    row.workflowResourceId !== pin.workflow ||
    row.manifestHash !== pin.manifest
  ) {
    throw new Error(`Test run ${runId} doesn't match its record`);
  }
  if (!unended.includes(row.status)) {
    throw new Error(`Test run ${runId} has ended: ${row.status}`);
  }
  // Past its lifetime it runs nothing more, however its waits were
  // chained: each wakes it in an activation, which ends it here.
  if (Date.now() - row.createdAt.getTime() > maxCandidateLifetimeMs) {
    throw workflowResourceErrors.create("workflow.candidate_time_limit", {
      limit: maxCandidateLifetimeMs,
    });
  }
  // Its workflow deleted, it runs nothing more of its draft.
  if ((await liveWorkflow(env, pin.workflow)) === undefined) {
    throw workflowResourceErrors.create("workflow.resource_unavailable");
  }
  const sealed = candidateManifestSchema.parse(JSON.parse(row.manifest));
  // As a version's: only under the evaluator it was compiled with.
  if (sealed.evaluatorHash !== jqProvenance.sha256) {
    throw workflowResourceErrors.create("workflow.evaluator_changed");
  }
  const build = await loadCandidateBuild(env, pin.workflow, row, pin.manifest);
  if (build.hash !== row.buildHash) {
    throw workflowResourceErrors.create("workflow.version_corrupt");
  }
  const fixtures = z
    .record(z.string(), z.object({ output: z.json() }))
    .parse(JSON.parse(row.fixtures));
  const { limits } = await quotaPolicy(env);
  return {
    run: {
      runId,
      workflowId: pin.workflow,
      // No version's: a test run of a checkpoint.
      version: 0,
      principal: row.principalId,
      input: z.json().parse(JSON.parse(row.input)),
      params: jsonObjectSchema.parse(JSON.parse(row.params)),
      createdAt: row.createdAt.getTime(),
      build,
      calling: {
        runId,
        workflowId: pin.workflow,
        version: 0,
        principal: row.principalId,
        invoker: { type: "person", id: row.principalId, appVersion: null },
        // None frozen: every call is answered from its fixtures.
        bindings: new Map(),
        restricted: false,
        candidate: new Map(
          sealed.bindings.map(({ alias, kind, contractId, fingerprint }) => [
            alias,
            {
              kind,
              contractId,
              fingerprint,
              answer: Object.hasOwn(fixtures, alias)
                ? fixtures[alias]?.output
                : undefined,
            },
          ])
        ),
      },
      maxModelCalls: Math.min(
        limits.lineageModelRequests,
        build.limits.maxModelCalls ?? limits.lineageModelRequests
      ),
      // A test run waits only briefly: one waiting longer fails.
      maxSleepMs: maxCandidateWaitMs,
    },
    output: JSON.stringify(sealed.contract.output),
    // Its attempts take its person's share, as their own runs' do, in its
    // workflow's test runs' queue.
    subject: row.principalId,
    owner: candidateOwnerOf(pin.workflow),
  };
};

/** Runs test run `runId`'s activation (the dispatcher's, for its pin). */
export const runCandidateWorkflow = async (
  env: Env,
  pin: PinnedCandidateRun,
  runId: string,
  engineStep: RunStep,
  memory: ResourceRunMemory
): Promise<unknown> =>
  await runLoadedResource(
    env,
    await loadedCandidateRun(env, pin, runId),
    engineStep,
    memory
  );

/**
 * Keeps test run `id`'s row in step with where the engine says it is
 * (run-object.ts), each notification only if newer than the last one
 * applied; a failure's code kept with it.
 */
export const projectCandidateRun = async (
  env: Env,
  id: string,
  engine: EngineStatus,
  failureCode: string | null = null
): Promise<void> => {
  const row = await rowOf(env, id);
  if (row === undefined) {
    return;
  }
  // A row already ended (core cancelled it while starting) still gives up
  // its places in the admission queue below; its update changes nothing,
  // so nothing more is audited.
  const status = projected[engine.status];
  const ended = !unended.includes(status);
  const entry = endEntry(row, status, failureCode);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(workflowCandidateRuns)
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
          eq(workflowCandidateRuns.id, id),
          inArray(workflowCandidateRuns.status, unended),
          engine.sequence === undefined
            ? undefined
            : lt(workflowCandidateRuns.engineSequence, engine.sequence)
        )
      ),
    // Its end, audited with the change, once: a notification that changed
    // nothing records nothing.
    ...(entry === undefined ? [] : [outboxedIfChanged(db, entry)]),
    // Ended, its places in the admission queue go now, as a run's do.
    // After the audit entry, which reads what the row's update changed.
    ...(ended
      ? [
          runDequeued(
            db,
            id,
            sql`EXISTS (SELECT 1 FROM ${workflowCandidateRuns} WHERE ${workflowCandidateRuns.id} = ${id} AND ${workflowCandidateRuns.status} = ${status})`
          ),
        ]
      : []),
  ]);
};

/**
 * Test run `runId` of workflow `id`, for its builders only: anyone else,
 * and a run of another workflow, is refused as one that doesn't exist
 * (`workflow.candidate_unavailable`). What it returned, or why it failed,
 * once it ended.
 */
export const candidateRunFor = async (
  env: Env,
  by: Acting,
  id: unknown,
  runId: unknown
): Promise<WorkflowCandidateRun> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const row = typeof runId === "string" ? await rowOf(env, runId) : undefined;
  if (row?.workflowResourceId !== workflow.id) {
    throw workflowResourceErrors.create("workflow.candidate_unavailable");
  }
  const run: WorkflowCandidateRun = {
    id: row.id,
    workflowId: row.workflowResourceId,
    draftRevision: row.draftRevision,
    buildHash: row.buildHash,
    principal: row.principalId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
  if (row.status !== "completed" && row.status !== "failed") {
    return run;
  }
  const result = await engineResultOf(env, row.id);
  // Core's own reason for a run the engine never had, else the engine's.
  if (
    row.failureCode !== null &&
    (result.error === undefined || result.error.code !== row.failureCode)
  ) {
    return { ...run, error: keptFailureOf(row.failureCode) };
  }
  return { ...run, ...result };
};

/**
 * Stops test run `runId` of workflow `id` for `by`, one of its builders,
 * as one of its runs is stopped: the engine is asked first, so a stop
 * that fails there changes nothing and can be asked again; then one the
 * engine never confirmed ends cancelled, at core's word, and one it has
 * follows the engine's notification. One that ended stays as it is, but a
 * stop of one core cancelled asks the engine again, in case an instance of
 * it started meanwhile. Recorded, then answered as it reads now.
 */
export const terminateCandidateRun = async (
  env: Env,
  by: Acting,
  id: unknown,
  runId: unknown
): Promise<WorkflowCandidateRun> => {
  const before = await candidateRunFor(env, by, id, runId);
  if (before.status === "cancelled") {
    await runEngine(env).terminate(before.id);
    return before;
  }
  if (!unended.includes(before.status)) {
    return before;
  }
  await runEngine(env).terminate(before.id);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(workflowCandidateRuns)
      .set({ status: "cancelled", endedAt: new Date() })
      .where(
        and(
          eq(workflowCandidateRuns.id, before.id),
          eq(workflowCandidateRuns.status, "starting")
        )
      ),
    outboxed(db, {
      actor: by.actor ?? actorOf(by),
      action: "workflow.candidate.terminated",
      target: { type: "workflow_resource", id: before.workflowId },
      detail: { run: before.id, candidate: true },
    }),
  ]);
  return await candidateRunFor(env, by, id, before.id);
};

/**
 * Moves test run `id`'s row to where the engine has it (`live`), at `at`,
 * with the engine's failure code when it errored: kept on the row, it
 * outlives the engine's record of the run.
 */
const projectedFrom = async (
  env: Env,
  id: string,
  live: InstanceStatus,
  at: Date
): Promise<void> => {
  await projectCandidateRun(
    env,
    id,
    { status: live.status, at: at.getTime() },
    live.status === "errored" ? (live.error.code ?? null) : null
  );
};

/**
 * Settles the test runs still `starting` a start's grace after they were
 * written: the engine never told core of them (the start stopped between
 * its row and the engine, or the row's failure wasn't written). One the
 * engine has takes where the engine has it; one it hasn't ends failed
 * (`workflow.start_unconfirmed`), at core's word, so it neither counts
 * against its person's runs going nor reads as starting.
 */
const settleUnconfirmed = async (env: Env, at: Date): Promise<void> => {
  const db = drizzle(env.DB);
  const stuck = await db
    .select({
      id: workflowCandidateRuns.id,
      workflowResourceId: workflowCandidateRuns.workflowResourceId,
    })
    .from(workflowCandidateRuns)
    .where(
      and(
        eq(workflowCandidateRuns.status, "starting"),
        lte(
          workflowCandidateRuns.createdAt,
          new Date(at.getTime() - startGraceMs)
        )
      )
    )
    .orderBy(workflowCandidateRuns.createdAt)
    .limit(candidatesPerSweep);
  for (const run of stuck) {
    const { id } = run;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      const live = await runEngine(env).status(id);
      if (live !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await projectedFrom(env, id, live, at);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      await failedByCore(
        env,
        run,
        "starting",
        "workflow.start_unconfirmed",
        at
      );
    } catch (error) {
      log.warn("workflow.candidate_sweep_failed", {
        run: id,
        ...errorFields(error),
      });
    }
  }
};

/**
 * Ends the test runs still going past the time they are kept: one the
 * engine has is terminated (its end comes back as any run's does); one it
 * has no record of ends failed at once, saying so
 * (`workflow.run_unavailable`), so the sweep can take it.
 */
const endOverdue = async (env: Env, cutoff: Date): Promise<void> => {
  const db = drizzle(env.DB);
  const overdue = await db
    .select({
      id: workflowCandidateRuns.id,
      workflowResourceId: workflowCandidateRuns.workflowResourceId,
    })
    .from(workflowCandidateRuns)
    .where(
      and(
        eq(workflowCandidateRuns.status, "running"),
        lte(workflowCandidateRuns.createdAt, cutoff)
      )
    )
    .orderBy(workflowCandidateRuns.createdAt)
    .limit(candidatesPerSweep);
  for (const run of overdue) {
    const { id } = run;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      const live = await runEngine(env).status(id);
      // Ended there already, its end never reached the row: taken as is.
      if (live !== undefined && !unended.includes(projected[live.status])) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await projectedFrom(env, id, live, new Date());
        continue;
      }
      if (live !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await runEngine(env).terminate(id);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      await failedByCore(
        env,
        run,
        "running",
        "workflow.run_unavailable",
        new Date()
      );
    } catch (error) {
      log.warn("workflow.candidate_sweep_failed", {
        run: id,
        ...errorFields(error),
      });
    }
  }
};

/** Removes ended test run `id`: its engine record, lineage and row. */
const removed = async (env: Env, id: string): Promise<boolean> => {
  const db = drizzle(env.DB);
  try {
    await runEngine(env).remove(id);
    // Its lineage's counters go with it: it has no attempt left to settle,
    // and roots no other run.
    await db.batch([
      db.delete(runLineageAttempts).where(eq(runLineageAttempts.rootRunId, id)),
      db.delete(runLineages).where(eq(runLineages.rootRunId, id)),
      db.delete(workflowCandidateRuns).where(eq(workflowCandidateRuns.id, id)),
    ]);
    return true;
  } catch (error) {
    log.warn("workflow.candidate_sweep_failed", {
      run: id,
      ...errorFields(error),
    });
    return false;
  }
};

/**
 * Settles test runs whose start the engine never confirmed
 * (`settleUnconfirmed`), ends those still going past the time they are
 * kept (`endOverdue`), then removes those that ended and are older, oldest
 * first, batch after batch for as long as the sweep's time allows: each
 * with its engine record and lineage, and its row, whose build's
 * reservation goes with it (the release sweep takes the bytes nothing else
 * names, release-retention.ts). From the cron, for the time `at`.
 */
export const sweepCandidateRuns = async (
  env: Env,
  at = new Date()
): Promise<void> => {
  const until = Date.now() + sweepBudgetMs;
  const cutoff = new Date(at.getTime() - keptMsOf(env));
  await settleUnconfirmed(env, at);
  // No test run goes on past its lifetime: one still `running` a grace
  // after it lost its end, and is settled now rather than when it goes.
  await endOverdue(
    env,
    new Date(at.getTime() - maxCandidateLifetimeMs - overdueGraceMs)
  );
  const db = drizzle(env.DB);
  while (Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- batch after batch
    const batch = await db
      .select({ id: workflowCandidateRuns.id })
      .from(workflowCandidateRuns)
      .where(
        and(
          lte(workflowCandidateRuns.createdAt, cutoff),
          notInArray(workflowCandidateRuns.status, unended)
        )
      )
      .orderBy(workflowCandidateRuns.createdAt)
      .limit(candidatesPerSweep);
    let gone = 0;
    for (const { id } of batch) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      if (await removed(env, id)) {
        gone += 1;
      }
    }
    // A short batch was the last; one that removed nothing would only
    // fail the same way again.
    if (batch.length < candidatesPerSweep || gone === 0) {
      return;
    }
  }
};
