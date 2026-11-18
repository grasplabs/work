import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "./auth/auth.ts";
import { notRemoved } from "./auth/membership-sql.ts";
import { members, teamMembers } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// Whom a person may share a memory with (GRA-1815, brain-next.ts
// `publishAs`): their teams and the company, each only with enough people
// in it that a reader can't tell who shared it. With the sharer and one
// other, that other knows; the copy would not read as someone's own word,
// as the page says it does.

/** Fewest current members an audience a memory is shared with has. */
export const shareAudienceMembersMin = 3;

/**
 * Which of teams `teamIds` have at least `least` current members now (a
 * member an admin removed counts for none): the one count of a team's
 * people, for whatever needs a team large enough.
 */
export const teamsOfAtLeast = async (
  database: D1Database,
  teamIds: readonly string[],
  least: number
): Promise<Set<string>> => {
  if (teamIds.length === 0) {
    return new Set();
  }
  const rows = await drizzle(database)
    .select({ team: teamMembers.teamId, members: count() })
    .from(teamMembers)
    .where(
      and(
        // One bound value however many teams: D1 binds 100 a statement.
        inList(teamMembers.teamId, teamIds),
        notRemoved(teamMembers.userId)
      )
    )
    .groupBy(teamMembers.teamId);
  return new Set(
    rows.flatMap(({ team, members: size }) => (size >= least ? [team] : []))
  );
};

/**
 * Whether the company, and which of teams `teamIds`, have at least
 * `shareAudienceMembersMin` current members now (a member an admin removed
 * counts for neither).
 */
export const largeEnoughAudiences = async (
  database: D1Database,
  teamIds: readonly string[]
): Promise<{ company: boolean; teams: Set<string> }> => {
  const [companyRow, teams] = await Promise.all([
    drizzle(database)
      .select({ members: count() })
      .from(members)
      .where(
        and(
          eq(members.organizationId, organizationId),
          notRemoved(members.userId)
        )
      ),
    teamsOfAtLeast(database, teamIds, shareAudienceMembersMin),
  ]);
  return {
    company: (companyRow[0]?.members ?? 0) >= shareAudienceMembersMin,
    teams,
  };
};
