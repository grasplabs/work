import type { AuditEntry } from "@grasp-os/shared/audit";
import { brainRecordSchema } from "@grasp-os/shared/brain-records";
import {
  listedNotifications,
  notificationErrors,
} from "@grasp-os/shared/notifications";
import type {
  Notification,
  NotificationCursor,
  NotificationPage,
  NotificationsApi,
} from "@grasp-os/shared/notifications";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  and,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { appsFoundBy } from "./app-access.ts";
import { outboxedWhere } from "./audit-outbox.ts";
import { activeMember } from "./auth/auth.ts";
import {
  apps,
  brainGapStates,
  brainRecords,
  notifications,
  triggerResources,
  workflowResources,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// What core tells a person in the product: that a workflow failed while
// acting for them, or that an admin asked them one of the brain's open
// questions (`gap_asked`, written by brain-gaps.ts in the batch that
// records the ask), or that a schedule trigger they own stopped
// (`trigger_stopped`, written by workflows/schedule-triggers.ts in the
// batch that stops it). A question is listed while it is open: once anyone
// answers or closes it, it goes from the list by itself; a stopped trigger
// while it is still theirs and not deleted.
//
// A workflow's failure tells who it acted for (who started the run, or,
// for a run a trigger started, the App's owner when it failed), while
// they are a member of the organization still. Nobody else is told:
// admins see every run's failure on the Workflows page, and the report
// itself stays there, for those who see it (`seesDetails` in
// workflows/runs.ts). A notification holds IDs and a count, never what
// the run read or its error's words.
//
// A failure notifies in the batch that marks the run failed, audited as
// `workflow.run.notified` in it too, only if that batch ended the run: a
// run ends once, so it notifies once. While a notification of a workflow
// is unread, its next failures count on it, so a workflow failing every
// minute is one notification, not thousands.
//
// A person lists only notifications of Apps they can still open
// (`appsFoundBy`), so one of an App taken from them tells them nothing
// more, not even its name now.

/** How long a person's read notifications are kept. */
const keptReadMs = 30 * 24 * 60 * 60 * 1000;

/** The failed run a notice is for, and whom it tells. */
export interface FailureNotice {
  run: { id: string; appId: string; workflowId: string; version: number };
  personId: string;
  /** Its audit event: `workflow.run.notified`. */
  entry: AuditEntry;
  /**
   * That the failure is recorded, as SQL on what the batch wrote before:
   * the run's own failed event stored. Nothing is written otherwise.
   */
  recorded: SQL;
}

/**
 * The statements that notify `personId` of the failed run, and audit it,
 * in the batch that records the failure: a new unread notification of
 * the workflow, or one more failure counted on the unread one there is.
 * Only while they are a member of the organization, as the batch finds
 * them: someone removed since the run started (members.ts, which deletes
 * their notifications) is told nothing, and the log doesn't say they were.
 */
export const failureNoticed = (
  db: DrizzleD1Database,
  { run, personId, entry, recorded }: FailureNotice
) => {
  const now = Date.now();
  const told = sql`${recorded} AND ${activeMember(personId)}`;
  return [
    // The WHERE keeps SQLite from reading ON CONFLICT as a join.
    db
      .insert(notifications)
      .select(
        sql`SELECT ${crypto.randomUUID()}, ${personId}, 'run_failed', ${run.appId}, ${run.workflowId}, ${run.id}, 1, NULL, ${now}, ${now}, NULL, NULL WHERE ${told}`
      )
      .onConflictDoUpdate({
        target: [
          notifications.personId,
          notifications.type,
          notifications.appId,
          notifications.workflowId,
        ],
        targetWhere: isNull(notifications.readAt),
        set: {
          runId: sql`excluded.run_id`,
          failures: sql`${notifications.failures} + 1`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
    outboxedWhere(db, entry, told),
  ] as const;
};

/** A schedule trigger that stopped, and whom it tells: its owner. */
export interface StopNotice {
  triggerId: string;
  workflowId: string;
  personId: string;
  /** That the stop is recorded, as SQL on what the batch wrote before. */
  recorded: SQL;
}

/**
 * The statement that tells `personId` their trigger stopped, in the batch
 * that stops it, only while they are a member of the organization.
 */
export const stopNoticed = (
  db: DrizzleD1Database,
  { triggerId, workflowId, personId, recorded }: StopNotice
) => {
  const now = Date.now();
  return db
    .insert(notifications)
    .select(
      sql`SELECT ${crypto.randomUUID()}, ${personId}, 'trigger_stopped', NULL, ${workflowId}, NULL, NULL, NULL, ${now}, ${now}, NULL, ${triggerId} WHERE ${recorded} AND ${activeMember(personId)}`
    );
};

/**
 * `person`'s notifications: of Apps they can still open, of gaps still
 * open, and of triggers still theirs. Read with `apps`, `brain_records` and `brain_gap_states`
 * joined on the row (`appOn`, `gapOn`, `gapStateOn`).
 */
const visibleTo = (env: Env, person: Identity): SQL | undefined =>
  and(
    eq(notifications.personId, person.userId),
    or(
      and(
        eq(notifications.type, "run_failed"),
        isNotNull(apps.id),
        appsFoundBy(env, person)
      ),
      and(
        eq(notifications.type, "gap_asked"),
        isNotNull(brainRecords.id),
        isNull(brainGapStates.closedAt)
      ),
      and(
        eq(notifications.type, "trigger_stopped"),
        eq(triggerResources.ownerId, person.userId),
        isNull(triggerResources.deletedAt)
      )
    )
  );

/** Joins `apps` to a notification: a `run_failed` row's App. */
const appOn = eq(apps.id, notifications.appId);
/** Joins `brain_records` to a notification: a `gap_asked` row's gap. */
const gapOn = and(
  eq(brainRecords.type, "gap"),
  eq(brainRecords.id, notifications.gapId)
);
/** Joins `brain_gap_states` to a notification: what became of its gap. */
const gapStateOn = eq(brainGapStates.gapId, notifications.gapId);
/** Joins `trigger_resources` to a notification: a stopped trigger. */
const triggerOn = eq(triggerResources.id, notifications.triggerId);
/** Joins `workflow_resources` to a notification: a stopped trigger's workflow. */
const workflowOn = and(
  eq(notifications.type, "trigger_stopped"),
  eq(workflowResources.id, notifications.workflowId)
);

/** A notification as `listNotifications` reads its row. */
interface ListedRow {
  id: string;
  type: "run_failed" | "gap_asked" | "trigger_stopped";
  app: string | null;
  appName: string | null;
  workflow: string | null;
  run: string | null;
  failures: number | null;
  gap: string | null;
  gapBody: string | null;
  trigger: string | null;
  workflowName: string | null;
  updatedAt: Date;
  readAt: Date | null;
}

/** The gap a `gap_asked` row is about, as added: its question and owner. */
const askedGapOf = (
  body: string | null
): { question: string; owner: string } | null => {
  if (body === null) {
    return null;
  }
  const record = brainRecordSchema.safeParse(JSON.parse(body));
  return record.success && record.data.type === "gap" ? record.data : null;
};

/** The notification a listed row holds; none for a row it can't read. */
const notificationOf = (row: ListedRow): Notification[] => {
  const at = row.updatedAt.toISOString();
  const read = row.readAt !== null;
  if (row.type === "gap_asked") {
    const gap = askedGapOf(row.gapBody);
    return row.gap === null || gap === null
      ? []
      : [
          {
            id: row.id,
            type: "gap_asked",
            gap: row.gap,
            question: gap.question,
            owner: gap.owner,
            at,
            read,
          },
        ];
  }
  if (row.type === "trigger_stopped") {
    return row.trigger === null ||
      row.workflow === null ||
      row.workflowName === null
      ? []
      : [
          {
            id: row.id,
            type: "trigger_stopped",
            trigger: row.trigger,
            workflow: row.workflow,
            workflowName: row.workflowName,
            at,
            read,
          },
        ];
  }
  const { app, appName, workflow, run, failures } = row;
  return app === null ||
    appName === null ||
    workflow === null ||
    run === null ||
    failures === null
    ? []
    : [
        {
          id: row.id,
          type: "run_failed",
          app,
          appName,
          workflow,
          run,
          failures,
          at,
          read,
        },
      ];
};

/** Where a page goes on from, as the page passes it. */
const cursorSchema = z
  .object({ at: z.iso.datetime(), id: z.string().max(64) })
  .optional();

/**
 * A page of the person's notifications, the latest or those older than
 * `before`, and how many of all they can see are unread: two reads of the
 * person's index, in its order (time, then ID), joined to each App by its
 * key.
 */
export const listNotifications = async (
  env: Env,
  person: Identity,
  before?: unknown
): Promise<NotificationPage> => {
  const cursor = cursorSchema.safeParse(before);
  if (!cursor.success) {
    throw notificationErrors.create("notification.invalid");
  }
  const after =
    cursor.data === undefined
      ? undefined
      : sql`(${notifications.updatedAt}, ${notifications.id}) < (${new Date(cursor.data.at).getTime()}, ${cursor.data.id})`;
  const db = drizzle(env.DB);
  const [rows, [unread]] = await db.batch([
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        app: notifications.appId,
        appName: apps.name,
        workflow: notifications.workflowId,
        run: notifications.runId,
        failures: notifications.failures,
        gap: notifications.gapId,
        gapBody: brainRecords.body,
        trigger: notifications.triggerId,
        // Named, so it doesn't share `name` with the App's in the batch's
        // rows, which D1 keys by column name.
        workflowName: sql<string | null>`${workflowResources.name}`.as(
          "workflow_name"
        ),
        updatedAt: notifications.updatedAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .leftJoin(apps, appOn)
      .leftJoin(brainRecords, gapOn)
      .leftJoin(brainGapStates, gapStateOn)
      .leftJoin(triggerResources, triggerOn)
      .leftJoin(workflowResources, workflowOn)
      .where(and(visibleTo(env, person), after))
      .orderBy(desc(notifications.updatedAt), desc(notifications.id))
      // One past the page: whether more follow.
      .limit(listedNotifications + 1),
    db
      .select({ count: count() })
      .from(notifications)
      .leftJoin(apps, appOn)
      .leftJoin(brainRecords, gapOn)
      .leftJoin(brainGapStates, gapStateOn)
      .leftJoin(triggerResources, triggerOn)
      .where(and(visibleTo(env, person), isNull(notifications.readAt))),
  ]);
  return {
    notifications: rows.slice(0, listedNotifications).flatMap(notificationOf),
    unread: unread?.count ?? 0,
    more: rows.length > listedNotifications,
  };
};

/** What `markRead` is told the person saw: IDs, and the newest time. */
const shownSchema = z.object({
  ids: z.array(z.string().max(64)).max(listedNotifications),
  upTo: z.iso.datetime(),
});

/**
 * Marks read the person's notifications `ids` whose latest failure is no
 * later than `upTo`, and drops those they read over {@link keptReadMs}
 * ago.
 */
export const markNotificationsRead = async (
  env: Env,
  person: Identity,
  ids: unknown,
  upTo: unknown
): Promise<void> => {
  const shown = shownSchema.safeParse({ ids, upTo });
  if (!shown.success) {
    throw notificationErrors.create("notification.invalid");
  }
  const db = drizzle(env.DB);
  const now = new Date();
  await db.batch([
    db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.personId, person.userId),
          isNull(notifications.readAt),
          inList(notifications.id, shown.data.ids),
          lte(notifications.updatedAt, new Date(shown.data.upTo))
        )
      ),
    db
      .delete(notifications)
      .where(
        and(
          eq(notifications.personId, person.userId),
          lt(notifications.readAt, new Date(now.getTime() - keptReadMs))
        )
      ),
  ]);
};

/** The signed-in person's notifications, over `/rpc`. */
export class NotificationsRpc
  extends CoreRpcTarget
  implements NotificationsApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(before?: NotificationCursor): Promise<NotificationPage> {
    return await withPerson(
      this.#check,
      async (person) => await listNotifications(this.#env, person, before)
    );
  }

  async markRead(ids: string[], upTo: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await markNotificationsRead(this.#env, person, ids, upTo);
    });
  }
}
