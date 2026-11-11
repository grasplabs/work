import { appErrors } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import { createAuditEvent, delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { functionErrors } from "@grasp-os/shared/functions";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  appNotificationMaxRecipients,
  appNotificationMessageSchema,
  appNotificationRecipientSchema,
  appNotificationsPerHour,
} from "@grasp-os/shared/notifications";
import type {
  AppNotificationMessage,
  AppNotificationReceipt,
} from "@grasp-os/shared/notifications";
import type { Authority } from "@grasp-os/shared/permissions";
import { roleSchema } from "@grasp-os/shared/roles";
import { workflowStartIntentSchema } from "@grasp-os/shared/workflow-resources";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { decidedAppRole, functionRoles } from "./app-access.ts";
import { readerOf, sourcesOf, unreadableBy } from "./app-provenance.ts";
import type { AppSources } from "./app-provenance.ts";
import { auditedBatch, outboxed, outboxedWhere } from "./audit-outbox.ts";
import { activeMember, notRemoved, organizationId } from "./auth/auth.ts";
import { memberOf } from "./auth/identity.ts";
import {
  appMembers,
  apps,
  auditOutbox,
  members,
  notifications,
  teamMembers,
  teams,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { defaultMaxAttempts } from "./outbox-delivery.ts";
import type { OutboxEntry } from "./outbox-delivery.ts";
import { requireNotRevoked } from "./release-runner.ts";
import { requireAgentAllowed, requireLive } from "./workflow-start-intents.ts";
import type { CallingAgent } from "./workflow-start-intents.ts";

// Apps telling people (`ctx.notifyPeople`, of an action or a mutation): a
// notification in the person's Grasp notifications
// (notifications.ts, `app_message`), which their inbox lists and which
// opens the App. It is the one
// channel the platform tells people through; nothing here sends mail or
// chat messages. Threat model, and how each is closed:
//
// - Telling someone who isn't the App's: whom App code names (a person or
//   a team, by ID) is resolved here, as the send is made, to the members
//   of the organization who can open the App now, as `requireAppRole`
//   decides it (a draft's builders only, nobody of an archived or removed
//   App, nobody it is shared with who can't read what it read). Anyone
//   else is skipped, and App code hears only how many were told, never
//   who or how many it skipped. That count still says whether one person
//   it names was told: only members call the App, and only they can ask.
//   The row goes in only while they still are one (`activeMember`), and
//   is listed only while they can still open the App.
// - A visitor, or a run, telling people: a visitor's call (a published
//   App's guest, who is no member) and a call from a workflow's run have
//   no `people` on their invocation (app-functions.ts), so their send is
//   refused (`permission.unavailable`), never narrowed: the safer of the two,
//   as nothing a visitor does reaches a member through the App.
// - Flooding: a title and body within their limits (checked as it is
//   made, or staged), at most `appNotificationMaxRecipients` people a send
//   (a larger team's rest skipped), and at most `appNotificationsPerHour`
//   notifications an App sends an hour, all its people's calls together,
//   held by each row's own statement on the same count (the App's others
//   that hour, and this send's), so a send's rows all go in or none do,
//   and two sends at once can't both pass it. A send past it is refused
//   whole (`permission.limit_reached`).
// - A link out: a notification opens the App's own page, on its first
//   route, and names nothing else. No URL is ever kept.
// - Told twice: an action's send is keyed by its call's key and its place
//   among its sends, a commit's by its outbox entry, and each person's row
//   by that key, so the same send made again tells nobody again; its
//   `app.notification.sent` event is written only with the rows its own
//   attempt wrote, so it is logged once.
// - A send after a mutation that didn't commit: it is an outbox entry
//   written in its commit's transaction, or not at all (store-host.ts),
//   and is decided again as it is dispatched: the release not revoked, the
//   person it acts for still in the App, an agent's permission on it still
//   held. One refused then is settled undeliverable and audited.
// - Unseen: every send is audited as the App acting for the person, with
//   how many it told and skipped, never what it said or to whom.
// - Many reads for one send: whom it reaches is decided in one batch of
//   reads (memberships, teams, the App's shares) and one read of what the
//   App read, however many people it names.

/** How long the App's hourly limit looks back. */
const hourMs = 60 * 60 * 1000;

/** How core tells people for one invocation's App and person. */
export interface PeopleNotifications {
  /**
   * Tells `to` now (an action's `ctx.notifyPeople`), under `key`: how many
   * were told.
   */
  readonly send: (
    to: unknown,
    notification: unknown,
    key: string
  ) => Promise<AppNotificationReceipt>;
  /**
   * What a mutation's commit stages in its outbox to tell `to` once it has
   * committed (a mutation's `ctx.notifyPeople`).
   */
  readonly intent: (to: unknown, notification: unknown) => Json;
}

/** A send as its commit stages it, and its dispatch reads it. */
const notifyIntentSchema = z.strictObject({
  app: appIdSchema,
  appVersion: z.int().min(1),
  principal: z.string().min(1).max(256),
  to: appNotificationRecipientSchema,
  notification: appNotificationMessageSchema,
  agent: workflowStartIntentSchema.shape.agent,
});

/** One send: who sends it, as whom, to whom, what and under which key. */
interface Send {
  readonly app: AppId;
  readonly appVersion: number;
  readonly principal: string;
  readonly agent: string | null;
  readonly to: string;
  readonly notification: AppNotificationMessage;
  readonly key: string;
  readonly via: "action" | "mutation";
}

/** What App code sent, read as a send takes it, or refused. */
const checkedOf = (
  to: unknown,
  notification: unknown
): { to: string; notification: AppNotificationMessage } => {
  const recipient = appNotificationRecipientSchema.safeParse(to);
  const message = appNotificationMessageSchema.safeParse(notification);
  if (!recipient.success || !message.success) {
    throw functionErrors.create("permission.invalid_args");
  }
  return { to: recipient.data, notification: message.data };
};

/** The people `to` names: a team's members, or the person themselves. */
const namedBy = async (env: Env, to: string): Promise<string[]> => {
  const inTeam = await drizzle(env.DB)
    .selectDistinct({ userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teams.id, to), eq(teams.organizationId, organizationId)))
    .orderBy(teamMembers.userId);
  return inTeam.length === 0 ? [to] : inTeam.map(({ userId }) => userId);
};

