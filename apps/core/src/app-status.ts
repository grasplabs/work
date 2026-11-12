import { appErrors } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { revocationsOf, tellKept } from "./access-revocations.ts";
import { appFor, toApp } from "./apps.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
} from "./audit-outbox.ts";
import { apps, appVisitorSessions } from "./db/core/schema.ts";
import { requireNotStaff } from "./sharing.ts";
import {
  stopRetryMs,
  stopRunsStartedBy,
  stopsUnsettled,
} from "./workflows/resource-runs.ts";

// Archiving an App, and restoring it: whether an App is archived is all
// of its status. An App is open to its builders alone until its first
// publish makes a version live (app-publish.ts), and from then on to
// everyone it is shared with too, unless archived: then nobody uses it,
// its builders included, and nothing of it runs.
//
// The rules are enforced where an App is reached, not here: only its
// builders and the admins have a role in an App with no live version or
// an archived one (app-access.ts); nobody uses an archived App
// (`usableApp`, apps.ts; `functionRoles`); only a live App's triggers
// fire (workflows/triggers.ts, connector-events.ts, inbound-email.ts),
// and no run of an archived App starts (`startRun`).
//
// Threats, and what stands against each:
// - Someone with only the user role reaching an App that isn't live, or
//   is archived, by a path that skips the role check: every path asks
//   `requireAppRole`, which reads the App's row with the role, or the SQL
//   forms beside it (`appsFoundBy`, `stillOpenTo`), so none has a path of
//   its own.
// - Learning that an App that isn't live exists: it is answered as an App
//   that isn't there (`app.not_found`), in lists and errors alike.
// - A trigger or run outliving the archive: archiving stops the
//   unfinished runs the App started (`stopRunsStartedBy`), the clock stops
//   any left or started in a race with it (`cancelArchivedRuns`), and a
//   start reads the App again once its row is written (`startRun`). A
//   restore waits for the stops still settling (`cancelledBeforeRestore`).
// - A change by someone who lost their role: the role is read for the
//   call, and the write only applies to the archive read (`app.conflict`
//   otherwise). Each is audited with the change itself.

/** When App `app` was archived, in ms; null while it isn't. */
const archivedAtOf = async (env: Env, app: string): Promise<number | null> => {
  const row = await drizzle(env.DB)
    .select({ at: apps.archivedAt })
    .from(apps)
    .where(eq(apps.id, app))
    .get();
  return row?.at?.getTime() ?? null;
};

/** Most runs of archived Apps one pass stops (`cancelArchivedRuns`). */
const archivedRunsPerPass = 50;

/** Most runs one page of a restore's cancels asks to cancel. */
const cancelPage = 50;

/** Most pages of cancels a restore asks for before it gives up for now. */
const maxCancelPages = 10;

/**
 * Finishes, before a restore, the cancels its archive still owes: every
 * unfinished run of the App not yet asked to cancel (a cancel that failed,
 * one the clock hadn't reached, or a start that overlapped the
 * archive's write), so none of them goes on as the App's again. While it
 * is archived nothing of it starts, so each is the archive's.
 */
const cancelledBeforeRestore = async (env: Env, app: App): Promise<void> => {
  const row = await drizzle(env.DB)
    .select({ by: apps.archivedBy })
    .from(apps)
    .where(eq(apps.id, app.id))
    .get();
  // Every run still unfinished is the archive's, up to now: one whose
  // start overlapped the archive's write was created after its time, and
  // runs started since a restore don't exist yet.
  const archivedAt = new Date();
  const by = row?.by ?? { userId: app.owner, staff: false };
  // A page at a time, until a page comes back short. A cancel that failed
  // refuses the restore: once restored, nothing would ask again, and the
  // run would go on as the App's (the clock asks while archived).
  let finished = false;
  for (let page = 0; page < maxCancelPages && !finished; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const { asked, failed } = await stopRunsStartedBy(
      env,
      actorOf(by),
      app.id,
      archivedAt,
      cancelPage
    );
    if (failed.length > 0) {
      // Which runs keep it archived, for whoever looks into the refusal.
      log.warn("app.restore_refused", {
        appId: app.id,
        runs: failed.join(","),
      });
      throw appErrors.create("app.conflict");
    }
    finished = asked < cancelPage;
  }
  if (!finished) {
    // Too many to finish in one call: the restore waits for the clock.
    throw appErrors.create("app.conflict");
  }
  // A short page proves every cancel was asked, not that every stop of a
  // run the App started was sent: a stop claimed by another pass, or by a
  // sender that died before sending, is skipped for `stopRetryMs`. Once
  // restored, no repair looks at the App's runs again, so such a run would
  // go on. So the restore waits until each claimed stop has ended its run,
  // the clock sending again any that was lost. Keeping a repair
  // alive across the restore instead would have to tell an archive's stops
  // apart from runs the restored App starts afresh.
  if (await stopsUnsettled(env, app.id)) {
    throw appErrors.create("app.stops_pending");
  }
};

/**
 * Archives the App `input` names (`archived`), or restores it, for one of
 * its builders: answered as it is when it is so already (nothing written
 * or audited). Archiving tells the App's people their access changed,
 * ends its visitors' sessions and stops its unfinished runs; a restore
 * waits for those stops first.
 */
