import { isExpectedCode, isExpectedError } from "@grasp-os/shared/errors";
import type { WorkflowStepConfig } from "@grasp-os/workerflow/contracts";
import { NonRetryableError } from "@grasp-os/workerflow/errors";
import { z } from "zod";

import type { RunStep } from "../workflows/host.ts";
import { ExtractorUnavailableError } from "./extract.ts";
import { extractUpload, failUpload, finalFailures } from "./uploads.ts";

// The extraction workflow: core's own, run on the engine like an App's
// workflows but by the dispatcher's own hand (workflows/dispatcher.ts),
// once per upload (uploads.ts). One step extracts the text and saves it;
// a failure a retry may fix (the database, R2, the extractor's sandbox or
// Workers AI out of reach for a moment, a save that conflicted) is retried with
// backoff; one no retry changes (a file that doesn't read, one that runs
// its sandbox out of CPU or memory, text over a document's limits) isn't.
// Either way, once it fails for good, a last step fails the upload with
// the reason: its code, or `internal.unexpected` for a failure that had
// none.
//
// An extractor with no place in the sandbox (extract.ts: its owner's share
// taken, the pool full) is neither: the step ends, the run sleeps (30 s,
// doubling, at most 5 minutes) and a new step tries again, so waiting for
// a place spends none of the retries a failing file gets. Crafted files
// holding the extractor's share, or Apps holding the pool, then delay
// uploads without failing them. Only once it has waited an hour does the
// upload fail, as `upload.extractor_busy`.
//
// Replaying the run is safe: a step that finished isn't run again, and
// one that ran without its result being kept finds the upload ready (or
// failed) and leaves it.

const inputSchema = z.object({ uploadId: z.string().min(1) });

/**
 * Retries of the extraction step: three, 30 seconds apart and doubling,
 * so a moment's outage passes and a failing file fails within minutes.
 */
const extractConfig: WorkflowStepConfig = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};

/** The first wait for a place in the sandbox, and the longest. */
const busyWaitMs = 30_000;
const busyWaitMaxMs = 5 * 60_000;

/** How long an upload waits for a place in the sandbox before it fails. */
const busyForMs = 60 * 60_000;

/**
 * What an extraction step ends with: `null` once the upload is extracted
 * (or left as it was), or when it found the extractor busy.
 */
const attemptSchema = z
  .object({ busy: z.literal(true), at: z.number() })
  .nullable();

/** The wait before try `attempt` + 1: tests set it to none. */
const busyWaitOf = (env: Env, attempt: number): number => {
  const set = Number(env.WORKFLOW_RETRY_DELAY_MS);
  if (
    env.WORKFLOW_RETRY_DELAY_MS !== undefined &&
    Number.isInteger(set) &&
    set >= 0
  ) {
    return set;
  }
  return Math.min(busyWaitMs * 2 ** attempt, busyWaitMaxMs);
};

/**
 * What the step throws for `error`: an expected error by its code, so the
 * code survives the engine, which keeps only an error's message; one no
 * retry changes as non-retryable. Anything else as it is, to retry.
 */
const stepError = (error: unknown): unknown => {
  if (!isExpectedError(error)) {
    return error;
  }
  return finalFailures.has(error.code)
    ? new NonRetryableError(error.code)
    : new Error(error.code);
};

/**
 * The code to fail the upload with, from the step's last error, whose
 * message the engine hands back as it was, or behind the error's name
 * (`NonRetryableError: upload.no_text`).
 */
const failureCode = (error: unknown): string => {
  const code =
    error instanceof Error ? error.message.split(": ").at(-1) : undefined;
  return isExpectedCode(code) ? code : "internal.unexpected";
};

/**
 * Extracts the upload, trying again after a wait for as long as the
 * extractor is busy, up to {@link busyForMs}. Throws the failure that
 * ends it: the step's last error, or `upload.extractor_busy`.
 */
const extractWaitingForPlace = async (
  env: Env,
  uploadId: string,
  step: RunStep
): Promise<void> => {
  let busySince: number | undefined;
  for (let attempt = 0; ; attempt += 1) {
    // In order: each try follows the wait after the one before.
    // oxlint-disable-next-line no-await-in-loop
    const ended = await step.do(
      attempt === 0 ? "extract" : `extract:${attempt}`,
      extractConfig,
      async () => {
        try {
          await extractUpload(env, uploadId);
        } catch (error) {
          if (error instanceof ExtractorUnavailableError && error.busy) {
            // When, from the step, so a replay reads the same.
            return { busy: true, at: Date.now() } as const;
          }
          throw stepError(error);
        }
        return null;
      }
    );
    const busy = attemptSchema.parse(ended);
    if (busy === null) {
      return;
    }
    busySince ??= busy.at;
    if (busy.at - busySince >= busyForMs) {
      throw new NonRetryableError("upload.extractor_busy");
    }
    // oxlint-disable-next-line no-await-in-loop
    await step.sleep(`extract:wait:${attempt}`, busyWaitOf(env, attempt));
  }
};

/** Runs (or resumes) the extraction of one upload. */
export const runExtraction = async (
  env: Env,
  payload: unknown,
  step: RunStep
): Promise<void> => {
  const { uploadId } = inputSchema.parse(payload);
  try {
    await extractWaitingForPlace(env, uploadId, step);
  } catch (error) {
    const code = failureCode(error);
    await step.do("fail", {}, async () => {
      await failUpload(env, uploadId, code);
      return null;
    });
  }
};