/**
 * Of `ids`, those who can open `app` now, as `requireAppRole` decides it
 * for each (an admin; the App's owner or someone it is shared with, as a
 * person or through a team, the person's role in the organization capping
 * theirs; a draft only for its builders; someone it is shared with only
 * while they can read what it read): their memberships, teams and the
 * App's shares in one batch, and what the App read once, whatever the
 * number of people.
 */
const openersOf = async (
  env: Env,
  app: Pick<App, "id" | "owner" | "status">,
  ids: readonly string[]
): Promise<Set<string>> => {
  if (app.status === "archived" || ids.length === 0) {
    return new Set();
  }
  const db = drizzle(env.DB);
  const [memberRows, teamRows, shares] = await db.batch([
    db
      .select({ userId: members.userId, role: members.role })
      .from(members)
      .where(
        and(
          eq(members.organizationId, organizationId),
          inList(members.userId, ids),
          notRemoved(members.userId)
        )
      ),
    db
      .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(
        and(
          inList(teamMembers.userId, ids),
          eq(teams.organizationId, organizationId)
        )
      ),
    db
      .select({
        type: appMembers.memberType,
        id: appMembers.memberId,
        role: appMembers.role,
      })
      .from(appMembers)
      .where(eq(appMembers.appId, app.id)),
  ]);
  let sources: AppSources | undefined;
  const opened = new Set<string>();
  for (const row of memberRows) {
    const role = roleSchema.safeParse(row.role);
    if (!role.success) {
      continue;
    }
    const teamIds = teamRows
      .filter(({ userId }) => userId === row.userId)
      .map(({ teamId }) => teamId);
    const theirs = shares.filter(
      (share) =>
        (share.type === "person" && share.id === row.userId) ||
        (share.type === "team" && teamIds.includes(share.id))
    );
    const found = decidedAppRole(
      { role: role.data },
      {
        owns: app.owner === row.userId,
        shares: theirs.map((share) => share.role),
        status: app.status,
      }
    );
    if (found === undefined) {
      continue;
    }
    if (found.shared) {
      // What the App read is the App's: read once, for whoever needs it.
      // oxlint-disable-next-line no-await-in-loop -- read at most once
      sources ??= await sourcesOf(env, app.id);
      if (
        unreadableBy(sources, readerOf(row.userId, teamIds, role.data)).length >
        0
      ) {
        continue;
      }
    }
    opened.add(row.userId);
  }
  return opened;
};

/**
 * That App `app`'s other notifications in the hour since `since` (those
 * not among `ids`, this send's), with this send's `count`, stay within its
 * hourly limit, as SQL: the same for every row of the send, so all of
 * them go in, or none.
 */
const withinLimit = (app: AppId, since: number, ids: readonly string[]): SQL =>
  sql`(SELECT count(*) FROM ${notifications} WHERE ${notifications.type} = 'app_message' AND ${notifications.appId} = ${app} AND ${notifications.createdAt} > ${since} AND NOT ${inList(notifications.id, ids)}) + ${ids.length} <= ${appNotificationsPerHour}`;

