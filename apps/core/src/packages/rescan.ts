import type { AuditActor } from "@grasp-os/shared/audit";
import { createAuditEvent } from "@grasp-os/shared/audit";
import type { DependencySubject } from "@grasp-os/shared/dependencies";
import { packageKey } from "@grasp-os/shared/dependencies";
import { errorFields, log } from "@grasp-os/shared/log";
import { packageErrors } from "@grasp-os/shared/packages";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
} from "../audit-outbox.ts";
import { dependencyRequests } from "../db/core/schema.ts";
import { packageNoticed } from "../notifications.ts";
import { malwareEntries, requestEntry, snapshotOf } from "./approvals.ts";
import { scanPackages } from "./malware.ts";
import { buildersOf } from "./subjects.ts";

// Approved packages scanned again on core's clock (clock.ts): each
// approval at most every `rescanMs`, the longest unscanned first, a few a
// run. What could go wrong, and what stops it:
//
// - Malware reported after approval running on: an approval a report
//   covers is revoked, by core, in one batch that lands only while it is
//   still approved, with its audit event and a notice to the App's or
//   workflow's builders. Nothing of a revoked graph is built any more, no
//   start or call of a workflow sealing it is admitted
//   (workflows/package-seal.ts), and a run in flight fails at its next
//   call.
// - A new advisory going unnoticed: one not known as the graph was
//   approved, or at its last scan, is audited and told to its builders
//   once; the approval stands, as every other finding only warns.
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

/** That `row` is still the approval it was as it was read, as SQL. */
const stillApproved = (row: Row) =>
  sql`EXISTS (SELECT 1 FROM ${dependencyRequests} WHERE ${dependencyRequests.id} = ${row.id} AND ${dependencyRequests.status} = 'approved')`;

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
  const db = drizzle(env.DB);
  const builders = await buildersOf(env, subject);
  const [malware] = scanned.malware;
  if (malware !== undefined) {
    const revoked = createAuditEvent(
      requestEntry(coreActor, "revoked", row, {
        reason: "malware",
        package: malware.package.name,
        version: malware.package.version,
        advisory: malware.advisory,
        found: scanned.malware.length,
      }),
      "core"
    );
    await auditedBatch(env, db, [
      outboxedEventWhere(db, revoked, stillApproved(row)),
      db
        .update(dependencyRequests)
        .set({
          status: "revoked",
          endedAt: at,
          endedReason: `Reported as malware: ${packageKey(malware.package)} (${malware.advisory})`,
          malwareCheckedAt: at,
        })
        .where(and(eq(dependencyRequests.id, row.id), storedEvent(revoked.id))),
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
        subject,
        package: malware.package,
        advisory: malware.advisory,
        personIds: builders,
        recorded: storedEvent(revoked.id),
      }),
    ]);
    return true;
  }
  const known = new Set(row.advisories);
  const found = scanned.advisories.filter(
    ({ advisory }) => !known.has(advisory.id)
  );
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
          eq(dependencyRequests.status, "approved"),
          row.malwareCheckedAt === null
            ? isNull(dependencyRequests.malwareCheckedAt)
            : eq(dependencyRequests.malwareCheckedAt, row.malwareCheckedAt)
        )
      ),
    ...events.map((event) => outboxedEventWhere(db, event, scannedNow)),
    ...found.flatMap(({ advisory, package: ref }, index) =>
      packageNoticed(db, {
        type: "package_advisory",
        subject,
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
        eq(dependencyRequests.status, "approved"),
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
