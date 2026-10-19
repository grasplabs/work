import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  accessRevocations,
  apps,
  appMembers,
  teamMembers,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { appHost } from "./durable-objects.ts";

// Telling an App's open screens that someone's access to it may have
// dropped (spec 11.4). Our own writes that can take a role in an App away
// (unsharing it or lowering whom it is shared with, app-members.ts; a
// member removed from the organization or given a lower role, members.ts)
// and those that can take an App's data from a build of its screens (an
// approval taken back or its data classified sensitive again,
// screen-trust-rpc.ts; a grant making it sensitive again, permissions.ts;
// its release revoked, release-retention.ts), for everyone of the App,
// keep a revocation for each App they reached in their own batch
// (`revocationsOf`), so it commits with the change or not at all, and tell
// the hosts from those rows once it has (`tellKept`); the cron trigger
// tells again whatever is still kept (`retryAccessRevocations`). Better
// Auth's team endpoints (a team left or deleted, auth/auth.ts) commit in
// the plugin's own batch, so they look the Apps up after it and call
// `accessMayHaveDropped`. The App's host tells each connection of those people that
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
 * `attempt`, run again after `retryDelaysMs` while it fails: a lookup or
 * a host away for a moment is tried once more. Throws what the last
 * attempt threw.
 */
const withRetries = async <T>(attempt: () => Promise<T>): Promise<T> => {
  for (let tried = 0; ; tried += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after the other
      return await attempt();
    } catch (error) {
      const delay = retryDelaysMs[tried];
      if (delay === undefined) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- one attempt after the other
      await scheduler.wait(delay);
    }
  }
};

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
 * have lost their role in them, after a change that couldn't keep its
 * revocations in its own batch committed. A host that still can't be
 * reached after its retries is told again by the cron trigger
 * (`retryAccessRevocations`). No periodic recheck (spec 11.4).
 */
const accessMayHaveDropped = async (
  env: Env,
  reached: Iterable<AppId>,
  userIds: readonly string[] | null
): Promise<void> => {
  const pending = [...new Set(reached)];
  for (let at = 0; at < pending.length; at += toldAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few hosts at a time
    await Promise.all(
      pending.slice(at, at + toldAtOnce).map(async (app) => {
        await tellHost(env, app, userIds);
      })
    );
  }
};

/** A revocation kept in the table, told until its host takes it. */
export type KeptRevocation = typeof accessRevocations.$inferSelect;

/**
 * Keeps, in a change's batch, a revocation for each App `reached` (a
 * condition on `apps`, every App when undefined) once `changed` holds when
 * the statement runs, for `userIds` (everyone, when `null`): so the change
 * and what it must tell commit together, and a database away after the
 * commit loses nothing. The Apps are read at that point of the batch, so
 * put it before anything there that takes away what found them (a
 * removal's team memberships). Only Apps that exist are kept: an App
 * deleted meanwhile gives no row, and never fails the change.
 *
 * Returns the rows kept, for `tellKept` to tell straight away.
 */
export const revocationsOf = (
  db: DrizzleD1Database,
  reached: SQL | undefined,
  userIds: readonly string[] | null,
  changed: SQL
) =>
  db
    .insert(accessRevocations)
    // The table's columns, in its order.
    .select(
      sql`SELECT lower(hex(randomblob(16))), ${apps.id}, ${userIds === null ? null : JSON.stringify(userIds)}, 0, ${Date.now()} FROM ${apps} WHERE ${and(reached, changed)}`
    )
    .returning();

/**
 * Tells the host of one revocation a change kept (`revocationsOf`), and
 * drops the row once it took it. A host that still can't be reached after
 * `retryDelaysMs`, or a row the database won't drop, is left to the cron
 * trigger, which tells it (again): a second word changes nothing.
 */
const tellKeptOne = async (env: Env, row: KeptRevocation): Promise<void> => {
  try {
    await withRetries(async () => {
      await appHost(env, appIdSchema.parse(row.appId)).accessRevoked(
        row.userIds
      );
    });
  } catch (error) {
    log.warn("app.access_revocation_failed", {
      appId: row.appId,
      ...errorFields(error),
    });
    return;
  }
  try {
    await drizzle(env.DB)
      .delete(accessRevocations)
      .where(eq(accessRevocations.id, row.id));
  } catch (error) {
    log.warn("app.access_revocation_keep_failed", {
      appId: row.appId,
      ...errorFields(error),
    });
  }
};

