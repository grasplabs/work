import { appChangesSchema, appErrors } from "@grasp-os/shared/apps";
import type { App, AppMemberRef } from "@grasp-os/shared/apps";
import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { appFor, toApp } from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/auth.ts";
import { appMembers, apps, teamMembers, teams } from "./db/core/schema.ts";
import { indexAppNow } from "./knowledge/apps-collection.ts";
import { requireNotStaff } from "./sharing.ts";
import { openTo } from "./workflows/owners.ts";

// An App's settings besides its code: its name and description, who
// answers for it, whom it is made for, and the business process it serves
// (GRA-511), which the UI shows its icon for and groups it by. Its builders change them, and
// each change is audited as `app.updated`, naming what changed: the
// people and teams by ID, the name and description only as changed, since
// the log holds no content.
//
// Who answers for an App (`responsible`) is not its owner. The owner
// created it and is whom its triggered runs act for and whose personal
// connections its event triggers listen on, so changing them would hand
// the App's reach to someone else; that never changes here. Who answers
// for it, like a workflow's owner (workflows/owners.ts), only says whom to
// ask: a current member of the organization who can open the App when
// named. Whom it is made for grants nothing either: whom it is open to is
// its members (app-members.ts). Naming either is the client's decision,
// so Grasp staff don't, as they don't share Apps.

/** That the column holds `value`, null included, as SQL. */
const holds = (column: SQLiteColumn, value: string | null): SQL =>
  sql`${column} IS ${value}`;

/** That `audience` is a member or a team of the organization now, as SQL. */
const ofOrganization = (audience: AppMemberRef): SQL =>
  audience.type === "team"
    ? sql`EXISTS (SELECT 1 FROM ${teams} WHERE ${teams.id} = ${audience.id} AND ${teams.organizationId} = ${organizationId})`
    : activeMember(audience.id);

/** `app.audience_invalid` unless `audience` is of the organization now. */
const requireAudience = async (
  env: Env,
  audience: AppMemberRef
): Promise<void> => {
  const found = await drizzle(env.DB).get<{ ok: number } | undefined>(
    sql`SELECT 1 AS ok WHERE ${ofOrganization(audience)}`
  );
  if (found === undefined) {
    throw appErrors.create("app.audience_invalid");
  }
};

/**
 * That `userId` may answer for `app` now, as SQL: a current member of the
 * organization who can open it (`openTo`) as its status lets them
 * (app-access.ts). A draft or an archived App is open only to whoever
 * builds it: an admin, or a builder by role in the organization who owns
 * it or with whom it is shared as a builder, as a person or through a
 * team.
 */
const mayAnswer = (userId: string, app: string): SQL => sql`(
  ${activeMember(userId)} AND ${openTo(userId, app)}
  AND (
    EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${app} AND ${apps.status} = 'published')
    OR ${activeMember(userId, ["admin"])}
    OR (${activeMember(userId, ["builder"])} AND (
      EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${app} AND ${apps.ownerId} = ${userId})
      OR EXISTS (
        SELECT 1 FROM ${appMembers}
        WHERE ${appMembers.appId} = ${app} AND ${appMembers.role} = 'builder'
          AND ((${appMembers.memberType} = 'person' AND ${appMembers.memberId} = ${userId})
            OR (${appMembers.memberType} = 'team' AND ${appMembers.memberId} IN (
              SELECT ${teamMembers.teamId} FROM ${teamMembers}
              WHERE ${teamMembers.userId} = ${userId})))
      )
    ))
  )
)`;

/**
 * `app.responsible_invalid` unless `userId` is a current member of the
 * organization who can open `app` now (`openTo`).
 */
const requireResponsible = async (
  env: Env,
  app: string,
  userId: string
): Promise<void> => {
  const found = await drizzle(env.DB).get<{ ok: number } | undefined>(
    sql`SELECT 1 AS ok WHERE ${mayAnswer(userId, app)}`
  );
  if (found === undefined) {
    throw appErrors.create("app.responsible_invalid");
  }
};

/** What an update writes, what it must still find, and what its event says. */
interface Plan {
  set: Partial<typeof apps.$inferInsert>;
  guards: SQL[];
  detail: Record<string, AuditDetailValue>;
}

type Changes = ReturnType<typeof appChangesSchema.parse>;
type Row = typeof apps.$inferSelect;

/** The name and description, where they change. */
const planText = (plan: Plan, row: Row, changes: Changes): void => {
  if (changes.name !== undefined && changes.name !== row.name) {
    plan.set.name = changes.name;
    plan.guards.push(holds(apps.name, row.name));
    plan.detail.name = true;
  }
  if (
    changes.description !== undefined &&
    changes.description !== row.description
  ) {
    plan.set.description = changes.description;
    plan.guards.push(holds(apps.description, row.description));
    plan.detail.description = true;
  }
};

