import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { migrationErrors } from "@grasp-os/shared/stores";
import type { DefinedTables, SchemaConsumer } from "@grasp-os/shared/stores";
import type { WorkflowStepConfig } from "@grasp-os/workerflow/contracts";
import { NonRetryableError } from "@grasp-os/workerflow/errors";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { OpenStore } from "./data-stores.ts";
import { sdkResourceBindings } from "./db/core/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import type {
  BackfillRestart,
  BackfillStatus,
  SchemaStatus,
} from "./store-host.ts";
import { runEngine } from "./workflows/engine.ts";
import type { RunStep } from "./workflows/host.ts";

// A store's schema change and the release that brought it (spec 17.2,
// 17.4 steps 5 and 6): a store takes a schema whose defaulted fields its
// records lack as a pending target, and its contract moves to it only
// once its backfill has filled them all in (store-host.ts,
// `fillMissing`). The backfill runs as a platform workflow of core's own
// (`runBackfill`), on the engine Apps' workflows run on, one bounded
// batch per step, so it survives restarts and runs apart from whoever
// asked for it.
//
// A release sealed on that schema runs on the store only once the
// store's contract holds its schema: core asks the store, the authority
// on its own contract, before it makes such a release current
// (`requireStoreSchemaActive`). A contract only ever widens, so a release
// found in force stays so, and nothing between the question and the
// change can undo the answer. Threat model, and how each is closed:
//
// - The backfill stops for good (its run ran out of retries, its start
//   was lost, the engine's retention removed it) and every schema change
//   of the store waits behind it, whichever App's: the backfill is kept
//   going (`keepBackfillGoing`) by the seal that made it pending, by
//   every seal it refuses, by every attempt to make its release current,
//   and by the store's own alarm once a run's lease ran out
//   (store-host.ts, `runAlarm`), so nothing depends on one App acting.
//   A run that ended without finishing, or that the engine no longer
//   knows after it took batches, is handed over to a new run, which
//   takes over only once the old one's lease ran out; the store answers
//   only its newest run (its fence), so two runs never fill at once.
// - A step is retried after its answer was lost, or the run replays:
//   the engine replays a finished step from its journal, and a step
//   retried sends the same batch again, which the store answers from its
//   receipt without filling anything twice.
// - A run's journal grows without bound on a large store: a run takes at
//   most `batchesPerRun` batches, then hands over to a fresh run itself.
// - The backfill finds a value it can't keep: it fails, naming the
//   record, and its releases are refused (`migration.backfill_failed`),
//   at the seal and as they are made current, rather than run over
//   records that don't fit. Once that record changed (the current
//   version shrank it, say), keeping it going retries from there; a
//   failure nothing changed for stays failed, so nothing loops.

/** The store `storeId`'s object, for core's own questions of it. */
const storeObject = (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId
) => inJurisdiction(env, env.DATA_STORES).getByName(storeId);

/** Whether the store holds `schemaHash` in force (`StoreHost.schemaStatus`). */
export const schemaStatus = async (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId,
  schemaHash: string
): Promise<SchemaStatus> =>
  await storeObject(env, storeId).schemaStatus(storeId, schemaHash);

/**
 * What keeping a backfill going asks of its store: core reaches it over
 * RPC, its own alarm calls its host directly.
 */
export interface BackfillStore {
  readonly id: StoreId;
  status: () => Promise<BackfillStatus | null>;
  retry: (target: string) => Promise<BackfillStatus | null>;
  restart: (restart: BackfillRestart) => Promise<number>;
}

/** The store `storeId`, as core keeps its backfill going. */
const remoteStore = (env: Env, storeId: StoreId): BackfillStore => {
  const stub = storeObject(env, storeId);
  return {
    id: storeId,
    status: async () => await stub.backfillStatus(storeId),
    retry: async (target) => await stub.retryBackfill(storeId, target),
    restart: async (restart) => await stub.restartBackfill(storeId, restart),
  };
};

/** Most batches one run takes before it hands over to a fresh one. */
export const batchesPerRun = 500;

/** What a backfill's run is started with. */
const inputSchema = z.strictObject({
  storeId: storeIdSchema,
  target: z.string().regex(/^[0-9a-f]{64}$/u),
  attempt: z.number().int().min(1),
  /** Most batches the run takes; tests choose fewer. */
  batchesPerRun: z.number().int().min(1).max(batchesPerRun).optional(),
});

/** What a batch answered, as far as its run needs it. */
const batchSchema = z.object({
  state: z.enum(["running", "complete", "failed"]),
});

