import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appFor } from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  appIntegrations,
  appMembers,
  appResourceBindings,
  appWorkflowBindings,
  apps,
  permissions,
} from "./db/core/schema.ts";
import { forgetAppEntry } from "./knowledge/apps-collection.ts";
import { requireNotStaff } from "./sharing.ts";
import {
  stopsUnsettled,
  stopsUnsettledSql,
} from "./workflows/resource-runs.ts";

// Removing an App (GRA-1120): what the settings page's "Remove app" and the
// Apps sidebar's row menu ask core for. The App goes; what it doesn't own
// stays: its stores and their records (whose owner claim it keeps for
// good, so a store never comes to serve another owner, spec 40.8),
// independently owned workflows, and what runs elsewhere still pin.
//
// A removed App is a tombstone: its row stays, with when it was removed
// and by whom, so the eighteen tables that name it (audit targets,
// receipts, a store's owner claim) stay history; it answers nothing
// (`findApp`, `appsFoundBy`, `stillOpenTo`: `app.not_found`, as an App
// that isn't there), and its ID, random, is never minted again.
//
// Threat model, and how each is closed:
//
// - Removing without the right: only the App's owner, while they build it,
//   or one of the organization's admins, and never Grasp staff (whether a
//   client's App is destroyed is the client's decision), read for this
//   call. A builder who isn't its owner: `role.forbidden`; anyone without
//   a role in it: `app.not_found`.
// - Running work outliving it: it must be archived first (its triggers
//   stopped, its unfinished runs cancelled, app-status.ts), and is refused
//   while the stops of runs it started are still settling
//   (`app.stops_pending`): checked against the archive the removal read,
//   and again by its write, which lands only over that archive with no
//   stop settling. The cron trigger goes on cancelling a removed App's
//   runs, as any archived App's (`cancelArchivedRuns`).
// - A removed App reached afterwards: every way to an App reads it through
//   `findApp` or the SQL forms beside it, which refuse a removed one; and
//   it is archived, which already serves nobody.
// - A write that read it before its removal and lands after (a grant, a
//   request, a binding, a member, a version, a run, a change to the App
//   itself): refused by the database (migration 0155's triggers), in one
//   place for every writer, now and later, and answered `app.not_found`
//   (`auditedBatch`). Every table naming an App is classified there,
//   refusing or open on purpose (removed-app-guard.test.ts). Only ending
//   things stays open: revoking, deleting, and the cron trigger
//   cancelling its runs.
// - Grants outliving it: in the batch that removes it, the permissions it
//   held, and other Apps' and agents' permissions on its exports, are
//   revoked; its resource bindings revoked; its workflow bindings
//   removed; its members and the integrations added to it by hand gone.
//   Every call path refuses an archived App anyway.
// - Destroying what it doesn't own: no statement here touches a store, a
//   store's owner claim, its default store's row, or a workflow resource.
//   Its releases go only as release retention reaps them: its current and
//   pending versions are cleared, and retention keeps what a live run
//   still pins.
// - A race with a restore, or a second removal: the removal writes only
//   over the App still archived, as read (its status's last change), and
//   not removed; the rest of its batch only once that write made it
//   removed. Otherwise nothing is written or recorded, and it is refused
//   (`app.conflict`). A restore that read it archived before the removal
//   writes only over an App not removed (app-status.ts), so it is refused
//   in turn, never undoing the removal.
// - What it was, kept where people search: its Apps-collection entry
//   (its name, description and AGENTS.md) is replaced by a tombstone and
//   read by nobody, admins included (app-entries.ts).
// - Its default store's records stuck: a removed App has no builders, so
//   the organization's own admins, never Grasp staff, read, export and
//   delete its default store (data-stores.ts, `managedBy`); the store's
//   owner claim stays.
// - Held actions waiting for ever: those it made in connect, which nobody
//   can confirm now, are declined as expired, recorded by connect
//   (`connection.action.expired`, reason `app.removed`).
// - Going unrecorded: `app.removed`, naming who and the App, is written in
//   the batch, only if the App was removed by it.

