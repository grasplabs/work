import { manifestText } from "@grasp-os/sdk/host";
import { actorOf } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";

import { schemaIdsOf } from "./app-definition.ts";
import type { Release } from "./app-releases.ts";
import { editableApp, versionFiles } from "./apps.ts";
import { openStore, resetAppStore } from "./data-stores.ts";
import { runMigrations } from "./migration-run.ts";
import { requireNotStaff } from "./sharing.ts";
import type { AppliedSchema } from "./store-host.ts";

// A version's schema applied to its App's store as the version is made
// current, by a publish or a rollback alike (apps.ts, `makeCurrent`): the
// one step that changes what the store holds. Its migrations, those from
// the schema the store holds, run first, once, their output staged in the
// store (migration-run.ts); then the store diffs the version's schema
// against what it holds, by the stable IDs of the version's own
// `definition.json`, and applies it with that output in one transaction
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
// - A rollback after a schema change: the older version's schema is
//   applied like any other. Fields and tables it leaves out keep their
//   values, so making the newer version current again finds them.
// - The IDs come from the files: the version's files are immutable, read
//   back by their hash, and its schema is generated from the very
//   definition its IDs come from.

/**
 * Applies the schema of `release` (a version's, read back from storage,
 * every byte checked) to its store for `by`, over the version current as
 * the publish began (`basedOn`): its migrations run, then the change
 * applied (see the header). Null for a version without a store.
 */
export const applyVersionSchema = async (
  env: Env,
  by: Identity,
  release: Release,
  basedOn: number | null
): Promise<AppliedSchema | null> => {
  if (release.store === null) {
    return null;
  }
  const app = appIdSchema.parse(release.manifest.resourceId);
  const version = release.manifest.resourceVersion;
  const ids = schemaIdsOf(
    await versionFiles(env, app, version),
    release.app.schema
  );
  const store = await openStore(env, release.store.storeId);
  const migration = await runMigrations(
    env,
    store,
    release,
    Object.fromEntries(Object.entries(ids).map(([name, { id }]) => [name, id]))
  );
  return await store.applySchema({
    manifest: manifestText(release.app.schema),
    ids,
    answers: (release.app.answers ?? []).map((answer) => ({ ...answer })),
    actor: actorOf(by),
    version: { app, number: version, basedOn },
    ...(migration === undefined ? {} : { migration }),
  });
};

/**
 * Resets App `app`'s data for `by`, one of its builders and never Grasp
 * staff (whether a client's data goes is the client's decision): every
 * record of its store goes (data-stores.ts, `resetAppStore`, audited),
 * and its current version's schema is applied to the empty store, so the
 * App runs again at once. What a store from before stable IDs holds
 * (`migration.metadata_missing`) is only ever reset.
 */
export const resetAppData = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<void> => {
  requireNotStaff(by);
  const found = await editableApp(env, by, app);
  const store = await resetAppStore(env, by, found.id);
  if (store === null || found.currentVersion === null) {
    return;
  }
  // Imported here, not at the top: releases reach back into apps.ts.
  const { readBackRelease } = await import("./app-releases.ts");
  await applyVersionSchema(
    env,
    by,
    await readBackRelease(env, found.id, found.currentVersion),
    found.currentVersion
  );
};
