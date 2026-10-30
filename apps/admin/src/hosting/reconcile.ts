/**
 * Provisioning that heals itself: every five minutes the admin's cron
 * (src/server.ts) looks at each client still being provisioned and, when
 * it isn't getting anywhere, resumes it as the system, backing off, so
 * staff never have to click to get a client through something passing.
 *
 * A client isn't getting anywhere when nothing keeps it from starting
 * and it has no operation, when its operation's attempt ended or is gone
 * before it was done, or when its operation stopped. Why it stopped
 * (`failureCause`, src/hosting/words.ts) decides what happens:
 *
 * - something passing (`retry`): resumed, after 0, 5, 15 and 60 minutes,
 *   then every 4 hours; once it has been resumed `attentionAfterAttempts`
 *   times without getting through, it needs a person's look too;
 * - the release (`release`): resumed once a newer release fits it, as
 *   resuming takes the newest that does; until then it needs a person;
 * - anything a person must look at first (`staff`): nothing is resumed,
 *   and it needs a person.
 *
 * Needing a person is recorded once an episode, as the audit event
 * `provision.needs_attention` (src/hosting/attention.ts), in one
 * conditional statement; Setup's "What needs a look" and the Platform
 * grid show it, with Retry now. An episode starts when a staff member
 * last added, placed, started or resumed the client (Retry now among
 * them), which clears it. Resuming is what staff do
 * (`placeAndProvision`): it claims the client in one conditional write,
 * so two runs at once start one attempt, and every step of the operation
 * finds what an earlier one did. How many times it resumed, and when, is
 * read from its own audit events (`provision.auto_resume`): no state of
 * its own to drift.
 */
