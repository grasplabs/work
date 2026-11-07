import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { dependencyErrors, packageKey } from "@grasp-os/shared/dependencies";
import type {
  DependencyFinding,
  DependencySubject,
} from "@grasp-os/shared/dependencies";
import { graspLockSchema } from "@grasp-os/shared/packages";
import type { GraspLock } from "@grasp-os/shared/packages";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
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
 * The approved lock of `subject`'s graph `graphHash`, and the approval it
 * stands on: the one way to a graph's packages for a build or an export.
 * `dependency.revoked` for a graph core revoked; `dependency.approval_required`
 * for anything else not approved.
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

/** The graph of `subject`'s latest approval in force, if any. */
export const latestApproval = async (
  env: Pick<Env, "DB">,
  subject: DependencySubject
): Promise<string | undefined> => {
  const approved = await latest(env, subject, "approved");
  return approved?.graphHash;
};

/**
 * Whether graph `graphHash` is approved for anyone now: what serving or
 * loading a build that bundles it requires. A graph is its packages'
 * exact bytes, so one revoked as malware is revoked for every App.
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
        eq(dependencyRequests.status, "approved")
      )
    )
    .limit(1)
    .get();
  return row !== undefined;
};
