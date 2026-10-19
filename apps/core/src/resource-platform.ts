import type { AppId, PermissionId } from "@grasp-os/shared/ids";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { permissions } from "./db/core/schema.ts";

// The App's `{ type: "platform" }` permissions, as a statistics or guests
// binding names one (resource-statistics.ts, resource-guests.ts): one
// action each, which an admin granted the App itself, never a chat's.

/** What the platform offers an App that a binding may name. */
export type PlatformAction = "statistics" | "guests";

/** App `app`'s own active permissions of `action`, as one condition. */
const ownActive = (app: AppId, action: PlatformAction) =>
  and(
    eq(permissions.subjectType, "app"),
    eq(permissions.subjectId, app),
    eq(permissions.objectType, "platform"),
    eq(permissions.status, "active"),
    isNull(permissions.chatId),
    sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value = ${action})`
  );

/**
 * Whether `permissionId` is App `app`'s own active permission of `action`,
 * as it stands now.
 */
export const platformGrantOf = async (
  env: Env,
  app: AppId,
  permissionId: PermissionId,
  action: PlatformAction
): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ id: permissions.id })
    .from(permissions)
    .where(and(eq(permissions.id, permissionId), ownActive(app, action)))
    .get();
  return row !== undefined;
};

/**
 * App `app`'s own active permissions of `action`, newest first, at most
 * `limit`: what a binding may name.
 */
export const platformGrantsOf = async (
  env: Env,
  app: AppId,
  action: PlatformAction,
  limit: number
): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .select({ id: permissions.id })
    .from(permissions)
    .where(ownActive(app, action))
    .orderBy(desc(permissions.grantedAt))
    .limit(limit);
  return rows.map(({ id }) => id);
};
