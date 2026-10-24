import { actorOf } from "@grasp-os/shared/audit";
import { connectionErrors, pointAppSchema } from "@grasp-os/shared/connect";
import type { AppPointerSetting } from "@grasp-os/shared/connect";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { appPointers, teams } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { audienceOf, storedOf, storedTeamsSchema } from "./tool-classes.ts";

// The company apps an admin points Stephen at, and for whom (GRA-725):
// reading in a company app (a Composio toolkit's connection) is Read
// company, which an admin turns on app by app, for everyone or some teams,
// and within some of its resources (a pipeline, a ticket queue, a
// register) or the whole app. Core refuses the chat's agent's reads in an
// app nobody pointed it at for its person (tool-classes.ts), and signs the
// resources into the capability of those it lets through, which connect
// holds them to (connect's app-pointers.ts). Changes there follow the
// company's classes and wait for their person's press. The ways it can
// fail, which the tests start from: a read in an app not pointed at, or by
// someone the pointer doesn't take in; a read of another resource; a
// pointer at a native or unknown connection; a change made by someone who
// isn't the company's own admin (Grasp staff included), or without a trace.

/** Off, for a row that can't be read: never more than the admin chose. */
const nobody = { who: "nobody" } as const;

/** A stored row's resources, or `undefined` for what it can't read. */
const storedResources = (stored: string): string[] | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return undefined;
  }
  return storedTeamsSchema.safeParse(value).data;
};

/** Every company app an admin pointed Stephen at, and for whom. */
export const readAppPointers = async (
  env: Env
): Promise<AppPointerSetting[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(appPointers)
    .orderBy(appPointers.connectionId);
  return rows.map((row) => {
    const resources = storedResources(row.resources);
    return {
      connectionId: row.connectionId,
      resources: resources ?? [],
      audience: audienceOf(row) ?? nobody,
      changedBy: row.changedBy,
      changedAt: row.changedAt.toISOString(),
    };
  });
};

/**
 * Points Stephen at a company app (`PointApp`). Admins only, never Grasp
 * staff; each change audited, and one that changes nothing records
 * nothing. Throws `connection.invalid` for a request that isn't one, a
 * connection that isn't a company app's, or a team the company doesn't
 * have.
 */
export const pointApp = async (
  env: Env,
  identity: Identity,
  request: unknown
): Promise<void> => {
  requireAdmin(identity);
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const parsed = pointAppSchema.safeParse(request);
  if (!parsed.success) {
    throw connectionErrors.create("connection.invalid");
  }
  const { connectionId, audience } = parsed.data;
  const [owner] = await env.CONNECT.connectionOwners([connectionId]);
  if (owner?.source !== "composio") {
    throw connectionErrors.create("connection.invalid");
  }
  const stored = storedOf(audience);
  const teamIds = storedTeamsSchema.parse(JSON.parse(stored.teams));
  const db = drizzle(env.DB);
  if (teamIds.length > 0) {
    const known = await db
      .select({ id: teams.id })
      .from(teams)
      .where(inList(teams.id, teamIds));
    if (known.length !== teamIds.length) {
      throw connectionErrors.create("connection.invalid");
    }
  }
  const resources = JSON.stringify(
    [...new Set(parsed.data.resources)].toSorted()
  );
  const detail: Record<string, string> = {
    connectionId,
    who: stored.who,
    resources,
  };
  for (const [index, team] of teamIds.entries()) {
    detail[`team${index + 1}`] = team;
  }
  const changedAt = new Date();
  await auditedBatch(env, db, [
    db
      .insert(appPointers)
      .values({
        connectionId,
        resources,
        ...stored,
        changedBy: identity.userId,
        changedAt,
      })
      .onConflictDoUpdate({
        target: appPointers.connectionId,
        set: { resources, ...stored, changedBy: identity.userId, changedAt },
        // Only a different pointer is a change: the same one again leaves
        // the row, and so the log, as it was.
        setWhere: or(
          sql`${appPointers.who} IS NOT ${stored.who}`,
          sql`${appPointers.teams} IS NOT ${stored.teams}`,
          sql`${appPointers.resources} IS NOT ${resources}`
        ),
      }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "connection.app.pointed",
      target: { type: "connection", id: connectionId },
      detail,
    }),
  ]);
};
