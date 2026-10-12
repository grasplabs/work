import { actorOf } from "@grasp-os/shared/audit";
import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appFor } from "../apps.ts";
import { auditedBatch, outboxedIfChanged } from "../audit-outbox.ts";
import { activeMember } from "../auth/auth.ts";
import { apps, appVersions, users, workflowOwners } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";

// Who owns a workflow: the person who answers for it. They are shown with
// it (the Workflows page, its view) and told when a run a trigger started
// fails (runs.ts). A workflow nobody set an owner for is owned by its
// App's owner. The owner never changes whom a run acts for: that stays
// the person who started it, or the App's owner (decision on GRA-398).
//
// Admins and the App's builders set it, to a current member of the
// organization, audited as `workflow.owner.updated`. Grasp staff don't:
// who answers for a client's workflow is the client's decision. The row
// is kept by App and workflow ID, so it holds across versions, as
// parameter values do.

/** A workflow's owner, as the lists show them. */
export interface WorkflowOwner {
  userId: string;
  name: string | null;
}

/** A key of an App's workflow, for looking its owner up. */
const keyOf = (app: string, workflow: string): string =>
  JSON.stringify([app, workflow]);

/**
 * The owners set for the workflows of the Apps `appIds`, by App workflow
 * (`ownerKey`): one read of the rows that start with those Apps. A
 * workflow without one is owned by its App's owner, which isn't here.
 */
export const ownersSet = async (
  env: Env,
  appIds: readonly string[]
): Promise<Map<string, WorkflowOwner>> => {
  if (appIds.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({
      app: workflowOwners.appId,
      workflow: workflowOwners.workflowId,
      userId: workflowOwners.ownerId,
      name: users.name,
    })
    .from(workflowOwners)
    .leftJoin(users, eq(users.id, workflowOwners.ownerId))
    .where(inList(workflowOwners.appId, appIds));
  return new Map(
    rows.map(({ app, workflow, userId, name }) => [
      keyOf(app, workflow),
      { userId, name },
    ])
  );
};

/** The key `ownersSet` holds an App workflow's owner by. */
export const ownerKey = keyOf;

const ownerInputSchema = z.string().min(1).max(256);

/**
 * Makes `owner` the owner of workflow `workflow` of App `app`'s current
 * version, for an admin or a builder of the App; not Grasp staff. The
 * owner must be a current member of the organization when the write
 * runs, or `workflow.owner_invalid`. The change and its audit event are
 * one batch.
 */
export const setWorkflowOwner = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  owner: unknown
): Promise<{ app: AppId; workflow: WorkflowId }> => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const found = await appFor(env, by, app, "builder");
  const workflowId = workflowErrors.parse(
    "workflow.invalid",
    workflowIdSchema,
    workflow
  );
  const ownerId = workflowErrors.parse(
    "workflow.invalid",
    ownerInputSchema,
    owner
  );
  const db = drizzle(env.DB);
  const [current, previous] = await Promise.all([
    found.currentVersion === null
      ? undefined
      : db
          .select({ workflows: appVersions.workflows })
          .from(appVersions)
          .where(
            and(
              eq(appVersions.appId, found.id),
              eq(appVersions.version, found.currentVersion)
            )
          )
          .get(),
    db
      .select({ ownerId: workflowOwners.ownerId })
      .from(workflowOwners)
      .where(
        and(
          eq(workflowOwners.appId, found.id),
          eq(workflowOwners.workflowId, workflowId)
        )
      )
      .get(),
  ]);
  if (current?.workflows.includes(workflowId) !== true) {
    throw workflowErrors.create("workflow.not_found");
  }
  const [set] = await auditedBatch(env, db, [
    db
      .insert(workflowOwners)
      .select(
        sql`SELECT ${found.id}, ${workflowId}, ${ownerId}, ${by.userId}, ${Date.now()}
          WHERE ${activeMember(ownerId)}
            AND EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${found.id})`
      )
      .onConflictDoUpdate({
        target: [workflowOwners.appId, workflowOwners.workflowId],
        set: {
          ownerId: sql`excluded.owner_id`,
          setBy: sql`excluded.set_by`,
          setAt: sql`excluded.set_at`,
        },
      })
      .returning({ ownerId: workflowOwners.ownerId }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "workflow.owner.updated",
      target: { type: "app", id: found.id },
      detail: {
        workflow: workflowId,
        owner: ownerId,
        previous: previous?.ownerId ?? found.owner,
      },
    }),
  ]);
  if (set.length === 0) {
    throw workflowErrors.create("workflow.owner_invalid");
  }
  return { app: found.id, workflow: workflowId };
};

/**
 * Who owns App `app`'s workflow `workflow` now: the person set, or the
 * App's owner. Whom a run's failure is told to (runs.ts).
 */
export const ownerOf = async (
  env: Env,
  app: AppId,
  workflow: string
): Promise<string> => {
  const row = await drizzle(env.DB)
    .select({ ownerId: workflowOwners.ownerId, appOwner: apps.ownerId })
    .from(apps)
    .leftJoin(
      workflowOwners,
      and(
        eq(workflowOwners.appId, apps.id),
        eq(workflowOwners.workflowId, workflow)
      )
    )
    .where(eq(apps.id, app))
    .get();
  if (row === undefined) {
    throw workflowErrors.create("workflow.not_found");
  }
  return row.ownerId ?? row.appOwner;
};
