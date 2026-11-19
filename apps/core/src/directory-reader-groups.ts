import { directoryErrors } from "@grasp-os/shared/directory";
import { errorFields, log } from "@grasp-os/shared/log";
import { readerProofMaxAgeMs } from "@grasp-os/shared/source-readers";
import { clockLeaseMs } from "@grasp-os/workerflow/clock";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { signInConfig } from "./auth/config.ts";
import {
  directoryGroupMembers,
  directoryGroupTeams,
  directoryPeople,
  sourceReaderGroups,
} from "./db/core/schema.ts";
import { readWholeGroup } from "./directory-group-reads.ts";
import type { EveryPage } from "./directory-group-reads.ts";
import { everyPage } from "./directory-people.ts";
import { jsonValuesOf } from "./directory-teams.ts";
import { entra } from "./directory-ties.ts";
import { connectionOf } from "./onboarding/directory.ts";
import {
  entraGroupPrefix,
  readerGroupRequestsPerTick,
} from "./source-readers.ts";

// The members of the Entra groups copied reader lists name, read through
// the company's directory connection (GRA-2146; the design and its threat
// model are on the issue), so a file shared with a group reaches its
// members who never connected their own Microsoft account. What a read
// keeps proves a group for a reader for a day, as every proof does
// (source-readers.ts `provedGroupsOf`). The ways it can go wrong, and what
// stops each:
//
// - Someone taken for someone else: a group's members are its users'
//   Entra object IDs, kept only for people the daily read keeps
//   (`directory_people`, in the deployment's own tenant), and a person
//   proves a group only through the member that read tied to that ID.
//   No address is read or compared, and no guest or erased person has a
//   row.
// - A group read in part, refused, gone, or one whose members can't all
//   be read (hidden membership, or a visibility Microsoft didn't answer):
//   nothing is written, and what an earlier whole read kept counts until a
//   day old, then nothing. A Public group proves its members: the source
//   lets anyone who joins it read.
// - A member removed from a group: their row goes at the group's next
//   whole read, half a day after the last at most while reads work, and
//   counts for nothing a day after the last whole read whatever happens.
// - Two writers undoing each other: a group mapped to a team is the daily
//   read's (directory-group-reads.ts), which alone can place its members
//   and mark the mapping read in one batch; this read skips it, checked
//   in each statement that writes, so a group mapped meanwhile is left to
//   the daily read. An older run landing after a newer one writes
//   nothing: each batch holds only while no run of a later slot recorded
//   a read of the group (`directory_read_at`).
// - A group of another tenant: only names in the deployment's own Entra
//   tenant are read; another's is proved only by its member's own
//   connection.
// - Rows outliving their use: rows of a group neither mapped nor named go
//   at the next run, and at once when its mapping is removed
//   (directory-groups.ts `unmap`).
// - Too many groups: a run sends connect at most as many calls as the
//   personal reads of groups may (`readerGroupRequestsPerTick`), stops at
//   the clock's lease, and the rest are read in the next quarter hour,
//   the longest unread first. A group whose read fails has its turn spent
//   all the same, so one that keeps failing holds up no other.

/** How long after a group's last read it is read again: half the proof's day, so a failed read has time to be tried again before the proof lapses. */
const readAgainAfterMs = readerProofMaxAgeMs / 2;

/** What the Brain's name of an Entra group of `tenant` (lower case) starts with. */
const namePrefixOf = (tenant: string): string =>
  `${entraGroupPrefix}${tenant}:`;

/**
 * That the row being considered (`directory_group_members`) belongs to a
 * group mapped to a team, as SQL.
 */
const mapped = (groupId: SQL | string): SQL => sql`EXISTS (
  SELECT 1 FROM ${directoryGroupTeams}
  WHERE ${directoryGroupTeams.provider} = ${entra.provider}
    AND ${directoryGroupTeams.groupId} = ${groupId}
)`;

/**
 * That a copied reader list names the group of the row being considered,
 * as SQL: its Brain name, `groupPrincipal`'s, from the row's tenant and
 * group, both kept lower case.
 */
const named = sql`EXISTS (
  SELECT 1 FROM ${sourceReaderGroups}
  WHERE ${sourceReaderGroups.name} = ${entraGroupPrefix} || ${directoryGroupMembers.tenant} || ':' || ${directoryGroupMembers.groupId}
)`;

/**
 * Deletes the rows of the directory's groups that are neither mapped to a
 * team nor named by a reader list: of `groupId` alone when given (an
 * unmap, in its batch after the mapping's delete), or of every group.
 */
export const unneededGroupRows = (db: DrizzleD1Database, groupId?: string) =>
  db
    .delete(directoryGroupMembers)
    .where(
      and(
        eq(directoryGroupMembers.provider, entra.provider),
        groupId === undefined
          ? undefined
          : eq(directoryGroupMembers.groupId, groupId),
        sql`NOT ${mapped(sql`${directoryGroupMembers.groupId}`)}`,
        sql`NOT ${named}`
      )
    );

/**
 * The statements that keep the read of `groupId` (Brain name `name`) the
 * clock's run of the slot `slot` made, started at `startedAt`: its users'
 * rows replaced by those of `users` the daily read keeps, each from
 * `startedAt`, unless it is held or failed (`users` null); and the read
 * recorded at `slot`. Each only while the group isn't mapped and no run of
 * a later slot recorded a read of it.
 */
