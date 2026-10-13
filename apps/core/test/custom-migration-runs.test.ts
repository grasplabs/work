import { storedFieldsSchema } from "@grasp-os/shared/stores";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { commitFiles, setCurrentVersion } from "../src/apps.ts";
import { openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { requireStoreSchemaActive } from "../src/store-backfill.ts";
import { commit } from "./pending-stores.ts";
import { appWith, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
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

const placeholder = "0".repeat(64);

const v1Schema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const noteFields = { title: v.string().min(1).max(200) };

export default defineSchema({ notes: defineTable(noteFields) });
`;

const v2Schema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().min(1).max(200),
  category: v.enum(["launch", "general"]),
};

export default defineSchema({ notes: defineTable(noteFields) });
`;

/** The App's registration, with the migration when it has one. */
const appFile = (
  migrated: boolean
): string => `import { app } from "@grasp-os/sdk";
import schema from "./schema.ts";
${migrated ? 'import derive from "./migrations/derive-category.ts";' : ""}

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: {},
  screens: [],
  uses: [],
  migrations: [${migrated ? "derive" : ""}],
});
`;

/** The migration from `fromSchema` to `toSchema`, transforming with `handler`. */
const migrationFile = (
  fromSchema: string,
  toSchema: string,
  handler: string
): string => `import { migration, v } from "@grasp-os/sdk";
import { noteFields } from "../schema.ts";

export default migration({
  name: "derive-category",
  table: "notes",
  fromSchema: ${JSON.stringify(fromSchema)},
  toSchema: ${JSON.stringify(toSchema)},
  input: v.object({ title: noteFields.title }),
  output: v.object(noteFields),
  handler: ${handler},
});
`;

const deriving = `(ctx, row) => ({
  ...row,
  category: row.title.includes("launch") ? "launch" : "general",
})`;

/** The version's files that migrate to `toSchema` with `handler`. */
const migratedFiles = (
  fromSchema: string,
  toSchema: string,
  handler: string
): Record<string, string> => ({
  "schema.ts": v2Schema,
  "migrations/derive-category.ts": migrationFile(fromSchema, toSchema, handler),
  "app.ts": appFile(true),
});

/** The code and details of what `work` threw. */
const refusalOf = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error) {
    if (typeof error !== "object" || error === null) {
      return { code: undefined, details: undefined };
    }
    const code: unknown = Reflect.get(error, "code");
    const details: unknown = Reflect.get(error, "details");
    return { code, details };
  }
  return { code: "ok", details: undefined };
};

/** The schema hash a seal's refusal names. */
const namedSchema = (details: unknown): string => {
  const toSchema: unknown =
    typeof details === "object" && details !== null
      ? Reflect.get(details, "toSchema")
      : undefined;
  if (typeof toSchema !== "string") {
    throw new TypeError("The seal named no schema hash");
  }
  return toSchema;
};

/** Every note's fields and revision. */
const notesOf = async (
  store: OpenStore
): Promise<{ fields: StoreFields; revision: number }[]> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) =>
      state.storage.sql
        .exec<{ value: string; revision: number }>(
          "SELECT value_json AS value, revision FROM sdk_records"
        )
        .toArray()
        .map(({ value, revision }) => ({
          fields: storedFieldsSchema.parse(JSON.parse(value)),
          revision,
        }))
  );

/**
 * Notes sealed as version 1 holding `count` notes, then version 3
 * migrating them with `handler` sealed (version 2 learned the schema hash
 * from the seal's refusal): the release whose store now runs it.
 */
const migrated = async (count: number, handler: string) => {
  const fixture: Fixture = await appWith({
    "schema.ts": v1Schema,
    "app.ts": appFile(false),
  });
  const first = await seal(fixture);
  const store = await openStore(env, fixture.store);
  const fromSchema = first.manifest.schemaHash;
  for (let index = 0; index < count; index += 1) {
    // One commit after the other, as a person's would be.
    // oxlint-disable-next-line no-await-in-loop -- see above
    await commit(
      store,
      fromSchema,
      [
        {
          op: "insert",
          table: "notes",
          id: newRecordId(),
          fields: {
            title: index % 3 === 0 ? `launch ${index}` : `Note ${index}`,
          },
        },
      ],
      fixture.owner.userId
    );
  }
  await commitFiles(
    env,
    fixture.owner,
    fixture.app,
    migratedFiles(fromSchema, placeholder, handler),
    "Migrate"
  );
  const refused = await refusalOf(async () => await seal(fixture, 2));
  const toSchema = namedSchema(refused.details);
  await commitFiles(
    env,
    fixture.owner,
    fixture.app,
    migratedFiles(fromSchema, toSchema, handler),
    "Migrate to the sealed schema"
  );
  const release = await seal(fixture, 3);
  return {
    fixture: { ...fixture, firstSchema: fromSchema },
    store,
    release,
  };
};

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

  it("refuses the release while its transform fails, telling the App why", async () => {
    const { fixture, store } = await migrated(
      5,
      `(ctx, row) => {
        if (row.title === "Note 4") throw new Error("No category for Note 4");
        return { ...row, category: "general" };
      }`
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
