import {
  dependencyErrors,
  dependencySubjectRefSchema,
  subjectOfRef,
} from "@grasp-os/shared/dependencies";
import type {
  DependencySubject,
  NamedDependencySubject,
} from "@grasp-os/shared/dependencies";
import { roleErrors } from "@grasp-os/shared/roles";
import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appFor, editableApp } from "../apps.ts";
import type { Acting } from "../auth/identity.ts";
import { activeMember } from "../auth/membership-sql.ts";
import { appMembers, apps, members, teamMembers } from "../db/core/schema.ts";
import { rowsOf } from "../sharing.ts";

// Whose packages a request is (an App), and who builds it: who may ask
// for its packages, decide them, and is told when the clock finds
// something wrong with them.

/** The subject a caller names (`{ app }`), or `dependency.invalid`. */
export const subjectOfInput = (input: unknown): DependencySubject =>
  subjectOfRef(
    dependencyErrors.parse(
      "dependency.invalid",
      dependencySubjectRefSchema,
      input
    )
  );

/**
 * `subject`, for one of its builders, with its name: `app.not_found` for
 * anyone with no role in it, and `role.forbidden` for one who only uses it
 * or is Grasp staff. With `change`, for asking for its packages, an
 * archived App refuses (`app.archived`).
 */
export const builtSubject = async (
  env: Env,
  by: Acting,
  subject: DependencySubject,
  change = false
): Promise<NamedDependencySubject> => {
  // Grasp staff neither ask for nor decide what a client's Apps may use,
  // whatever role their session carries.
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const { id, name } = change
    ? await editableApp(env, by, subject.id)
    : await appFor(env, by, subject.id, "builder");
  return { type: "app", id, name };
};

/**
 * That `by` builds `subject` as the statement runs, as SQL: an active
 * admin of the organization, or an active member whose role builds and
 * who owns it or with whom it is shared as a builder (as a person, a team
 * or a project), as `builtSubject` decides it. What a decision's write
 * requires, so a role taken away while it waited decides nothing.
 */
export const buildsNowSql = (subject: DependencySubject, by: Acting): SQL => {
  const owned = sql`EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${subject.id} AND ${apps.ownerId} = ${by.userId} AND ${apps.removedAt} IS NULL)`;
  const shared = sql`EXISTS (SELECT 1 FROM ${appMembers} WHERE ${appMembers.appId} = ${subject.id} AND ${appMembers.role} = 'builder' AND ${rowsOf(appMembers, by)})`;
  return sql`(${activeMember(by.userId, ["admin"])}
    OR (${activeMember(by.userId, ["builder", "admin"])} AND (${owned} OR ${shared})))`;
};

/**
 * The members who build `subject` now, whom the clock tells what it found
 * of its packages: its owner and whom it is shared with as a builder, as
 * a person or through a team, whose role in the organization builds.
 */
export const buildersOf = async (
  env: Env,
  subject: DependencySubject
): Promise<string[]> => {
  const shared = sql`SELECT ${apps.ownerId} AS person FROM ${apps} WHERE ${apps.id} = ${subject.id} AND ${apps.removedAt} IS NULL
      UNION SELECT ${appMembers.memberId} FROM ${appMembers} WHERE ${appMembers.appId} = ${subject.id} AND ${appMembers.role} = 'builder' AND ${appMembers.memberType} = 'person'
      UNION SELECT ${teamMembers.userId} FROM ${appMembers} INNER JOIN ${teamMembers} ON ${teamMembers.teamId} = ${appMembers.memberId} WHERE ${appMembers.appId} = ${subject.id} AND ${appMembers.role} = 'builder' AND ${appMembers.memberType} = 'team'`;
  const builders = sql.raw("builders");
  const rows = await drizzle(env.DB).all<{ person: string }>(
    sql`WITH ${builders} AS (${shared})
      SELECT person FROM ${builders} WHERE EXISTS (SELECT 1 FROM ${members} WHERE ${members.userId} = ${builders}.person AND ${members.role} IN ('builder', 'admin'))`
  );
  return rows.map(({ person }) => person);
};

/** The name of `subject` now. */
export const subjectName = async (
  env: Env,
  subject: DependencySubject
): Promise<string> => {
  const row = await drizzle(env.DB)
    .select({ name: apps.name })
    .from(apps)
    .where(eq(apps.id, subject.id))
    .get();
  return row?.name ?? "";
};
