import type { OrganizationTeam } from "@grasp-os/shared/members";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "./auth/auth.ts";
import { teamMembers, teams } from "./db/core/schema.ts";

/**
 * The organization's teams by name, each with its members' user IDs, in
 * one read. For an admin's list of teams (Settings › Members): Better
 * Auth's own `list-team-members` answers only someone in the team, and
 * an admin manages teams they aren't in. The caller checks the role.
 */
export const teamsWithMembers = async (
  env: Env
): Promise<OrganizationTeam[]> => {
  const rows = await drizzle(env.DB)
    .select({ id: teams.id, name: teams.name, userId: teamMembers.userId })
    .from(teams)
    .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
    .where(eq(teams.organizationId, organizationId))
    .orderBy(asc(teams.name), asc(teams.id));
  const byId = new Map<string, OrganizationTeam>();
  for (const { id, name, userId } of rows) {
    const team = byId.get(id) ?? { id, name, memberIds: [] };
    if (userId !== null) {
      team.memberIds.push(userId);
    }
    byId.set(id, team);
  }
  return [...byId.values()];
};
