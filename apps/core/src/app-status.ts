import { appErrors } from "@grasp-os/shared/apps";
import type { App, AppStatus } from "@grasp-os/shared/apps";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { revocationsOf, tellKept } from "./access-revocations.ts";
import { queuedWebhookDeliveries } from "./app-webhook-queue.ts";
import { appFor, toApp } from "./apps.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
} from "./audit-outbox.ts";
import { apps } from "./db/core/schema.ts";
import { appHost } from "./durable-objects.ts";
import { requireNotStaff } from "./sharing.ts";
import { cancelRunsOf } from "./workflows/controls.ts";
import { stopsUnsettled } from "./workflows/resource-runs.ts";

// Where an App is in its life (`AppStatus`), and its builders moving it:
//
//   draft ──publish──▶ published ──unpublish──▶ draft
//   draft, published ──archive──▶ archived ──restore──▶ draft
//
// The rules each status holds are enforced where an App is reached, not
// here: only its builders and the admins have a role in a draft or an
// archived App (app-access.ts); nobody uses an archived App, its builders
// included (`usableApp`, apps.ts; `operationRoles`); only a published
// App's triggers fire (workflows/triggers.ts, connector-events.ts,
// inbound-email.ts), and no run of an archived App starts (`startRun`).
//
// Threats, and what stands against each:
// - Someone with only the user role reaching a draft or archived App by a
//   path that skips the role check: every path asks `requireAppRole`,
//   which reads the status with the role, or the SQL forms beside it
//   (`appsFoundBy`, `stillOpenTo`), so none has a path of its own.
// - Learning that a draft exists: it is answered as an App that isn't
//   there (`app.not_found`), in lists and errors alike.
// - A trigger or run outliving the archive: archiving cancels the App's
//   unfinished runs (`cancelRunsOf`), the cron trigger cancels any left or
//   started in a race with it (`cancelArchivedRuns`), and a start reads
//   the status again once its row is written (`startRun`). A restore
//   waits for the stops still settling (`cancelledBeforeRestore`).
// - A transition by someone who lost their role: the role is read for the
//   call, and the write only applies to the status read (`app.conflict`
//   otherwise). Each transition is audited with the change itself.
// - An old screen still open after a restore: a restore lands in draft,
//   so users stay out until a builder publishes it again.

/** A transition: the statuses it starts from, and where it goes. */
interface Transition {
  readonly from: readonly AppStatus[];
  readonly to: AppStatus;
  readonly action:
    | "app.published"
    | "app.unpublished"
    | "app.archived"
    | "app.restored";
}

const transitions = {
  publish: { from: ["draft"], to: "published", action: "app.published" },
  unpublish: { from: ["published"], to: "draft", action: "app.unpublished" },
  archive: {
    from: ["draft", "published"],
    to: "archived",
    action: "app.archived",
  },
  restore: { from: ["archived"], to: "draft", action: "app.restored" },
} as const satisfies Record<string, Transition>;

export type AppTransition = keyof typeof transitions;

/**
 * Tells the App's host its people's access may have changed, so open
 * screens look again (access-revocations.ts), and restarts its server
 * code, which lets go of what they subscribed to. Best effort: every push
 * checks again anyway.
 */
const closeScreens = async (env: Env, app: App): Promise<void> => {
  try {
    await appHost(env, app.id).restart("Its status changed.");
  } catch (error) {
    log.error("app.restart_failed", { appId: app.id, ...errorFields(error) });
  }
};

/**
 * App `app`'s status, with when it last changed in ms (null while it never
 * has), read together: the fence a transition writes under.
 */
const statusFenceOf = async (
  env: Env,
  app: string
): Promise<{ status: AppStatus | undefined; at: number | null }> => {
  const row = await drizzle(env.DB)
    .select({ status: apps.status, at: apps.statusChangedAt })
    .from(apps)
    .where(eq(apps.id, app))
    .get();
  return { status: row?.status, at: row?.at?.getTime() ?? null };
};

/** Most runs one page of a restore's cancels asks to cancel. */
const cancelPage = 50;

/** Most pages of cancels a restore asks for before it gives up for now. */
const maxCancelPages = 10;

/**
 * Finishes, before a restore, the cancels its archive still owes: every
 * unfinished run of the App not yet asked to cancel (a cancel that failed,
 * one the cron trigger hadn't reached, or a start that overlapped the
 * archive's write), so none of them goes on as the App's again. While it
 * is archived nothing of it starts, so each is the archive's.
 */
