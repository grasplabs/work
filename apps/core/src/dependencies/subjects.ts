import {
  dependencyErrors,
  dependencySubjectRefSchema,
  subjectOfRef,
} from "@grasp-os/shared/dependencies";
import type { DependencySubject } from "@grasp-os/shared/dependencies";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { apps, workflowResources } from "../db/core/schema.ts";

// Whose packages a request, an approval, a lock or a build is: an App, or
// an independent workflow resource, whose compute modules may use only
// the `computation` target (GRA-665). The same approvers decide both, in
// the same queue; an approval is its subject's alone, so an App's covers
// no workflow, and a workflow's no App. Who may ask is the subject's own
// builders (subject-builders.ts). Nothing here reads who someone is, so
// the workflow registry can use it without a cycle.

/** The columns of a table's subject (`subject_type`, `subject_id`). */
interface SubjectColumns {
  subjectType: SQLiteColumn;
  subjectId: SQLiteColumn;
}

/** That a row of `table` is `subject`'s, as SQL. */
export const ofSubject = (
  table: SubjectColumns,
  subject: DependencySubject
): SQL =>
  // Never on the ID alone: and() of two conditions is never undefined,
  // and should it be, nothing matches.
  and(eq(table.subjectType, subject.type), eq(table.subjectId, subject.id)) ??
  sql`0`;

/** A subject's key, for maps of them. */
export const subjectKey = (subject: DependencySubject): string =>
  `${subject.type}:${subject.id}`;

/** The subject of a row's `subjectType` and `subjectId`. */
export const subjectOfRow = (row: {
  subjectType: DependencySubject["type"];
  subjectId: string;
}): DependencySubject => ({ type: row.subjectType, id: row.subjectId });

/**
 * What the audit log names a subject as: an App, or a workflow resource,
 * as every other event of either does.
 */
export const auditTargetOf = (
  subject: DependencySubject
): { type: "app" | "workflow_resource"; id: string } => ({
  type: subject.type === "app" ? "app" : "workflow_resource",
  id: subject.id,
});

/**
 * The subject a caller names (`{ app }` or `{ workflow }`), or
 * `dependency.invalid` for anything else.
 */
export const subjectOfInput = (input: unknown): DependencySubject =>
  subjectOfRef(
    dependencyErrors.parse(
      "dependency.invalid",
      dependencySubjectRefSchema,
      input
    )
  );

/** The names of `subjects` now, by `subjectKey`; one that is gone has none. */
export const subjectNames = async (
  db: DrizzleD1Database,
  subjects: readonly DependencySubject[]
): Promise<Map<string, string>> => {
  const appIds = [
    ...new Set(
      subjects.filter(({ type }) => type === "app").map(({ id }) => id)
    ),
  ];
  const workflowIds = [
    ...new Set(
      subjects.filter(({ type }) => type === "workflow").map(({ id }) => id)
    ),
  ];
  const [appRows, workflowRows] = await Promise.all([
    appIds.length === 0
      ? []
      : db
          .select({ id: apps.id, name: apps.name })
          .from(apps)
          .where(inArray(apps.id, appIds)),
    workflowIds.length === 0
      ? []
      : db
          .select({
            id: workflowResources.id,
            name: workflowResources.name,
            deletedAt: workflowResources.deletedAt,
          })
          .from(workflowResources)
          .where(inArray(workflowResources.id, workflowIds)),
  ]);
  return new Map([
    ...appRows.map(({ id, name }): [string, string] => [`app:${id}`, name]),
    // A deleted workflow says so: its name may have been released to a
    // new workflow (GRA-562), which the subject isn't.
    ...workflowRows.map(({ id, name, deletedAt }): [string, string] => [
      `workflow:${id}`,
      deletedAt === null ? name : `${name} (deleted)`,
    ]),
  ]);
};
