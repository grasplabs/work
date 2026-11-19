import { createAuditEvent } from "@grasp-os/shared/audit";
import { directoryErrors } from "@grasp-os/shared/directory";
import type { DirectoryConnection } from "@grasp-os/shared/directory";
import { errorFields, log } from "@grasp-os/shared/log";
import { clockLeaseMs } from "@grasp-os/workerflow/clock";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { tellKept } from "./access-revocations.ts";
import { auditedBatch, outboxedEventWithDetailWhere } from "./audit-outbox.ts";
import { signInConfig } from "./auth/config.ts";
import {
  directoryDepartments,
  directoryPeople,
  directoryReads,
  erasedSubjects,
} from "./db/core/schema.ts";
import {
  keptIn,
  placementStatements,
  placeMember,
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
//   that no longer lists the person.
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
}

/**
 * Every page of `connection`, read through connect: the whole directory
 * of `tenant`, the deployment's own sign-in tenant, or a directory error;
 * a page connect answers for any other tenant is refused. Bounded by what is real: the clock's lease on the
 * task (`deadline`), past which it is refused as `directory.read_too_long`,
 * and the provider's own end; a next link it handed back already is the
 * provider failing, never read again.
 */
const listedIn = async (
  env: Env,
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
  };
  const followed = new Set<string>();
  let cursor: string | null = null;
  do {
    if (Date.now() >= deadline) {
      throw directoryErrors.create("directory.read_too_long");
    }
    // oxlint-disable-next-line no-await-in-loop -- each read goes on from the last
    const read = await env.CONNECT.readDirectory({
      connectionId: connection.id,
      cursor,
    });
    if (read.tenant.toLowerCase() !== listed.tenant) {
      throw directoryErrors.create("directory.other_tenant");
    }
    for (const { id, department } of read.people) {
      listed.people.push({ id, department });
    }
    listed.disabled.push(...read.disabled);
    cursor = read.next;
    if (cursor !== null) {
      if (followed.has(cursor)) {
        throw directoryErrors.create("directory.provider_failed");
      }
      followed.add(cursor);
    }
  } while (cursor !== null);
  return listed;
};

/** One entry of the JSON the batch reads: ID, department, turned on (1 or 0), erased subject's hash. */
type Entry = [string, string, 0 | 1, string];

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
    entries.push([id, department, 1, await hashOf(id)]);
  }
  for (const id of listed.disabled) {
    // oxlint-disable-next-line no-await-in-loop -- one hash at a time
    entries.push([id, "", 0, await hashOf(id)]);
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
        sql`SELECT ${kind.provider}, ${listed.tenant}, value ->> 0, value ->> 1, value ->> 2, NULL
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
        },
      }),
    tieDirectoryPeople(db, kind, claimed),
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
 * as they are. Its own apply having landed, what failed after it (placing
 * whom its snapshot didn't know) is recorded too.
 */
const recordFailure = async (
  env: Env,
  kind: DirectoryKind,
  connection: DirectoryConnection,
  tenant: string,
  code: string,
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
      setWhere: sql`${directoryReads.startedAt} IS NULL OR ${directoryReads.startedAt} <= ${startedAt.getTime()}`,
    });
  log.warn("directory.read_failed", {
    provider: kind.provider,
    connectionId: connection.id,
    code,
  });
};

/**
 * Places, by the same statements, each member the read tied to a person
 * whose department fills a team but whose membership its snapshot couldn't
 * offer (`placement.members`): someone who first signed in between the
 * snapshot and the batch. One batch each, for them alone, so the read
 * ends with them placed rather than a day later.
 */
const placeUnknown = async (
  env: Env,
  kind: DirectoryKind,
  placement: Placement
): Promise<void> => {
  const tied = await drizzle(env.DB)
    .selectDistinct({ userId: directoryPeople.userId })
    .from(directoryPeople)
    .innerJoin(
      directoryDepartments,
      and(
        eq(directoryDepartments.provider, directoryPeople.provider),
        eq(directoryDepartments.department, directoryPeople.department)
      )
    )
    .where(
      and(
        eq(directoryPeople.provider, kind.provider),
        isNotNull(directoryPeople.userId)
      )
    );
  for (const { userId } of tied) {
    if (userId !== null && !placement.members.has(userId)) {
      // oxlint-disable-next-line no-await-in-loop -- one member at a time
      await tellKept(env, await placeMember(env, kind, userId));
    }
  }
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
      code ?? "directory.read_failed",
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
    const listed = await listedIn(env, connection, tenant, deadline);
    const json = await entriesOf(env, kind, listed);
    const placement = await readPlacementOf(env, kind, listed.people);
    if (Date.now() >= deadline) {
      throw directoryErrors.create("directory.read_too_long");
    }
    await apply(env, kind, connection, listed, json, placement, startedAt);
    await placeUnknown(env, kind, placement);
  } catch (error) {
    await failedWith(env, kind, connection, tenant, startedAt, error);
  }
};

/**
 * The clock's daily read of the organization's directories (clock.ts): run
 * every quarter hour, it reads each once a day, and again at the next
 * quarter hour after one failed.
 */
export const readDirectories = async (env: Env, at: Date): Promise<void> => {
  for (const kind of directoryKinds) {
    // oxlint-disable-next-line no-await-in-loop -- one provider at a time
    await readKind(env, kind, at);
  }
};