const cancelledBeforeRestore = async (env: Env, app: App): Promise<void> => {
  const row = await drizzle(env.DB)
    .select({ by: apps.statusChangedBy })
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
  // run would go on as the App's (the cron trigger asks while archived).
  let finished = false;
  for (let page = 0; page < maxCancelPages && !finished; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const { asked, failed } = await cancelRunsOf(
      env,
      by,
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
    // Too many to finish in one call: the restore waits for the cron trigger.
    throw appErrors.create("app.conflict");
  }
  // A short page proves every cancel was asked, not that every stop of a
  // run the App started was sent: a stop claimed by another pass, or by a
  // sender that died before sending, is skipped for `stopRetryMs`. Once
  // restored, no repair looks at the App's runs again, so such a run would
  // go on. So the restore waits until each claimed stop has ended its run,
  // the cron trigger sending again any that was lost. Keeping a repair
  // alive across the restore instead would have to tell an archive's stops
  // apart from runs the restored App starts afresh.
  if (await stopsUnsettled(env, app.id)) {
    throw appErrors.create("app.stops_pending");
  }
};

/**
 * Moves the App `input` names along `transition`, for one of its builders:
 * answered as it is when it is where the transition goes already (nothing
 * written or audited); refused with `app.archived` for an archived App
 * other than by `restore`, and with `app.no_version` for publishing an App
 * no version of which is current. Leaving `published` tells the App's
 * people their access changed; archiving cancels its unfinished runs.
 */
export const changeStatus = async (
  env: Env,
  by: Identity,
  input: unknown,
  transition: AppTransition
): Promise<App> => {
  const { from, to, action }: Transition = transitions[transition];
  // Grasp staff never change a client's App's status: whom it reaches is
  // the client's decision, as whom it is shared with is (app-members.ts).
  requireNotStaff(by);
  const found = await appFor(env, by, input, "builder");
  if (found.status === to) {
    return found;
  }
  if (!from.includes(found.status)) {
    throw appErrors.create(
      found.status === "archived" ? "app.archived" : "app.conflict"
    );
  }
  if (to === "published" && found.currentVersion === null) {
    throw appErrors.create("app.no_version");
  }
  // The status as read, with when it last changed: the write applies only
  // to that very state, so a cycle back to the same status meanwhile (a
  // restore, a run started, an archive again) is a conflict, never a
  // stale restore landing on the new archive.
  const read = await statusFenceOf(env, found.id);
  if (read.status !== found.status) {
    throw appErrors.create("app.conflict");
  }
  const fence = read.at;
  if (transition === "restore") {
    await cancelledBeforeRestore(env, found);
  }
  const db = drizzle(env.DB);
  const event = createAuditEvent(
    {
      actor: actorOf(by),
      action,
      target: { type: "app", id: found.id },
      detail: { from: found.status, to },
    },
    "core"
  );
  // Later than the fence's time, so the next transition's fence differs.
  const now = new Date(Math.max(Date.now(), (fence ?? 0) + 1));
  // Only from the status read: a change meanwhile is a conflict, never
  // overwritten. The revocation is kept with the change, so a database
  // away after it loses nothing (access-revocations.ts).
  const [[changed], , revocations] = await auditedBatch(env, db, [
    db
      .update(apps)
      .set({
        status: to,
        statusChangedAt: now,
        statusChangedBy: { userId: by.userId, staff: by.staff },
      })
      .where(
        and(
          eq(apps.id, found.id),
          eq(apps.status, found.status),
          sql`${apps.statusChangedAt} IS ${fence}`
        )
      )
      .returning(),
    outboxedEventWhere(db, event, sql`changes() > 0`),
    revocationsOf(
      db,
      eq(apps.id, found.id),
      null,
      // Everyone of a published App may lose it; an archived App's
      // builders lose its use too, a draft's included.
      found.status === "published" || to === "archived"
        ? storedEvent(event.id)
        : sql`0`
    ),
    // Its webhooks told it was published, with the change or not at all.
    ...(to === "published"
      ? [
          queuedWebhookDeliveries(
            db,
            {
              app: found.id,
              event: "published",
              dedupe: `published:${event.id}`,
              version: found.currentVersion,
            },
            storedEvent(event.id)
          ),
        ]
      : []),
  ]);
  if (changed === undefined) {
    throw appErrors.create("app.conflict");
  }
  const app = toApp(changed);
  if (found.status === "published" || to === "archived") {
    await tellKept(env, revocations);
    await closeScreens(env, app);
  }
  if (to === "archived") {
    await cancelRunsOf(env, by, app.id, now);
  }
  return app;
};
