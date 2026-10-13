import { auditActorSchema } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { deploymentConfig } from "@grasp-os/shared/config";
import {
  runRetentionDefaultDays,
  runRetentionSchema,
} from "@grasp-os/shared/deployment-config";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { Workflow } from "@grasp-os/workerflow/binding";
import type { WorkflowOptions } from "@grasp-os/workerflow/binding";
import { encode } from "@grasp-os/workerflow/codec";
import type {
  DefinitionIdentity,
  InstanceStatus,
} from "@grasp-os/workerflow/contracts";
import { runObjectName } from "@grasp-os/workerflow/identity";
import type { RunStub } from "@grasp-os/workerflow/instance";
import { z } from "zod";

import { inJurisdiction } from "../durable-objects.ts";

// The engine that runs Apps' workflow runs, behind the little core asks of
// it: create a run, see where it is, terminate it, send it an event, remove
// it. This is the only module that reaches the engine's runs, so the rest
// of core never depends on how it keeps them.
//
// The engine is Workerflow (@grasp-os/workerflow): one SQLite Durable
// Object per run (`WORKFLOW_RUNS`, run-object.ts), the only authority on
// the run's steps, waits and lifecycle. It runs on Cloudflare and on plain
// workerd alike, its objects in the EU where the platform has
// jurisdictions (durable-objects.ts). Every run, an App's or one of
// core's own, is a run of one definition, `grasp`, so its object is named
// by the run's ID alone; what it runs is the opaque version it was created
// with (`pinOf`), which the dispatcher checks against the run's row on
// every activation (dispatcher.ts).
//
// Starts are admissions under the run's own ID as their key: the same
// start sent again, after an answer that never came, finds the run it
// created, and finds a run deleted since as deleted rather than create it
// again. So a start is retried safely, and nothing creates a run twice.
//
// The engine keeps a run's record only for the deployment's run retention
// once the run has ended: every run is created with that as its
// retention, so the engine purges the record itself, on the same clock as
// core removes the rest of the run's details (retention.ts).

/** What an App's run is pinned to: the dispatcher loads it by these. */
export interface PinnedRun {
  app: AppId;
  workflow: WorkflowId;
  version: number;
}

/**
 * A workflow of core's own, not an App's, run on the same engine and
 * dispatcher: extracting an upload's text (knowledge/extraction.ts), a
 * build a chat's code handed to a durable job (build-jobs.ts), or filling
 * in a store's defaulted fields before its contract takes them
 * (store-backfill.ts).
 */
export const internalWorkflows = ["extraction", "build", "backfill"] as const;

export type InternalWorkflow = (typeof internalWorkflows)[number];

/** What a run executes: an App's pinned workflow, or one of core's own. */
export type RunPin =
  | ({ type: "app" } & PinnedRun)
  | { type: "internal"; workflow: InternalWorkflow };

/** The one definition every run is a run of. */
export const runDefinition = "grasp";

const pinSchema = z.union([
  z
    .tuple([
      z.literal("app"),
      appIdSchema,
      workflowIdSchema,
      z.int().positive(),
    ])
    .transform(([, app, workflow, version]): RunPin => ({
      type: "app",
      app,
      workflow,
      version,
    })),
  z
    .tuple([z.literal("internal"), z.enum(internalWorkflows)])
    .transform(([, workflow]): RunPin => ({ type: "internal", workflow })),
]);

/** A pin as the engine keeps it: the run's opaque definition version. */
const versionOf = (pin: RunPin): string =>
  JSON.stringify(
    pin.type === "app"
      ? ["app", pin.app, pin.workflow, pin.version]
      : ["internal", pin.workflow]
  );

/**
 * What a run the engine activates is pinned to, from the definition and
 * version it was created with; nothing for anything core never created.
 */
export const pinOf = (identity: DefinitionIdentity): RunPin | undefined => {
  if (identity.definition !== runDefinition || identity.version === undefined) {
    return undefined;
  }
  try {
    return pinSchema.safeParse(JSON.parse(identity.version)).data;
  } catch {
    return undefined;
  }
};

/** The engine core runs workflow runs on. */
export interface RunEngine {
  /**
   * Creates the run `id`, pinned to its App version, with its input. Sent
   * again, it finds the run the first one created, ended or deleted
   * since included: it never creates a second one.
   */
  create: (run: {
    id: string;
    pinned: PinnedRun;
    input: Json | undefined;
  }) => Promise<void>;
  /** As `create`, for a run of one of core's own workflows. */
  createInternal: (run: {
    id: string;
    workflow: InternalWorkflow;
    input: Json;
  }) => Promise<void>;
  /** Where the engine has the run; nothing when it has no such run. */
  status: (id: string) => Promise<InstanceStatus | undefined>;
  /**
   * Terminates the run; one that has ended already, that is rolling back,
   * or that the engine has no record of, stays as it is.
   */
  terminate: (id: string) => Promise<void>;
  /**
   * Delivers the run an event of `type`, which ends a wait on that type: it
   * carries nothing (`RunHost.waitForDecision`). `key` names the delivery:
   * the same key again is the same event, taken once. A run that has
   * ended takes none, and that is no error.
   */
  sendEvent: (id: string, type: string, key: string) => Promise<void>;
  /**
   * Removes the run, with all the engine kept of it, whether or not it has
   * ended; one it has no record of stays as it is. For a run core ended
   * that the engine's own retention may not reach (retention.ts).
   */
  remove: (id: string) => Promise<void>;
}

