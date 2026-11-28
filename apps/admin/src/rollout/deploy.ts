/**
 * How an organization's deploy ends, whoever ends it: its rollout's run
 * (src/rollout/org-rollout.ts), or the rollout pass settling one whose
 * run ended without saying so (src/rollout/scheduler.ts). Recorded on
 * `client_deploys`, audited and alerted once, and the client's claim
 * given back (`recordEnd`). Its own module, so the run and the pass both
 * import it without importing each other.
 */
import "@tanstack/react-start/server-only";
import { and, eq } from "drizzle-orm";

import { alert } from "../alerts/alert.ts";
import { actIfChanged } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clientDeploys } from "../db/schema.ts";
import { lostAttemptOf } from "../hosting/operation.ts";
import { releaseRun, stillHolds } from "../runners.ts";
import type { HeldClient } from "../runners.ts";
import { stopReason } from "../workflow-steps.ts";

/** The code at the front of a stop's reason (`<code>: <words>`). */
export const codeOf = (reason: string): string =>
  reason.split(":", 1)[0] ?? reason;

/**
 * What the engine fails a step with when its last attempt ended without
 * an outcome of its own: cut off (its isolate killed) or timed out, as
 * Cloudflare Workflows names them.
 */
const lostAttemptErrors: ReadonlySet<string> = new Set([
  "WorkflowInternalError",
  "WorkflowTimeoutError",
]);

/**
 * The code run `runId`'s deploy of `clientId` failed with: for an
 * attempt the engine cut off, the step the operation was left in
 * (`lostAttemptOf`), not the engine's own words; otherwise the stop's.
 */
export const failureCodeOf = async (
  db: AdminDatabase,
  { clientId, runId }: { clientId: string; runId: string },
  error: unknown
): Promise<string> => {
  const lost =
    error instanceof Error && lostAttemptErrors.has(error.name)
      ? await lostAttemptOf(db, clientId, runId)
      : null;
  return lost ?? codeOf(stopReason(error));
};

/**
 * How a failed deploy ended, beyond its code: put back on the release
 * before (`restored`), or the failure (`cause`) a restore was refused or
 * failed after (src/rollout/org-rollout.ts).
 */
export interface DeployEnd {
  restored?: boolean;
  cause?: string;
  /**
   * The attempt that records it, which must still hold the client: one
   * that timed out records nothing over the attempt after it, nor gives
   * that one's claim back.
   */
  held?: HeldClient;
}

/** The codes of a restore that didn't put the release before back: each tells staff at once. */
const unrestored = ["restore_refused", "restore_failed"] as const;
const isUnrestored = (error: string): error is (typeof unrestored)[number] =>
  unrestored.some((code) => code === error);

/**
 * Records run `runId`'s deploy of client `clientId` ended, `error` null
 * when it worked, and gives the client back, audited once, and alerted:
 * only while the client's deploy is still this run's. A failure restored
 * to the release before tells nobody by itself (the rollout counts it);
 * one whose restore was refused or failed tells staff as urgent.
 */
export const recordEnd = async (
  db: AdminDatabase,
  {
    clientId,
    runId,
    releaseId,
  }: { clientId: string; runId: string; releaseId: string },
  error: string | null,
  { restored = false, cause, held }: DeployEnd = {}
): Promise<void> => {
  const recorded = await actIfChanged(
    db,
    "system",
    db
      .update(clientDeploys)
      .set({
        status: error === null ? "done" : "failed",
        error,
        endedAt: new Date(),
      })
      .where(
        and(
          eq(clientDeploys.clientId, clientId),
          eq(clientDeploys.runId, runId),
          eq(clientDeploys.status, "deploying"),
          held === undefined ? undefined : stillHolds(held)
        )
      ),
    error === null
      ? {
          action: "deploy.done",
          clientId,
          target: releaseId,
          detail: { run: runId },
        }
      : {
          action: "deploy.fail",
          clientId,
          target: releaseId,
          detail: {
            run: runId,
            error,
            ...(restored ? { restored } : {}),
            ...(cause === undefined ? {} : { cause }),
          },
        },
    [releaseRun(db, clientId, runId, held?.attempt, held?.attemptKey)]
  );
  // A failed deploy alerts staff once, and the next one that works says
  // it recovered (src/alerts/alert.ts).
  if (!recorded || (error !== null && restored)) {
    return;
  }
  if (error === null) {
    await alert(db, { kind: "deployed", clientId, releaseId });
  } else if (isUnrestored(error)) {
    await alert(db, {
      kind: error,
      clientId,
      releaseId,
      code: codeOf(cause ?? error),
    });
  } else {
    await alert(db, {
      kind: "deploy_failed",
      clientId,
      releaseId,
      code: codeOf(error),
    });
  }
};
