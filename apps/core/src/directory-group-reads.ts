import { directoryErrors } from "@grasp-os/shared/directory";
import type {
  DirectoryConnection,
  DirectoryGroup,
  DirectoryGroupHeld,
} from "@grasp-os/shared/directory";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";

import {
  directoryGroupMembers,
  directoryGroupTeams,
  directoryPeople,
} from "./db/core/schema.ts";
import { jsonValuesOf } from "./directory-teams.ts";
import type { DirectoryKind } from "./directory-ties.ts";

// The daily read of the directory's mapped groups (GRA-2056, G3; the
// threat model is on the issue): each group an admin mapped to a team
// (directory-groups.ts) is read whole, through connect, and its members'
// rows replaced in the read's one batch; the placement then puts them in
// the group's team (directory-teams.ts). The ways it can go wrong, and
// what stops each:
//
// - A group read in part, or not at all, taken for one that holds nobody:
//   a group's rows are replaced only from a read of every page; any
//   failure but the two below fails the whole read, which applies
//   nothing.
// - A group gone (404) or refused by Microsoft alone, or one that can't be
//   a team's any more (turned Public, hidden, or not described), or one
//   that suddenly lists nobody: held. Its rows and when it was last read
//   stay as they were, so nothing changes for anyone, and why is kept for
//   the admin (`held`).
// - A group mapped while the read ran: the read didn't read it, so it
//   isn't marked read, and places nobody until a read reads it. One moved
//   to another team meanwhile was read whole all the same, and places its
//   members in the team it is mapped to when the batch lands. One unmapped
//   meanwhile gets no rows: each needs its mapping.
// - Someone the read keeps no row for (a guest, an erased person) in a
//   group: each row needs the person's row, and goes with it.

/** Why the read left a mapped group as it was (`directory_group_teams.held`). */
export type GroupHeld = DirectoryGroupHeld;

/** One mapped group, as the read read it. */
export interface GroupRead {
  groupId: string;
  /** The team it was mapped to when the read began. */
  teamId: string;
  /** As Microsoft answered it; null when it couldn't be read. */
  group: DirectoryGroup | null;
  /** Its users, by the provider's ID, lower case: none when held. */
  users: string[];
  held: GroupHeld | null;
}

/** What reads every page of something through connect (directory-people.ts `everyPage`). */
export type EveryPage = <Page extends { next: string | null }>(
  readPage: (cursor: string | null) => Promise<Page>,
  take: (page: Page) => void
) => Promise<void>;

/** The failures of a group's read that hold it rather than fail the read. */
const holding = new Map<string | undefined, GroupHeld>([
  ["directory.group_gone", "gone"],
  ["directory.group_refused", "refused"],
]);

/** The mapped group `groupId` read whole, or held. */
const readGroup = async (
  env: Env,
  connection: DirectoryConnection,
  everyPage: EveryPage,
  { groupId, teamId }: { groupId: string; teamId: string }
): Promise<GroupRead> => {
  const users = new Set<string>();
  // The group, as the first page answers it.
  const answered: DirectoryGroup[] = [];
  try {
    await everyPage(
      async (cursor) =>
        await env.CONNECT.readDirectoryGroup({
          connectionId: connection.id,
          groupId,
          cursor,
        }),
      (page) => {
        if (page.group !== null) {
          answered.push(page.group);
        }
        for (const user of page.users) {
          users.add(user);
        }
      }
    );
  } catch (error) {
    const held = holding.get(directoryErrors.codeOf(error));
    if (held === undefined) {
      throw error;
    }
    return { groupId, teamId, group: null, users: [], held };
  }
  // Connect answers the group on the first page: a read without it is
  // the provider failing.
  const [group] = answered;
  if (group === undefined) {
    throw directoryErrors.create("directory.provider_failed");
  }
  const { refusal } = group;
  let held: GroupHeld | null = null;
  if (refusal !== null) {
    held = "not_mappable";
  } else if (users.size === 0) {
    held = "empty";
  }
  return {
    groupId,
    teamId,
    group,
    users: held === null ? [...users] : [],
    held,
  };
};