/**
 * Tells the hosts of the revocations a change kept in its batch
 * (`revocationsOf`), a few at a time, from the rows themselves: no read
 * of the database, which may be away. Never throws: the change has
 * committed, and whatever isn't told now the cron trigger tells.
 */
export const tellKept = async (
  env: Env,
  kept: readonly KeptRevocation[]
): Promise<void> => {
  for (let at = 0; at < kept.length; at += toldAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few hosts at a time
    await Promise.all(
      kept.slice(at, at + toldAtOnce).map(async (row) => {
        await tellKeptOne(env, row);
      })
    );
  }
};

/** Most kept revocations one run of the cron trigger tells. */
const retriedAtOnce = 100;

/**
 * How long a kept revocation is told for: a day, counted from when it was
 * kept, however often it was tried. One whose host is away longer
 * is logged and dropped; the screens then fall back on the check before
 * each push.
 */
const keptForMs = 24 * 60 * 60 * 1000;

/** Tells one kept revocation again: dropped once taken. */
const retryOne = async (
  env: Env,
  row: typeof accessRevocations.$inferSelect
): Promise<void> => {
  const db = drizzle(env.DB);
  try {
    await appHost(env, appIdSchema.parse(row.appId)).accessRevoked(row.userIds);
  } catch (error) {
    log.warn("app.access_revocation_retry_failed", {
      appId: row.appId,
      ...errorFields(error),
    });
    // Told again at a later run, behind those tried less often, until
    // it is a day old (`dropExpired`).
    await db
      .update(accessRevocations)
      .set({ attempts: sql`${accessRevocations.attempts} + 1` })
      .where(eq(accessRevocations.id, row.id));
    return;
  }
  await db.delete(accessRevocations).where(eq(accessRevocations.id, row.id));
};

/**
 * Drops, logged, every kept revocation a day old, whether or not a run
 * would reach it: one behind many others, or behind a steady stream of
 * new ones, is never kept longer.
 */
const dropExpired = async (env: Env): Promise<void> => {
  const lost = await drizzle(env.DB)
    .delete(accessRevocations)
    .where(lt(accessRevocations.createdAt, new Date(Date.now() - keptForMs)))
    .returning({ appId: accessRevocations.appId });
  for (const { appId } of lost) {
    log.error("app.access_revocation_lost", { appId });
  }
};

/**
 * Tells the hosts of the revocations still kept: those a change kept that
 * weren't told yet (`revocationsOf`), and those a host couldn't be told of
 * (`keepForLater`), least tried first, once those a day old are dropped.
 * The cron trigger runs it every minute.
 */
export const retryAccessRevocations = async (env: Env): Promise<void> => {
  await dropExpired(env);
  const kept = await drizzle(env.DB)
    .select()
    .from(accessRevocations)
    // The least tried first: one whose host stays away moves behind
    // those not tried yet, so it never holds them back.
    .orderBy(asc(accessRevocations.attempts), asc(accessRevocations.createdAt))
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
const appsSharedWithAnyone = async (env: Env): Promise<AppId[]> => {
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
 *
 * Residual, accepted (GRA-564, GRA-635): a database away for longer than
 * the lookup's retries loses this event, logged. Nothing leaks: every push
 * still checks access first, so nothing new reaches the person; their
 * screen is only cleared later. Our own writes keep it in their batch
 * (`revocationsOf`); Better Auth's team endpoints stay best effort while
 * the plugin is native: our hook runs after its commit, so can't join it.
 */
export const teamAccessMayHaveDropped = async (
  env: Env,
  teamId: string,
  userIds: readonly string[] | null
): Promise<void> => {
  try {
    const [shared, theirs] = await withRetries(
      async () =>
        await Promise.all([
          appsSharedWith(env, teamId),
          userIds === null
            ? appsSharedWithAnyone(env)
            : appsSharedWithPeople(env, userIds),
        ])
    );
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
