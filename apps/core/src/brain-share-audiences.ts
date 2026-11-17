import { and, count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "./auth/auth.ts";
import { notRemoved } from "./auth/membership-sql.ts";
import { members, teamMembers } from "./db/core/schema.ts";

// Whom a person may share a memory with (GRA-1815, brain-next.ts
// `publishAs`): their teams and the company, each only with enough people
// in it that a reader can't tell who shared it. With the sharer and one
// other, that other knows; the copy would not read as someone's own word,
// as the page says it does.

/** Fewest current members an audience a memory is shared with has. */
export const shareAudienceMembersMin = 3;

/**
 * Whether the company, and which of teams `teamIds`, have at least
 * `shareAudienceMembersMin` current members now (a member an admin removed
 * counts for neither).
 */
export const largeEnoughAudiences = async (
  database: D1Database,
  teamIds: readonly string[]
): Promise<{ company: boolean; teams: Set<string> }> => {
  const db = drizzle(database);
  const [companyRow, teamRows] = await Promise.all([
    db
      .select({ members: count() })
      .from(members)
      .where(
        and(
          eq(members.organizationId, organizationId),
          notRemoved(members.userId)
        )
      ),
    teamIds.length === 0
      ? []
      : db
          .select({ team: teamMembers.teamId, members: count() })
          .from(teamMembers)
          .where(
            and(
              inArray(teamMembers.teamId, [...teamIds]),
              notRemoved(teamMembers.userId)
            )
          )
          .groupBy(teamMembers.teamId),
  ]);
  return {
    company: (companyRow[0]?.members ?? 0) >= shareAudienceMembersMin,
    teams: new Set(
      teamRows.flatMap(({ team, members: size }) =>
        size >= shareAudienceMembersMin ? [team] : []
      )
    ),
  };
};
