import type { AuditActor } from "@grasp-os/shared/audit";
import { createAuditEvent } from "@grasp-os/shared/audit";
import type { DependencySubject } from "@grasp-os/shared/dependencies";
import { packageKey } from "@grasp-os/shared/dependencies";
import { errorFields, log } from "@grasp-os/shared/log";
import { packageErrors } from "@grasp-os/shared/packages";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
} from "../audit-outbox.ts";
import { dependencyRequests } from "../db/core/schema.ts";
import { packageNoticed } from "../notifications.ts";
import {
  inForce,
  malwareEntries,
  requestEntry,
  snapshotOf,
} from "./approvals.ts";
import { scanPackages } from "./malware.ts";
import { buildersOf } from "./subjects.ts";

// Approvals in force (`inForce`: current, or replaced but still what an
// older release runs on) scanned again on core's clock (clock.ts): each
// at most every `rescanMs`, the longest unscanned first, a few a run.
// What could go wrong, and what stops it:
//
// - Malware reported after approval running on: every row in force of a
//   graph a report covers is revoked, by core, whichever App it is of, in
//   one batch, each with its audit event and a notice to its builders.
//   Nothing of a revoked graph is built or served any more.
// - A new advisory going unnoticed: one not known of a current approval
//   as it was approved, or at its last scan, is audited and told to its
//   builders once; the approval stands, as every other finding only warns.
// - Sources out of reach taken as clean: a scan that can't read either
//   source changes nothing, is logged, and ends the run; the next asks
//   again.

/** How long an approval goes between two scans. */
export const rescanMs = 6 * 60 * 60 * 1000;

/** Most approvals one run scans, one after another. */
export const rescanBatch = 20;

/** Core itself, as the actor of what no person decided. */
const coreActor: AuditActor = { type: "system" };

type Row = typeof dependencyRequests.$inferSelect;

/** That `row` is still in force as the statement runs, as SQL. */
const stillInForce = (row: Pick<Row, "id">) =>
  sql`EXISTS (SELECT 1 FROM ${dependencyRequests} WHERE ${dependencyRequests.id} = ${row.id} AND ${dependencyRequests.status} IN ('approved', 'retired'))`;

/**
 * Revokes every row in force of `row`'s graph for `malware`, by core: one
 * audit event and builders' notice each, every App sharing
 * the graph at once, in one batch.
 */
