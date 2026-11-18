import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "../src/auth/membership-sql.ts";
import { teams } from "../src/db/core/schema.ts";

/**
 * Makes the members' teams `roster` names, under its own ids, as an admin
 * who made them in Settings › Members first would have them: the staff
 * list names the members' teams (GRA-2055), so saving it then keeps the
 * ids a test names them by. A team new to the members' teams gets an id
 * of core's own instead (staff-list-teams.test.ts). Answers `roster`.
 */
export const teamsMade = async (roster: RosterInput): Promise<RosterInput> => {
  const now = new Date();
  await drizzle(env.DB)
    .insert(teams)
    .values(
      roster.teams.map(({ id, name }) => ({
        id,
        name,
        organizationId,
        createdAt: now,
      }))
    )
    .onConflictDoNothing();
  return roster;
};
