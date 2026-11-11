import { manifestText } from "@grasp-os/runtime/host";
import { appErrors } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";

import type { Release } from "./app-releases.ts";
import { changeEntry, editableApp, findApp, releaseIdsOf } from "./apps.ts";
import { appendAuditEvent } from "./audit-outbox.ts";
import { liveStoreOf, openStore, resetAppStore } from "./data-stores.ts";
import { runMigrations } from "./migration-run.ts";
import { requireMemberAdmin } from "./permissions.ts";
import type { AppliedSchema, SchemaApply } from "./store-host.ts";

// A version's schema applied to its App's store as the version is made
// current, by a publish or a rollback alike (apps.ts, `makeCurrent`): the
// one step that changes what the store holds. Its migrations, those from
// the schema the store holds, run first, once, their output staged in the
// store (migration-run.ts); then the store diffs the version's schema
// against what it holds, by the stable IDs of the version's own
// definition (apps.ts), and applies it with that output in one transaction
// (store-host.ts, `applySchema`). A failure anywhere changes nothing.
//
// What can go wrong, and how each is closed:
//
// - A migration fails midway, or the store refuses the change: nothing
//   staged is applied, the store keeps the schema it held, and the version
//   isn't made current (the caller's batch runs only after this).
// - Two publishes at once: the store applies a version's schema only over
//   the version current as its publish began (`version.basedOn`), so of
//   two over one base, the second is refused (`migration.busy`) while the
//   first makes its version current.
// - A record changes while its migration runs: each output is applied
//   only at the revision it was read at, in the transaction, so the
//   change refuses (`migration.busy`) rather than lose the write.
// - Core's batch fails after the store took the schema (a D1 error, a
//   lost compare-and-set, an archive): the store would hold a version
//   that isn't current, and refuse the current one's reads and writes
//   (`migration.not_current`). So a failed batch puts the current
//   version's schema back at once (`unfinishedPublish`, over the version
//   it applied, so nothing else's publish is in the way). Where it can't
//   (the version migrated or narrowed a field), or the publish stopped
//   before it could, the publish is unfinished: refused loudly and
//   audited, the store's refusal names the version it holds, and
//   publishing that version again finishes it, the store holding its
//   schema already.
// - A rollback after a schema change: the older version's schema is
//   applied like any other. Fields and tables it leaves out keep their
//   values, so making the newer version current again finds them.
// - The IDs aren't the ones the release was sealed with: they come from
//   the version's definition, immutable and read back by its hash, which
//   must be the hash the release names (`definitionHash`); and its
//   schema is generated from the very definition its IDs come from.

/**
 * The change applying `release`'s schema over version `basedOn`, for
 * `by`: its schema, its IDs from the version's own definition, and its
 * answers; no migration.
 */
const schemaApplyOf = async (
  env: Env,
  by: Identity,
  release: Release,
  basedOn: number | null
): Promise<SchemaApply> => {
  const app = appIdSchema.parse(release.manifest.resourceId);
  const version = release.manifest.resourceVersion;
  return {
    manifest: manifestText(release.app.schema),
    ids: await releaseIdsOf(env, release),
    answers: (release.app.answers ?? []).map((answer) => ({ ...answer })),
    actor: actorOf(by),
    version: { app, number: version, basedOn },
  };
};

/**
 * Applies the schema of `release` (a version's, read back from storage,
 * every byte checked) to its store for `by`, over the version current as
 * the publish began (`basedOn`): its migrations run, then the change
 * applied (see the header). A version with no tables binds no store, yet
 * its schema (none) is applied to the App's store all the same, so the
 * store's version is always the current one's and its tables are kept.
 * Null for an App without a store.
 */
export const applyVersionSchema = async (
  env: Env,
  by: Identity,
  release: Release,
  basedOn: number | null,
  onlyIfAppliedAt?: number
): Promise<AppliedSchema | null> => {
  const storeId =
    release.store?.storeId ??
    (await liveStoreOf(env, appIdSchema.parse(release.manifest.resourceId)));
  if (storeId === null) {
    return null;
  }
  const change = await schemaApplyOf(env, by, release, basedOn);
  const store = await openStore(env, storeId);
  const migration = await runMigrations(env, store, release, change.ids);
  return await store.applySchema({
    ...change,
    ...(onlyIfAppliedAt === undefined ? {} : { onlyIfAppliedAt }),
    ...(migration === undefined ? {} : { migration }),
  });
};