const revokeGraph = async (
  env: Env,
  row: Row,
  scanned: Awaited<ReturnType<typeof scanPackages>>,
  at: Date
): Promise<void> => {
  const [malware] = scanned.malware;
  if (malware === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const sharing = await db
    .select()
    .from(dependencyRequests)
    .where(
      and(
        eq(dependencyRequests.graphHash, row.graphHash),
        eq(dependencyRequests.subjectType, "app"),
        inArray(dependencyRequests.status, [...inForce])
      )
    );
  const statements = await Promise.all(
    sharing.map(async (each) => {
      const subject: DependencySubject = {
        type: each.subjectType,
        id: each.subjectId,
      };
      const revoked = createAuditEvent(
        requestEntry(coreActor, "revoked", each, {
          reason: "malware",
          package: malware.package.name,
          version: malware.package.version,
          advisory: malware.advisory,
          found: scanned.malware.length,
        }),
        "core"
      );
      return [
        outboxedEventWhere(db, revoked, stillInForce(each)),
        db
          .update(dependencyRequests)
          .set({
            status: "revoked",
            endedAt: at,
            endedReason: `Reported as malware: ${packageKey(malware.package)} (${malware.advisory})`,
            malwareCheckedAt: at,
          })
          .where(
            and(eq(dependencyRequests.id, each.id), storedEvent(revoked.id))
          ),
        ...malwareEntries(coreActor, subject, scanned.malware, "rescan").map(
          (entry) =>
            outboxedEventWhere(
              db,
              createAuditEvent(entry, "core"),
              storedEvent(revoked.id)
            )
        ),
        ...packageNoticed(db, {
          type: "package_revoked",
          app: subject.id,
          package: malware.package,
          advisory: malware.advisory,
          personIds: await buildersOf(env, subject),
          recorded: storedEvent(revoked.id),
        }),
      ];
    })
  );
  const [first, ...rest] = statements.flat();
  if (first !== undefined) {
    await auditedBatch(env, db, [first, ...rest]);
  }
};

/**
 * Scans approval `row` again: revoked for malware, its builders told of
 * any advisory it didn't know, its scan time moved on. False when the
 * sources couldn't be read: nothing changes, and it is logged.
 */
const rescanApproval = async (
  env: Env,
  row: Row,
  at: Date
): Promise<boolean> => {
  const subject: DependencySubject = {
    type: row.subjectType,
    id: row.subjectId,
  };
  const { lock } = snapshotOf(row);
  let scanned: Awaited<ReturnType<typeof scanPackages>>;
  try {
    scanned = await scanPackages(env, Object.values(lock.packages));
  } catch (error) {
    log.warn("dependencies.rescan_unread", {
      request: row.id,
      errorCode: packageErrors.codeOf(error) ?? "internal.unexpected",
      ...errorFields(error),
    });
    return false;
  }
  if (scanned.malware.length > 0) {
    await revokeGraph(env, row, scanned, at);
    return true;
  }
  const db = drizzle(env.DB);
  const builders = await buildersOf(env, subject);
  const known = new Set(row.advisories);
  // Advisories are told of the current approval only: a replaced one runs
  // only what was built before, until it is built again.
  const found =
    row.status === "approved"
      ? scanned.advisories.filter(({ advisory }) => !known.has(advisory.id))
      : [];
  const events = found.map(({ advisory, package: ref }) =>
    createAuditEvent(
      requestEntry(coreActor, "advisory_found", row, {
        package: ref.name,
        version: ref.version,
        advisory: advisory.id,
        severity: advisory.severity,
      }),
      "core"
    )
  );
  const advisories = [
    ...new Set([...known, ...found.map(({ advisory }) => advisory.id)]),
  ];
  // Only while it is still the approval this read, at the scan time it
  // read: two runs never tell the same advisory twice.
  const scannedNow = sql`EXISTS (SELECT 1 FROM ${dependencyRequests} WHERE ${dependencyRequests.id} = ${row.id} AND ${dependencyRequests.malwareCheckedAt} = ${at.getTime()})`;
  await auditedBatch(env, db, [
    db
      .update(dependencyRequests)
      .set({ malwareCheckedAt: at, advisories })
      .where(
        and(
          eq(dependencyRequests.id, row.id),
          eq(dependencyRequests.status, row.status),
          row.malwareCheckedAt === null
            ? isNull(dependencyRequests.malwareCheckedAt)
            : eq(dependencyRequests.malwareCheckedAt, row.malwareCheckedAt)
        )
      ),
    ...events.map((event) => outboxedEventWhere(db, event, scannedNow)),
    ...found.flatMap(({ advisory, package: ref }, index) =>
      packageNoticed(db, {
        type: "package_advisory",
        app: subject.id,
        package: ref,
        advisory: advisory.id,
        personIds: builders,
        recorded: storedEvent(events[index]?.id ?? ""),
      })
    ),
  ]);
  return true;
};

/**
 * Scans the approvals due again (`rescanMs`), the longest unscanned
 * first, at most {@link rescanBatch} a run; one whose sources can't be
 * read ends the run, to be asked again by the next.
 */
export const rescanPackages = async (
  env: Env,
  at: Date = new Date()
): Promise<void> => {
  const due = await drizzle(env.DB)
    .select()
    .from(dependencyRequests)
    .where(
      and(
        // A workflow's, from before workflows lost their packages, is
        // never served again: nothing to rescan.
        eq(dependencyRequests.subjectType, "app"),
        inArray(dependencyRequests.status, [...inForce]),
        or(
          isNull(dependencyRequests.malwareCheckedAt),
          lt(
            dependencyRequests.malwareCheckedAt,
            new Date(at.getTime() - rescanMs)
          )
        )
      )
    )
    .orderBy(asc(sql`coalesce(${dependencyRequests.malwareCheckedAt}, 0)`))
    .limit(rescanBatch);
  for (const row of due) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time, bounded
    if (!(await rescanApproval(env, row, at))) {
      return;
    }
  }
};
