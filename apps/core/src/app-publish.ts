import { versionErrors } from "@grasp-os/shared/app-releases";
import { appErrors } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { sealedEvidence, sealRelease } from "./app-releases.ts";
import { requireAppTestsPass } from "./app-tests.ts";
import {
  changeEntry,
  editableApp,
  findVersion,
  isPublished,
  makeCurrent,
  publishedSql,
  versionFiles,
} from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { appVersions } from "./db/core/schema.ts";
import { requireMigrationEvidence } from "./migration-run.ts";

// Publishing a version of an App (spec 8, 16, 22): one function, run by
// one of the App's builders as themselves. It builds and seals the
// version's release, bound to the App's store (app-releases.ts), checks
// its migrations passed on their fixtures, runs its App tests on fixture
// stores (app-tests.ts), marks the version `published`, and makes it
// current (`makeCurrent`), which applies its schema to the store, its
// migrations with it, in one transaction (app-schema.ts), each step
// audited. A version published already is only made current: a rollback
// runs no tests again, and its schema is applied as any other.
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
//   type-check or inspect, and a failing test or migration fixture
//   refuses the version, before it is marked and before its store
//   changes. Making a version current requires it
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
//   names the manifest it tested (`published_manifest_hash`), and a
//   version counts as published only while a release with that hash is
//   stored (apps.ts, `publishedSql`), whoever deleted it; making a version
//   current reads its release back from storage, every byte checked.
// - A failure misread as a pass, or unrecorded: anything thrown leaves the
//   version unmarked and marks it `failed`, which nothing makes current,
//   audited with its code (`internal.unexpected` for an error no code
//   names), and is thrown as it came.
// - Someone without the right: only the App's builders publish
//   (`editableApp`, and again in `makeCurrent` and `sealRelease`); made
//   current by someone who couldn't grant the App's permissions, its
//   version is unapproved until an admin approves (permissions.ts).
// - A store another App's data is in, or a second store of its own: no
//   request names a store. Sealing binds the App's one store, keyed by the
//   App (data-stores.ts, `appStoreFor`), and a rollback to a published
//   version seals nothing; one whose release went is sealed again on that
//   same store, or on its replacement once an admin deleted it.

/** What a caller may expect is current: a version, or null for none. */
const expectedSchema = z.int().min(1).nullable();

/**
 * Seals `version` of `app` on the App's one store (data-stores.ts,
 * `appStoreFor`, created the first time a version needs it): the sealed
 * manifest's hash.
 */
const sealed = async (
  env: Env,
  by: Identity,
  app: AppId,
  version: number
): Promise<string> => {
  const release = await sealRelease(env, { app, version, by });
  return release.manifestHash;
};

/**
 * Marks `version` of `app` `failed`, unless a publish passed meanwhile,
 * audited with the code of `error` (`internal.unexpected` for one no code
 * names): logged rather than thrown should that write fail, so the
 * caller throws the error that failed the publish.
 */
const recordFailure = async (
  env: Env,
  by: Identity,
  app: AppId,
  version: number,
  error: unknown
): Promise<void> => {
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db
        .update(appVersions)
        .set({ status: "failed", publishedManifestHash: null })
        .where(
          and(
            eq(appVersions.appId, app),
            eq(appVersions.version, version),
            sql`NOT ${publishedSql(app, version)}`
          )
        ),
      outboxedIfChanged(
        db,
        changeEntry(by, "app.version.publish_failed", app, {
          version,
          code: isExpectedError(error) ? error.code : "internal.unexpected",
        })
      ),
    ]);
  } catch (recordError) {
    log.error("app.publish_failure_unrecorded", {
      app,
      version,
      ...errorFields(recordError),
    });
  }
};

/**
 * Builds, seals and tests `version` of `app` for `by`, then marks it
 * `published` with the hash of the manifest it tested, while that release
 * is stored, audited with it. A failure marks it `failed`, audited
 * (`recordFailure`), and is thrown.
 */
const publish = async (
  env: Env,
  by: Identity,
  app: AppId,
  version: number
): Promise<void> => {
  const db = drizzle(env.DB);
  try {
    const files = await versionFiles(env, app, version);
    const manifestHash = await sealed(env, by, app, version);
    requireMigrationEvidence((await sealedEvidence(env, app, version)) ?? []);
    await requireAppTestsPass(env, app, version, files);
    const [marked] = await auditedBatch(env, db, [
      db
        .update(appVersions)
        .set({ status: "published", publishedManifestHash: manifestHash })
        .where(
          and(
            eq(appVersions.appId, app),
            eq(appVersions.version, version),
            // Only while the release it tested is stored: one deleted
            // since leaves it unmarked.
            sql`EXISTS (SELECT 1 FROM sdk_release_manifests
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
  } catch (error) {
    await recordFailure(env, by, app, version, error);
    throw error;
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
  if (!(await isPublished(env, found.id, row.version))) {
    await publish(env, by, found.id, row.version);
  }
  return await makeCurrent(env, by, found.id, row.version, basedOn);
};
