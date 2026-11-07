import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { publishVersion } from "../src/app-publish.ts";
import { commitFiles } from "../src/apps.ts";
import type { OpenStore } from "../src/data-stores.ts";
import {
  failedOutside,
  inputMismatch,
  threwOnRecord,
} from "../src/migration-transform.ts";
import { requireStoreSchemaActive } from "../src/store-backfill.ts";
import { racingDb } from "./apps.ts";
import {
  deriving,
  migrated,
  notesOf,
  notesOfFields,
  refusalOf,
} from "./migrated-apps.ts";
import { codeOf, commit } from "./pending-stores.ts";
import { newRecordId } from "./store-schemas.ts";

/** Notes whose category is optional: version 1's notes fit it as they are. */
const optionalCategorySchema = notesOfFields({
  title: "v.string().min(1).max(200)",
  category: 'v.enum(["launch", "general"]).optional()',
});

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
// - A transform's failure lets the release run, or reaches no one who can
//   act on it, or carries a record its builders can't read into what they
//   are told: "refuses the release while its transform fails, telling the
//   App on which record".
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
// - A transform carries a record its builders can't read (each person's
//   own notes) into its failure, which they are shown, by failing outside
//   its handler with the record's values (replacing `JSON.stringify`,
//   which the isolate answers through): "shows nothing of a record its
//   builders can't read when the transform fails outside its handler";
//   or through the issues of a record that doesn't fit its input, their
//   paths or messages: "shows only which declared field a hidden record
//   doesn't fit its input on". Wherever the failure is told: the release's
//   refusal, the App's status and the admins'.

/**
 * Waits for the run of `store`'s migration to fail, and answers the failure
 * wherever it is told: the refusal of making version 3 of `app` current,
 * what the App is shown of its schema, and the admins' status.
 */
const failureTold = async (
  app: AppId,
  store: OpenStore,
  schemaHash: string
): Promise<{ refusal: unknown; status: unknown; admins: unknown }> => {
  await vi.waitFor(
    async () => {
      await expect(
        refusalOf(async () => {
          await requireStoreSchemaActive(env, app, 3);
        })
      ).resolves.toMatchObject({ code: "migration.backfill_failed" });
    },
    { timeout: 120_000, interval: 500 }
  );
  const object = env.DATA_STORES.getByName(store.id);
  const refused = await refusalOf(async () => {
    await requireStoreSchemaActive(env, app, 3);
  });
  return {
    refusal: refused.details,
    status: await object.schemaStatus(store.id, schemaHash, {
      resourceId: app,
      resourceVersion: 3,
    }),
    admins: await object.backfillStatus(store.id),
  };
};

/** The notes' titles: the records the failures must not show. */
const titlesOf = async (store: OpenStore): Promise<string[]> => {
  const notes = await notesOf(store);
  return notes.map(({ fields }) =>
    typeof fields.title === "string" ? fields.title : ""
  );
};

