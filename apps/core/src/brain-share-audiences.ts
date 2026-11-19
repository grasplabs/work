import { and, count, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { organizationId } from "./auth/auth.ts";
import { directoryProviderId } from "./auth/config.ts";
import { mayAct } from "./auth/membership-sql.ts";
import { accounts, members, teamMembers } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// Whom a person may share a memory with (GRA-1815, brain-next.ts
// `publishAs`): their teams and the company, each only with enough people
// in it that a reader can't tell who shared it. With the sharer and one
// other, that other knows; the copy would not read as someone's own word,
// as the page says it does.

/**
 * That the member `userId` holds has signed in, as SQL: they hold no
 * account the directory made them a member under before they did, which
 * their first sign-in takes over (auth.ts `adoptDirectoryMember`). Only
 * they count towards a minimum that keeps who shared or did something
 * from being told apart (GRA-2156): a team the directory filled with
 * people who never came is still one sharer and one reader.
 */
const signedIn = (userId: SQLiteColumn): SQL => sql`NOT EXISTS (
  SELECT 1 FROM ${accounts}
  WHERE ${accounts.userId} = ${userId}
    AND ${accounts.providerId} = ${directoryProviderId}
)`;

/** Fewest current members an audience a memory is shared with has. */
export const shareAudienceMembersMin = 3;

/**
 * Which of teams `teamIds` have at least `least` current members now who
 * have signed in (`signedIn`; a member an admin removed, or suspended,
 * counts for none): the one count of a team's people, for whatever needs
 * a team large enough.
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
        mayAct(teamMembers.userId),
        signedIn(teamMembers.userId)
      )
    )
    .groupBy(teamMembers.teamId);
  return new Set(
    rows.flatMap(({ team, members: size }) => (size >= least ? [team] : []))
  );
};

/**
 * Whether the company, and which of teams `teamIds`, have at least
 * `shareAudienceMembersMin` current members now who have signed in (a
 * member an admin removed, or one who never signed in, counts for
 * neither).
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
          mayAct(members.userId),
          signedIn(members.userId)
        )
      ),
    teamsOfAtLeast(database, teamIds, shareAudienceMembersMin),
  ]);
  return {
    company: (companyRow[0]?.members ?? 0) >= shareAudienceMembersMin,
    teams,
  };
};
