/** Reading clients and their provisioning, as the client pages show them. */
import { eq } from "drizzle-orm";

import { adminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { clientDomain } from "../deploy/context.ts";
import { provisionOf } from "../hosting/operation.ts";
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
   * code. Null while it hasn't, and for an attempt that's gone without
   * one.
   */
  stopped: { step: string; error: string } | null;
  phase: ProvisioningPhase;
}

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
    return { ...view, stopped: null, phase: "active" };
  }
  const operation = await provisionOf(db, clientId);
  if (operation === undefined) {
    return { ...view, stopped: null, phase: "placing" };
  }
  if (operation.status === "failed") {
    return {
      ...view,
      stopped: {
        step: operation.step ?? "validated",
        error: operation.error ?? "unknown",
      },
      phase: "failed",
    };
  }
  const run = await currentRun(env, clientId);
  const gone = run === null || isReplaceable(run.status);
  return {
    ...view,
    stopped: null,
    phase: gone && operation.status !== "done" ? "failed" : "provisioning",
  };
};