/** That any of the rows `ids` is there, as SQL. */
const anyOf = (ids: readonly string[]): SQL =>
  sql`EXISTS (SELECT 1 FROM ${notifications} WHERE ${inList(notifications.id, ids)})`;

/** The App acting for the person, as the audit log names it. */
const actorOf = (send: Send): AuditActor =>
  delegateActorOf({
    subject: { type: "app", appId: send.app },
    onBehalfOf: send.principal,
    mode: "interactive",
    appVersion: send.appVersion,
  });

/** The audit event of a send, or of its refusal, with counts and nothing it said. */
const sendEntry = (
  send: Send,
  action: string,
  detail: Record<string, string | number>
) => ({
  actor: actorOf(send),
  action,
  target: { type: "app", id: send.app },
  detail: {
    appVersion: send.appVersion,
    // Whom the App acted for: the actor names the App alone.
    principal: send.principal,
    via: send.via,
    ...(send.agent === null ? {} : { agent: send.agent }),
    ...detail,
  },
});

/**
 * Tells the people `send` names who can open its App (see the header):
 * how many were told, audited either way. Refuses a send past the App's
 * hourly limit whole (`permission.limit_reached`), and one of an App nobody
 * can open now (`permission.unavailable`).
 */
const deliver = async (
  env: Env,
  send: Send
): Promise<AppNotificationReceipt> => {
  const db = drizzle(env.DB);
  const app = await db
    .select({
      id: apps.id,
      owner: apps.ownerId,
      status: apps.status,
      removedAt: apps.removedAt,
    })
    .from(apps)
    .where(eq(apps.id, send.app))
    .get();
  if (app === undefined || app.removedAt !== null) {
    throw functionErrors.create("permission.unavailable");
  }
  const named = await namedBy(env, send.to);
  const asked = named.slice(0, appNotificationMaxRecipients);
  const opened = await openersOf(
    env,
    { id: send.app, owner: app.owner, status: app.status },
    asked
  );
  const rows = await Promise.all(
    asked
      .filter((userId) => opened.has(userId))
      .map(async (userId) => ({
        userId,
        id: await sha256Hex(`${send.key}\n${userId}`),
      }))
  );
  const ids = rows.map(({ id }) => id);
  if (rows.length === 0) {
    await auditedBatch(env, db, [
      outboxed(
        db,
        sendEntry(send, "app.notification.sent", {
          told: 0,
          skipped: named.length,
        })
      ),
    ]);
    return { delivered: 0 };
  }
  const now = Date.now();
  const limit = withinLimit(send.app, now - hourMs, ids);
  // This attempt's own rows, by its time: none for one made again.
  const mine = sql`(SELECT count(*) FROM ${notifications} WHERE ${inList(notifications.id, ids)} AND ${notifications.createdAt} = ${now})`;
  const { title, body } = send.notification;
  const [first, ...rest] = rows.map(({ id, userId }) =>
    db
      .insert(notifications)
      .select(
        sql`SELECT ${id}, ${userId}, 'app_message', ${send.app}, NULL, NULL, ${now}, ${now}, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${title}, ${body ?? null}, NULL WHERE ${activeMember(userId)} AND ${limit}`
      )
      .onConflictDoNothing({ target: notifications.id })
  );
  if (first === undefined) {
    throw new Error("A send with people to tell has no statement");
  }
  // Told by this attempt: logged with how many its rows told. One made
  // again inserts nothing, and logs nothing. Past the limit, nothing went
  // in: the refusal is logged instead. Everyone removed meanwhile: told
  // nobody.
  const sent = createAuditEvent(
    sendEntry(send, "app.notification.sent", { told: 0, skipped: 0 }),
    "core"
  );
  const results = await auditedBatch(env, db, [
    first,
    ...rest,
    db
      .insert(auditOutbox)
      .select(
        sql`SELECT ${sent.id}, json_set(${JSON.stringify(sent)}, '$.detail.told', ${mine}, '$.detail.skipped', ${named.length} - ${mine}), ${Date.now()} WHERE ${mine} > 0`
      ),
    outboxedWhere(
      db,
      sendEntry(send, "app.notification.refused", {
        reason: "permission.limit_reached",
        named: named.length,
      }),
      sql`NOT ${anyOf(ids)} AND NOT (${limit})`
    ),
    outboxedWhere(
      db,
      sendEntry(send, "app.notification.sent", {
        told: 0,
        skipped: named.length,
      }),
      sql`NOT ${anyOf(ids)} AND ${limit}`
    ),
    db
      .select({
        stored: sql<number>`count(*)`,
        within: sql<number>`${limit}`,
      })
      .from(notifications)
      .where(inList(notifications.id, ids)),
  ]);
  // What the batch's last read found: the rows there, and the limit.
  const [outcome] = z
    .tuple([z.object({ stored: z.number(), within: z.number() })])
    .parse(results.at(-1));
  if (outcome.stored === 0 && outcome.within === 0) {
    throw functionErrors.create("permission.limit_reached", { limit: "hour" });
  }
  return { delivered: outcome.stored };
};

