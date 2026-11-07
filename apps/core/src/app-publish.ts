import { isAppLayout } from "@grasp-os/compiler";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { appErrors } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import { isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { sealRelease } from "./app-releases.ts";
import { requireAppTestsPass } from "./app-tests.ts";
import {
  changeEntry,
  editableApp,
  findVersion,
  makeCurrent,
  versionFiles,
} from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { createStore } from "./data-stores.ts";
import {
  appDefaultStores,
  appVersions,
  businessStores,
} from "./db/core/schema.ts";
import { requireMigrationEvidence } from "./migration-evidence.ts";

// Publishing a version of an App (spec 8, 16, 22): one function, run by
// one of the App's builders as themselves. It builds and seals the
// version's release on the App's default store, which applies its schema
// to the store as a seal does (app-releases.ts), checks its migrations
// passed on their fixtures, runs its App tests on fixture stores
// (app-tests.ts), marks the version `published`, and makes it current
// (`makeCurrent`), each step audited. A version published already is only
// made current: a rollback runs no tests again.
//
// Threat model: no path makes code current that didn't pass. How each way
// it could fail is closed:
//
// - The base changed: publishing is over the version current when it
//   begins, or over `expected` when the caller says what it expects
//   (`app.conflict` when that isn't current), and `makeCurrent` makes it
//   current only over that version, compared and set in the statement that
//   does it. A version committed or made current meanwhile is a change the
//   publish never saw.
// - The build or a test fails: sealing refuses code that doesn't build,
//   type-check, inspect or migrate, and a failing test refuses the
//   version, before it is marked. Making a version current requires it
//   `published`, in the statement that does it.
// - Two publishes at once: sealing a version twice finds one release
//   (a second manifest is refused, `version.seal_conflict`); marking it
//   twice is the same mark; of two versions made current over one base,
//   the compare and set keeps one, and the other is `app.conflict`.
// - A crash midway: a version is marked only after every check passed,
//   and made current only after it is marked, so a crash leaves it
//   unmarked, or marked and not current; publishing again seals nothing
//   new (the release stored is found) and goes on from there.
// - A release deleted or changed under a published version: the mark
//   holds only while the release it was tested on is stored (its manifest
//   hash, in the statement that marks it), the retention sweep clears it as
//   it deletes the release (release-retention.ts), and making a version
//   current reads its release back from storage, every byte checked.
// - A failure misread as a pass: anything thrown leaves the version
//   unmarked; an expected refusal marks it `failed`, which nothing makes
//   current, and the refusal is thrown as it came.
// - Someone without the right: only the App's builders publish
//   (`editableApp`, and again in `makeCurrent` and `sealRelease`); made
//   current by someone who couldn't grant the App's permissions, its
//   version is unapproved until an admin approves (permissions.ts).
// - A store another App's data is in: no request names a store. The App's
//   one default store is the host's record (`app_default_stores`), created
//   here the first time a version needs one; sealing then claims it for
//   the App for good (`sdk_store_owners`).

/** What a caller may expect is current: a version, or null for none. */
const expectedSchema = z.int().min(1).nullable();

/** The App's default store, if it has one yet, and whether it still lives. */
const defaultStoreOf = async (
  env: Env,
  app: AppId
): Promise<{ store: StoreId; live: boolean } | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      store: appDefaultStores.storeId,
      deletedAt: businessStores.deletedAt,
      exists: businessStores.id,
    })
    .from(appDefaultStores)
    .leftJoin(businessStores, eq(businessStores.id, appDefaultStores.storeId))
    .where(eq(appDefaultStores.appId, app))
    .get();
  return row === undefined
    ? undefined
    : {
        store: storeIdSchema.parse(row.store),
        live: row.exists !== null && row.deletedAt === null,
      };
};

/**
 * The App's default store, created for `by` if it has none, or none that
 * still lives: a deleted default store is replaced by a new one, in one
 * conditional statement, so of two publishes replacing it at once one
 * record wins and both use its store; the other store stays empty and
 * claimed by no App. The versions sealed on the deleted store stay bound
 * to it and are refused as they are made current (`makeCurrent`): their
 * data is gone, and a fresh store isn't it.
 */