/**
 * Retries of a batch: a store out of reach for a moment passes, and a
 * run that keeps failing ends within minutes, for the backfill to be
 * handed over to a new run.
 */
const batchConfig: WorkflowStepConfig = {
  retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
  timeout: "1 minute",
};

/**
 * What a step throws for `error`: only what the platform marks as worth
 * another try (a store out of reach for a moment, `retryable`) as it is,
 * to retry. Anything else no retry changes (a run the store moved past,
 * a store that is gone, damaged metadata, a bug) is non-retryable, so the
 * run ends at once, and the store counts it as a hand-over without
 * progress (store-host.ts, `restartBackfill`) rather than runs retrying
 * it for minutes each.
 */
const stepError = (error: unknown): unknown => {
  if (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "retryable") === true
  ) {
    return error;
  }
  if (isExpectedError(error)) {
    return new NonRetryableError(error.code);
  }
  return new NonRetryableError(
    error instanceof Error ? error.message : "The store failed the batch"
  );
};

/**
 * The ID of run `attempt` of the backfill of `target` in `storeId`: one
 * of its own per run, within the engine's hundred characters.
 */
export const backfillRunId = async (
  storeId: StoreId,
  target: string,
  attempt: number
): Promise<string> => {
  const hash = await sha256Hex(`${storeId}:${target}`);
  return `backfill-${hash.slice(0, 40)}-${attempt}`;
};

/**
 * Runs (or resumes) one run of a backfill: batch after batch, each a step
 * of its own, until the store answers that the backfill completed (and
 * activated its target) or failed; or, after its share of batches, hands
 * over to a fresh run that goes on from the store's cursor.
 */
export const runBackfill = async (
  env: Env,
  payload: unknown,
  step: RunStep
): Promise<void> => {
  const input = inputSchema.parse(payload);
  const { storeId, target, attempt } = input;
  const limit = input.batchesPerRun ?? batchesPerRun;
  for (let batch = 1; batch <= limit; batch += 1) {
    // One batch after the other: each starts where the last one left.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const answered = await step.do(`batch-${batch}`, batchConfig, async () => {
      try {
        return await storeObject(env, storeId).fillMissing(storeId, {
          target,
          attempt,
          batch,
        });
      } catch (error) {
        throw stepError(error);
      }
    });
    if (batchSchema.parse(answered).state !== "running") {
      return;
    }
  }
  await step.do("hand-over", batchConfig, async () => {
    try {
      const next = await storeObject(env, storeId).restartBackfill(storeId, {
        target,
        attempt,
        ending: true,
      });
      await runEngine(env).createInternal({
        id: await backfillRunId(storeId, target, next),
        workflow: "backfill",
        input: { ...input, attempt: next },
      });
    } catch (error) {
      throw stepError(error);
    }
    return null;
  });
};

/** Engine statuses of a run that has ended. */
const endedStatuses: ReadonlySet<string> = new Set([
  "complete",
  "errored",
  "terminated",
]);

/**
 * Hands run `attempt` over to the next; undefined while its lease holds,
 * or when the store didn't move on (the backfill stopped running).
 */
const handedOver = async (
  store: BackfillStore,
  target: string,
  attempt: number
): Promise<number | undefined> => {
  try {
    const next = await store.restart({ target, attempt });
    // Not moved on: the backfill is no longer running (it stalled, say).
    return next === attempt ? undefined : next;
  } catch (error) {
    if (isExpectedError(error) && error.code === "migration.busy") {
      return undefined;
    }
    throw error;
  }
};

/**
 * Makes sure a run of the running backfill `status` describes is going:
 * started when it never was; handed over to a new run when its run ended
 * without finishing it, or the engine no longer knows a run that took
 * batches (its retention removed it). A lease that still holds leaves it
 * as it is, for a later look.
 */
const ensureRun = async (
  env: Env,
  store: BackfillStore,
  status: BackfillStatus
): Promise<void> => {
  const engine = runEngine(env);
  const { target } = status;
  const runOf = async (attempt: number) =>
    await backfillRunId(store.id, target, attempt);
  const run = await engine.status(await runOf(status.attempt));
  if (run !== undefined && !endedStatuses.has(run.status)) {
    return;
  }
  let attempt: number | undefined = status.attempt;
  if (run !== undefined || status.lastBatch > 0) {
    attempt = await handedOver(store, target, status.attempt);
    if (attempt === undefined) {
      return;
    }
  }
  const start = async (at: number) => {
    await engine.createInternal({
      id: await runOf(at),
      workflow: "backfill",
      input: { storeId: store.id, target, attempt: at },
    });
  };
  await start(attempt);
  // A run the engine removed before it took a batch is found removed,
  // not created again: hand over past it too.
  if ((await engine.status(await runOf(attempt))) === undefined) {
    const next = await handedOver(store, target, attempt);
    if (next !== undefined) {
      await start(next);
    }
  }
};

