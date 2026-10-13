import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import type { WorkflowStepConfig } from "@grasp-os/workerflow/contracts";
import { NonRetryableError } from "@grasp-os/workerflow/errors";
import { z } from "zod";

import { loadRelease } from "./app-releases.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { transformBatch } from "./migration-transform.ts";
import { SandboxUnavailableError } from "./sandboxed.ts";
import { backfillRunId, batchesPerRun } from "./store-backfill.ts";
import { backfillBatchSchema } from "./store-host.ts";
import type { BackfillOutcome, TransformedBatch } from "./store-host.ts";
import { runEngine } from "./workflows/engine.ts";
import type { RunStep } from "./workflows/host.ts";

// A store's backfill run (store-backfill.ts says how it is kept going):
// core's own platform workflow on the engine Apps' workflows run on, one
// bounded batch per step, a fill's or an explicit migration's. Apart from
// store-backfill.ts because a migration's batch loads its release
// (app-releases.ts), which applies schemas through store-backfill.ts.

/** The store `storeId`'s object, for the run's batches. */
const storeObject = (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId
) => inJurisdiction(env, env.DATA_STORES).getByName(storeId);

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
  state: z.enum(["running", "ready", "complete", "failed"]),
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
 * Batch `batch` of the backfill of `target` in `storeId` for run
 * `attempt`: a fill's, which the store runs alone; or an explicit
 * migration's (store-migrations.ts), whose records the store hands over
 * for the release's transform to run on in the sandbox
 * (migration-transform.ts), and whose output, or failure, it then
 * commits under the same fence and number. A step retried after its
 * answer was lost asks again and is answered from the store's receipt.
 */
const runBatch = async (
  env: Env,
  storeId: StoreId,
  step: { target: string; attempt: number; batch: number }
): Promise<BackfillOutcome> => {
  const stub = storeObject(env, storeId);
  const answered = backfillBatchSchema.parse(
    JSON.parse(await stub.fillMissing(storeId, step))
  );
  if (answered.state !== "transform") {
    return answered;
  }
  const { consumer, migration, table, rows, phase, through } = answered;
  let transformed: Awaited<ReturnType<typeof transformBatch>>;
  try {
    const release = await loadRelease(
      env,
      appIdSchema.parse(consumer.resourceId),
      consumer.resourceVersion
    );
    transformed = await transformBatch(env, release, migration, rows);
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      // The sandbox host out of reach for a moment: the step's retry.
      throw Object.assign(error, { retryable: true });
    }
    throw error;
  }
  const batch: TransformedBatch = {
    ...step,
    phase,
    table,
    through,
    rows: transformed.ok
      ? transformed.rows.map(({ id, fields }) => ({
          id,
          fields,
          revision: rows.find((row) => row.id === id)?.revision ?? 1,
        }))
      : [],
    ...(transformed.ok
      ? {}
      : {
          failure: {
            ...transformed.failure,
            issues: transformed.failure.issues
              .slice(0, 20)
              .map((issue) => issue.slice(0, 500)),
            table,
            migration,
          },
          // What the transform failed on: a record changed since is
          // transformed again rather than failed (`commitTransformed`).
          failureRevision: rows.find((row) => row.id === transformed.failure.id)
            ?.revision,
        }),
  };
  return await stub.commitTransformed(storeId, JSON.stringify(batch));
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
        return await runBatch(env, storeId, { target, attempt, batch });
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
