import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { commitFiles, setCurrentVersion } from "../src/apps.ts";
import { requireStoreSchemaActive } from "../src/store-backfill.ts";
import {
  appFile,
  deriving,
  migrated,
  notesOf,
  refusalOf,
} from "./migrated-apps.ts";
import { codeOf, commit } from "./pending-stores.ts";
import { seal } from "./sealed-apps.ts";
import { newRecordId } from "./store-schemas.ts";

// An explicit migration run end to end (spec 17.2): an App's release
// declares it, the seal hands it to the App's store as its pending
// target, core's backfill workflow runs on the engine, each batch through
// the release's transform in the sandbox (migration-transform.ts), and
// the store activates the target once every record is transformed. Real
// compiler, seal, Loader isolates, engine and store objects; nothing
// mocked. What can go wrong, and the test that shows it doesn't:
//
// - The run doesn't reach activation, or transforms a record twice:
//   "transforms every record once, then takes over as its release is
//   made current"; the version still current loses writes before it is
//   made current: same test (version 1's schema stays in force).
// - A transform's failure lets the release run, or its message reaches
//   no one who can act on it: "refuses the release while its transform
//   fails, telling the App why".
// - A transform that answers wrong rewrites real records, or its release
//   runs, on App code's word that it works: "keeps a migration that fails
//   on its fixtures off every record, and refuses its release" and
//   "refuses a release whose migration failed on its fixtures, though
//   there was nothing to transform"; the evidence of one that passed is
//   the host's, sealed with the release: "transforms every record once …".
// - A rollback to a version the migration left behind runs it over
//   records it no longer fits, or refuses without saying what would fit:
//   "refuses a rollback past the migration, naming the versions that
//   still fit"; one to a version that fits is refused, or a version whose
//   receipt was abandoned is named beside another on its schema: same
//   test.

