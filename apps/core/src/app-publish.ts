import { versionErrors } from "@grasp-os/shared/app-releases";
import { appErrors } from "@grasp-os/shared/apps";
import type { DraftProblem } from "@grasp-os/shared/drafts";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { checkFiles } from "./agent-builds.ts";
import type { DraftCheck } from "./agent-builds.ts";
import { sealedEvidence, sealRelease } from "./app-releases.ts";
import { requireAppTestsPass } from "./app-tests.ts";
import {
  activateVersion,
  changeEntry,
  commitDraft,
  draftDefinition,
  findVersion,
  isPublished,
  nextVersion,
  publishedSql,
  versionFiles,
} from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { appVersions } from "./db/core/schema.ts";
import { indexAppNow } from "./knowledge/apps-collection.ts";
import { requireMigrationEvidence } from "./migration-run.ts";
import type { PublishSteps } from "./publish.ts";

// Publishing an App (spec 8, 16, 22, GRA-1665): its steps of publish.ts's
// publish and roll back (`appSteps`). Building a version seals its
// release, bound to the App's store (app-releases.ts), checks its
// migrations passed on their fixtures, runs its App tests on fixture
// stores (app-tests.ts), and marks it `published` (`buildRelease`);
// activating it makes it current (apps.ts, `activateVersion`), which
// applies its schema to the store, its migrations with it, in one
// transaction (app-schema.ts), each step audited. A version built already
// is only made current: a rollback runs no tests again, and its schema is
// applied as any other.
//
// Threat model: no path makes code current that didn't pass. How each way
// it could fail is closed:
//
// - The base changed: `activateVersion` makes a version current only over
//   the version current when the publish began, compared and set in the
//   statement that does it (`draft.conflict` otherwise).
// - The build or a test fails: sealing refuses code that doesn't build,
//   type-check or inspect, and a failing test or migration fixture
//   refuses the version, before it is marked and before its store
//   changes. Making a version current requires it `published`, in the
//   statement that does it.
// - Two publishes at once: sealing a version twice finds one release
//   (a second manifest is refused, `version.seal_conflict`); marking it
//   twice is the same mark; of two versions made current over one base,
//   the compare and set keeps one, and the other is `draft.conflict`.
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
//   (`editableApp`, and again in `activateVersion` and `sealRelease`);
//   made current by someone who couldn't grant the App's permissions, its
//   version is unapproved until an admin approves (permissions.ts).
// - A store another App's data is in, or a second store of its own: no
//   request names a store. Sealing binds the App's one store, keyed by the
//   App (data-stores.ts, `appStoreFor`), and a rollback to a published
//   version seals nothing; one whose release went is sealed again on that
//   same store, or on its replacement once an admin deleted it.

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
const buildRelease = async (
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
        changeEntry(by, "app.version.built", app, {
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
 * The errors `check` found, as a builder reads them before publishing:
 * its builds' errors by file, then what its preview ran into. Warnings
 * never fail a check, so they aren't listed.
 */
const problemsOf = (check: DraftCheck): DraftProblem[] => [
  ...[check.pages, check.server, check.lint].flatMap((build) =>
    build.diagnostics
      .filter(({ severity }) => severity === "error")
      .map(({ file, line, message }) => ({ at: file, line, message }))
  ),
  ...check.preview.problems
    .filter(({ kind }) => kind !== "warning")
    .map(({ at, message }) => ({ at, line: null, message })),
];

/**
 * How an App's draft is published (publish.ts): checked as
 * a chat's agent's turn checks it (`checkFiles`, with what the App's
 * preview of it ran into), committed as it was checked as the App's next
 * version (`commitDraft`), built, sealed and tested (`buildRelease`), and
 * made live (`activateVersion`), then indexed into the Apps collection
 * (knowledge/apps-collection.ts): its entry holds the live version once
 * this returns, unless indexing failed or raced another; the clock then
 * heals it within 15 minutes. A version committed whose build fails is
 * marked `failed` and never live, with no label; the draft keeps its
 * changes over its base.
 */
export const appSteps: PublishSteps = {
  check: async (env, _by, id, { draft, files }) => {
    const checked = await checkFiles(
      env,
      appIdSchema.parse(id),
      draft,
      Object.fromEntries(files)
    );
    return { passed: checked.passed, problems: problemsOf(checked) };
  },
  // Checked as it is built, once the number its version takes is read:
  // of two publishes of one draft at once, the second finds it taken as
  // it commits (`draft.conflict`), never committing a version that
  // can't go live.
  build: async (env, by, id, { draft, files }) => {
    const app = appIdSchema.parse(id);
    const version = await nextVersion(env, app);
    const check = await checkFiles(env, app, draft, Object.fromEntries(files));
    if (!check.passed) {
      throw appErrors.create("app.draft_failed");
    }
    const defined = await draftDefinition(env, app, draft);
    await commitDraft(env, by, app, {
      parent: draft.base,
      version,
      files,
      definition: defined?.definition ?? null,
    });
    await buildRelease(env, by, app, version);
    return version;
  },
  activate: async (env, by, id, { version, basedOn, action, alongside }) => {
    const app = appIdSchema.parse(id);
    if (!(await isPublished(env, app, version))) {
      await findVersion(env, app, version);
      await buildRelease(env, by, app, version);
    }
    const live = await activateVersion(
      env,
      by,
      app,
      version,
      basedOn,
      action,
      alongside
    );
    await indexAppNow(env, app);
    if (live.liveLabel === null) {
      throw new Error("A live App version has no label.");
    }
    return live.liveLabel;
  },
};
