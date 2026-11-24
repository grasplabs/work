import { actorOf } from "@grasp-os/shared/audit";
import {
  appRequestSchema,
  appRequestsListed,
  connectionErrors,
} from "@grasp-os/shared/connect";
import type { AppRequest } from "@grasp-os/shared/connect";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { appRequestAskers, appRequests, users } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// Apps people asked Grasp to add, as the catalog doesn't have them: for
// Grasp to see what the client misses, and for the integrations page to
// show what was asked for already. Anyone in the organization asks, and
// sees what everyone asked, with who asked; Grasp staff aren't in it, so
// they ask for nothing. The same app asked for twice, by its name in any
// case, is one request: the first, as the first to ask wrote it. Whoever
// asks for it after is added to it as an asker, once, and what they wrote
// isn't kept. Asking is audited by the request's ID only, as the name and
// the why are what someone typed.

/** A request as the list reads it, with its first asker's name. */
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

/**
 * The requests of `rows` with their askers: the first, who is on the
 * request itself, then those who asked after, in the order they asked.
 */
const withAskers = async (
  db: DrizzleD1Database,
  rows: readonly RequestRow[]
): Promise<AppRequest[]> => {
  const later = await db
    .select()
    .from(appRequestAskers)
    // One bound value however many: D1 binds at most 100.
    .where(
      inList(
        appRequestAskers.requestId,
        rows.map(({ id }) => id)
      )
    )
    .orderBy(asc(appRequestAskers.askedAt), asc(appRequestAskers.userId));
  const askers = new Map<string, AppRequest["askers"]>(
    rows.map((row) => [
      row.id,
      [{ userId: row.userId, askedAt: row.requestedAt.toISOString() }],
    ])
  );
  for (const { requestId, userId, askedAt } of later) {
    askers.get(requestId)?.push({ userId, askedAt: askedAt.toISOString() });
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    why: row.why,
    url: row.url,
    requestedBy: { userId: row.userId, name: row.userName },
    requestedAt: row.requestedAt.toISOString(),
    askers: askers.get(row.id) ?? [],
  }));
};

/**
 * Asks for the app `request` names as `by`: a new request, or the one
 * made for it already, with `by` among its askers.
 */
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
  const now = new Date();
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
        requestedAt: now,
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
  // Someone else's request for it: theirs stands, and `by` joins its
  // askers. Recorded the first time only, as asking again changes nothing.
  if (row.userId !== by.userId) {
    await auditedBatch(env, db, [
      db
        .insert(appRequestAskers)
        .values({ requestId: row.id, userId: by.userId, askedAt: now })
        .onConflictDoNothing(),
      outboxedIfChanged(db, {
        actor: actorOf(by),
        action: "connection.app_requested",
        target: { type: "app_request", id: row.id },
      }),
    ]);
  }
  const [asked] = await withAskers(db, [row]);
  if (asked === undefined) {
    throw new Error("An app request was read and is gone");
  }
  return asked;
};

/** The apps people asked for, latest first. */
export const listAppRequests = async (env: Env): Promise<AppRequest[]> => {
  const db = drizzle(env.DB);
  const rows = await db
    .select(requestColumns)
    .from(appRequests)
    .leftJoin(users, eq(users.id, appRequests.requestedBy))
    .orderBy(desc(appRequests.requestedAt), desc(appRequests.id))
    .limit(appRequestsListed);
  return await withAskers(db, rows);
};

/**
 * The apps people asked for, oldest first, as Grasp's admin reads them
 * (admin-snapshot.ts): each by its name and when, never why, its link or
 * who asked.
 */
export const appsAsked = async (
  env: Env
): Promise<{ id: string; name: string; askedAt: string }[]> => {
  const rows = await drizzle(env.DB)
    .select({
      id: appRequests.id,
      name: appRequests.name,
      requestedAt: appRequests.requestedAt,
    })
    .from(appRequests)
    .orderBy(asc(appRequests.requestedAt), asc(appRequests.id))
    .limit(appRequestsListed);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    askedAt: row.requestedAt.toISOString(),
  }));
};
