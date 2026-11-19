import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { directoryErrors } from "@grasp-os/shared/directory";
import type {
  DirectoryConnection,
  DirectoryGroup,
  DirectoryGroupFound,
  DirectoryGroupMapping,
  DirectoryGroupPreview,
  DirectoryGroupRead,
  DirectoryGroupsApi,
} from "@grasp-os/shared/directory";
import { identifierSchema } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  auditedBatch,
  outboxedEventWithDetailWhere,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/membership-sql.ts";
import {
  directoryGroupTeams,
  directoryPeople,
  teams,
} from "./db/core/schema.ts";
import { unneededGroupRows } from "./directory-reader-groups.ts";
import { connectionOf } from "./onboarding/directory.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The directory's groups as teams' source (GRA-2056, G2; the threat model
// is on the issue): an admin maps an Entra group to a members' team, and
// the daily read places the group's members in it (G3). Only the
// directory connection of the deployment's own tenant is read, through
// connect, which keeps its token. The ways this part can go wrong, and
// what stops each:
//
// - Someone but the client's admin maps a group: every call is an
//   admin's of the client, never Grasp staff's, and every write holds
//   only while they still are one, in its own statement.
// - A group anyone can join, whose members can't all be read, or that
//   Microsoft didn't describe: `map` reads the group from Microsoft itself,
//   never from the client, and refuses one with a refusal.
// - A team that doesn't exist: the mapping is written only while the team
//   does, in the statement; deleting the team deletes its mappings.
// - What a preview tells: counts only, never who.
// - The audit log: one event per change, written in the change's batch
//   only when it changed something, by IDs alone.

const provider = "microsoft-directory";

/** Refuses anyone but an admin of the client (never Grasp staff), logged. */
const requireAdmin = (by: Identity): void => {
  if (by.staff || !isAdmin(by.role)) {
    log.warn("directory_group.refused", { actor: by.userId });
    throw roleErrors.create("role.forbidden");
  }
};

/** That `userId` is an admin of the organization now, as SQL. */
const isActiveAdmin = (userId: string): SQL => activeMember(userId, ["admin"]);

/** Whether `userId` is an admin of the organization now. */
const stillAdmin = async (env: Env, userId: string): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ admin: number }>(
    sql`SELECT ${isActiveAdmin(userId)} AS admin`
  );
  return row.admin === 1;
};

/** A group's Entra object ID as the client named it, lower case. */
const groupIdOf = (groupId: unknown): string => {
  const parsed = identifierSchema.safeParse(groupId);
  if (!parsed.success) {
    throw directoryErrors.create("directory.invalid");
  }
  return parsed.data.toLowerCase();
};

/**
 * The directory connection of the deployment's own Entra tenant, while it
 * can be read (`connectionOf` reads no other tenant's, and connect answers
 * for the connection it is named); `directory.not_connected` or
 * `directory.inactive` otherwise.
 */
const entraDirectory = async (env: Env): Promise<DirectoryConnection> => {
  const connection = await connectionOf(env, provider);
  if (connection === undefined) {
    throw directoryErrors.create("directory.not_connected");
  }
  if (connection.status !== "active") {
    throw directoryErrors.create("directory.inactive");
  }
  return connection;
};

/** The first page of the group `groupId` as connect reads it now. */
const firstPage = async (
  env: Env,
  connection: DirectoryConnection,
  groupId: string
): Promise<DirectoryGroupRead & { group: DirectoryGroup }> => {
  const page = await env.CONNECT.readDirectoryGroup({
    connectionId: connection.id,
    groupId,
    cursor: null,
  });
  const { group } = page;
  if (group?.id !== groupId) {
    throw directoryErrors.create("directory.provider_failed");
  }
  return { ...page, group };
};

/** The team each mapped group is mapped to, by the group's ID. */
const mappedTeams = async (env: Env): Promise<Map<string, string>> => {
  const rows = await drizzle(env.DB)
    .select({
      groupId: directoryGroupTeams.groupId,
      teamId: directoryGroupTeams.teamId,
    })
    .from(directoryGroupTeams)
    .where(eq(directoryGroupTeams.provider, provider));
  return new Map(rows.map(({ groupId, teamId }) => [groupId, teamId]));
};

