import { requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "../auth/auth.ts";
import { teams } from "../db/core/schema.ts";

/**
 * The organization's teams, by name, to choose one from (a collection's, a
 * person's): for admins and builders; not Grasp staff, who never choose.
 */
export const teamChoices = async (
  env: Env,
  by: Identity
): Promise<{ id: string; name: string }[]> => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  requireBuilder(by);
  return await drizzle(env.DB)
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.organizationId, organizationId))
    .orderBy(asc(teams.name), asc(teams.id));
};