import { log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";

import { adminDatabase, audit } from "../db/act.ts";
import type { Actor, AdminDatabase } from "../db/act.ts";
import { clients, releases } from "../db/schema.ts";
import { errorCode } from "../deploy/errors.ts";
import { ProvisionError } from "../provision/errors.ts";
import { getProvisioning } from "../provision/queries.ts";
import {
  autoResumeAction,
  episodeOf,
  markNeedsAttention,
} from "./attention.ts";
import type { Episode } from "./attention.ts";
import { InventoryError } from "./inventory.ts";
import {
  newestFittingRelease,
  ProvisionOperationError,
  provisionOf,
} from "./operation.ts";
import { clientHostingOf } from "./organization.ts";
import { PlacementError, placeAndProvision } from "./placement.ts";
import { failureCause } from "./words.ts";
import type { FailureCause } from "./words.ts";

const minute = 60 * 1000;

/**
 * How long after its last automatic resume a client is resumed again, by
 * how many it had: at once the first time, then longer, then every 4
 * hours for as long as it keeps stopping.
 */
export const resumeDelaysMs = [
  0,
  5 * minute,
  15 * minute,
  60 * minute,
  240 * minute,
];

/** How many automatic resumes that didn't get through before a person is asked to look. */
export const attentionAfterAttempts = 3;

/** Whether `episode`'s next automatic resume is due at `now`. */
const isDue = ({ attempts, lastAttemptAt }: Episode, now: Date): boolean => {
  if (lastAttemptAt === null) {
    return true;
  }
  const delay =
    resumeDelaysMs[Math.min(attempts, resumeDelaysMs.length - 1)] ?? 0;
  return now.getTime() - lastAttemptAt.getTime() >= delay;
};

/**
 * The newest release that fits client `clientId` among those built after
 * its operation's recorded one (`newestFittingRelease`, the one ordering
 * of releases: when built, then id); null when none newer fits, or it has
 * no operation.
 */
const newerFittingRelease = async (
  db: AdminDatabase,
  clientId: string
): Promise<string | null> => {
  const operation = await provisionOf(db, clientId);
  if (operation === undefined) {
    return null;
  }
  const recorded = await db
    .select({ id: releases.id, builtAt: releases.builtAt })
    .from(releases)
    .where(eq(releases.id, operation.releaseId))
    .get();
  return recorded === undefined
    ? null
    : await newestFittingRelease(db, clientId, recorded);
};

/**
 * Resumes client `clientId`'s provisioning as `actor`, as staff resume it
 * from Setup: where it is placed or in the automatic
 * destination, on the newest release that fits it (or the one its
 * operation runs, when none newer does). Returns the attempt's id;
 * refused as `placeAndProvision` refuses, `already_running` while an
 * attempt is still going.
 */
export const resumeProvisioning = async (
  env: Env,
  actor: Actor,
  clientId: string
): Promise<string> =>
  await placeAndProvision(env, actor, {
    clientId,
    // The newest release that fits, else the one it runs: as a retry
    // from Setup picks it (src/hosting/placement.ts).
    releaseId: null,
    destinationId: null,
  });

/**
 * Refusals of a resume that mean another run has the client, or got there
 * first, so waiting for it is right; every other refusal (a release behind
 * a migration, a destination it can't use) lasts until a person acts.
 */
const competingCodes: ReadonlySet<string> = new Set([
  "already_running",
  "other_run_held",
  "runner_replaced",
  "operation_running",
]);

/** What the reconciler did with one client. */
export type Reconciled =
  /** Live, or its attempt is still going. */
  | "progressing"
  /** On its own premises, or not started for a reason Setup names (no destination, no release). */
  | "waiting"
  /** Resumed by the system. */
  | "resumed"
  /** Stopped for something passing, and its next resume isn't due yet. */
  | "backing_off"
  /** Stopped for something a person must look at, or a release none newer replaces. */
  | "needs_staff"
  /** Resuming was refused: something else got there first. */
  | "refused";

/** What client `clientId`'s stop needs, a release cause becoming a retry once a newer release fits it. */
const causeOf = async (
  db: AdminDatabase,
  clientId: string,
  code: string | null
): Promise<FailureCause> => {
  const cause = code === null ? "retry" : failureCause(code);
  if (cause !== "release") {
    return cause;
  }
  return (await newerFittingRelease(db, clientId)) === null
    ? "release"
    : "retry";
};

/** Looks at client `clientId` once at `now`, and resumes it or tells staff as it needs. */
export const reconcileClient = async (
  env: Env,
  clientId: string,
  now = new Date()
): Promise<Reconciled> => {
  const db = adminDatabase(env.DB);
  const view = await getProvisioning(env, clientId);
  if (
    view === null ||
    view.phase === "active" ||
    view.phase === "provisioning"
  ) {
    return "progressing";
  }
  // On its own premises: Grasp's cloud never provisions it, so nothing is
  // resumed and nobody is told.
  const { hosting } = await clientHostingOf(db, clientId);
  if (hosting !== "grasp_cloud") {
    return "waiting";
  }
  if (view.phase === "placing" && view.notStarted !== null) {
    return "waiting";
  }
  const code = view.stopped?.error ?? null;
  const episode = await episodeOf(db, clientId);
  const cause = await causeOf(db, clientId, code);
  if (cause !== "retry") {
    await markNeedsAttention(db, clientId, episode, {
      reason: "needs_person",
      code,
    });
    return "needs_staff";
  }
  if (episode.attempts >= attentionAfterAttempts) {
    await markNeedsAttention(db, clientId, episode, { reason: "stuck", code });
  }
  if (!isDue(episode, now)) {
    return "backing_off";
  }
  let runId: string;
  try {
    runId = await resumeProvisioning(env, "system", clientId);
  } catch (error) {
    if (
      error instanceof ProvisionError ||
      error instanceof PlacementError ||
      error instanceof ProvisionOperationError ||
      error instanceof InventoryError
    ) {
      log.info("provision.auto_resume_refused", { clientId, code: error.code });
      // Another run got there first, or something passing: wait for it.
      if (competingCodes.has(error.code)) {
        return "refused";
      }
      // Something that won't pass by waiting: a person looks.
      await markNeedsAttention(db, clientId, episode, {
        reason: "needs_person",
        code: error.code,
      });
      return "needs_staff";
    }
    throw error;
  }
  await audit(db, "system", {
    action: autoResumeAction,
    clientId,
    target: runId,
    detail: {
      attempt: episode.attempts + 1,
      ...(code === null ? {} : { after: code }),
    },
  });
  return "resumed";
};

/**
 * Looks at every client still being provisioned, at `now`
 * (`reconcileClient`), one at a time: what one of them throws is logged,
 * by its code, and the rest go on.
 */
export const reconcileProvisioning = async (
  env: Env,
  now = new Date()
): Promise<Record<string, Reconciled>> => {
  const db = adminDatabase(env.DB);
  const provisioning = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.status, "provisioning"));
  const done: Record<string, Reconciled> = {};
  for (const { id } of provisioning) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one client at a time
      done[id] = await reconcileClient(env, id, now);
    } catch (error) {
      log.error("provision.reconcile_failed", {
        clientId: id,
        error: errorCode(error),
      });
    }
  }
  return done;
};
