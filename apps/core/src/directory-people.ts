import { createAuditEvent } from "@grasp-os/shared/audit";
import {
  directoryErrors,
  isDirectoryDeletedFailure,
  isDirectoryReadFailure,
} from "@grasp-os/shared/directory";
import type {
  DirectoryConnection,
  DirectoryDeletedFailure,
  DirectoryReadFailure,
} from "@grasp-os/shared/directory";
import { errorFields, log } from "@grasp-os/shared/log";
import { clockLeaseMs } from "@grasp-os/workerflow/clock";
import { and, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { tellKept } from "./access-revocations.ts";
import { auditedBatch, outboxedEventWithDetailWhere } from "./audit-outbox.ts";
import { signInConfig } from "./auth/config.ts";
import {
  accounts,
  directoryPeople,
  directoryReads,
  erasedSubjects,
} from "./db/core/schema.ts";
import { groupStatements, mappedGroupsRead } from "./directory-group-reads.ts";
import type { GroupRead } from "./directory-group-reads.ts";
import { suspensionStatements } from "./directory-suspensions.ts";
import {
  jsonValuesOf,
  keptIn,
  placementStatements,
  readPlacementOf,
} from "./directory-teams.ts";
import type { Placement } from "./directory-teams.ts";
import { directoryKinds, tieDirectoryPeople } from "./directory-ties.ts";
import type { DirectoryKind } from "./directory-ties.ts";
import { subjectHashOf, subjectKeyVersion } from "./erased-people.ts";
import { connectionOf } from "./onboarding/directory.ts";

// The organization's directory, read once a day (GRA-2056, slice 1; the
// design and its threat model are on the issue): everyone it lists, by
// the provider's own ID of them, tied to the member whose sign-in names
// that same ID. This keeps who is who; it changes no membership and shows
// nothing to anyone. The ways it can go wrong, and what stops each:
//
// - Someone taken for someone else: no address is read or compared. A
//   person is tied to a member only by the provider's ID of them and the
//   tenant, as the ID token the SSO plugin verified named them at sign-in
//   (`oid` and `tid`, kept on the account by auth.ts `keptClaimsOf`;
//   `input: false`, so no client sets them). Never a staff sign-in's
//   account, and only while they are a member, checked in the statement.
// - Another tenant's person under the same ID: the tenant is compared too,
//   and only the connection of the deployment's own tenant is read
//   (onboarding/directory.ts `connectionOf`), each page refused unless it
//   says the tenant the deployment's sign-in config names.
// - A slow tie: the directory's rows keep object IDs lower case (connect's
//   read), and the tie compares `lower()` of the account's, as the
//   provider gave it, by the index on that expression
//   (`accounts_provider_oid_lower_idx`): one lookup a person, and no other
//   comparison of a sign-in's object ID changes.
// - A read that failed or stopped part way: every page is read before
//   anything is written, then the whole read is applied in one batch, one
//   transaction. A failure records only itself (`directory_reads`): the
//   rows the last good read left stay.
// - An older read landing after a newer one, or two at once (the clock
//   may start a task again past its lease): each claims the status row in
//   its batch only when it started later than the one there, and every
//   write of the batch holds only while that claim does.
// - An erased person written again: the read skips everyone whose
//   subject's keyed hash an erasure kept (erased-people.ts), in the same
//   statement that writes, and an erasure deletes their rows
//   (person-erasure.ts), with their accounts.
// - Personal data past its use: the provider's ID, the tenant, the
//   department and whether the account is on. Rows go with the first read
//   that neither lists the person nor holds them deleted. Of a deleted
//   account, only its ID is read, kept as one turned off.
// - A directory too big for one batch: the people go to D1 as one JSON
//   value, which D1 takes up to 2 MB (`d1ValueBytes`), measured as sent;
//   a larger read is refused as `directory.too_large`, nothing applied,
//   rather than cut short.
// - A read that never ends: it stops at the clock's lease on the task
//   (`clockLeaseMs`), and at a next link the provider handed back before,
//   failed as a whole. Every failure, D1's refusal of the batch too, is
//   recorded (`directory_reads`), and nothing of the read is kept.

const dayMs = 24 * 60 * 60 * 1000;

/** The most D1 takes in one value (its limits page: "Maximum string, BLOB or table row size"). */
const d1ValueBytes = 2_000_000;

/** The action the audit log records an applied read under. */
const readAction = "directory.people_read";

/** Everyone one read of a directory listed, by the provider's ID. */
interface Listed {
  tenant: string;
  /** Turned on, with their department. */
  people: { id: string; department: string }[];
  /** Turned off. */
  disabled: string[];
  /**
   * Deleted (Entra keeps a deleted account 30 days), and listed neither on
   * nor off: kept as turned off, for 3a's rules to suspend and lift.
   */
  deleted: string[];
  /** Why the deleted accounts couldn't be read (`deletedOf`); null when they were. */
  deletedFailure: DirectoryDeletedFailure | null;
}

/**
 * Every page `readPage` answers, from the first on, each handed to `take`:
 * refused past the clock's lease on the task (`deadline`), and at a next
 * link handed back before, the provider failing, never read again.
 */
const everyPage = async <Page extends { next: string | null }>(
  deadline: number,
  readPage: (cursor: string | null) => Promise<Page>,
  take: (page: Page) => void
): Promise<void> => {
  const followed = new Set<string>();
  let cursor: string | null = null;
  do {
    if (Date.now() >= deadline) {
      throw directoryErrors.create("directory.read_too_long");
    }
    // oxlint-disable-next-line no-await-in-loop -- each read goes on from the last
    const page = await readPage(cursor);
    take(page);
    cursor = page.next;
    if (cursor !== null) {
      if (followed.has(cursor)) {
        throw directoryErrors.create("directory.provider_failed");
      }
      followed.add(cursor);
    }
  } while (cursor !== null);
};

/**
 * Every deleted account of `connection`, or why the list can't be read at
 * all. Where the line is, and why: added to a read that worked without
 * it, the list must never take that read away. So a first page refused,
 * or not a list (connect's `deletedReadFailure`), which no retry in a
 * quarter hour mends, leaves the read as it was before: applied, with no
 * proof of anyone having left, and the reason recorded. Anything else
 * fails the whole read, to be tried again in a quarter hour: throttling
 * or a server error, which pass, and any failure past the first page, so
 * a part of the list is never taken for all of it.
 */
const deletedOf = async (
  env: Env,
  connection: DirectoryConnection,
  deadline: number
): Promise<{ ids: string[] } | { failure: DirectoryDeletedFailure }> => {
  const ids = new Set<string>();
  let pages = 0;
  try {
    // Connect answers the same connection's tenant as for its people,
    // whose pages were checked already.
    await everyPage(
      deadline,
      async (cursor) =>
        await env.CONNECT.readDeletedDirectoryUsers({
          connectionId: connection.id,
          cursor,
        }),
      (read) => {
        pages += 1;
        for (const id of read.deleted) {
          ids.add(id);
        }
      }
    );
  } catch (error) {
    const code = directoryErrors.codeOf(error);
    // The failures of the first page the read goes on without it for.
    if (pages === 0 && isDirectoryDeletedFailure(code)) {
      return { failure: code };
    }
    throw error;
  }
  return { ids: [...ids] };
};

/**
 * Of the deleted accounts `ids`, those a sign-in account of `kind`
 * carries: kept before the batch, so the many deleted accounts nobody
 * signed in with never take room in its one value (`d1ValueBytes`) nor
 * time. It drops none that matters: only such an account ties a row to a
 * member (directory-ties.ts `tiedMember`, which asks its tenant and
 * membership again as it ties), and none can appear after this, as Entra
 * signs no deleted account in. Someone restored and signing in meanwhile
 * is listed by the next read, and owes no suspension. Sought by the
 * index on the provider and `lower()` of the ID
 * (`accounts_provider_oid_lower_idx`), as the tie seeks it.
 */
const carriedOf = async (
  env: Env,
  kind: DirectoryKind,
  ids: string[]
): Promise<string[]> => {
  const db = drizzle(env.DB);
  const id = sql<string>`lower(${kind.signedInAs})`;
  const found = await Promise.all(
    jsonValuesOf(ids).map(
      async (value) =>
        await db
          .selectDistinct({ id })
          .from(accounts)
          .where(
            and(
              eq(accounts.providerId, kind.signInProvider),
              sql`${id} IN (SELECT value FROM json_each(${value}))`
            )
          )
    )
  );
  return found.flat().map((row) => row.id);
};

/**
 * Every page of `connection`, read through connect: the whole directory
 * of `tenant`, the deployment's own sign-in tenant, then its deleted
 * users, or a directory error (`everyPage`). Someone missing from the
 * people is a leaver only when the deleted users hold them (slice 3b):
 * missing alone suspends nobody.
 */
const listedIn = async (
  env: Env,
  kind: DirectoryKind,
  connection: DirectoryConnection,
  tenant: string,
  deadline: number
): Promise<Listed> => {
  if (connection.status !== "active") {
    throw directoryErrors.create("directory.inactive");
  }
  const listed: Listed = {
    tenant,
    people: [],
    disabled: [],
    deleted: [],
    deletedFailure: null,
  };
  await everyPage(
    deadline,
    async (cursor) =>
      await env.CONNECT.readDirectory({ connectionId: connection.id, cursor }),
    (read) => {
      // Refused for another tenant than the deployment's own.
      if (read.tenant.toLowerCase() !== tenant) {
        throw directoryErrors.create("directory.other_tenant");
      }
      for (const { id, department } of read.people) {
        listed.people.push({ id, department });
      }
      listed.disabled.push(...read.disabled);
    }
  );
  // The proof someone no longer listed has left, read in full in the same
  // read: an account listed, on or off, wins over the deleted list, which
  // may lag behind it, and the next read settles it.
  const listedIds = new Set([
    ...listed.people.map(({ id }) => id),
    ...listed.disabled,
  ]);
  const deleted = await deletedOf(env, connection, deadline);
  if ("failure" in deleted) {
    listed.deletedFailure = deleted.failure;
  } else {
    listed.deleted = await carriedOf(
      env,
      kind,
      deleted.ids.filter((id) => !listedIds.has(id))
    );
  }
  return listed;
};

/** One entry of the JSON the batch reads: ID, department, turned on (1 or 0), erased subject's hash, deleted (1 or 0). */
type Entry = [string, string, 0 | 1, string, 0 | 1];

/**
 * `listed` as the batch's one JSON value, or `directory.too_large` when
 * that is more than D1 takes in one value.
 */
const entriesOf = async (
  env: Env,
  kind: DirectoryKind,
  listed: Listed
): Promise<string> => {
  const hashOf = async (id: string) =>
    await subjectHashOf(env, kind.subjectOf(id));
  const entries: Entry[] = [];
  for (const { id, department } of listed.people) {
    // oxlint-disable-next-line no-await-in-loop -- one hash at a time
    entries.push([id, department, 1, await hashOf(id), 0]);
  }
  for (const id of listed.disabled) {
    // oxlint-disable-next-line no-await-in-loop -- one hash at a time
    entries.push([id, "", 0, await hashOf(id), 0]);
  }
  // A deleted account is kept as one turned off, as it can't sign in
  // either, marked deleted for an admin to see why.
  for (const id of listed.deleted) {
    // oxlint-disable-next-line no-await-in-loop -- one hash at a time
    entries.push([id, "", 0, await hashOf(id), 1]);
  }
  const json = JSON.stringify(entries);
  // The JSON as D1 is sent it, escapes and all, in bytes.
  if (new TextEncoder().encode(json).length > d1ValueBytes) {
    throw directoryErrors.create("directory.too_large");
  }
  return json;
};

/**
 * Applies `listed` as the rows of `kind`, whole, in one batch: the rows of
 * everyone no longer listed (or of another tenant) go, everyone listed is
 * written, an erased person aside, and every row is tied to its member.
 * Every statement holds only while this read's claim of the status row
 * does. Recorded once, with counts alone.
 */
const apply = async (
  env: Env,
  kind: DirectoryKind,
  connection: DirectoryConnection,
  listed: Listed,
  json: string,
  groups: readonly GroupRead[],
  placement: Placement,
  startedAt: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  const run = crypto.randomUUID();
  const claimed = sql`EXISTS (
    SELECT 1 FROM ${directoryReads}
    WHERE ${directoryReads.provider} = ${kind.provider} AND ${directoryReads.run} = ${run}
  )`;
  // An entry of `json` (as `value`) whose subject an erasure kept.
  const erased = sql`EXISTS (
    SELECT 1 FROM ${erasedSubjects}
    WHERE ${erasedSubjects.subjectHash} = value ->> 3
      AND ${erasedSubjects.keyVersion} = ${subjectKeyVersion}
  )`;
  const listedNow = sql`SELECT value ->> 0 FROM json_each(${json}) WHERE NOT ${erased}`;
  const ofKind = eq(directoryPeople.provider, kind.provider);
  const event = createAuditEvent(
    {
      actor: { type: "system" },
      action: readAction,
      target: { type: "connection", id: connection.id },
      detail: {
        provider: kind.provider,
        people: listed.people.length,
        disabled: listed.disabled.length,
        deleted: listed.deleted.length,
      },
    },
    "core"
  );
  const placing = placementStatements(db, kind, placement, sql`1`, claimed);
  // The read's own statements, then its placement's, then its outcome's.
  const claim = db
    .insert(directoryReads)
    .values({
      provider: kind.provider,
      connectionId: connection.id,
      tenant: listed.tenant,
      run,
      startedAt,
    })
    .onConflictDoUpdate({
      target: directoryReads.provider,
      set: {
        run,
        startedAt,
        connectionId: connection.id,
        tenant: listed.tenant,
      },
      setWhere: sql`${directoryReads.startedAt} IS NULL OR ${directoryReads.startedAt} < ${startedAt.getTime()}`,
    });
  const own: BatchItem<"sqlite">[] = [
    db
      .delete(directoryPeople)
      .where(
        and(
          ofKind,
          sql`NOT (${directoryPeople.tenant} = ${listed.tenant} AND ${directoryPeople.accountId} IN (${listedNow}))`,
          claimed
        )
      ),
    db
      .insert(directoryPeople)
      .select(
        sql`SELECT ${kind.provider}, ${listed.tenant}, value ->> 0, value ->> 1, value ->> 2, value ->> 4, NULL
          FROM json_each(${json})
          WHERE NOT ${erased} AND ${claimed}`
      )
      .onConflictDoUpdate({
        target: [
          directoryPeople.provider,
          directoryPeople.tenant,
          directoryPeople.accountId,
        ],
        set: {
          department: sql`excluded.department`,
          enabled: sql`excluded.enabled`,
          deleted: sql`excluded.deleted`,
        },
      }),
    tieDirectoryPeople(db, kind, claimed),
    // Before the placement, so someone listed on again is lifted and
    // placed in the same batch.
    ...suspensionStatements(db, kind, claimed, startedAt),
    // After the people's rows, which each group row needs, and before the
    // placement, which places by them.
    ...groupStatements(db, kind, listed.tenant, groups, claimed, startedAt),
  ];
  const results: unknown[] = await auditedBatch(env, db, [
    claim,
    ...own,
    ...placing.statements,
    db
      .update(directoryReads)
      .set({
        readAt: startedAt,
        people: listed.people.length,
        disabled: listed.disabled.length,
        failure: null,
        failedAt: null,
        deletedFailure: listed.deletedFailure,
      })
      .where(
        and(
          eq(directoryReads.provider, kind.provider),
          eq(directoryReads.run, run)
        )
      ),
    outboxedEventWithDetailWhere(
      db,
      event,
      {
        tied: sql`(SELECT count(*) FROM ${directoryPeople} WHERE ${ofKind} AND ${directoryPeople.userId} IS NOT NULL)`,
      },
      claimed
    ),
  ]);
  await tellKept(env, keptIn(results[1 + own.length + placing.revocation]));
};

/**
 * Records that a read of `connection`, started at `startedAt`, failed with
 * `code`, unless a read started after it was applied since: the rows stay
 * as they are.
 */
const recordFailure = async (
  env: Env,
  kind: DirectoryKind,
  connection: DirectoryConnection,
  tenant: string,
  code: DirectoryReadFailure,
  startedAt: Date
): Promise<void> => {
  const failedAt = new Date();
  await drizzle(env.DB)
    .insert(directoryReads)
    .values({
      provider: kind.provider,
      connectionId: connection.id,
      tenant,
      failure: code,
      failedAt,
    })
    .onConflictDoUpdate({
      target: directoryReads.provider,
      set: { connectionId: connection.id, failure: code, failedAt },
      setWhere: sql`${directoryReads.startedAt} IS NULL OR ${directoryReads.startedAt} < ${startedAt.getTime()}`,
    });
  log.warn("directory.read_failed", {
    provider: kind.provider,
    connectionId: connection.id,
    code,
  });
};

/**
 * Records `failure`, what stopped a read started at `startedAt`, as the
 * read's failure; whatever stopped it, nothing of the read was kept. One
 * that isn't the directory's own (D1 refusing the batch, say) goes on to
 * the clock's report too. Should recording it fail as well, that is
 * logged, and `failure` is still the error the clock reports.
 */
const failedWith = async (
  env: Env,
  kind: DirectoryKind,
  connection: DirectoryConnection,
  tenant: string,
  startedAt: Date,
  failure: unknown
): Promise<void> => {
  const code = directoryErrors.codeOf(failure);
  try {
    await recordFailure(
      env,
      kind,
      connection,
      tenant,
      // Typed as the admin is told it; anything else as the catch-all.
      isDirectoryReadFailure(code) ? code : "directory.read_failed",
      startedAt
    );
  } catch (error) {
    log.error("directory.read_failure_unrecorded", errorFields(error));
    throw failure;
  }
  if (code === undefined) {
    throw failure;
  }
};

/**
 * Reads `kind`'s directory of the deployment's own tenant and applies it,
 * once a day: when no read was applied in the day before `at`. Nothing
 * when none is connected.
 */
const readKind = async (
  env: Env,
  kind: DirectoryKind,
  at: Date
): Promise<void> => {
  const [status] = await drizzle(env.DB)
    .select({ readAt: directoryReads.readAt })
    .from(directoryReads)
    .where(eq(directoryReads.provider, kind.provider));
  if (
    status?.readAt !== null &&
    status?.readAt !== undefined &&
    at.getTime() - status.readAt.getTime() < dayMs
  ) {
    return;
  }
  const connection = await connectionOf(env, kind.provider);
  const config = signInConfig(env);
  const tenant =
    config === undefined ? undefined : kind.tenantIn(config)?.toLowerCase();
  if (connection === undefined || tenant === undefined) {
    return;
  }
  // Before the first page: a read that started later, whichever ends
  // first, is the one that stands. The clock started the task at `at`,
  // and takes it for dead once its lease is over.
  const startedAt = new Date();
  const deadline = at.getTime() + clockLeaseMs;
  try {
    const listed = await listedIn(env, kind, connection, tenant, deadline);
    const json = await entriesOf(env, kind, listed);
    // The mapped groups, each read whole or held (directory-group-reads.ts).
    const groups = await mappedGroupsRead(
      env,
      kind,
      connection,
      async (readPage, take) => {
        await everyPage(deadline, readPage, take);
      }
    );
    const placement = await readPlacementOf(env, kind, listed.people, groups);
    if (Date.now() >= deadline) {
      throw directoryErrors.create("directory.read_too_long");
    }
    await apply(
      env,
      kind,
      connection,
      listed,
      json,
      groups,
      placement,
      startedAt
    );
    if (listed.deletedFailure !== null) {
      // The fall-back `deletedOf` chose: the rest of the read was applied,
      // with nobody suspended for having left.
      log.warn("directory.read_applied_without_deleted", {
        provider: kind.provider,
        code: listed.deletedFailure,
      });
    }
  } catch (error) {
    await failedWith(env, kind, connection, tenant, startedAt, error);
  }
};

/**
 * The clock's daily read of the organization's directories (clock.ts): run
 * every quarter hour, it reads each once a day. A read that failed before
 * its batch was applied left the last applied one as it was, so the next
 * quarter hour reads again; once applied, nothing of it is owed later.
 */
export const readDirectories = async (env: Env, at: Date): Promise<void> => {
  for (const kind of directoryKinds) {
    // oxlint-disable-next-line no-await-in-loop -- one provider at a time
    await readKind(env, kind, at);
  }
};