/**
 * How core tells people for an invocation acting as `authority` (the App,
 * its version, the person), made by `agent`'s call when an agent made it.
 */
export const appPeopleNotifications = (
  env: Env,
  authority: Authority,
  agent: CallingAgent | null
): PeopleNotifications => {
  const { subject, appVersion, onBehalfOf } = authority;
  if (subject.type !== "app" || appVersion === undefined) {
    throw new Error("Only an App's call tells people.");
  }
  return {
    send: async (to, notification, key) =>
      await deliver(env, {
        ...checkedOf(to, notification),
        app: subject.appId,
        appVersion,
        principal: onBehalfOf,
        agent: agent?.agentId ?? null,
        key: `action:${key}`,
        via: "action",
      }),
    intent: (to, notification) => {
      const intent = {
        ...checkedOf(to, notification),
        app: subject.appId,
        appVersion,
        principal: onBehalfOf,
        agent:
          agent === null
            ? null
            : {
                agentId: agent.agentId,
                workspaceId: agent.workspaceId,
                chatId: agent.chatId,
              },
      };
      // As its dispatch will read it, or not staged at all.
      return notifyIntentSchema.parse(intent);
    },
  };
};

/** Refusals no later attempt would turn into a send. */
const settledRefusals: ReadonlySet<string> = new Set([
  "permission.unavailable",
  "permission.limit_reached",
  "workflow.start_denied",
  "app.not_found",
  "app.unreadable",
  "app.archived",
  "version.revoked",
  "version.not_sealed",
  "role.forbidden",
]);

/**
 * Sends what a committed mutation staged (see the header): delivered once
 * the people it names are told (or skipped); settled undeliverable, with
 * its code and audited, once refused for good (the person it acts for out
 * of the App, an agent's permission gone, the App's hourly limit reached);
 * handed over again later for anything else, audited once its last
 * attempt fails.
 */
export const dispatchAppNotifyIntent = async (
  env: Env,
  entry: Pick<OutboxEntry, "id" | "intent" | "attempts" | "signal">
): Promise<"delivered" | { undeliverable: string }> => {
  const read =
    entry.intent.kind === "app.notify"
      ? notifyIntentSchema.safeParse(entry.intent.data)
      : undefined;
  if (read?.success !== true) {
    log.error("app.notify_intent_unreadable", { entry: entry.id });
    requireLive(entry.signal);
    const db = drizzle(env.DB);
    await auditedBatch(env, db, [
      outboxed(db, {
        actor: { type: "system" },
        action: "app.notify_intent.unreadable",
        target: { type: "outbox_entry", id: entry.id },
        detail: { entry: entry.id },
      }),
    ]);
    return { undeliverable: "outbox.unreadable" };
  }
  const intent = read.data;
  const send: Send = {
    app: intent.app,
    appVersion: intent.appVersion,
    principal: intent.principal,
    agent: intent.agent?.agentId ?? null,
    to: intent.to,
    notification: intent.notification,
    key: `commit:${entry.id}`,
    via: "mutation",
  };
  try {
    requireLive(entry.signal);
    // The person it acts for, the release and an agent's permission, now.
    await requireNotRevoked(env, intent.app, intent.appVersion);
    const member = await memberOf(env.DB, intent.principal);
    if (member === undefined) {
      throw appErrors.create("app.not_found");
    }
    await functionRoles(env, member, intent.app);
    await requireAgentAllowed(env, intent.app, intent.principal, intent.agent);
    requireLive(entry.signal);
    await deliver(env, send);
    return "delivered";
  } catch (error) {
    const code = isExpectedError(error) ? error.code : undefined;
    const db = drizzle(env.DB);
    if (code !== undefined && settledRefusals.has(code)) {
      // The limit's refusal is audited as it is made.
      if (code !== "permission.limit_reached") {
        requireLive(entry.signal);
        await auditedBatch(env, db, [
          outboxed(
            db,
            sendEntry(send, "app.notification.refused", { reason: code })
          ),
        ]);
      }
      return { undeliverable: code };
    }
    if (code === undefined) {
      log.error("app.notify_intent_failed", {
        entry: entry.id,
        ...errorFields(error),
      });
    }
    // Its last attempt: recorded before the outbox gives it up.
    if (entry.attempts + 1 >= defaultMaxAttempts) {
      requireLive(entry.signal);
      await auditedBatch(env, db, [
        outboxed(
          db,
          sendEntry(send, "app.notification.abandoned", {
            reason: code ?? "internal.unexpected",
          })
        ),
      ]);
    }
    throw error;
  }
};
