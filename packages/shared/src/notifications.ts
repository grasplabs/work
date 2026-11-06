import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

/** Why a call on notifications was refused. */
export const notificationErrors = defineErrorFamily({
  "notification.invalid": "Those aren't notifications as the list showed them.",
});

// What core tells a signed-in person in the product (core's
// notifications.ts): that an admin asked them one of the brain's open
// questions, that a
// schedule trigger of theirs stopped, that connect stopped hearing a
// mailbox or drive their triggers listen to, or that packages of an App
// or workflow they build or approved were revoked as malware, or what an
// App's server code told them (`ctx.notifyPeople`, core's
// app-notifications.ts).
// Only they see their own; nobody else is told.

/**
 * An admin asked the person one of the brain's open questions, as the
 * role that can answer it (core's brain-gaps.ts): listed while the
 * question is open, and gone once anyone answers or closes it.
 */
export interface GapAskedNotification {
  id: string;
  type: "gap_asked";
  /** The question's id: `brain.answerGap` takes it. */
  gap: string;
  question: string;
  /** The role it was asked of, as the question names it. */
  owner: string;
  /** When they were asked (ISO 8601). */
  at: string;
  read: boolean;
}

/**
 * A schedule trigger the person owns stopped after its starts failed too
 * many times in a row (core's workflows/schedule-triggers.ts): it starts
 * nothing more until they enable it again. Listed while the trigger is
 * still theirs and not deleted.
 */
export interface TriggerStoppedNotification {
  id: string;
  type: "trigger_stopped";
  trigger: string;
  /** The workflow the trigger starts: its ID and name. */
  workflow: string;
  workflowName: string;
  /** When it stopped (ISO 8601). */
  at: string;
  read: boolean;
}

/**
 * Connect stopped hearing events where the person's triggers listen (a
 * mailbox, a drive): the provider refused access (`refused`: connect then
 * asks only daily, until the connection is signed in to again or its
 * access is given back), or its reads kept failing (`failed`: connect
 * goes on trying). Their triggers there start nothing new meanwhile.
 */
export interface EventsStoppedNotification {
  id: string;
  type: "events_stopped";
  /** The connection's ID. */
  connection: string;
  /** The event type it stopped hearing, such as `m365.mail.received`. */
  event: string;
  /** The part of the connection (a mailbox, a drive); null for the account's own. */
  resource: string | null;
  reason: "refused" | "failed";
  /** When connect stopped hearing it (ISO 8601). */
  at: string;
  read: boolean;
}

/**
 * Packages of an App or workflow the person builds, or whose packages
 * they approved, were revoked because one was reported as malware
 * (core's dependencies/requests.ts): nothing of them is built, served or
 * started until a builder removes it and an approver approves a new set.
 * Listed while the person can still open the App or workflow, or approve
 * packages.
 */
export interface PackageRevokedNotification {
  id: string;
  type: "package_revoked";
  /** The App or workflow whose packages were revoked, by its name now. */
  subject:
    | { type: "app"; app: string; appName: string }
    | { type: "workflow"; workflow: string; workflowName: string };
  /** The package version reported as malware: the first, if several were. */
  package: { name: string; version: string };
  /** The advisory that reported it, such as an OSV or GHSA ID. */
  advisory: string;
  /** When they were revoked (ISO 8601). */
  at: string;
  read: boolean;
}

/**
 * What an App's server code told the person (`ctx.notifyPeople`, core's
 * app-notifications.ts): its title and body; it opens the App.
 * Listed while they can still open the App, by its name now.
 */
export interface AppMessageNotification {
  id: string;
  type: "app_message";
  app: string;
  appName: string;
  title: string;
  body: string | null;
  /** When it was sent (ISO 8601). */
  at: string;
  read: boolean;
}

export type Notification =
  | AppMessageNotification
  | GapAskedNotification
  | TriggerStoppedNotification
  | PackageRevokedNotification
  | EventsStoppedNotification;

/** Most notifications `list` returns: the latest. */
export const listedNotifications = 50;

/**
 * Where a page of notifications goes on from: the last one shown, by its
 * time (`at`) and ID. The next page lists those older than it.
 */
export interface NotificationCursor {
  at: string;
  id: string;
}

/** A page of the person's notifications. */
export interface NotificationPage {
  /** At most {@link listedNotifications}, latest first. */
  notifications: Notification[];
  /** How many of all those they can see are unread. */
  unread: number;
  /** Whether older ones follow: list again from the last one's cursor. */
  more: boolean;
}

/** The signed-in person's notifications. */
export interface NotificationsApi {
  /**
   * Their notifications of Apps they can still open, and of questions
   * still open, latest first: the latest page, or the page older than
   * `before`.
   */
  list: (before?: NotificationCursor) => Promise<NotificationPage>;
  /**
   * Marks read the notifications `list` showed (their IDs, at most
   * {@link listedNotifications}) as they were shown: each only while its
   * latest failure is no later than `upTo`, the newest `at` shown, so a
   * failure counted on one since leaves it unread.
   */
  markRead: (ids: string[], upTo: string) => Promise<void>;
}

// What App code may send (`ctx.notifyPeople`): bounded, so one send can't fill
// someone's notifications or the database, and rate-limited per App.

/** The longest title an App's notification has, in characters. */
export const appNotificationTitleMax = 120;

/** The longest body an App's notification has, in characters. */
export const appNotificationBodyMax = 1000;

/**
 * The most people one send reaches: a team larger than this is told up to
 * here, and the rest skipped.
 */
export const appNotificationMaxRecipients = 50;

/**
 * The most notifications (one per person told) an App sends in an hour,
 * all its people's calls together: a send that would go past it is
 * refused whole (`resource.limit_reached`, `{ limit: "hour" }`).
 */
export const appNotificationsPerHour = 200;

/**
 * What App code sends: a title, a body if it has one, and the App's page
 * to open on (`link`), the App's first when it names none or one the App
 * doesn't have. Never a URL: a notification opens the App, nothing else.
 */
export const appNotificationMessageSchema = z.strictObject({
  title: z.string().trim().min(1).max(appNotificationTitleMax),
  body: z.string().trim().max(appNotificationBodyMax).optional(),
});

export type AppNotificationMessage = z.infer<
  typeof appNotificationMessageSchema
>;

/** Whom App code tells: a person's ID or a team's. */
export const appNotificationRecipientSchema = z.string().min(1).max(128);

/**
 * What a send did: how many people it told. Never who, nor how many it
 * skipped, which would tell App code a team's size.
 */
export interface AppNotificationReceipt {
  delivered: number;
}

/**
 * The resource alias App code's channel names to tell people
 * (`channel.resource(peopleAlias, "notify", [to, notification])`): no
 * alias an App declares is one, as each starts with a letter.
 */
export const peopleAlias = "~people";
