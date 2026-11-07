import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { dependencyErrors, packageKey } from "@grasp-os/shared/dependencies";
import type {
  DependencyFinding,
  DependencySubject,
} from "@grasp-os/shared/dependencies";
import { graspLockSchema } from "@grasp-os/shared/packages";
import type { GraspLock } from "@grasp-os/shared/packages";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import type { OutboxEnv } from "../audit-outbox.ts";
import { dependencyRequests } from "../db/core/schema.ts";
import type { MalwareFound } from "./malware.ts";

// The requests and approvals as builds, loads and the clock read them,
// and the refusal of known malware they share: apart from asking and
// deciding (requests.ts), which read who someone is, so a build reads an
// approval without reaching the App registry.

/** That a row of `dependency_requests` is `subject`'s, as SQL. */
export const ofSubject = (subject: DependencySubject): SQL =>
  and(
    eq(dependencyRequests.subjectType, subject.type),
    eq(dependencyRequests.subjectId, subject.id)
  ) ?? sql`0`;

/** What the audit log names a subject as, as every other event of either does. */
export const auditTargetOf = (
  subject: DependencySubject
): { type: "app" | "workflow_resource"; id: string } => ({
  type: subject.type === "app" ? "app" : "workflow_resource",
  id: subject.id,
});

type Row = typeof dependencyRequests.$inferSelect;

/** What a request keeps of its review, as JSON in `snapshot`. */
const snapshotSchema = z.object({
  lock: graspLockSchema,
  findings: z.array(z.custom<DependencyFinding>()),
  /** The packages it takes out of the subject's approved set, by name. */
  removed: z.array(z.string()),
});

export const snapshotOf = (row: Pick<Row, "snapshot">) =>
  snapshotSchema.parse(JSON.parse(row.snapshot));

/** The audit entry of something that happened to a request: identifiers only. */
export const requestEntry = (
  actor: AuditActor,
  action: string,
  row: Pick<Row, "id" | "subjectType" | "subjectId" | "graphHash" | "packages">,
  detail: Record<string, string | number | boolean | null> = {}
): AuditEntry => ({
  actor,
  action: `dependency.${action}`,
  target: { type: "dependency_request", id: row.id },
  detail: {
    [row.subjectType]: row.subjectId,
    graphHash: row.graphHash,
    packages: row.packages,
    ...detail,
  },
});

/**
 * The statuses of an approval still in force for what was built on it: the
 * subject's one current approval (`approved`), and one a later approval
 * of the subject replaced (`retired`), which a release or a workflow
 * version built before keeps running on. Only the current approval is
 * proposed against, built or sealed; malware revokes both.
 */
export const inForce = ["approved", "retired"] as const;

/**
 * The statements that withdraw `subject`'s approvals once it is gone (an
 * App removed, a workflow deleted, as `gone` says when they run), for a
 * batch that does that: what is in force is revoked, so the clock stops
 * scanning it and nothing of it is served, audited by `actor`; a request
 * still waiting goes, as nobody can decide it now.
 */
export const withdrawnWith = (
  db: DrizzleD1Database,
  actor: AuditActor,
  subject: DependencySubject,
  gone: SQL,
  at: Date
) =>
  [
    db
      .update(dependencyRequests)
      .set({
        status: "revoked",
        endedAt: at,
        endedReason:
          subject.type === "app"
            ? "Withdrawn: the App was removed."
            : "Withdrawn: the workflow was deleted.",
      })
      .where(
        and(
          ofSubject(subject),
          inArray(dependencyRequests.status, [...inForce]),
          gone
        )
      ),
    outboxedIfChanged(db, {
      actor,
      action: "dependency.withdrawn",
      target: auditTargetOf(subject),
      detail: { [subject.type]: subject.id },
    }),
    db
      .delete(dependencyRequests)
      .where(
        and(ofSubject(subject), eq(dependencyRequests.status, "pending"), gone)
      ),
  ] as const;

/**
 * The statements that withdraw App `app`'s replaced approvals no kept
 * release runs on any more (none of its releases bundles their graph's
 * modules, `packageModuleName`), for the batch of release retention that
 * deletes a release: the clock then scans only what can still run.
 * Audited by core.
 */
export const unusedRetiredWithdrawn = (
  db: DrizzleD1Database,
  app: string,
  at: Date
) =>
  [
    db
      .update(dependencyRequests)
      .set({
        status: "revoked",
        endedAt: at,
        endedReason: "Withdrawn: no kept release runs on it.",
      })
      .where(
        and(
          ofSubject({ type: "app", id: app }),
          eq(dependencyRequests.status, "retired"),
          sql`NOT EXISTS (SELECT 1 FROM sdk_release_manifests AS kept
            WHERE kept.app_id = ${app}
              AND instr(kept.manifest, 'pkg~' || ${dependencyRequests.graphHash} || '~') > 0)`
        )
      ),
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action: "dependency.withdrawn",
      target: auditTargetOf({ type: "app", id: app }),
      detail: { app, reason: "unused" },
    }),
  ] as const;

