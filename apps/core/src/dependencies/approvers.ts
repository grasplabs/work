import type { AuditEntry } from "@grasp-os/shared/audit";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import {
  dependencyApproverSubjectSchema,
  dependencyErrors,
} from "@grasp-os/shared/dependencies";
import type {
  DependencyApprover,
  DependencyApproverSubject,
} from "@grasp-os/shared/dependencies";
import { identifierSchema } from "@grasp-os/shared/ids";
import { requireAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
} from "../audit-outbox.ts";
import { activeMember, organizationId } from "../auth/auth.ts";
import { permissions, teamMembers, teams, users } from "../db/core/schema.ts";
import { isUniqueViolation } from "../db/d1.ts";
import {
  requireMemberAdmin,
  requireStillAdmin,
  stillAdmin,
} from "../permissions.ts";
import { advancePolicy } from "./policy.ts";

// `dependencies.approve`: who may approve npm packages for Apps. It is a
// permission like any other, a row in `permissions` that an admin of the
// organization grants and revokes, audited as `permission.granted` and
// `permission.revoked`; only its holder differs: a member or a team,
// never an App or an agent. What could go wrong, and what stops it:
//
// - A role standing in for it. No role gives it: an admin or a builder
//   holds it only by a row of their own (an admin may grant themselves
//   one), and the check reads rows, never roles (`holdsApproveSql`).
// - Grasp staff deciding a client's dependencies. Staff neither grant,
//   revoke nor hold it, as for every other permission.
// - An agent, a workflow or App code granting it, or asking for it.
//   Nothing they reach leads here: this is only on a person's own `/rpc`
//   session, and the permissions API they do reach takes an App's
//   permissions only (permissions.ts).
// - Someone who lost it, left, or was taken off the team, still deciding.
//   Whether a person holds it is part of the one update that takes their
//   decision (requests.ts), read then, from the rows as they are.
// - A grant or revoke by someone demoted meanwhile. That they are still
//   an admin is part of the statement that grants or revokes.
// - A decision or a build going by who held it before a change. Each
//   grant and revoke moves the policy generation on in its own batch
//   (policy.ts).

type Row = typeof permissions.$inferSelect;

/** What fills the columns every permission has, for this one. */
const objectType = "dependencies";
const action = "approve";
const binding = "DEPENDENCIES_APPROVE";

/** The rows that are `dependencies.approve`, as a condition. */
const isApprover = and(
  eq(permissions.objectType, objectType),
  inArray(permissions.subjectType, ["person", "team"])
);

const subjectIdOf = (subject: DependencyApproverSubject): string =>
  subject.type === "person" ? subject.userId : subject.teamId;

const subjectOf = (row: Row): DependencyApproverSubject =>
  row.subjectType === "team"
    ? { type: "team", teamId: row.subjectId }
    : { type: "person", userId: row.subjectId };

/**
 * That `userId` holds `dependencies.approve` now, as SQL: an active member
 * of the organization with an active grant of their own, or of a team of
 * the organization they are in. Part of the statement that takes a
 * decision, so it is read as the decision lands.
 */
export const holdsApproveSql = (userId: string): SQL => sql`(
  ${activeMember(userId)}
  AND EXISTS (
    SELECT 1 FROM ${permissions}
    WHERE ${permissions.objectType} = ${objectType}
      AND ${permissions.status} = 'active'
      AND (
        (${permissions.subjectType} = 'person' AND ${permissions.subjectId} = ${userId})
        OR (
          ${permissions.subjectType} = 'team'
          AND EXISTS (
            SELECT 1 FROM ${teamMembers}
            INNER JOIN ${teams} ON ${teams.id} = ${teamMembers.teamId}
            WHERE ${teamMembers.teamId} = ${permissions.subjectId}
              AND ${teamMembers.userId} = ${userId}
              AND ${teams.organizationId} = ${organizationId}
          )
        )
      )
  )
)`;

/** Whether `by` holds `dependencies.approve` now; never Grasp staff. */
export const holdsApprove = async (
  env: Env,
  by: Pick<Identity, "userId" | "staff">
): Promise<boolean> => {
  if (by.staff) {
    return false;
  }
  const row = await drizzle(env.DB).get<{ holds: number }>(
    sql`SELECT ${holdsApproveSql(by.userId)} AS holds`
  );
  return row.holds !== 0;
};

/** That the member or team `subject` names is there now, as SQL. */
const subjectExists = (subject: DependencyApproverSubject): SQL =>
  subject.type === "person"
    ? activeMember(subject.userId)
    : sql`EXISTS (
        SELECT 1 FROM ${teams}
        WHERE ${teams.id} = ${subject.teamId}
          AND ${teams.organizationId} = ${organizationId}
      )`;

/** The audit entry of a grant or revoke: identifiers only. */
const entry = (
  by: Identity,
  change: "permission.granted" | "permission.revoked",
  row: Pick<Row, "id" | "subjectType" | "subjectId">
): AuditEntry => ({
  actor: actorOf(by),
  action: change,
  target: { type: "permission", id: row.id },
  detail: {
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    objectType,
    actions: action,
  },
});