const search = async (
  env: Env,
  by: Identity,
  query: unknown
): Promise<{ groups: DirectoryGroupFound[]; more: boolean }> => {
  requireAdmin(by);
  const connection = await entraDirectory(env);
  const found = await env.CONNECT.searchDirectoryGroups({
    connectionId: connection.id,
    query,
  });
  const mapped = await mappedTeams(env);
  return {
    groups: found.groups.map((group) => ({
      ...group,
      teamId: mapped.get(group.id) ?? null,
    })),
    more: found.more,
  };
};

/**
 * How many of `users` (Entra object IDs, lower case) the directory's read
 * tied to a member here, in `tenant`.
 */
const tiedCount = async (
  env: Env,
  tenant: string,
  users: ReadonlySet<string>
): Promise<number> => {
  const row = await drizzle(env.DB).get<{ tied: number }>(
    sql`SELECT count(*) AS tied FROM ${directoryPeople}
      WHERE ${directoryPeople.provider} = ${provider}
        AND ${directoryPeople.tenant} = ${tenant.toLowerCase()}
        AND ${directoryPeople.userId} IS NOT NULL
        AND ${directoryPeople.accountId} IN (SELECT value FROM json_each(${JSON.stringify([...users])}))`
  );
  return row.tied;
};

const preview = async (
  env: Env,
  by: Identity,
  groupId: unknown
): Promise<DirectoryGroupPreview> => {
  requireAdmin(by);
  const id = groupIdOf(groupId);
  const connection = await entraDirectory(env);
  const first = await firstPage(env, connection, id);
  const users = new Set(first.users);
  let { nestedGroups } = first;
  const followed = new Set<string>();
  let cursor = first.next;
  while (cursor !== null) {
    // A next link handed back before is Graph failing: never read again.
    if (followed.has(cursor)) {
      throw directoryErrors.create("directory.provider_failed");
    }
    followed.add(cursor);
    // oxlint-disable-next-line no-await-in-loop -- each page goes on from the last
    const page = await env.CONNECT.readDirectoryGroup({
      connectionId: connection.id,
      groupId: id,
      cursor,
    });
    for (const user of page.users) {
      users.add(user);
    }
    nestedGroups += page.nestedGroups;
    cursor = page.next;
  }
  const mapped = await mappedTeams(env);
  return {
    group: first.group,
    teamId: mapped.get(id) ?? null,
    people: users.size,
    members: await tiedCount(env, connection.tenant, users),
    nestedGroups,
  };
};

const mappingOf = (
  row: typeof directoryGroupTeams.$inferSelect
): DirectoryGroupMapping => ({
  groupId: row.groupId,
  name: row.name,
  kind: row.kind,
  membersFrom: row.membersFrom,
  teamId: row.teamId,
  mappedAt: row.mappedAt.toISOString(),
  readAt: row.readAt?.toISOString() ?? null,
  held: row.held,
});

/** The mapping of `groupId`, as it is now. */
const mappingNow = async (
  env: Env,
  groupId: string
): Promise<typeof directoryGroupTeams.$inferSelect | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(directoryGroupTeams)
    .where(
      and(
        eq(directoryGroupTeams.provider, provider),
        eq(directoryGroupTeams.groupId, groupId)
      )
    )
    .get();

const map = async (
  env: Env,
  by: Identity,
  groupId: unknown,
  teamId: unknown
): Promise<DirectoryGroupMapping> => {
  requireAdmin(by);
  const id = groupIdOf(groupId);
  const team = identifierSchema.safeParse(teamId);
  if (!team.success) {
    throw directoryErrors.create("directory.team_not_found");
  }
  const connection = await entraDirectory(env);
  // The group as Microsoft answers it now: never as the client sent it.
  const { group } = await firstPage(env, connection, id);
  if (group.refusal !== null) {
    throw directoryErrors.create("directory.group_not_mappable", {
      reason: group.refusal,
    });
  }
  const db = drizzle(env.DB);
  const mappedAt = new Date();
  const ofGroup = sql`${directoryGroupTeams.provider} = ${provider} AND ${directoryGroupTeams.groupId} = ${id}`;
  // Written only while the admin is one and the team exists, and only
  // when it changes the group's team: what the event records too.
  const changes = sql`${isActiveAdmin(by.userId)}
    AND EXISTS (
      SELECT 1 FROM ${teams}
      WHERE ${teams.id} = ${team.data} AND ${teams.organizationId} = ${organizationId}
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${directoryGroupTeams}
      WHERE ${ofGroup} AND ${directoryGroupTeams.teamId} = ${team.data}
    )`;
  const event = createAuditEvent(
    {
      actor: actorOf(by),
      action: "directory.group_mapped",
      target: { type: "team", id: team.data },
      detail: { provider, groupId: id },
    },
    "core"
  );
  await auditedBatch(env, db, [
    outboxedEventWithDetailWhere(
      db,
      event,
      {
        previousTeamId: sql`(SELECT ${directoryGroupTeams.teamId} FROM ${directoryGroupTeams} WHERE ${ofGroup})`,
      },
      changes
    ),
    db
      .insert(directoryGroupTeams)
      .select(
        sql`SELECT ${provider}, ${id}, ${team.data}, ${group.name}, ${group.kind}, ${group.membersFrom}, ${mappedAt.getTime()}, NULL, NULL
          WHERE ${changes}`
      )
      .onConflictDoUpdate({
        target: [directoryGroupTeams.provider, directoryGroupTeams.groupId],
        // A group moved to another team waits for the read again.
        set: {
          teamId: sql`excluded.team_id`,
          name: sql`excluded.name`,
          kind: sql`excluded.kind`,
          membersFrom: sql`excluded.members_from`,
          mappedAt: sql`excluded.mapped_at`,
          readAt: sql`NULL`,
        },
      }),
  ]);
  const now = await mappingNow(env, id);
  if (now?.teamId === team.data) {
    return mappingOf(now);
  }
  if (!(await stillAdmin(env, by.userId))) {
    throw roleErrors.create("role.forbidden");
  }
  throw directoryErrors.create("directory.team_not_found");
};