/**
 * Audits a publish left unfinished (`unfinishedPublish`), straight to the
 * log: core's database may be what failed it.
 */
const recordUnfinished = async (
  env: Env,
  by: Identity,
  app: AppId,
  detail: { version: number; current: number; code: string }
): Promise<void> => {
  try {
    await appendAuditEvent(
      env,
      changeEntry(by, "app.version.unfinished", app, detail)
    );
  } catch (error) {
    log.error("app.publish_unfinished_unrecorded", {
      app,
      ...detail,
      ...errorFields(error),
    });
  }
};

/**
 * After core's batch failed to make version `version` of App `app`
 * current (`makeCurrent`: its batch failed or changed nothing), once its
 * schema was applied: puts the schema of the version current in D1 back
 * on the store, over `version` (see the header), so the current version
 * goes on as it did. Where the store can't take it back (`version`
 * migrated or narrowed a field the current version's schema can't hold
 * again), the store stays on `version`'s schema and only `version` can
 * run on it: refused loudly (`app.publish_unfinished`, audited as
 * `app.version.unfinished`), and publishing `version` again finishes it
 * (the store holds its schema already). Only while the store holds what
 * this publish applied at `appliedAt`: another publish of the same
 * version that applied it again since answers for the store, and nothing
 * is put back under it. The store and D1 share no transaction, so such a
 * publish can't be made impossible: only seen.
 */
export const unfinishedPublish = async (
  env: Env,
  by: Identity,
  app: AppId,
  version: number,
  appliedAt: number
): Promise<void> => {
  const { currentVersion } = await findApp(env, app);
  if (currentVersion === null || currentVersion === version) {
    return;
  }
  try {
    // Imported here, not at the top: releases reach back into apps.ts.
    const { readBackRelease } = await import("./app-releases.ts");
    await applyVersionSchema(
      env,
      by,
      await readBackRelease(env, app, currentVersion),
      version,
      appliedAt
    );
    return;
  } catch (error) {
    // Another publish of the version applied it again since: it answers
    // for the store, and makes the version current or puts it back.
    if (isExpectedError(error) && error.code === "migration.busy") {
      return;
    }
    log.error("app.publish_unfinished", {
      app,
      version,
      current: currentVersion,
      ...errorFields(error),
    });
    await recordUnfinished(env, by, app, {
      version,
      current: currentVersion,
      code: isExpectedError(error) ? error.code : "internal.unexpected",
    });
  }
  throw appErrors.create("app.publish_unfinished", { version });
};

/**
 * Resets App `app`'s data for `by` and applies its current version's
 * schema to the empty store, in the store's one transaction
 * (data-stores.ts, `resetAppStore`; store-host.ts, `resetData`): a schema
 * that can't be applied leaves the data as it was, so the App is never
 * left without one. Audited there, with how many records each table held.
 */
const resetWith = async (env: Env, by: Identity, found: App): Promise<void> => {
  // Imported here, not at the top: releases reach back into apps.ts.
  const { readBackRelease } = await import("./app-releases.ts");
  const release =
    found.currentVersion === null
      ? null
      : await readBackRelease(env, found.id, found.currentVersion);
  // A version with no tables applies its schema (none) all the same,
  // so the reset goes only over the version current as it was asked for.
  const apply =
    release === null || found.currentVersion === null
      ? undefined
      : await schemaApplyOf(env, by, release, found.currentVersion);
  await resetAppStore(env, by, found.id, apply === undefined ? {} : { apply });
};

/**
 * Resets every record of App `app` for good, for one of the
 * organization's admins, never Grasp staff nor a builder: whether a
 * client's data goes is the client's decision, and a removal otherwise
 * keeps its history. Confirmed by the App's `name` exactly as it stands
 * now, checked here (`app.reset_name_mismatch`).
 */
export const resetAppData = async (
  env: Env,
  by: Identity,
  app: unknown,
  name: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const found = await editableApp(env, by, app);
  if (typeof name !== "string" || name !== found.name) {
    throw appErrors.create("app.reset_name_mismatch");
  }
  await resetWith(env, by, found);
};
