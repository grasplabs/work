import type { AuditActor } from "@grasp-os/shared/audit";
import type { DependencySubject } from "@grasp-os/shared/dependencies";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  auditOutbox,
  dependencyRequests,
  workflowResources,
} from "../db/core/schema.ts";
import { unusedLockStatements } from "../packages/locks.ts";
import { ofSubject } from "./subjects.ts";

// Dropping the request that waits for a subject, in the batch that makes
// it moot: one that replaces it (requests.ts), or deleting the workflow it
// was for (workflow-resources.ts). Kept apart from requests.ts so the
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
 * The statements, for the batch that deletes workflow `workflow`, that
 * withdraw its waiting request once the batch has marked it deleted (so
 * nobody approves packages for a workflow that is gone), audited as
 * `actor`'s `dependency.withdrawn`, and then drop each of its locks no
 * request names any more, recording their files for cleanup. What it had
 * approved stays, as history.
 */
export const withdrawnWithWorkflow = (
  db: DrizzleD1Database,
  actor: AuditActor,
  workflow: string
) => {
  const subject: DependencySubject = { type: "workflow", id: workflow };
  return [
    ...dropPending(
      db,
      actor,
      subject,
      { action: "withdrawn", reason: "workflow.deleted" },
      sql`EXISTS (SELECT 1 FROM ${workflowResources} WHERE ${workflowResources.id} = ${workflow} AND ${workflowResources.deletedAt} IS NOT NULL)`
    ),
    ...unusedLockStatements(db, subject),
  ];
};