const unmap = async (
  env: Env,
  by: Identity,
  groupId: unknown
): Promise<{ unmapped: boolean }> => {
  requireAdmin(by);
  const id = groupIdOf(groupId);
  const before = await mappingNow(env, id);
  if (before === undefined) {
    if (!(await stillAdmin(env, by.userId))) {
      throw roleErrors.create("role.forbidden");
    }
    return { unmapped: false };
  }
  const db = drizzle(env.DB);
  // The mapping as it was read: one moved since is another admin's change,
  // left as it is.
  const mapped = and(
    eq(directoryGroupTeams.provider, provider),
    eq(directoryGroupTeams.groupId, id),
    eq(directoryGroupTeams.teamId, before.teamId),
    isActiveAdmin(by.userId)
  );
  const [deleted] = await auditedBatch(env, db, [
    db
      .delete(directoryGroupTeams)
      .where(mapped)
      .returning({ groupId: directoryGroupTeams.groupId }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "directory.group_unmapped",
      target: { type: "team", id: before.teamId },
      detail: { provider, groupId: id },
    }),
    // Its members' rows, unless a reader list names it: then they are the
    // reader groups' read's (directory-reader-groups.ts).
    unneededGroupRows(db, id),
  ]);
  if (deleted.length === 0 && !(await stillAdmin(env, by.userId))) {
    throw roleErrors.create("role.forbidden");
  }
  return { unmapped: deleted.length > 0 };
};

const list = async (
  env: Env,
  by: Identity
): Promise<DirectoryGroupMapping[]> => {
  requireAdmin(by);
  const rows = await drizzle(env.DB)
    .select()
    .from(directoryGroupTeams)
    .where(eq(directoryGroupTeams.provider, provider))
    .orderBy(asc(directoryGroupTeams.name), asc(directoryGroupTeams.groupId));
  return rows.map(mappingOf);
};

/**
 * A signed-in admin's `directoryGroups`. Every call checks the session
 * first, then the caller's role.
 */
export class DirectoryGroupsRpc
  extends CoreRpcTarget
  implements DirectoryGroupsApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async search(
    query: string
  ): Promise<{ groups: DirectoryGroupFound[]; more: boolean }> {
    return await withPerson(
      this.#check,
      async (person) => await search(this.#env, person, query)
    );
  }

  async preview(groupId: string): Promise<DirectoryGroupPreview> {
    return await withPerson(
      this.#check,
      async (person) => await preview(this.#env, person, groupId)
    );
  }

  async mapToTeam(
    groupId: string,
    teamId: string
  ): Promise<DirectoryGroupMapping> {
    return await withPerson(
      this.#check,
      async (person) => await map(this.#env, person, groupId, teamId)
    );
  }

  async unmap(groupId: string): Promise<{ unmapped: boolean }> {
    return await withPerson(
      this.#check,
      async (person) => await unmap(this.#env, person, groupId)
    );
  }

  async list(): Promise<DirectoryGroupMapping[]> {
    return await withPerson(
      this.#check,
      async (person) => await list(this.#env, person)
    );
  }
}