/** The request of `subject` in `status`, newest decision first, if any. */
export const latest = async (
  env: Pick<Env, "DB">,
  subject: DependencySubject,
  status: Row["status"],
  graphHash?: string
): Promise<Row | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(dependencyRequests)
    .where(
      and(
        ofSubject(subject),
        eq(dependencyRequests.status, status),
        graphHash === undefined
          ? undefined
          : eq(dependencyRequests.graphHash, graphHash)
      )
    )
    .orderBy(desc(dependencyRequests.decidedAt))
    .limit(1)
    .get();

/** Most findings one malware refusal audits, each as its own event. */
const malwareAuditedMax = 25;

/**
 * The audit entries of a refusal of `found` as known malware for
 * `subject`, `at` a resolve, an approval, a build or the clock's rescan:
 * one per package and report, the first {@link malwareAuditedMax}.
 */
export const malwareEntries = (
  actor: AuditActor,
  subject: DependencySubject,
  found: readonly MalwareFound[],
  at: "resolve" | "approval" | "build" | "rescan"
): AuditEntry[] =>
  found.slice(0, malwareAuditedMax).map((malware) => ({
    actor,
    action: "dependency.malware_refused",
    target: auditTargetOf(subject),
    detail: {
      [subject.type]: subject.id,
      package: malware.package.name,
      version: malware.package.version,
      advisory: malware.advisory,
      found: found.length,
      at,
    },
  }));

/**
 * Refuses `found` as known malware for `subject` (Nick's decision of
 * 2026-10-19: confirmed malware is refused, every other finding warns),
 * audited first. No approval can admit it.
 */
export const refuseMalware = async (
  env: OutboxEnv & Pick<Env, "DB">,
  actor: AuditActor,
  subject: DependencySubject,
  found: readonly [MalwareFound, ...MalwareFound[]],
  at: "resolve" | "approval" | "build"
): Promise<never> => {
  const db = drizzle(env.DB);
  const [first, ...rest] = malwareEntries(actor, subject, found, at).map(
    (entry) => outboxed(db, entry)
  );
  if (first !== undefined) {
    await auditedBatch(env, db, [first, ...rest]);
  }
  throw dependencyErrors.create("dependency.malware", {
    packages: found.map(
      (malware) => `${packageKey(malware.package)} (${malware.advisory})`
    ),
  });
};

/**
 * The lock of `subject`'s graph `graphHash` while it is the subject's
 * current approval, and that approval: the one way to a graph's packages
 * for a build, a seal or an export. `dependency.revoked` for a graph core
 * revoked; `dependency.approval_required` for anything else, one a later
 * approval replaced too.
 */
export const approvedLock = async (
  env: Pick<Env, "DB">,
  subject: DependencySubject,
  graphHash: string
): Promise<{ approval: string; lock: GraspLock }> => {
  const row = await latest(env, subject, "approved", graphHash);
  if (row) {
    return { approval: row.id, lock: snapshotOf(row).lock };
  }
  const revoked = await latest(env, subject, "revoked", graphHash);
  throw dependencyErrors.create(
    revoked ? "dependency.revoked" : "dependency.approval_required"
  );
};

/**
 * The lock of `subject`'s current approval, if any: what a new request
 * adds to, or takes packages out of.
 */
export const latestApprovedLock = async (
  env: Pick<Env, "DB">,
  subject: DependencySubject
): Promise<GraspLock | undefined> => {
  const approved = await latest(env, subject, "approved");
  return approved === undefined ? undefined : snapshotOf(approved).lock;
};

/** The graph of `subject`'s current approval, if any. */
export const latestApproval = async (
  env: Pick<Env, "DB">,
  subject: DependencySubject
): Promise<string | undefined> => {
  const approved = await latest(env, subject, "approved");
  return approved?.graphHash;
};

/**
 * Whether graph `graphHash` is in force for anyone now (`inForce`): what
 * serving or loading a build that bundles it requires. A graph is its
 * packages' exact bytes, so malware revokes every row of it at once
 * (rescan.ts), for every App.
 */
export const graphApproved = async (
  env: Env,
  graphHash: string
): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ id: dependencyRequests.id })
    .from(dependencyRequests)
    .where(
      and(
        eq(dependencyRequests.graphHash, graphHash),
        inArray(dependencyRequests.status, [...inForce])
      )
    )
    .limit(1)
    .get();
  return row !== undefined;
};