const ensureDefaultStore = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<StoreId> => {
  const existing = await defaultStoreOf(env, app);
  if (existing?.live === true) {
    return existing.store;
  }
  const created = await createStore(env, by);
  const db = drizzle(env.DB);
  await (existing === undefined
    ? db
        .insert(appDefaultStores)
        .values({ appId: app, storeId: created, createdAt: new Date() })
        .onConflictDoNothing({ target: appDefaultStores.appId })
    : db
        .update(appDefaultStores)
        .set({ storeId: created, createdAt: new Date() })
        .where(
          and(
            eq(appDefaultStores.appId, app),
            eq(appDefaultStores.storeId, existing.store)
          )
        ));
  const recorded = await defaultStoreOf(env, app);
  if (recorded?.live !== true) {
    throw new Error("The App's default store wasn't recorded");
  }
  return recorded.store;
};

/**
 * Seals `version` of `app` on the App's default store when it has one,
 * and when the App needs one (tables or preferences) but no default store
 * lives yet, on one created now. The sealed manifest's hash.
 */
const sealed = async (
  env: Env,
  by: Identity,
  app: AppId,
  version: number
): Promise<string> => {
  const found = await defaultStoreOf(env, app);
  const store = found?.live === true ? found.store : undefined;
  try {
    const release = await sealRelease(env, { app, version, store, by });
    return release.manifestHash;
  } catch (error) {
    if (
      store !== undefined ||
      !isExpectedError(error) ||
      error.code !== "version.store_unbound"
    ) {
      throw error;
    }
    const created = await ensureDefaultStore(env, by, app);
    const release = await sealRelease(env, {
      app,
      version,
      store: created,
      by,
    });
    return release.manifestHash;
  }
};

/**
 * Builds, seals and tests `version` of `app` for `by`, then marks it
 * `published` while the release it tested is stored, audited with it. An
 * expected refusal marks it `failed`, audited, and is thrown.
 */
const publish = async (
  env: Env,
  by: Identity,
  app: AppId,
  version: number
): Promise<void> => {
  const db = drizzle(env.DB);
  const files = await versionFiles(env, app, version);
  let manifestHash: string | null = null;
  try {
    if (isAppLayout(files)) {
      manifestHash = await sealed(env, by, app, version);
      await requireMigrationEvidence(env, app, version);
      await requireAppTestsPass(env, app, version, files);
    }
  } catch (error) {
    if (isExpectedError(error)) {
      await auditedBatch(env, db, [
        db
          .update(appVersions)
          .set({ status: "failed" })
          .where(
            and(
              eq(appVersions.appId, app),
              eq(appVersions.version, version),
              // A publish that passed meanwhile stands.
              sql`${appVersions.status} IS NOT 'published'`
            )
          ),
        outboxedIfChanged(
          db,
          changeEntry(by, "app.version.publish_failed", app, {
            version,
            code: error.code,
          })
        ),
      ]);
    }
    throw error;
  }
  const [marked] = await auditedBatch(env, db, [
    db
      .update(appVersions)
      .set({ status: "published" })
      .where(
        and(
          eq(appVersions.appId, app),
          eq(appVersions.version, version),
          // Only while the release it tested is stored: one the sweep
          // deleted since leaves it unmarked.
          manifestHash === null
            ? undefined
            : sql`EXISTS (SELECT 1 FROM sdk_release_manifests
                WHERE app_id = ${app} AND version = ${version}
                  AND manifest_hash = ${manifestHash})`
        )
      )
      .returning({ version: appVersions.version }),
    outboxedIfChanged(
      db,
      changeEntry(by, "app.version.published", app, {
        version,
        manifestHash,
      })
    ),
  ]);
  if (marked.length === 0) {
    throw versionErrors.create("version.unpublished");
  }
};

/**
 * Makes `version` of `app` the one that runs, for one of its builders:
 * published first unless it is already (see the header), then made
 * current over the version current now, or over `expected` when the
 * caller says what it expects is current (`app.conflict` when it isn't).
 * A version current already is answered as it is.
 */
export const publishVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown,
  expected?: unknown
): Promise<App> => {
  // An archived App is read-only until a builder restores it (app-status.ts).
  const found = await editableApp(env, by, app);
  const row = await findVersion(env, found.id, version);
  if (found.currentVersion === row.version) {
    return found;
  }
  const basedOn =
    expected === undefined
      ? found.currentVersion
      : appErrors.parse("app.invalid", expectedSchema, expected);
  if (basedOn !== found.currentVersion) {
    throw appErrors.create("app.conflict");
  }
  if (row.status !== "published") {
    await publish(env, by, found.id, row.version);
  }
  return await makeCurrent(env, by, found.id, row.version, basedOn);
};
