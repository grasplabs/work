import { log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { activeMember } from "./auth/auth.ts";

// Who changes the organization's own settings (organization.ts,
// organization-logo.ts): its own admins, never Grasp staff, who are
// admins too, but what the client is called and looks like is the
// client's to say.

/** Refuses anyone but the organization's own admins. */
export const requireOwnAdmin = (by: Identity): void => {
  if (by.staff || !isAdmin(by.role)) {
    log.warn("organization.refused", { actor: by.userId });
    throw roleErrors.create("role.forbidden");
  }
};

/**
 * Whether `userId` is an admin of the organization now: asked when a write
 * guarded by `activeMember` changed nothing, to tell "it already was so"
 * from "they stopped being an admin since their session was checked".
 */
export const stillAdmin = async (
  env: Env,
  userId: string
): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ admin: number }>(
    sql`SELECT ${activeMember(userId, ["admin"])} AS admin`
  );
  return row.admin === 1;
};