describe("an explicit migration's run", { timeout: 180_000 }, () => {
  it("makes the release current with its store when a person commits between the switch and the batch", async () => {
    const { fixture, store, release } = await migrated(20, deriving);
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
    // A person commits after the store switched to the migration's
    // contract, just before the batch that makes the release current.
    const racing = racingDb(
      async () =>
        await commitFiles(
          env,
          fixture.owner,
          fixture.app,
          { "AGENTS.md": "# Notes\n" },
          "Later"
        ),
      /update "apps" set "current_version"/iu
    );
    const current = await publishVersion(
      { ...env, DB: racing },
      fixture.owner,
      fixture.app,
      3
    );
    const after = await object.schemaStatus(
      store.id,
      release.manifest.schemaHash,
      consumer
    );
    expect({ current: current.currentVersion, after }).toStrictEqual({
      current: 3,
      after: { state: "active" },
    });
  });

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

    const current = await publishVersion(env, fixture.owner, fixture.app, 3);
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
      async () => await publishVersion(env, fixture.owner, fixture.app, 3)
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

  it("keeps a rollback open past a migration that leaves the old schema in force", async () => {
    // The migration only derives a field the old schema may go without:
    // the store's contract still covers version 1's schema after it.
    const { fixture, store, release } = await migrated(5, deriving, {
      firstCurrent: true,
      next: optionalCategorySchema,
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
    await publishVersion(env, fixture.owner, fixture.app, 3);
    const back = await publishVersion(env, fixture.owner, fixture.app, 1);
    expect(back.currentVersion).toBe(1);
  });

  it("rolls back past the migration once every record fits the version before, keeping what it derived", async () => {
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
    await publishVersion(env, fixture.owner, fixture.app, 3);
    // Version 3 requires the category; version 1 writes notes without it,
    // so the migration left it behind.
    const left = await object.schemaStatus(store.id, fixture.firstSchema);
    // Made current again, its schema is planned onto the contract and
    // every record checked against it (store-schema-changes.ts): they all
    // fit, the category kept, as optional.
    const back = await publishVersion(env, fixture.owner, fixture.app, 1);
    const records = await notesOf(store);

    expect({
      left,
      back: back.currentVersion,
      status: await object.schemaStatus(store.id, fixture.firstSchema),
      categorised: records.every(
        ({ fields }) => typeof fields.category === "string"
      ),
    }).toStrictEqual({
      left: {
        state: "ready",
        target: fixture.firstSchema,
        attempt: 1,
        scanned: 0,
        filled: 0,
        failure: null,
      },
      back: 1,
      status: { state: "active" },
      categorised: true,
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
      async () => await publishVersion(env, fixture.owner, fixture.app, 3)
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
      async () => await publishVersion(env, fixture.owner, fixture.app, 3)
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

  it("refuses the release while its transform fails, telling the App on which record", async () => {
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
              // Each person's own notes: what the transform said of one
              // isn't shown to the App's builders, only on which record.
              issues: [threwOnRecord],
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

  it("shows nothing of a record its builders can't read when the transform fails outside its handler", async () => {
    // As its module loads, it replaces `JSON.stringify` with one that
    // throws the title of the last record it saw on the isolate's answer
    // (the one object with an own `ok`), after the handler returned. It
    // passes on its fixtures, the App's own data, which it tells apart by
    // their IDs. Past the types, as an attacker's code would.
    const { fixture, store, release } = await migrated(
      3,
      `(() => {
        let seen = "";
        const stringify = JSON.stringify;
        Reflect.set(JSON, "stringify", (value: unknown, ...rest: unknown[]) => {
          if (seen !== "" && typeof value === "object" && value !== null && Object.hasOwn(value, "ok")) {
            throw new Error(\`Leaked: \${seen}\`);
          }
          return Reflect.apply(stringify, JSON, [value, ...rest]);
        });
        return (ctx: { id: string }, row: { title: string }) => {
          if (!ctx.id.startsWith("fixture-")) {
            seen = row.title;
          }
          return { ...row, category: "general" as const };
        };
      })()`,
      { fixtures: '[{ row: { title: "Note" } }]' }
    );

    const told = await failureTold(
      fixture.app,
      store,
      release.manifest.schemaHash
    );
    const text = JSON.stringify(told);
    const titles = await titlesOf(store);

    expect({
      told,
      leaked:
        text.includes("Leaked") || titles.some((title) => text.includes(title)),
    }).toMatchObject({
      told: {
        refusal: {
          failure: {
            id: null,
            reason: "invalid_answer",
            issues: [failedOutside],
          },
        },
        status: {
          state: "failed",
          failure: { reason: "invalid_answer", issues: [failedOutside] },
        },
        admins: {
          failure: { reason: "invalid_answer", issues: [failedOutside] },
        },
      },
      leaked: false,
    });
  });

  it("shows only which declared field a hidden record doesn't fit its input on", async () => {
    // Version 3's titles are of a list: the migration's input takes them
    // from it, and the first note's ("launch 0") isn't on it. What the
    // validator would say of it names the value.
    const { fixture, store, release } = await migrated(3, deriving, {
      fixtures: '[{ row: { title: "Note 1" } }]',
      next: notesOfFields({
        title: 'v.enum(["Note 1", "Note 2"])',
        category: 'v.enum(["launch", "general"])',
      }),
    });

    const told = await failureTold(
      fixture.app,
      store,
      release.manifest.schemaHash
    );
    const text = JSON.stringify(told);
    const titles = await titlesOf(store);
    const failure = {
      reason: "invalid_input",
      issues: [inputMismatch, "title: doesn't fit"],
    };

    expect({
      told,
      leaked: titles
        .filter((title) => title.startsWith("launch"))
        .some((title) => text.includes(title)),
    }).toMatchObject({
      told: {
        refusal: { failure },
        status: { state: "failed", failure },
        admins: { failure },
      },
      leaked: false,
    });
  });
});