/** Every group mapped for `kind`, each read whole or held, one after another. */
export const mappedGroupsRead = async (
  env: Env,
  kind: DirectoryKind,
  connection: DirectoryConnection,
  everyPage: EveryPage
): Promise<GroupRead[]> => {
  const mapped = await drizzle(env.DB)
    .select({
      groupId: directoryGroupTeams.groupId,
      teamId: directoryGroupTeams.teamId,
    })
    .from(directoryGroupTeams)
    .where(eq(directoryGroupTeams.provider, kind.provider));
  const reads: GroupRead[] = [];
  for (const mapping of mapped) {
    // oxlint-disable-next-line no-await-in-loop -- one group at a time, within the read's lease
    reads.push(await readGroup(env, connection, everyPage, mapping));
  }
  return reads;
};

/**
 * The statements that keep what the read found of the mapped groups, in
 * its batch after the people's rows and before the placement, each only
 * while `claimed` (the read's claim) holds: the rows of every group read
 * whole replaced, and each group's mapping marked read, or held, with its
 * name, kind and who decides its members as Microsoft answered now.
 */
export const groupStatements = (
  db: DrizzleD1Database,
  kind: DirectoryKind,
  tenant: string,
  reads: readonly GroupRead[],
  claimed: SQL,
  readAt: Date
): BatchItem<"sqlite">[] => {
  if (reads.length === 0) {
    return [];
  }
  const whole = reads.filter(({ held }) => held === null);
  const wholeIds = JSON.stringify(whole.map(({ groupId }) => groupId));
  const pairs = jsonValuesOf(
    whole.flatMap(({ groupId, users }) =>
      users.map((user) => [groupId, user] as const)
    )
  );
  const outcomes = JSON.stringify(
    reads.map(({ groupId, held, group }) => [
      groupId,
      held,
      group?.name ?? null,
      group?.kind ?? null,
      group?.membersFrom ?? null,
    ])
  );
  /**
   * The read's outcome of the mapping's group, field `at` of it, as SQL;
   * the index written into the statement, as a bound number reaches D1 as
   * a real, which `->>` takes for no index.
   */
  const outcome = (at: 1 | 2 | 3 | 4) =>
    sql`(SELECT value ->> ${sql.raw(String(at))} FROM json_each(${outcomes}) WHERE value ->> 0 = ${directoryGroupTeams.groupId})`;
  return [
    db
      .delete(directoryGroupMembers)
      .where(
        and(
          eq(directoryGroupMembers.provider, kind.provider),
          sql`${directoryGroupMembers.groupId} IN (SELECT value FROM json_each(${wholeIds}))`,
          claimed
        )
      ),
    ...pairs.map((value) =>
      db
        .insert(directoryGroupMembers)
        .select(
          sql`SELECT ${kind.provider}, ${tenant}, value ->> 0, value ->> 1
            FROM json_each(${value})
            WHERE ${claimed}
              AND EXISTS (
                SELECT 1 FROM ${directoryPeople}
                WHERE ${directoryPeople.provider} = ${kind.provider}
                  AND ${directoryPeople.tenant} = ${tenant}
                  AND ${directoryPeople.accountId} = value ->> 1
              )
              AND EXISTS (
                SELECT 1 FROM ${directoryGroupTeams}
                WHERE ${directoryGroupTeams.provider} = ${kind.provider}
                  AND ${directoryGroupTeams.groupId} = value ->> 0
              )`
        )
        .onConflictDoNothing()
    ),
    db
      .update(directoryGroupTeams)
      .set({
        held: sql`${outcome(1)}`,
        name: sql`coalesce(${outcome(2)}, ${directoryGroupTeams.name})`,
        kind: sql`coalesce(${outcome(3)}, ${directoryGroupTeams.kind})`,
        membersFrom: sql`coalesce(${outcome(4)}, ${directoryGroupTeams.membersFrom})`,
        readAt: sql`CASE WHEN ${outcome(1)} IS NULL THEN ${readAt.getTime()} ELSE ${directoryGroupTeams.readAt} END`,
      })
      .where(
        and(
          eq(directoryGroupTeams.provider, kind.provider),
          sql`EXISTS (
            SELECT 1 FROM json_each(${outcomes})
            WHERE value ->> 0 = ${directoryGroupTeams.groupId}
          )`,
          claimed
        )
      ),
  ];
};
