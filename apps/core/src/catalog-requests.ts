import { actorOf } from "@grasp-os/shared/audit";
import {
  appRequestSchema,
  appRequestsListed,
  connectionErrors,
} from "@grasp-os/shared/connect";
import type { AppRequest } from "@grasp-os/shared/connect";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { appRequests, users } from "./db/core/schema.ts";

// Apps people asked Grasp to add, as the catalog doesn't have them: for
// Grasp to see what the client misses, and for the integrations page to
// show what was asked for already. Anyone in the organization asks, and
// sees what everyone asked; Grasp staff aren't in it, so they ask for
// nothing. The same app asked for twice, by its name in any case, is one
// request: the first. Asking is audited by the request's ID only, as the
// name and the why are what someone typed.

/** A request as the list reads it, with its asker's name. */
const requestColumns = {
  id: appRequests.id,
  name: appRequests.name,
  why: appRequests.why,
  url: appRequests.url,
  userId: appRequests.requestedBy,
  userName: users.name,
  requestedAt: appRequests.requestedAt,
};

interface RequestRow {
  id: string;
  name: string;
  why: string | null;
  url: string | null;
  userId: string;
  userName: string | null;
  requestedAt: Date;
}

const requestOf = (row: RequestRow): AppRequest => ({
  id: row.id,
  name: row.name,
  why: row.why,
  url: row.url,
  requestedBy: { userId: row.userId, name: row.userName },
  requestedAt: row.requestedAt.toISOString(),
});

/** Asks for the app `request` names as `by`; the first request for it if one was made. */
export const requestApp = async (
  env: Env,
  by: Identity,
  request: unknown
): Promise<AppRequest> => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const { name, why, url } = connectionErrors.parse(
    "connection.invalid",
    appRequestSchema,
    request
  );
  const nameKey = name.toLowerCase();
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(appRequests)
      .values({
        id,
        name,
        nameKey,
        why: why === undefined || why === "" ? null : why,
        url: url ?? null,
        requestedBy: by.userId,
        requestedAt: new Date(),
      })
      .onConflictDoNothing(),
    // Only a new request is recorded.
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "connection.app_requested",
      target: { type: "app_request", id },
    }),
  ]);
  const [row] = await db
    .select(requestColumns)
    .from(appRequests)
    .leftJoin(users, eq(users.id, appRequests.requestedBy))
    .where(eq(appRequests.nameKey, nameKey));
  if (row === undefined) {
    throw new Error("An app request was stored and is gone");
  }
  return requestOf(row);
};

/** The apps people asked for, latest first. */
export const listAppRequests = async (env: Env): Promise<AppRequest[]> => {
  const rows = await drizzle(env.DB)
    .select(requestColumns)
    .from(appRequests)
    .leftJoin(users, eq(users.id, appRequests.requestedBy))
    .orderBy(desc(appRequests.requestedAt), desc(appRequests.id))
    .limit(appRequestsListed);
  return rows.map(requestOf);
};