/** That App `app` is removed, when the statement runs. */
const removedSql = (app: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${app} AND ${apps.removedAt} IS NOT NULL)`;

/**
 * Removes the archived App `input` names, for its owner or an admin of
 * the organization, never Grasp staff (see the header). Answers nothing.
 */
export const removeApp = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const found = await appFor(env, by, input, "builder");
  if (found.owner !== by.userId && !isAdmin(by.role)) {
    throw appErrors.create("app.remove_forbidden");
  }
  const db = drizzle(env.DB);
  // Its status, and when that last changed, read before anything is
  // checked against it: the stops below are this very archive's, and the
  // batch writes only over it, so a restore, new work and another archive
  // meanwhile is a conflict, never a removal whose stops went unchecked.
  const fence = await db
    .select({ status: apps.status, at: apps.statusChangedAt })
    .from(apps)
    .where(eq(apps.id, found.id))
    .get();
  if (fence?.status !== "archived") {
    throw appErrors.create("app.remove_unarchived");
  }
  if (await stopsUnsettled(env, found.id)) {
    throw appErrors.create("app.stops_pending");
  }
  const now = new Date();
  const gone = removedSql(found.id);
  const [[removed]] = await auditedBatch(env, db, [
    db
      .update(apps)
      .set({
        removedAt: now,
        removedBy: by.userId,
        // Retention reaps its releases, but what a live run still pins.
        currentVersion: null,
        pendingVersion: null,
      })
      .where(
        and(
          eq(apps.id, found.id),
          eq(apps.status, "archived"),
          isNull(apps.removedAt),
          sql`${apps.statusChangedAt} IS ${fence.at?.getTime() ?? null}`,
          // And none settling still, read where the removal lands: a stop
          // claimed since the check above waits as one before it did.
          sql`NOT ${stopsUnsettledSql(found.id)}`
        )
      )
      .returning({ id: apps.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "app.removed",
      target: { type: "app", id: found.id },
      detail: { name: found.name },
    }),
    db
      .update(permissions)
      .set({ status: "revoked", revokedBy: by.userId, revokedAt: now })
      .where(
        and(
          ne(permissions.status, "revoked"),
          or(
            and(
              eq(permissions.subjectType, "app"),
              eq(permissions.subjectId, found.id)
            ),
            and(
              eq(permissions.objectType, "app"),
              eq(permissions.objectId, found.id)
            )
          ),
          gone
        )
      ),
    db
      .update(appResourceBindings)
      .set({ status: "revoked", revokedBy: by.userId, revokedAt: now })
      .where(
        and(
          eq(appResourceBindings.appId, found.id),
          eq(appResourceBindings.status, "active"),
          gone
        )
      ),
    db
      .update(appWorkflowBindings)
      .set({ status: "removed", removedBy: by.userId, removedAt: now })
      .where(
        and(
          eq(appWorkflowBindings.appId, found.id),
          eq(appWorkflowBindings.status, "active"),
          gone
        )
      ),
    db.delete(appMembers).where(and(eq(appMembers.appId, found.id), gone)),
    db
      .delete(appIntegrations)
      .where(and(eq(appIntegrations.appId, found.id), gone)),
  ]);
  if (removed === undefined) {
    throw appErrors.create("app.conflict");
  }
  // Its Apps-collection entry: its name, description and AGENTS.md go.
  await forgetAppEntry(env, found.id);
  // Its held actions in connect, which nobody can confirm now, go as
  // expired ones do, recorded there. Best effort: confirming one checks
  // its binding, which is revoked, and refuses it all the same.
  try {
    await env.CONNECT.dropForRemovedApp({ appId: found.id });
  } catch (error) {
    log.warn("app.held_drop_failed", {
      appId: found.id,
      ...errorFields(error),
    });
  }
};