export const setArchived = async (
  env: Env,
  by: Identity,
  input: unknown,
  archived: boolean
): Promise<App> => {
  // Grasp staff never archive a client's App: whom it reaches is the
  // client's decision, as whom it is shared with is (app-members.ts).
  requireNotStaff(by);
  const found = await appFor(env, by, input, "builder");
  if (found.archived === archived) {
    return found;
  }
  // When it was archived, as read: a restore applies only to that very
  // archive, so one archived again meanwhile is a conflict.
  const fence = await archivedAtOf(env, found.id);
  if (archived !== (fence === null)) {
    throw appErrors.create("app.conflict");
  }
  if (!archived) {
    await cancelledBeforeRestore(env, found);
  }
  const db = drizzle(env.DB);
  const event = createAuditEvent(
    {
      actor: actorOf(by),
      action: archived ? "app.archived" : "app.restored",
      target: { type: "app", id: found.id },
      detail: {},
    },
    "core"
  );
  // Later than the archive read, so a restore's fence differs from the
  // next archive's.
  const now = new Date(Math.max(Date.now(), (fence ?? 0) + 1));
  const done = archived ? storedEvent(event.id) : sql`0`;
  // Only over the archive read: a change meanwhile is a conflict, never
  // overwritten. The revocation is kept with the change, so a database
  // away after it loses nothing (access-revocations.ts).
  const [[changed], , revocations] = await auditedBatch(env, db, [
    db
      .update(apps)
      .set(
        archived
          ? {
              archivedAt: now,
              archivedBy: { userId: by.userId, staff: by.staff },
              // Kept for one release, for the release before (schema.ts).
              status: "archived" as const,
            }
          : {
              archivedAt: null,
              archivedBy: null,
              status: sql<
                "draft" | "published"
              >`CASE WHEN ${apps.currentVersion} IS NULL THEN 'draft' ELSE 'published' END`,
            }
      )
      .where(
        and(
          eq(apps.id, found.id),
          sql`${apps.archivedAt} IS ${fence}`,
          // Removed meanwhile (app-removal.ts), it stays removed.
          isNull(apps.removedAt)
        )
      )
      .returning(),
    outboxedEventWhere(db, event, sql`changes() > 0`),
    // Everyone loses an archived App, its builders included.
    revocationsOf(db, eq(apps.id, found.id), null, done),
    // Every visitor's session ends with it (app-visitors.ts), in the same
    // batch and only if the archive won: an archive with sessions left
    // over would let a restore revive them.
    db
      .delete(appVisitorSessions)
      .where(and(eq(appVisitorSessions.appId, found.id), done)),
  ]);
  if (changed === undefined) {
    throw appErrors.create("app.conflict");
  }
  const app = toApp(changed);
  if (archived) {
    // Open pages look again (access-revocations.ts), and stop.
    await tellKept(env, revocations);
    await stopRunsStartedBy(env, actorOf(by), app.id, now, archivedRunsPerPass);
  }
  return app;
};

/**
 * Stops, a few at a time, the unfinished runs that archived Apps started:
 * those archiving left (more than one pass's worth, or a stop that
 * failed), and a run whose start raced the archive. Each is stopped for
 * whoever archived its App, or its owner. The clock runs it every minute.
 */
export const cancelArchivedRuns = async (
  env: Env,
  from: string = crypto.randomUUID()
): Promise<void> => {
  // Archived Apps with a run they started left to stop: in ID order from
  // a random ID (`from`), wrapping round, so Apps whose stops keep failing
  // can't hold every pass's budget, and every one is reached in time.
  const slice = async (side: SQL, limit: number) =>
    await drizzle(env.DB)
      .select({
        app: apps.id,
        owner: apps.ownerId,
        by: apps.archivedBy,
        at: apps.archivedAt,
      })
      .from(apps)
      .where(
        and(
          sql`${apps.archivedAt} IS NOT NULL`,
          sql`EXISTS (SELECT 1 FROM workflow_resource_runs r JOIN workflow_start_receipts s ON s.id = r.id WHERE s.invoker_type = 'app' AND s.invoker_id = ${apps.id} AND r.status IN ('starting', 'running', 'paused') AND (r.stop_requested_at IS NULL OR r.stop_requested_at <= ${Date.now() - stopRetryMs}))`,
          side
        )
      )
      .orderBy(asc(apps.id))
      .limit(limit);
  const onward = await slice(gte(apps.id, from), archivedRunsPerPass);
  const rows =
    onward.length < archivedRunsPerPass
      ? [
          ...onward,
          ...(await slice(
            lt(apps.id, from),
            archivedRunsPerPass - onward.length
          )),
        ]
      : onward;
  // One budget for the whole pass, whatever the number of Apps.
  let left = archivedRunsPerPass;
  for (const { app, owner, by, at } of rows) {
    if (left <= 0) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- one App at a time
    const { asked } = await stopRunsStartedBy(
      env,
      actorOf(by ?? { userId: owner, staff: false }),
      app,
      // Archived now: every run of it, a run that raced the archive too.
      new Date(Math.max(Date.now(), at?.getTime() ?? 0)),
      left
    );
    left -= asked;
  }
};
