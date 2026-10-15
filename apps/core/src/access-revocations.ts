import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appMembers } from "./db/core/schema.ts";
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
 * `accessMayHaveDropped` for the Apps shared with team `teamId`, after
 * `userIds` left it, or everyone in it was let go of with it (`null`).
 * Never throws: Better Auth's change has committed already.
 */
export const teamAccessMayHaveDropped = async (
  env: Env,
  teamId: string,
  userIds: readonly string[] | null
): Promise<void> => {
  try {
    await accessMayHaveDropped(env, await appsSharedWith(env, teamId), userIds);
  } catch (error) {
    log.error("app.access_revocation_failed", errorFields(error));
  }
};