/**
 * How many days an ended run keeps its details (`RUN_RETENTION_DAYS`), or
 * `undefined` if the deployment's config is invalid.
 */
export const runRetentionDays = (
  env: Pick<Env, "RUN_RETENTION_DAYS">
): number | undefined =>
  env.RUN_RETENTION_DAYS === undefined
    ? runRetentionDefaultDays
    : deploymentConfig(
        runRetentionSchema,
        "RUN_RETENTION_DAYS",
        env.RUN_RETENTION_DAYS
      );

/**
 * How long the engine keeps a run once it has ended, after it completed
 * or was terminated and after it errored: the deployment's run retention.
 * While the deployment's config is invalid, the engine's default, 30
 * days, the longest the deployment may set.
 */
const retentionOf = (
  env: Pick<Env, "RUN_RETENTION_DAYS">
): Pick<WorkflowOptions, "retention"> => {
  const days = runRetentionDays(env);
  if (days === undefined) {
    return {};
  }
  const kept = `${days} days` as const;
  return { retention: { successRetention: kept, errorRetention: kept } };
};

const runs = (
  env: Pick<Env, "WORKFLOW_RUNS" | "DURABLE_OBJECT_JURISDICTION">
) => inJurisdiction(env, env.WORKFLOW_RUNS);

/** The run `id`'s object, whether or not it has a run. */
/** The object run `id` lives in, as core's own class (run-object.ts). */
export const runObjectOf = (
  env: Pick<Env, "WORKFLOW_RUNS" | "DURABLE_OBJECT_JURISDICTION">,
  id: string
) => {
  const namespace = runs(env);
  return namespace.get(namespace.idFromName(runObjectName(runDefinition, id)));
};

const runStub = (env: Env, id: string): RunStub => runObjectOf(env, id);

/**
 * Marks run `id` cancelled in its object by `actor` (run-object.ts,
 * `markCancelled`), the first step of a cancel and its record: no attempt
 * of it holds from then on, whatever the engine does after. Answers the
 * cancel it is marked with, a first one's if it was cancelled before.
 * Throws when the object can't be told, so a cancel fails before anything
 * else of it.
 */
export const markRunCancelled = async (
  env: Pick<Env, "WORKFLOW_RUNS" | "DURABLE_OBJECT_JURISDICTION">,
  id: string,
  actor: AuditActor
): Promise<{ runId: string; actor: AuditActor; at: number }> => {
  const mark = await runObjectOf(env, id).markCancelled(id, actor, Date.now());
  return {
    runId: mark.runId,
    actor: auditActorSchema.parse(mark.actor),
    at: mark.at,
  };
};

/** Records that run `id`'s cancel is done (`markRunCancelled`). */
export const settleRunCancel = async (
  env: Pick<Env, "WORKFLOW_RUNS" | "DURABLE_OBJECT_JURISDICTION">,
  id: string
): Promise<void> => {
  await runObjectOf(env, id).settleCancel();
};

/**
 * A run's params, as the engine keeps them: its input under `input`, left
 * out when the run has none, so a run started with nothing gets nothing
 * (the engine makes absent params `{}`, as Cloudflare does).
 */
export const runParamsSchema = z.object({ input: z.json().optional() });

/** Admits the run `id` of `pin`: created once, however often sent. */
const admit = async (
  env: Env,
  id: string,
  pin: RunPin,
  input: Json | undefined
): Promise<void> => {
  const binding = new Workflow<{ input?: Json }>(runs(env), runDefinition, {
    version: versionOf(pin),
    ...retentionOf(env),
  });
  await binding.admit({
    id,
    key: id,
    params: input === undefined ? {} : { input },
  });
};

/** Workerflow, through the deployment's one run object class. */
export const runEngine = (env: Env): RunEngine => ({
  create: async ({ id, pinned, input }) => {
    await admit(env, id, { type: "app", ...pinned }, input);
  },
  createInternal: async ({ id, workflow, input }) => {
    await admit(env, id, { type: "internal", workflow }, input);
  },
  status: async (id) => await runStub(env, id).status(),
  terminate: async (id) => {
    // Ended, rolling back or missing: nothing to terminate, and nothing
    // to fail over (a cancel racing a run's own end finds it ended).
    await runStub(env, id).terminate({ rollback: false });
  },
  sendEvent: async (id, type, key) => {
    const outcome = await runStub(env, id).sendEvent({
      type,
      payload: encode(null),
      key,
    });
    if (
      outcome !== "accepted" &&
      outcome !== "duplicate" &&
      outcome !== "ended"
    ) {
      throw new Error(`Run ${id} didn't take the event ${type}: ${outcome}`);
    }
  },
  remove: async (id) => {
    await runStub(env, id).deleteRun();
  },
});
