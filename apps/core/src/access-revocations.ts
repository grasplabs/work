import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
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
// An admin's role reaches every App, so its loss keeps one revocation for
// every App (a null `app_id`), not one per App: the change's batch stays
// one row however many Apps there are, within D1's limits (GRA-650). It is
// expanded, a page of Apps at a time in ID order, into one row per App,
// each page with the cursor that moves past it in one batch, and the
// every-App row goes once the last page is out; each page's rows are told
// at once and kept like any other until their host takes them. None of
// this grants anything: what the person may do is decided by the role the
// change already wrote, which every push checks; the rows only bring the
// clearing of their open screens forward.
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
 * condition on `apps`) once `changed` holds when the statement runs, for
 * `userIds` (everyone, when `null`): so the change and what it must tell
 * commit together, and a database away after the commit loses nothing.
 * The Apps are read at that point of the batch, so put it before anything
 * there that takes away what found them (a removal's team memberships).
 * Only Apps that exist are kept: an App deleted meanwhile gives no row,
 * and never fails the change. Every App, when `reached` is undefined: one
 * row for all of them, however many there are, expanded later
 * (`expandPage`).
 *
 * Returns the rows kept, for `tellKept` to tell straight away.
 */
export const revocationsOf = (
  db: DrizzleD1Database,
  reached: SQL | undefined,
  userIds: readonly string[] | null,
  changed: SQL
) => {
  const people = userIds === null ? null : JSON.stringify(userIds);
  return (
    db
      .insert(accessRevocations)
      // The table's columns, in its order.
      .select(
        reached === undefined
          ? sql`SELECT lower(hex(randomblob(16))), NULL, ${people}, 0, ${Date.now()}, NULL WHERE ${changed}`
          : sql`SELECT lower(hex(randomblob(16))), ${apps.id}, ${people}, 0, ${Date.now()}, NULL FROM ${apps} WHERE ${and(reached, changed)}`
      )
      .returning()
  );
};

/** How many Apps one page of an every-App revocation expands to. */
const expandedAtOnce = 200;

/**
 * Expands the next page of every-App revocation `row`: one row per App
 * after its cursor, up to `expandedAtOnce` in App ID order, written in one
 * batch with the cursor moved past them, or with the row dropped once no
 * App is left after them. Only while the row is still at the cursor read:
 * a page another run expanded meanwhile writes nothing again. Returns the
 * rows written, for `tellKept`.
 */
const expandPage = async (
  env: Env,
  row: KeptRevocation
): Promise<KeptRevocation[]> => {
  const db = drizzle(env.DB);
  const after = row.afterAppId;
  const stillAt = and(
    eq(accessRevocations.id, row.id),
    isNull(accessRevocations.appId),
    after === null
      ? isNull(accessRevocations.afterAppId)
      : eq(accessRevocations.afterAppId, after)
  );
  const page = await db
    .select({ id: apps.id })
    .from(apps)
    .where(after === null ? undefined : gt(apps.id, after))
    .orderBy(asc(apps.id))
    .limit(expandedAtOnce);
  const ids = page.map(({ id }) => id);
  const last = ids.at(-1);
  const moved =
    last === undefined || ids.length < expandedAtOnce
      ? db.delete(accessRevocations).where(stillAt)
      : db.update(accessRevocations).set({ afterAppId: last }).where(stillAt);
  if (ids.length === 0) {
    await moved;
    return [];
  }
  const people = row.userIds === null ? null : JSON.stringify(row.userIds);
  const [expanded] = await db.batch([
    db
      .insert(accessRevocations)
      .select(
        sql`SELECT lower(hex(randomblob(16))), ${apps.id}, ${people}, 0, ${Date.now()}, NULL FROM ${apps} WHERE ${inList(apps.id, ids)} AND EXISTS (SELECT 1 FROM ${accessRevocations} WHERE ${stillAt})`
      )
      .returning(),
    moved,
  ]);
  return expanded;
};

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
      appId: row.appId ?? undefined,
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
      appId: row.appId ?? undefined,
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
  const ofApps = kept.filter(({ appId }) => appId !== null);
  // Each every-App revocation's first page, told now; the cron trigger
  // expands the rest (`retryAccessRevocations`).
  for (const row of kept.filter(({ appId }) => appId === null)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one row's page after the other
      ofApps.push(...(await expandPage(env, row)));
    } catch (error) {
      log.warn("app.access_revocation_expand_failed", errorFields(error));
    }
  }
  for (let at = 0; at < ofApps.length; at += toldAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few hosts at a time
    await Promise.all(
      ofApps.slice(at, at + toldAtOnce).map(async (row) => {
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
      appId: row.appId ?? undefined,
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
 * Drops, logged, every kept revocation of one App a day old, whether or
 * not a run would reach it: one behind many others, or behind a steady
 * stream of new ones, is never kept longer. An every-App revocation is
 * kept until it is expanded: each run moves it on by a page, and each
 * App's row it writes is then kept a day of its own.
 */
const dropExpired = async (env: Env): Promise<void> => {
  const lost = await drizzle(env.DB)
    .delete(accessRevocations)
    .where(
      and(
        isNotNull(accessRevocations.appId),
        lt(accessRevocations.createdAt, new Date(Date.now() - keptForMs))
      )
    )
    .returning({ appId: accessRevocations.appId });
  for (const { appId } of lost) {
    log.error("app.access_revocation_lost", { appId: appId ?? undefined });
  }
};

/** Most every-App revocations one run of the cron trigger expands a page of. */
const expandedRowsAtOnce = 5;

/**
 * Expands a page of each every-App revocation still kept, oldest first,
 * and tells the hosts of the rows written (`tellKept`): what isn't told
 * now is kept, and told by a later run.
 */
const expandKept = async (env: Env): Promise<void> => {
  const everyApp = await drizzle(env.DB)
    .select()
    .from(accessRevocations)
    .where(isNull(accessRevocations.appId))
    .orderBy(asc(accessRevocations.createdAt))
    .limit(expandedRowsAtOnce);
  await tellKept(env, everyApp);
};

/**
 * Tells the hosts of the revocations still kept: those a change kept that
 * weren't told yet (`revocationsOf`), and those a host couldn't be told of
 * (`keepForLater`), least tried first, once those a day old are dropped;
 * and a page more of each every-App revocation (`expandKept`). The cron
 * trigger runs it every minute.
 */
export const retryAccessRevocations = async (env: Env): Promise<void> => {
  await dropExpired(env);
  await expandKept(env);
  const kept = await drizzle(env.DB)
    .select()
    .from(accessRevocations)
    .where(isNotNull(accessRevocations.appId))
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
