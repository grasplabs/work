import { brainRecordSchema } from "@grasp-os/shared/brain-records";
import {
  listedNotifications,
  notificationErrors,
} from "@grasp-os/shared/notifications";
import type {
  Notification,
  NotificationCursor,
  PackageNotification,
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

// What core tells a person in the product: that an admin asked them one
// of the brain's open questions (`gap_asked`, written by brain-gaps.ts in the batch that
// records the ask), or that a schedule trigger they own stopped
// (`trigger_stopped`, written by workflows/schedule-triggers.ts in the
// batch that stops it), or that connect stopped hearing a mailbox or
// drive their triggers listen to (`events_stopped`, written by
// connector-source-notices.ts as connect's audit events reach core), or
// that the clock found the approved packages of an App they build
// reported as malware, and revoked them (`package_revoked`), or a new
// advisory against them (`package_advisory`), both written by
// packages/rescan.ts in the batch that records it, or what an App's
// server code told them (`app_message`, written by app-notifications.ts).
// A question is listed while it is open: once anyone answers or closes
// it, it goes from the list by itself; a stopped trigger while it is
// still theirs and not deleted; a package notice or an App's message
// while they can still open the App.
//
// A person lists only notifications of Apps they can still open
// (`appsFoundBy`), so one of an App taken from them tells them nothing
// more, not even its name now.

/** How long a person's read notifications are kept. */
const keptReadMs = 30 * 24 * 60 * 60 * 1000;

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
      sql`SELECT ${crypto.randomUUID()}, ${personId}, 'trigger_stopped', NULL, ${workflowId}, NULL, ${now}, ${now}, NULL, ${triggerId}, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL WHERE ${recorded} AND ${activeMember(personId)}`
    );
};

/** A source connect stopped hearing, and whom it tells. */
export interface EventsStopNotice {
  /** Its own ID, the same however often it is written. */
  id: string;
  personId: string;
  /** When connect stopped hearing it. */
  at: Date;
  connection: string;
  type: string;
  resource: string | null;
  reason: "refused" | "failed";
}

/**
 * The statement that tells `personId` connect stopped hearing a source
 * their triggers listen to, once (by its ID), only while they are a
 * member of the organization.
 */
export const eventsStopNoticed = (
  db: DrizzleD1Database,
  notice: EventsStopNotice
) => {
  const at = notice.at.getTime();
  return db
    .insert(notifications)
    .select(
      sql`SELECT ${notice.id}, ${notice.personId}, 'events_stopped', NULL, NULL, NULL, ${at}, ${at}, NULL, NULL, NULL, NULL, NULL, ${notice.connection}, ${notice.type}, ${notice.resource}, ${notice.reason}, NULL, NULL, NULL WHERE ${activeMember(notice.personId)}`
    )
    .onConflictDoNothing({ target: notifications.id });
};

/** The notifications of what core's rescan found of approved packages. */
const packageTypes = ["package_revoked", "package_advisory"] as const;

/**
 * What core's rescan found of an App's approved packages
 * (packages/rescan.ts), and whom it tells: its builders.
 */
export interface PackageNotice {
  type: PackageNotification["type"];
  app: string;
  package: { name: string; version: string };
  advisory: string;
  personIds: readonly string[];
  /** That what it tells is recorded, as SQL on what the batch wrote before. */
  recorded: SQL;
}

/**
 * The statements that tell each of `personIds` what was found, in the
 * batch that records it, each only while they are a member of the
 * organization.
 */
export const packageNoticed = (
  db: DrizzleD1Database,
  { type, app, package: found, advisory, personIds, recorded }: PackageNotice
) => {
  const now = Date.now();
  return [...new Set(personIds)].map((personId) =>
    db
      .insert(notifications)
      .select(
        sql`SELECT ${crypto.randomUUID()}, ${personId}, ${type}, ${app}, NULL, NULL, ${now}, ${now}, NULL, NULL, ${found.name}, ${found.version}, ${advisory}, NULL, NULL, NULL, NULL, NULL, NULL, NULL WHERE ${recorded} AND ${activeMember(personId)}`
      )
  );
};

