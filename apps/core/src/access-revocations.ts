import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  accessRevocations,
  appMembers,
  teamMembers,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { appHost } from "./durable-objects.ts";

// Telling an App's open screens that someone's access to it may have
// dropped (spec 11.4): every write that can take a role in an App away
// (unsharing it or lowering whom it is shared with, app-members.ts; a team
// left or deleted, auth/auth.ts; a member removed from the organization or
// given a lower role, members.ts) calls `accessMayHaveDropped` once it has
// committed. The App's host tells each connection of those people that
// follows the App's live queries, and the connection checks their access
// again at once (query-subscriptions.ts): a screen of someone who lost it
// is cleared within the event's delivery, with no commit and no periodic
// recheck needed.
//
// The event says only "look again", never who lost what: the connection's
// own check, read now, decides. So an event that names too many people,
// arrives late or twice, or comes from anywhere else changes nothing for
// someone who still has their role. Only core reaches an App's host.

/** How many Apps' hosts are told at once. */
const toldAtOnce = 16;

/**
 * How long to wait before telling a host again that couldn't be reached:
 * a host that is away for a moment is told within a second.
 */
const retryDelaysMs = [100, 500] as const;

/**
 * Keeps a revocation `app`'s host couldn't be told of, for the cron
 * trigger to tell it again (`retryAccessRevocations`). A database away
 * too is logged: the screens then fall back on the check before each push.
 */
const keepForLater = async (
  env: Env,
  app: AppId,
  userIds: readonly string[] | null
): Promise<void> => {
  try {
    await drizzle(env.DB)
      .insert(accessRevocations)
      .values({
        id: crypto.randomUUID(),
        appId: app,
        userIds: userIds === null ? null : [...userIds],
        createdAt: new Date(),
      });
  } catch (error) {
    log.error("app.access_revocation_lost", {
      appId: app,
      ...errorFields(error),
    });
  }
};

/**
 * Tells `app`'s host, trying again after `retryDelaysMs` while it can't
 * be reached. A host that restarted meanwhile let go of every connection
 * it held, and each of those looks again on its own (query-subscriptions.ts).
 */
const tellHost = async (
  env: Env,
  app: AppId,
  userIds: readonly string[] | null
): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after the other
      await appHost(env, app).accessRevoked(userIds);
      return;
    } catch (error) {
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) {
        log.error("app.access_revocation_failed", {
          appId: app,
          ...errorFields(error),
        });
        // oxlint-disable-next-line no-await-in-loop -- the last attempt, then out
        await keepForLater(env, app, userIds);
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- one attempt after the other
      await scheduler.wait(delay);
    }
  }
};

/**
 * Tells the hosts of `apps` that `userIds` (everyone, when `null`) may
 * have lost their role in them, after the change committed. A host that
 * still can't be reached after its retries is told again by the cron
 * trigger (`retryAccessRevocations`). No periodic recheck (spec 11.4).
 */
export const accessMayHaveDropped = async (
  env: Env,
  apps: Iterable<AppId>,
  userIds: readonly string[] | null
): Promise<void> => {
  const pending = [...new Set(apps)];
  for (let at = 0; at < pending.length; at += toldAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few hosts at a time
    await Promise.all(
      pending.slice(at, at + toldAtOnce).map(async (app) => {
        await tellHost(env, app, userIds);
      })
    );
  }
};

/** Most kept revocations one run of the cron trigger tells. */
const retriedAtOnce = 100;

/**
 * How many runs of the cron trigger (one a minute) a kept revocation is
 * told again for: a day. One whose host is away longer is logged and
 * dropped; the screens then fall back on the check before each push.
 */
const maxRetries = 24 * 60;