const withNames = async (
  env: Env,
  rows: Row[]
): Promise<DependencyApprover[]> => {
  const idsOf = (type: Row["subjectType"]): string[] =>
    rows.filter((row) => row.subjectType === type).map((row) => row.subjectId);
  const db = drizzle(env.DB);
  const people = idsOf("person");
  const groups = idsOf("team");
  const [named, teamsNamed] = await Promise.all([
    people.length === 0
      ? []
      : db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, people)),
    groups.length === 0
      ? []
      : db
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(inArray(teams.id, groups)),
  ]);
  const names = new Map(
    [...named, ...teamsNamed].map(({ id, name }) => [id, name])
  );
  return rows.map((row) => ({
    id: row.id,
    subject: subjectOf(row),
    name: names.get(row.subjectId) ?? null,
    status: row.status === "active" ? "active" : "revoked",
    grantedBy: row.grantedBy ?? row.requestedBy,
    grantedAt: (row.grantedAt ?? row.requestedAt).toISOString(),
    revokedBy: row.revokedBy,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
};

const one = async (env: Env, row: Row): Promise<DependencyApprover> => {
  const [approver] = await withNames(env, [row]);
  if (approver === undefined) {
    throw new Error(`Approver ${row.id} is missing`);
  }
  return approver;
};

/** Everyone who holds or held `dependencies.approve`, oldest first. Admins only. */
export const listApprovers = async (
  env: Env,
  by: Identity
): Promise<DependencyApprover[]> => {
  requireAdmin(by);
  const rows = await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(isApprover)
    .orderBy(asc(permissions.requestedAt), asc(permissions.id));
  return await withNames(env, rows);
};

/** The subject's live grant, if it has one. */
const liveGrant = async (
  env: Env,
  subject: DependencyApproverSubject
): Promise<Row | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(
      and(
        isApprover,
        eq(permissions.subjectType, subject.type),
        eq(permissions.subjectId, subjectIdOf(subject)),
        eq(permissions.status, "active")
      )
    )
    .get();

/**
 * Gives a member or a team `dependencies.approve`: one insert that lands
 * only while `by` is still an admin and the member or team is there, in
 * the batch that records it and moves the policy generation on. Giving it
 * to someone who holds it changes and records nothing.
 */
export const grantApprover = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<DependencyApprover> => {
  requireMemberAdmin(by);
  const subject = dependencyErrors.parse(
    "dependency.invalid",
    dependencyApproverSubjectSchema,
    input
  );
  const held = await liveGrant(env, subject);
  if (held) {
    return await one(env, held);
  }
  const id = crypto.randomUUID();
  const subjectId = subjectIdOf(subject);
  const now = Date.now();
  const event = createAuditEvent(
    entry(by, "permission.granted", {
      id,
      subjectType: subject.type,
      subjectId,
    }),
    "core"
  );
  const db = drizzle(env.DB);
  try {
    const [[granted]] = await auditedBatch(env, db, [
      db
        .insert(permissions)
        // Every column, in the table's order.
        .select(
          sql`SELECT ${id}, ${subject.type}, ${subjectId}, ${objectType}, ${objectType}, NULL, ${JSON.stringify([action])}, ${binding}, 'active', ${by.userId}, ${now}, ${by.userId}, ${now}, NULL, NULL, NULL WHERE ${stillAdmin(by)} AND ${subjectExists(subject)}`
        )
        .returning(),
      outboxedEventWhere(db, event, sql`changes() > 0`),
      advancePolicy(db, storedEvent(event.id)),
    ]);
    if (granted) {
      return await one(env, granted);
    }
  } catch (error) {
    // Someone gave it to them at the same moment: that grant stands.
    const raced = isUniqueViolation(error)
      ? await liveGrant(env, subject)
      : undefined;
    if (!raced) {
      throw error;
    }
    return await one(env, raced);
  }
  await requireStillAdmin(env, by);
  throw dependencyErrors.create("dependency.invalid", {
    issues: [`subject: There's no such ${subject.type}.`],
  });
};

/**
 * Revokes a grant: its holder's next decision is refused. What they
 * approved before stays approved; each approval is a decision of its own.
 * Revoking one already revoked changes and records nothing.
 */
export const revokeApprover = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<DependencyApprover> => {
  requireMemberAdmin(by);
  const id = identifierSchema.safeParse(input);
  const db = drizzle(env.DB);
  const found = id.success
    ? await db
        .select()
        .from(permissions)
        .where(and(isApprover, eq(permissions.id, id.data)))
        .get()
    : undefined;
  if (!found) {
    throw dependencyErrors.create("dependency.not_found");
  }
  const event = createAuditEvent(
    entry(by, "permission.revoked", found),
    "core"
  );
  const [[revoked]] = await auditedBatch(env, db, [
    db
      .update(permissions)
      .set({ status: "revoked", revokedBy: by.userId, revokedAt: new Date() })
      .where(
        and(
          isApprover,
          eq(permissions.id, found.id),
          eq(permissions.status, "active"),
          stillAdmin(by)
        )
      )
      .returning(),
    outboxedEventWhere(db, event, sql`changes() > 0`),
    advancePolicy(db, storedEvent(event.id)),
  ]);
  if (revoked) {
    return await one(env, revoked);
  }
  await requireStillAdmin(env, by);
  // Already revoked: nothing changed, and nothing is recorded.
  const now = await db
    .select()
    .from(permissions)
    .where(eq(permissions.id, found.id))
    .get();
  return await one(env, now ?? found);
};