describe("an explicit migration's run", { timeout: 180_000 }, () => {
  it("transforms every record once, then takes over as its release is made current", async () => {
    const { fixture, store, release } = await migrated(130, deriving);
    const object = env.DATA_STORES.getByName(store.id);
    const consumer = { resourceId: fixture.app, resourceVersion: 3 };

    await vi.waitFor(
      async () => {
        await expect(
          object.schemaStatus(store.id, release.manifest.schemaHash, consumer)
        ).resolves.toMatchObject({ state: "ready" });
      },
      { timeout: 120_000, interval: 500 }
    );
    // Ready, it hasn't taken over: version 1's schema still writes.
    const before = await object.schemaStatus(store.id, fixture.firstSchema);

    const current = await setCurrentVersion(env, fixture.owner, fixture.app, 3);
    const after = await object.schemaStatus(
      store.id,
      release.manifest.schemaHash,
      consumer
    );
    expect({ before, current: current.currentVersion, after }).toStrictEqual({
      before: { state: "active" },
      current: 3,
      after: { state: "active" },
    });
    // What running it on its fixtures found, sealed with the release.
    expect(release.manifest.migrationEvidence).toMatchObject([
      {
        migration: "derive-category",
        table: "notes",
        fromSchema: fixture.firstSchema,
        toSchema: release.manifest.schemaHash,
        fixtures: 2,
        passed: true,
        failure: null,
      },
    ]);

    const records = await notesOf(store);
    const derivedRight = records.every(({ fields }) => {
      const launch =
        typeof fields.title === "string" && fields.title.includes("launch");
      return fields.category === (launch ? "launch" : "general");
    });
    expect({
      count: records.length,
      revisions: new Set(records.map(({ revision }) => revision)),
      derivedRight,
    }).toStrictEqual({
      count: 130,
      revisions: new Set([2]),
      derivedRight: true,
    });
  });

  it("leaves the version still current in force when another gate refuses making the migrated one current", async () => {
    const failingTests = {
      "tests/fixtures/base.json": JSON.stringify({
        principals: { someone: { role: "user" } },
      }),
      "tests/failing.test.ts": `import { appTest } from "@grasp-os/sdk/testing";

export default appTest({
  fixtures: "base",
  tests: {
    "fails": async (t) => {
      t.equal(1, 2);
    },
  },
});
`,
    };
    const { fixture, store, release } = await migrated(5, deriving, {
      extra: failingTests,
      firstCurrent: true,
    });
    const object = env.DATA_STORES.getByName(store.id);
    const consumer = { resourceId: fixture.app, resourceVersion: 3 };
    await vi.waitFor(
      async () => {
        await expect(
          object.schemaStatus(store.id, release.manifest.schemaHash, consumer)
        ).resolves.toMatchObject({ state: "ready" });
      },
      { timeout: 120_000, interval: 500 }
    );

    const refused = await refusalOf(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 3)
    );
    const current = await env.DB.prepare(
      "SELECT current_version AS version FROM apps WHERE id = ?"
    )
      .bind(fixture.app)
      .first<{ version: number }>();

    expect({
      refused: refused.code,
      current: current?.version,
      migration: await object.schemaStatus(
        store.id,
        release.manifest.schemaHash,
        consumer
      ),
      firstWrite: await codeOf(
        commit(
          store,
          fixture.firstSchema,
          [
            {
              op: "insert",
              table: "notes",
              id: newRecordId(),
              fields: { title: "Still writing" },
            },
          ],
          fixture.owner.userId
        )
      ),
    }).toMatchObject({
      refused: "version.tests_failed",
      current: 1,
      // Not taken over; the write it then queued makes it pending again.
      migration: { state: "ready" },
      firstWrite: "ok",
    });
  });

  it("refuses a rollback past the migration, naming the versions that still fit", async () => {
    const { fixture, store, release } = await migrated(5, deriving, {
      firstCurrent: true,
    });
    const object = env.DATA_STORES.getByName(store.id);
    await vi.waitFor(
      async () => {
        await expect(
          object.schemaStatus(store.id, release.manifest.schemaHash, {
            resourceId: fixture.app,
            resourceVersion: 3,
          })
        ).resolves.toMatchObject({ state: "ready" });
      },
      { timeout: 120_000, interval: 500 }
    );
    await setCurrentVersion(env, fixture.owner, fixture.app, 3);
    const toFirst = await refusalOf(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 1)
    );
    // A later version on the migrated schema, without the migration.
    await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      { "app.ts": appFile(false), "migrations/derive-category.ts": null },
      "Drop the finished migration"
    );
    await seal(fixture, 4);
    await setCurrentVersion(env, fixture.owner, fixture.app, 4);

    const toThird = await setCurrentVersion(env, fixture.owner, fixture.app, 3);
    const again = await refusalOf(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 1)
    );
    // Version 4's receipt waited on a target an admin abandoned
    // (store-abandon.ts): it never runs on the store, though version 3,
    // on the same schema, does.
    const abandoned = await runInDurableObject(
      object,
      (_instance, state) =>
        state.storage.sql.exec(
          "UPDATE sdk_schema_activations SET abandoned_at = ? WHERE resource_id = ? AND resource_version = 4",
          Date.now(),
          fixture.app
        ).rowsWritten
    );
    const withoutAbandoned = await refusalOf(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 1)
    );

    expect({
      toFirst,
      status: await object.schemaStatus(store.id, fixture.firstSchema),
      toThird: toThird.currentVersion,
      again,
      abandoned,
      withoutAbandoned,
    }).toStrictEqual({
      toFirst: {
        code: "migration.rollback_incompatible",
        details: { compatible: [3] },
      },
      status: { state: "incompatible" },
      toThird: 3,
      again: {
        code: "migration.rollback_incompatible",
        details: { compatible: [4, 3] },
      },
      abandoned: 1,
      withoutAbandoned: {
        code: "migration.rollback_incompatible",
        details: { compatible: [3] },
      },
    });
  });

  it("keeps a migration that fails on its fixtures off every record, and refuses its release", async () => {
    const { fixture, store, release } = await migrated(5, deriving, {
      firstCurrent: true,
      fixtures:
        '[{ row: { title: "launch day" }, expect: { title: "launch day", category: "general" } }]',
    });

    await vi.waitFor(
      async () => {
        await expect(
          refusalOf(async () => {
            await requireStoreSchemaActive(env, fixture.app, 3);
          })
        ).resolves.toMatchObject({
          code: "migration.backfill_failed",
          details: {
            failure: {
              table: "notes",
              migration: "derive-category",
              id: null,
              reason: "fixtures_failed",
            },
          },
        });
      },
      { timeout: 120_000, interval: 500 }
    );
    const refused = await refusalOf(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 3)
    );
    const records = await notesOf(store);

    expect({
      evidence: release.manifest.migrationEvidence,
      refused,
      revisions: new Set(records.map(({ revision }) => revision)),
    }).toStrictEqual({
      evidence: [
        expect.objectContaining({
          migration: "derive-category",
          fixtures: 1,
          passed: false,
          failure: {
            fixture: 0,
            reason: "unexpected_output",
            issues: [
              'It answered {"category":"launch","title":"launch day"}',
              'The fixture expects {"category":"general","title":"launch day"}',
            ],
          },
        }),
      ],
      refused: {
        code: "version.migration_fixtures_failed",
        details: {
          migration: "derive-category",
          fixture: 1,
          reason: "unexpected_output",
          issues: [
            'It answered {"category":"launch","title":"launch day"}',
            'The fixture expects {"category":"general","title":"launch day"}',
          ],
        },
      },
      // Not one record was transformed.
      revisions: new Set([1]),
    });
  });

  it("refuses a release whose migration failed on its fixtures, though there was nothing to transform", async () => {
    const { fixture, store, release } = await migrated(
      0,
      `(ctx, row) => {
        throw new Error("Not written yet");
      }`,
      { fixtures: '[{ row: { title: "Note" } }]' }
    );
    const object = env.DATA_STORES.getByName(store.id);

    const refused = await refusalOf(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 3)
    );

    expect({
      // The store took its schema at once: no record to transform.
      status: await object.schemaStatus(store.id, release.manifest.schemaHash),
      refused,
    }).toStrictEqual({
      status: { state: "active" },
      refused: {
        code: "version.migration_fixtures_failed",
        details: {
          migration: "derive-category",
          fixture: 1,
          reason: "threw",
          issues: ["Not written yet"],
        },
      },
    });
  });

  it("refuses the release while its transform fails, telling the App why", async () => {
    const { fixture, store } = await migrated(
      5,
      `(ctx, row) => {
        if (row.title === "Note 4") throw new Error("No category for Note 4");
        return { ...row, category: "general" };
      }`,
      { fixtures: '[{ row: { title: "Note" } }]' }
    );

    await vi.waitFor(
      async () => {
        await expect(
          refusalOf(async () => {
            await requireStoreSchemaActive(env, fixture.app, 3);
          })
        ).resolves.toMatchObject({
          code: "migration.backfill_failed",
          details: {
            failure: {
              table: "notes",
              migration: "derive-category",
              reason: "threw",
              issues: ["No category for Note 4"],
            },
          },
        });
      },
      { timeout: 120_000, interval: 500 }
    );
    // Nothing of the failed batch was written.
    const records = await notesOf(store);
    expect(new Set(records.map(({ revision }) => revision))).toStrictEqual(
      new Set([1])
    );
  });
});
