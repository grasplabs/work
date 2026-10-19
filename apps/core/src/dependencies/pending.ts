import { actorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import type { DependencySubject } from "@grasp-os/shared/dependencies";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { Acting } from "../auth/identity.ts";
import {
  auditOutbox,
  dependencyRequests,
  workflowResources,
} from "../db/core/schema.ts";
import { unusedLockStatements } from "../packages/locks.ts";
import { advancePolicy, policyGenerationSql } from "./policy.ts";
import { ofSubject } from "./subjects.ts";

// Dropping the request that waits for a subject, in the batch that makes
// it moot: one that replaces it (requests.ts), or deleting the workflow it
// was for (workflow-resources.ts), which also revokes what it had approved. Kept apart from requests.ts so the
// workflow registry can use it without a cycle.

/** Why a waiting request is dropped: replaced by request `by`, or withdrawn. */
type Dropped =
  | { action: "superseded"; by: string }
  | { action: "withdrawn"; reason: string };

/**
 * The statements that drop whatever request waits for `subject` as their
 * batch runs, while `onlyIf` holds then, with its audit event by `actor`
 * (`dependency.superseded` or `dependency.withdrawn`, `why`): the event
 * first, written from the very row the delete then removes (one waits per
 * subject at most), so it names what was removed whatever was read
 * before, and nothing is recorded when nothing waits. What `requestEntry`
 * records of the request, as SQL.
 */
export const dropPending = (
  db: DrizzleD1Database,
  actor: AuditActor,
  subject: DependencySubject,
  why: Dropped,
  onlyIf: SQL = sql`1`
) => {
  const waits = and(
    ofSubject(dependencyRequests, subject),
    eq(dependencyRequests.status, "pending"),
    onlyIf
  );
  const [key, value] =
    why.action === "superseded" ? ["by", why.by] : ["reason", why.reason];
  const eventId = crypto.randomUUID();
  const now = new Date();
  const event = sql`json_object(
    'id', ${eventId},
    'at', ${now.toISOString()},
    'source', 'core',
    'actor', json(${JSON.stringify(actor)}),
    'action', ${`dependency.${why.action}`},
    'target', json_object('type', 'dependency_request', 'id', ${dependencyRequests.id}),
    'provenance', json('[]'),
    'detail', json_object(
      ${dependencyRequests.subjectType}, ${dependencyRequests.subjectId},
      'sourceRevision', ${dependencyRequests.sourceRevision},
      'graphHash', ${dependencyRequests.graphHash},
      'targets', (SELECT group_concat(value, ' ') FROM json_each(${dependencyRequests.targets})),
      'direct', ${dependencyRequests.direct},
      'packages', ${dependencyRequests.packages},
      ${key}, ${value}
    )
  )`;
  return [
    db
      .insert(auditOutbox)
      .select(
        sql`SELECT ${eventId}, ${event}, ${now.getTime()} FROM ${dependencyRequests} WHERE ${waits}`
      ),
    db.delete(dependencyRequests).where(waits),
  ] as const;
};

/**
 * The statements, for the batch that deletes workflow `workflow` as `by`,
 * that end everything its packages were, once the batch has marked it
 * deleted: each approval in force (approved or retired) is revoked, as
 * `dependency.revoked` naming the deletion, and the policy generation
 * moves on, so a build that read it before pins nothing (its pin checks
 * both, packages/build.ts); its waiting request is withdrawn
 * (`dependency.withdrawn`), so nobody approves packages for a workflow
 * that is gone; and each of its locks no request names any more goes,
 * its files recorded for cleanup. The rows stay, as history.
 */
export const withdrawnWithWorkflow = (
  db: DrizzleD1Database,
  by: Acting,
  workflow: string
) => {
  const subject: DependencySubject = { type: "workflow", id: workflow };
  const actor = by.actor ?? actorOf(by);
  const gone = sql`EXISTS (SELECT 1 FROM ${workflowResources} WHERE ${workflowResources.id} = ${workflow} AND ${workflowResources.deletedAt} IS NOT NULL)`;
  const inForce = and(
    ofSubject(dependencyRequests, subject),
    inArray(dependencyRequests.status, ["approved", "retired"]),
    gone
  );
  const reason = "workflow.deleted";
  const now = new Date();
  // One event per approval, each its own UUID: this batch's random first
  // 24 characters, then the approval's own last 12 (its ID is a UUID too).
  const batch = crypto.randomUUID().slice(0, 24);
  const eventId = sql`${batch} || substr(${dependencyRequests.id}, 25, 12)`;
  // Each event read before the generation moves on, naming the one the
  // revocation lands under: the next.
  const event = sql`json_object(
    'id', ${eventId},
    'at', ${now.toISOString()},
    'source', 'core',
    'actor', json(${JSON.stringify(actor)}),
    'action', 'dependency.revoked',
    'target', json_object('type', 'dependency_request', 'id', ${dependencyRequests.id}),
    'provenance', json('[]'),
    'detail', json_object(
      ${dependencyRequests.subjectType}, ${dependencyRequests.subjectId},
      'graphHash', ${dependencyRequests.graphHash},
      'targets', (SELECT group_concat(value, ' ') FROM json_each(${dependencyRequests.targets})),
      'reason', ${reason},
      'policyGeneration', ${policyGenerationSql} + 1
    )
  )`;
  return [
    db
      .insert(auditOutbox)
      .select(
        sql`SELECT ${eventId}, ${event}, ${now.getTime()} FROM ${dependencyRequests} WHERE ${inForce}`
      ),
    advancePolicy(
      db,
      sql`EXISTS (SELECT 1 FROM ${dependencyRequests} WHERE ${inForce})`
    ),
    db
      .update(dependencyRequests)
      .set({
        status: "revoked",
        endedBy: by.userId,
        endedAt: now,
        endedGeneration: sql`${policyGenerationSql}`,
        endedReason: reason,
      })
      .where(inForce),
    ...dropPending(db, actor, subject, { action: "withdrawn", reason }, gone),
    ...unusedLockStatements(db, subject),
  ];
};
