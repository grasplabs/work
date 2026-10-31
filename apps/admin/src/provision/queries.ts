/** Reading clients and their provisioning, as the client pages show them. */
import { eq } from "drizzle-orm";

import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { clientDomain } from "../deploy/context.ts";
import { needsAttentionOf } from "../hosting/attention.ts";
import type { NeedsAttention } from "../hosting/attention.ts";
import { newestRelease, provisionOf } from "../hosting/operation.ts";
import { clientHostingOf } from "../hosting/organization.ts";
import { startDestination } from "../hosting/placement.ts";
import type { NotStarted } from "../hosting/placement.ts";
import { currentRun, isReplaceable } from "../runners.ts";

/**
 * Where a client's provisioning is, as its page tells staff what to do:
 * - `placing`: recorded, and not yet placed in a hosting destination and
 *   provisioned there: staff do that from its Setup;
 * - `provisioning`: its operation is running (src/hosting/operation.ts);
 * - `failed`: its operation stopped, or its attempt is gone, for staff to
 *   fix what it says and start it again, which resumes it;
 * - `active`: done.
 */
export type ProvisioningPhase =
  | "placing"
  | "provisioning"
  | "failed"
  | "active";

/** A client's provisioning, as its page shows it. */
export interface ProvisioningView {
  clientId: string;
  /** `<id>.<domain>`; null while the admin has no domain. */
  hostname: string | null;
  client: {
    name: string;
    ring: number;
    status: "provisioning" | "active" | "offboarded";
    createdBy: string | null;
    createdAt: Date;
    /** The release rollouts leave it on, if it's pinned (src/rollout/control.ts). */
    pinnedReleaseId: string | null;
  };
  /**
   * Why its operation stopped: the last step it finished and the error's
   * code; for an attempt that ended without recording why, `run_<how it
   * ended>` (`run_errored`, `run_terminated`, `run_gone`). Null while it
   * hasn't stopped.
   */
  stopped: { step: string; error: string } | null;
  /**
   * While it's `placing`: why its provisioning hasn't started (no
   * destination, no release), or null when nothing keeps it and staff
   * start it from Hosting. Null in every other phase.
   */
  notStarted: NotStarted | null;
  /**
   * While it's `failed`: whether the admin's own retries gave up and a
   * person needs to look (src/hosting/attention.ts); null otherwise, and
   * once staff retried it.
   */
  needsAttention: NeedsAttention | null;
  phase: ProvisioningPhase;
}

/**
 * Why client `clientId`'s provisioning hasn't started: it runs on its own
 * premises, no shared destination the admin picks by itself, or no
 * imported release; null when nothing keeps it.
 */
export const notStartedOf = async (
  db: AdminDatabase,
  clientId: string
): Promise<NotStarted | null> => {
  const { hosting } = await clientHostingOf(db, clientId);
  if (hosting !== "grasp_cloud") {
    return "on_prem";
  }
  const destination = await startDestination(db);
  if (destination.destinationId === null) {
    return "no_destination";
  }
  return (await newestRelease(db)) === null ? "no_release" : null;
};

/** Client `clientId`'s provisioning, or null when the admin has no record of it. */
export const getProvisioning = async (
  env: Env,
  clientId: string
): Promise<ProvisioningView | null> => {
  const db = adminDatabase(env.DB);
  const [client] = await db
    .select({
      name: clients.name,
      ring: clients.ring,
      status: clients.status,
      createdBy: clients.createdBy,
      createdAt: clients.createdAt,
      pinnedReleaseId: clients.pinnedReleaseId,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    return null;
  }
  const domain = clientDomain(env);
  const view = {
    clientId,
    hostname: domain === null ? null : `${clientId}.${domain}`,
    client,
  };
  if (client.status !== "provisioning") {
    return {
      ...view,
      stopped: null,
      notStarted: null,
      needsAttention: null,
      phase: "active",
    };
  }
  const operation = await provisionOf(db, clientId);
  if (operation === undefined) {
    return {
      ...view,
      stopped: null,
      notStarted: await notStartedOf(db, clientId),
      needsAttention: null,
      phase: "placing",
    };
  }
  if (operation.status === "failed") {
    return {
      ...view,
      stopped: {
        step: operation.step ?? "validated",
        error: operation.error ?? "unknown",
      },
      notStarted: null,
      needsAttention: await needsAttentionOf(db, clientId),
      phase: "failed",
    };
  }
  const run = await currentRun(env, clientId);
  const gone = run === null || isReplaceable(run.status);
  if (!gone || operation.status === "done") {
    return {
      ...view,
      stopped: null,
      notStarted: null,
      needsAttention: null,
      phase: "provisioning",
    };
  }
  return {
    ...view,
    // Its attempt ended without the operation saying why: how it ended.
    stopped: {
      step: operation.step ?? "validated",
      error: `run_${run?.status ?? "gone"}`,
    },
    notStarted: null,
    needsAttention: await needsAttentionOf(db, clientId),
    phase: "failed",
  };
};
