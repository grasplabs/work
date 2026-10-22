import { appChangesSchema, appErrors } from "@grasp-os/shared/apps";
import type { App, AppMemberRef } from "@grasp-os/shared/apps";
import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { appFor, toApp } from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/auth.ts";
import { apps, teams } from "./db/core/schema.ts";
import { requireNotStaff } from "./sharing.ts";
import { openTo } from "./workflows/owners.ts";

// An App's settings besides its code: its name and description, who
// answers for it, and whom it is made for. Its builders change them, and
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

/** `app.audience_invalid` unless `audience` is a member or team of the organization now. */
const requireAudience = async (
  env: Env,
  audience: AppMemberRef
): Promise<void> => {
  const db = drizzle(env.DB);
  const found =
    audience.type === "team"
      ? await db
          .select({ id: teams.id })
          .from(teams)
          .where(
            and(
              eq(teams.id, audience.id),
              eq(teams.organizationId, organizationId)
            )
          )
          .get()
      : await db.get<{ member: number } | undefined>(
          sql`SELECT 1 AS member WHERE ${activeMember(audience.id)}`
        );
  if (found === undefined) {
    throw appErrors.create("app.audience_invalid");
  }
};

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
    sql`SELECT 1 AS ok WHERE ${activeMember(userId)} AND ${openTo(userId, app)}`
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
 * Who answers for it, where that changes, once they qualify: kept as none
 * for its owner, who always may.
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
  if (responsibleId !== null) {
    await requireResponsible(env, row.id, responsibleId);
    plan.guards.push(
      sql`${activeMember(responsibleId)} AND ${openTo(responsibleId, row.id)}`
    );
  }
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
  if (audience?.type === row.audienceType && audience?.id === row.audienceId) {
    return;
  }
  if (audience !== null) {
    await requireAudience(env, audience);
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
  if (plan.guards.length === 0) {
    return toApp(row);
  }
  const [updated] = await auditedBatch(env, db, [
    db
      .update(apps)
      .set(plan.set)
      .where(and(eq(apps.id, found.id), ...plan.guards))
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
  return toApp(after);
};