/** Tells one kept revocation again: dropped once taken, or past its retries. */
const retryOne = async (
  env: Env,
  row: typeof accessRevocations.$inferSelect
): Promise<void> => {
  const db = drizzle(env.DB);
  const app = appIdSchema.parse(row.appId);
  const drop = db
    .delete(accessRevocations)
    .where(eq(accessRevocations.id, row.id));
  try {
    await appHost(env, app).accessRevoked(row.userIds);
    await drop;
  } catch (error) {
    if (row.attempts + 1 < maxRetries) {
      await db
        .update(accessRevocations)
        .set({ attempts: sql`${accessRevocations.attempts} + 1` })
        .where(eq(accessRevocations.id, row.id));
      return;
    }
    log.error("app.access_revocation_lost", {
      appId: app,
      ...errorFields(error),
    });
    await drop;
  }
};

/**
 * Tells the hosts again of the revocations they couldn't be told of
 * (`keepForLater`), oldest first. The cron trigger runs it every minute.
 */
export const retryAccessRevocations = async (env: Env): Promise<void> => {
  const kept = await drizzle(env.DB)
    .select()
    .from(accessRevocations)
    .orderBy(asc(accessRevocations.createdAt))
    .limit(retriedAtOnce);
  for (let at = 0; at < kept.length; at += toldAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few hosts at a time
    await Promise.all(
      kept.slice(at, at + toldAtOnce).map(async (row) => {
        await retryOne(env, row);
      })
    );
  }
};

/** The Apps shared with team `teamId`. */
const appsSharedWith = async (env: Env, teamId: string): Promise<AppId[]> => {
  const rows = await drizzle(env.DB)
    .select({ appId: appMembers.appId })
    .from(appMembers)
    .where(
      and(eq(appMembers.memberType, "team"), eq(appMembers.memberId, teamId))
    );
  return rows.map(({ appId }) => appIdSchema.parse(appId));
};

/**
 * The Apps shared with any of `userIds`, as a person or through a team
 * they are in now. Leaving a team can take those away too, though none
 * is shared with that team: one that read a collection only that team
 * may read is refused to them from then on (app-provenance.ts).
 */
const appsSharedWithPeople = async (
  env: Env,
  userIds: readonly string[]
): Promise<AppId[]> => {
  if (userIds.length === 0) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .selectDistinct({ appId: appMembers.appId })
    .from(appMembers)
    .where(
      or(
        and(
          eq(appMembers.memberType, "person"),
          inList(appMembers.memberId, userIds)
        ),
        and(
          eq(appMembers.memberType, "team"),
          inArray(
            appMembers.memberId,
            drizzle(env.DB)
              .select({ teamId: teamMembers.teamId })
              .from(teamMembers)
              .where(inList(teamMembers.userId, userIds))
          )
        )
      )
    );
  return rows.map(({ appId }) => appIdSchema.parse(appId));
};

/** Every App shared with someone: whom a change of unknown people may reach. */
export const appsSharedWithAnyone = async (env: Env): Promise<AppId[]> => {
  const rows = await drizzle(env.DB)
    .selectDistinct({ appId: appMembers.appId })
    .from(appMembers);
  return rows.map(({ appId }) => appIdSchema.parse(appId));
};

/**
 * `accessMayHaveDropped` once `userIds` left team `teamId`: the Apps
 * shared with the team, and those shared with them otherwise, whose
 * provenance the team may have been what let them read. Who left unknown
 * (`null`): every App shared with anyone, for everyone. Never throws:
 * Better Auth's change has committed already.
 */
export const teamAccessMayHaveDropped = async (
  env: Env,
  teamId: string,
  userIds: readonly string[] | null
): Promise<void> => {
  try {
    const [shared, theirs] = await Promise.all([
      appsSharedWith(env, teamId),
      userIds === null
        ? appsSharedWithAnyone(env)
        : appsSharedWithPeople(env, userIds),
    ]);
    await accessMayHaveDropped(env, [...shared, ...theirs], userIds);
  } catch (error) {
    log.error("app.access_revocation_failed", errorFields(error));
  }
};

/**
 * `teamAccessMayHaveDropped` once team `teamId` is deleted, for everyone:
 * who was in it can't be read now, and a snapshot read before could miss
 * someone who joined meanwhile. A team is deleted rarely; every App
 * shared with anyone looks again.
 */
export const teamGone = async (env: Env, teamId: string): Promise<void> => {
  await teamAccessMayHaveDropped(env, teamId, null);
};