/**
 * Keeps the store's pending backfill going, if it has one (see the
 * header): a failed one retried once its record changed, a running one
 * made sure of a run. Answers the backfill as it is then.
 */
export const keepStoreBackfillGoing = async (
  env: Env,
  store: BackfillStore
): Promise<BackfillStatus | null> => {
  let status = await store.status();
  if (status?.state === "failed") {
    status = await store.retry(status.target);
  }
  if (status?.state === "running") {
    await ensureRun(env, store, status);
  }
  return status;
};

/** `keepStoreBackfillGoing`, for the store `storeId`, over RPC. */
export const keepBackfillGoing = async (
  env: Env,
  storeId: StoreId
): Promise<BackfillStatus | null> =>
  await keepStoreBackfillGoing(env, remoteStore(env, storeId));

/**
 * Keeps the backfill going for a seal or an activation, which never fail
 * for it: what it says of the backfill is read from the store, not from
 * this (the engine may be unavailable, the store's alarm keeps it going).
 */
const keepGoingQuietly = async (env: Env, storeId: StoreId): Promise<void> => {
  try {
    await keepBackfillGoing(env, storeId);
  } catch (error) {
    log.warn("store.backfill_start_failed", errorFields(error));
  }
};

/**
 * Hands `store` a release's schema (`defineTables`), for a seal: when the
 * store takes it as its pending target, or refuses it because another
 * target is pending or failed, keeps that backfill going before
 * answering, so a backfill nobody else drives isn't left to stall every
 * schema change of the store.
 */
export const defineSchemaOnStore = async (
  env: Env,
  store: OpenStore,
  manifest: string,
  consumer: SchemaConsumer
): Promise<DefinedTables> => {
  let defined: DefinedTables;
  try {
    defined = await store.defineTables(manifest, consumer);
  } catch (error) {
    if (
      isExpectedError(error) &&
      (error.code === "migration.pending" ||
        error.code === "migration.backfill_failed")
    ) {
      await keepGoingQuietly(env, store.id);
    }
    throw error;
  }
  if (defined.contract.pending) {
    await keepGoingQuietly(env, store.id);
  }
  return defined;
};

/**
 * Refuses release `version` of `app` while the store it binds doesn't
 * hold its schema in force, keeping its backfill going:
 * `migration.pending` (retryable, with the backfill's progress) while
 * its defaulted fields are being filled in, `migration.backfill_failed`
 * (naming the record) while the backfill stays failed. A release without
 * a store passes.
 */
export const requireStoreSchemaActive = async (
  env: Env,
  app: AppId,
  version: number
): Promise<void> => {
  const bound = await drizzle(env.DB)
    .select({
      store: sdkResourceBindings.targetId,
      schemaHash: sdkResourceBindings.schemaHash,
    })
    .from(sdkResourceBindings)
    .where(
      and(
        eq(sdkResourceBindings.resourceId, app),
        eq(sdkResourceBindings.resourceVersion, version),
        eq(sdkResourceBindings.kind, "store")
      )
    )
    .get();
  if (bound === undefined) {
    return;
  }
  const storeId = storeIdSchema.parse(bound.store);
  const status = await schemaStatus(env, storeId, bound.schemaHash);
  if (status.state === "active") {
    return;
  }
  if (status.state === "unknown") {
    // A sealed release's schema the store never took: its records and
    // core's disagree, which no retry mends.
    throw new Error(
      "The store doesn't hold the schema its release was sealed on"
    );
  }
  await keepGoingQuietly(env, storeId);
  // Asked again: the store's pending target may have moved on meanwhile
  // (this schema's finished and a newer one began), and only this
  // schema's own state refuses its release.
  const after = await schemaStatus(env, storeId, bound.schemaHash);
  if (after.state === "active") {
    return;
  }
  if (after.state === "failed") {
    throw migrationErrors.create("migration.backfill_failed", {
      failure: after.failure === null ? null : { ...after.failure },
    });
  }
  if (after.state === "unknown") {
    throw new Error(
      "The store doesn't hold the schema its release was sealed on"
    );
  }
  throw migrationErrors.create("migration.pending", {
    retryable: true,
    scanned: after.scanned,
    filled: after.filled,
  });
};
