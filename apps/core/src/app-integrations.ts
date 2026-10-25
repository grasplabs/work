import { appLimits } from "@grasp-os/shared/app-limits";
import { appErrors } from "@grasp-os/shared/apps";
import type {
  AppIntegration,
  AppIntegrationReason,
  AppIntegrationsApi,
} from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { catalogEntryRefSchema } from "@grasp-os/shared/connect";
import type { CatalogEntryRef } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appFor } from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { connectionOwnersOf, entryKey } from "./connections.ts";
import { appIntegrations, permissions } from "./db/core/schema.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The integrations an App works with, as its cards and settings show them:
// the catalog entries of the connections it holds a permission on (asked
// for or granted, as its Integrations tab counts them), and those its
// builders added by hand for what it needs besides. Adding one is a note
// on the App: it grants nothing, connects nothing and asks for nothing,
// so the App's code still asks for a permission to use it. Listed to
// anyone with a role in the App, as entries only: which connection, and
// whose, stays with those who may list its permissions.

/** The rows of App `app`'s integration `entry`, as a condition. */
const rowOf = (app: string, entry: CatalogEntryRef) =>
  and(
    eq(appIntegrations.appId, app),
    eq(appIntegrations.source, entry.source),
    eq(appIntegrations.connectorId, entry.id)
  );

/** The connections App `app` holds a permission on, asked for or granted. */
const heldConnections = async (env: Env, app: string): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .selectDistinct({ id: permissions.objectId })
    .from(permissions)
    .where(
      and(
        eq(permissions.subjectType, "app"),
        eq(permissions.subjectId, app),
        eq(permissions.objectType, "connection"),
        ne(permissions.status, "revoked")
      )
    );
  return rows.map(({ id }) => id);
};

/**
 * App `app`'s integrations, each once with why it is the App's, by source
 * and ID; the page puts them in the catalog's order. A connection since
 * disconnected, or one connect doesn't know, names none.
 */
export const listIntegrations = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppIntegration[]> => {
  const found = await appFor(env, by, app, "user");
  const [added, held] = await Promise.all([
    drizzle(env.DB)
      .select({
        source: appIntegrations.source,
        id: appIntegrations.connectorId,
      })
      .from(appIntegrations)
      .where(eq(appIntegrations.appId, found.id)),
    heldConnections(env, found.id),
  ]);
  const owners = await connectionOwnersOf(env, held);
  const byKey = new Map<string, AppIntegration>();
  const note = (entry: CatalogEntryRef, why: AppIntegrationReason): void => {
    const key = entryKey(entry.source, entry.id);
    const known = byKey.get(key);
    if (known === undefined) {
      byKey.set(key, { ...entry, why: [why] });
    } else if (!known.why.includes(why)) {
      known.why.push(why);
    }
  };
  for (const { source, provider, status } of owners) {
    if (status !== "disconnected") {
      note({ source, id: provider }, "permission");
    }
  }
  for (const entry of added) {
    note(entry, "added");
  }
  return [...byKey.entries()]
    .toSorted(([one], [other]) => (one < other ? -1 : 1))
    .map(([, integration]) => integration);
};

/**
 * Adds `entry` to App `app`'s integrations by hand, for its builders, at
 * most `appLimits.addedIntegrations` of them. Adding one it has changes
 * and records nothing; otherwise audited as `app.integration.added`.
 */
export const addIntegration = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown
): Promise<void> => {
  const found = await appFor(env, by, app, "builder");
  const entry = appErrors.parse("app.invalid", catalogEntryRefSchema, input);
  const db = drizzle(env.DB);
  const count = sql`(SELECT count(*) FROM ${appIntegrations} WHERE ${appIntegrations.appId} = ${found.id})`;
  const [inserted] = await auditedBatch(env, db, [
    db
      .insert(appIntegrations)
      .select(
        sql`SELECT ${found.id}, ${entry.source}, ${entry.id}, ${by.userId}, ${Date.now()}
          WHERE ${count} < ${appLimits.addedIntegrations}`
      )
      .onConflictDoNothing()
      .returning({ appId: appIntegrations.appId }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "app.integration.added",
      target: { type: "app", id: found.id },
      detail: { source: entry.source, provider: entry.id },
    }),
  ]);
  if (inserted.length > 0) {
    return;
  }
  const there = await db
    .select({ appId: appIntegrations.appId })
    .from(appIntegrations)
    .where(rowOf(found.id, entry))
    .get();
  if (there === undefined) {
    throw appErrors.create("app.integrations_full");
  }
};

/**
 * Takes `entry`, added by hand, off App `app`'s integrations, for its
 * builders: its permissions, if it holds any, stay. Taking off one it
 * doesn't have changes and records nothing; otherwise audited as
 * `app.integration.removed`.
 */
export const removeIntegration = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown
): Promise<void> => {
  const found = await appFor(env, by, app, "builder");
  const entry = appErrors.parse("app.invalid", catalogEntryRefSchema, input);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.delete(appIntegrations).where(rowOf(found.id, entry)),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "app.integration.removed",
      target: { type: "app", id: found.id },
      detail: { source: entry.source, provider: entry.id },
    }),
  ]);
};

/** A signed-in person's `apps.integrations`. */
export class AppIntegrationsRpc
  extends CoreRpcTarget
  implements AppIntegrationsApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(app: string): Promise<AppIntegration[]> {
    return await withPerson(
      this.#check,
      async (by) => await listIntegrations(this.#env, by, app)
    );
  }

  async add(app: string, entry: CatalogEntryRef): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await addIntegration(this.#env, by, app, entry);
    });
  }

  async remove(app: string, entry: CatalogEntryRef): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await removeIntegration(this.#env, by, app, entry);
    });
  }
}
