import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appMembers, teamMembers } from "./db/core/schema.ts";
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
 * Tells the hosts of `apps` that `userIds` (everyone, when `null`) may
 * have lost their role in them. Best effort, after the change committed:
 * a host that can't be reached is logged, and its screens fall back on
 * the check before each push (query-subscriptions.ts).
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
        try {
          await appHost(env, app).accessRevoked(userIds);
        } catch (error) {
          log.error("app.access_revocation_failed", {
            appId: app,
            ...errorFields(error),
          });
        }
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