/**
 * `person`'s notifications: of Apps they can still open, of gaps still
 * open, of triggers still theirs, of the sources connect stopped hearing
 * for them, and of package notices of Apps they can still open. Read with
 * `apps`, `brain_records` and `brain_gap_states` joined on the row
 * (`appOn`, `gapOn`, `gapStateOn`).
 */
const visibleTo = (env: Env, person: Identity): SQL | undefined =>
  and(
    eq(notifications.personId, person.userId),
    or(
      and(
        eq(notifications.type, "app_message"),
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
      ),
      eq(notifications.type, "events_stopped"),
      and(
        inList(notifications.type, packageTypes),
        isNotNull(apps.id),
        appsFoundBy(env, person),
        isNull(apps.removedAt)
      )
    )
  );

/** Joins `apps` to a notification: the App of an `app_message` or a revocation. */
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
  type:
    | "gap_asked"
    | "trigger_stopped"
    | PackageNotification["type"]
    | "events_stopped"
    | "app_message";
  app: string | null;
  appName: string | null;
  workflow: string | null;
  gap: string | null;
  gapBody: string | null;
  trigger: string | null;
  workflowName: string | null;
  packageName: string | null;
  packageVersion: string | null;
  advisory: string | null;
  connection: string | null;
  eventType: string | null;
  eventResource: string | null;
  stopReason: "refused" | "failed" | null;
  title: string | null;
  body: string | null;
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

/** The package notice a listed row holds, if it reads. */
const packageNoticeOf = (
  row: ListedRow,
  type: PackageNotification["type"]
): Notification[] => {
  const { app, appName, packageName, packageVersion, advisory } = row;
  return app === null ||
    appName === null ||
    packageName === null ||
    packageVersion === null ||
    advisory === null
    ? []
    : [
        {
          id: row.id,
          type,
          app,
          appName,
          package: { name: packageName, version: packageVersion },
          advisory,
          at: row.updatedAt.toISOString(),
          read: row.readAt !== null,
        },
      ];
};

/** The `app_message` notification a listed row holds, if it reads. */
const appMessageOf = (row: ListedRow): Notification[] => {
  const { app, appName, title } = row;
  return app === null || appName === null || title === null
    ? []
    : [
        {
          id: row.id,
          type: "app_message",
          app,
          appName,
          title,
          body: row.body,
          at: row.updatedAt.toISOString(),
          read: row.readAt !== null,
        },
      ];
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
  if (row.type === "events_stopped") {
    const { connection, eventType, eventResource, stopReason } = row;
    return connection === null || eventType === null || stopReason === null
      ? []
      : [
          {
            id: row.id,
            type: "events_stopped",
            connection,
            event: eventType,
            resource: eventResource,
            reason: stopReason,
            at,
            read,
          },
        ];
  }
  if (row.type === "package_revoked" || row.type === "package_advisory") {
    return packageNoticeOf(row, row.type);
  }
  if (row.type === "app_message") {
    return appMessageOf(row);
  }
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
        gap: notifications.gapId,
        gapBody: brainRecords.body,
        trigger: notifications.triggerId,
        // Named, so it doesn't share `name` with the App's in the batch's
        // rows, which D1 keys by column name.
        workflowName: sql<string | null>`${workflowResources.name}`.as(
          "workflow_name"
        ),
        packageName: notifications.packageName,
        packageVersion: notifications.packageVersion,
        advisory: notifications.advisory,
        connection: notifications.connectionId,
        eventType: notifications.eventType,
        eventResource: notifications.eventResource,
        stopReason: notifications.stopReason,
        // Named, as the workflow's: `body` is the gap's record's too.
        title: sql<string | null>`${notifications.title}`.as("message_title"),
        body: sql<string | null>`${notifications.body}`.as("message_body"),
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
      .leftJoin(workflowResources, workflowOn)
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