/**
 * Who answers for it, where that changes, once they qualify (`mayAnswer`):
 * its owner too, whom being its owner doesn't qualify once they were
 * removed from the organization or can no longer open it as it is. Its
 * owner is kept as none.
 */
const planResponsible = async (
  env: Env,
  plan: Plan,
  row: Row,
  responsible: string
): Promise<void> => {
  const responsibleId = responsible === row.ownerId ? null : responsible;
  if (responsibleId === row.responsibleId) {
    return;
  }
  await requireResponsible(env, row.id, responsible);
  plan.guards.push(mayAnswer(responsible, row.id));
  plan.set.responsibleId = responsibleId;
  plan.guards.push(holds(apps.responsibleId, row.responsibleId));
  plan.detail.responsible = responsible;
  plan.detail.previousResponsible = row.responsibleId ?? row.ownerId;
};

/** Whom it is made for, where that changes, once they are of the organization. */
const planAudience = async (
  env: Env,
  plan: Plan,
  row: Row,
  audience: AppMemberRef | null
): Promise<void> => {
  // None is null on both sides: clearing what is clear changes nothing.
  if (
    (audience?.type ?? null) === row.audienceType &&
    (audience?.id ?? null) === row.audienceId
  ) {
    return;
  }
  if (audience !== null) {
    await requireAudience(env, audience);
    plan.guards.push(ofOrganization(audience));
  }
  plan.set.audienceType = audience?.type ?? null;
  plan.set.audienceId = audience?.id ?? null;
  plan.guards.push(
    holds(apps.audienceType, row.audienceType),
    holds(apps.audienceId, row.audienceId)
  );
  plan.detail.audienceType = audience?.type ?? null;
  plan.detail.audience = audience?.id ?? null;
  plan.detail.previousAudienceType = row.audienceType;
  plan.detail.previousAudience = row.audienceId;
};

/**
 * The business process it serves, where that changes. Grasp's staff may
 * set it too: it names nobody and grants nothing, and Grasp assigns it as
 * it maps a client's work.
 */
const planProcess = (
  plan: Plan,
  row: Row,
  process: BusinessProcess | null
): void => {
  if (process === row.process) {
    return;
  }
  plan.set.process = process;
  plan.guards.push(holds(apps.process, row.process));
  plan.detail.process = process;
  plan.detail.previousProcess = row.process;
};

/**
 * Changes App `app`'s settings, for its builders. Settings given as they
 * are already change and record nothing. The write goes through only
 * while what it changes is still what was read, and while whoever answers
 * for it and whom it is made for still qualify, or `app.conflict`; the
 * change and its audit event are one batch.
 */
export const updateApp = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown
): Promise<App> => {
  const found = await appFor(env, by, app, "builder");
  const changes = appErrors.parse("app.invalid", appChangesSchema, input);
  const db = drizzle(env.DB);
  const row = await db.select().from(apps).where(eq(apps.id, found.id)).get();
  if (row === undefined) {
    throw appErrors.create("app.not_found");
  }
  // Naming people is the client's decision.
  if (changes.responsible !== undefined || changes.audience !== undefined) {
    requireNotStaff(by);
  }
  const plan: Plan = { set: {}, guards: [], detail: {} };
  planText(plan, row, changes);
  if (changes.responsible !== undefined) {
    await planResponsible(env, plan, row, changes.responsible);
  }
  if (changes.audience !== undefined) {
    await planAudience(env, plan, row, changes.audience);
  }
  if (changes.process !== undefined) {
    planProcess(plan, row, changes.process);
  }
  if (plan.guards.length === 0) {
    return toApp(row);
  }
  const [updated] = await auditedBatch(env, db, [
    db
      .update(apps)
      .set(plan.set)
      // Removed meanwhile (app-removal.ts), it is left as removed.
      .where(and(eq(apps.id, found.id), isNull(apps.removedAt), ...plan.guards))
      .returning(),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "app.updated",
      target: { type: "app", id: found.id },
      detail: plan.detail,
    }),
  ]);
  const [after] = updated;
  if (after === undefined) {
    throw appErrors.create("app.conflict");
  }
  // Its entry in the Apps collection carries its name and description;
  // a failed indexing is left to the clock, which finds it stale.
  if (plan.set.name !== undefined || plan.set.description !== undefined) {
    await indexAppNow(env, after.id);
  }
  return toApp(after);
};
