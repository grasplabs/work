import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "../src/auth/auth.ts";
import { organizations, teamMembers, teams } from "../src/db/core/schema.ts";

// Teams for tests, written as the organization plugin keeps them: a team
// of an organization, and who is in it. Joining and leaving count from the
// next read, as core reads a person's teams each time.

/** Adds `userId` to the team `teamId`. */
export const joinTeam = async (
  teamId: string,
  userId: string
): Promise<void> => {
  await drizzle(env.DB)
    .insert(teamMembers)
    .values({ id: crypto.randomUUID(), teamId, userId, createdAt: new Date() });
};

/** Takes `userId` out of the team `teamId`. */
export const leaveTeam = async (
  teamId: string,
  userId: string
): Promise<void> => {
  await drizzle(env.DB)
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
};

/** A new team of the organization `of` (the deployment's own by default), with `members`: its ID. */
const teamOf = async (of: string, members: readonly string[]) => {
  const id = crypto.randomUUID();
  await drizzle(env.DB)
    .insert(teams)
    .values({
      id,
      name: `Team ${id}`,
      organizationId: of,
      createdAt: new Date(),
    });
  for (const userId of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await joinTeam(id, userId);
  }
  return id;
};

/** A new team of the organization, with `members`: its ID. */
export const newTeam = async (...members: string[]): Promise<string> =>
  await teamOf(organizationId, members);

/** A team of another organization than the deployment's, with `members`: its ID. */
export const otherOrganizationsTeam = async (
  ...members: string[]
): Promise<string> => {
  const other = `other-${crypto.randomUUID()}`;
  await drizzle(env.DB).insert(organizations).values({
    id: other,
    name: "Another company",
    slug: other,
    createdAt: new Date(),
  });
  return await teamOf(other, members);
};