const keptRead = (
  db: DrizzleD1Database,
  tenant: string,
  { groupId, name }: { groupId: string; name: string },
  users: readonly string[] | null,
  { slot, startedAt }: { slot: number; startedAt: number }
) => {
  const { provider } = entra;
  // Checked in each statement, as written: the record goes last.
  const ours = sql`NOT ${mapped(groupId)} AND NOT EXISTS (
    SELECT 1 FROM ${sourceReaderGroups}
    WHERE ${sourceReaderGroups.name} = ${name}
      AND ${sourceReaderGroups.directoryReadAt} > ${slot}
  )`;
  const record = db
    .update(sourceReaderGroups)
    .set({ directoryReadAt: new Date(slot) })
    .where(and(eq(sourceReaderGroups.name, name), ours));
  if (users === null) {
    return [record] as const;
  }
  return [
    db
      .delete(directoryGroupMembers)
      .where(
        and(
          eq(directoryGroupMembers.provider, provider),
          eq(directoryGroupMembers.groupId, groupId),
          ours
        )
      ),
    ...jsonValuesOf(users).map((value) =>
      db
        .insert(directoryGroupMembers)
        .select(
          sql`SELECT ${provider}, ${tenant}, ${groupId}, value, ${startedAt}
            FROM json_each(${value})
            WHERE ${ours}
              AND EXISTS (
                SELECT 1 FROM ${directoryPeople}
                WHERE ${directoryPeople.provider} = ${provider}
                  AND ${directoryPeople.tenant} = ${tenant}
                  AND ${directoryPeople.accountId} = value
              )`
        )
        .onConflictDoNothing()
    ),
    record,
  ] as const;
};

/**
 * The clock's read of the Entra groups reader lists name (clock.ts), every
 * quarter hour: each named group of the deployment's tenant, not mapped
 * to a team, whose last read is half a day old or that was never read,
 * the longest unread first, one at a time, each kept in its own batch.
 */
export const readReaderGroups = async (env: Env, at: Date): Promise<void> => {
  const config = signInConfig(env);
  const tenant =
    config === undefined ? undefined : entra.tenantIn(config)?.toLowerCase();
  const db = drizzle(env.DB);
  await unneededGroupRows(db);
  if (tenant === undefined) {
    return;
  }
  const connection = await connectionOf(env, entra.provider);
  if (connection === undefined) {
    return;
  }
  const prefix = namePrefixOf(tenant);
  const due = await db
    .select({ name: sourceReaderGroups.name })
    .from(sourceReaderGroups)
    .where(
      and(
        sql`substr(${sourceReaderGroups.name}, 1, ${prefix.length}) = ${prefix}`,
        or(
          isNull(sourceReaderGroups.directoryReadAt),
          lt(
            sourceReaderGroups.directoryReadAt,
            new Date(at.getTime() - readAgainAfterMs)
          )
        ),
        sql`NOT ${mapped(sql`substr(${sourceReaderGroups.name}, ${prefix.length + 1})`)}`
      )
    )
    .orderBy(
      sql`${sourceReaderGroups.directoryReadAt} IS NOT NULL`,
      asc(sourceReaderGroups.directoryReadAt)
    );
  const deadline = at.getTime() + clockLeaseMs;
  const run = { calls: 0 };
  /** Every page, as the daily read reads them, counting this run's calls to connect. */
  const counted: EveryPage = async (readPage, take) => {
    await everyPage(
      deadline,
      async (cursor) => {
        if (run.calls >= readerGroupRequestsPerTick) {
          throw directoryErrors.create("directory.read_too_long");
        }
        run.calls += 1;
        return await readPage(cursor);
      },
      take
    );
  };
  for (const { name } of due) {
    // The run's calls spent: this group waits for the next run unread.
    if (run.calls >= readerGroupRequestsPerTick) {
      return;
    }
    const groupId = name.slice(prefix.length);
    const startedAt = Date.now();
    let users: string[] | null = null;
    let stopped: unknown = null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one group at a time, within the run's calls
      const read = await readWholeGroup(env, connection, counted, groupId);
      // Held: gone or refused, or members that can't all be read.
      if (
        !("held" in read) &&
        read.group.refusal !== "hidden_membership" &&
        read.group.refusal !== "unknown"
      ) {
        ({ users } = read);
      }
    } catch (error) {
      stopped = error;
    }
    // A group's turn is spent whether its read worked or not, so one that
    // keeps failing holds up no other: its rows stay as they were.
    // oxlint-disable-next-line no-await-in-loop -- each group's own batch
    await db.batch([
      ...keptRead(db, tenant, { groupId, name }, users, {
        slot: at.getTime(),
        startedAt,
      }),
    ]);
    if (stopped !== null) {
      // Throttling, a server error, a connection that can't read groups,
      // the run's calls or lease spent: the rest wait for the next run.
      log.warn("directory.reader_groups_stopped", {
        ...errorFields(stopped),
        code: directoryErrors.codeOf(stopped),
      });
      return;
    }
  }
};
