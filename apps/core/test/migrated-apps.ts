import type { Identity } from "@grasp-os/shared/rpc";
import { storedFieldsSchema } from "@grasp-os/shared/stores";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { publishVersion } from "../src/app-publish.ts";
import { commitFiles } from "../src/apps.ts";
import { openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { appDefinition } from "./app-definitions.ts";
import { commit } from "./pending-stores.ts";
import { appWith, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { newRecordId } from "./store-schemas.ts";

// A Notes App whose next version migrates its notes with an explicit
// migration (spec 17.2): the fixtures of custom-migration-runs.test.ts.

const placeholder = "0".repeat(64);

/**
 * The Notes App's definition with notes of `fields`, which its values.ts
 * exports as `noteFields` for its migrations.
 */
export const notesOfFields = (
  fields: Readonly<Record<string, string>>
): Record<string, string> => ({
  ...appDefinition({
    name: "Notes",
    tables: {
      notes: { fields, access: { read: "owner", write: "owner" } },
    },
  }),
  "values.ts": `import { v } from "@grasp-os/sdk";

export const noteFields = {
${Object.entries(fields)
  .map(([name, type]) => `  ${name}: ${type},`)
  .join("\n")}
};
`,
});

const title = "v.string().min(1).max(200)";

/** Notes of a title. */
export const v1Files = notesOfFields({ title });

/** Notes of a title and a category. */
export const v2Files = notesOfFields({
  title,
  category: 'v.enum(["launch", "general"])',
});

/** A fixture `deriving` passes: a launch note gets the launch category. */
export const passingFixtures = `[
    { row: { title: "launch day" }, expect: { title: "launch day", category: "launch" } },
    { row: { title: "Note" } },
  ]`;

/** The migration from `fromSchema` to `toSchema`, transforming with `handler`. */
export const migrationFile = (
  fromSchema: string,
  toSchema: string,
  handler: string,
  fixtures = passingFixtures
): string => `import { migration, v } from "@grasp-os/sdk";
import { noteFields } from "../../values.ts";

export default migration({
  name: "derive-category",
  table: "notes",
  fromSchema: ${JSON.stringify(fromSchema)},
  toSchema: ${JSON.stringify(toSchema)},
  input: v.object({ title: noteFields.title }),
  output: v.object(noteFields),
  fixtures: ${fixtures},
  handler: ${handler},
});
`;

export const deriving = `(ctx, row) => ({
  ...row,
  category: row.title.includes("launch") ? "launch" : "general",
})`;

/** The version's files that migrate to `toSchema` with `handler`. */
export const migratedFiles = (
  fromSchema: string,
  toSchema: string,
  handler: string,
  fixtures = passingFixtures,
  schema = v2Files
): Record<string, string> => ({
  ...schema,
  "server/migrations/derive-category.ts": migrationFile(
    fromSchema,
    toSchema,
    handler,
    fixtures
  ),
});

/** The code and details of what `work` threw. */
export const refusalOf = async (work: () => Promise<unknown>) => {
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
export const namedSchema = (details: unknown): string => {
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
export const notesOf = async (
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
export const migrated = async (
  count: number,
  handler: string,
  {
    extra = {},
    firstCurrent = false,
    fixtures = passingFixtures,
    owner,
    start = v1Files,
    next = v2Files,
  }: {
    extra?: Record<string, string>;
    firstCurrent?: boolean;
    fixtures?: string;
    /** Who creates the App and writes its notes: a new builder unless given. */
    owner?: Identity;
    /** The files the notes start under: `v1Files` unless given. */
    start?: Record<string, string>;
    /** The files the migration migrates to: `v2Files` unless given. */
    next?: Record<string, string>;
  } = {}
) => {
  const fixture: Fixture = await appWith(start, "Notes", owner);
  const first = await seal(fixture);
  if (firstCurrent) {
    await publishVersion(env, fixture.owner, fixture.app, 1);
  }
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
    {
      ...migratedFiles(fromSchema, placeholder, handler, fixtures, next),
      ...extra,
    },
    "Migrate"
  );
  const refused = await refusalOf(async () => await seal(fixture, 2));
  const toSchema = namedSchema(refused.details);
  await commitFiles(
    env,
    fixture.owner,
    fixture.app,
    {
      ...migratedFiles(fromSchema, toSchema, handler, fixtures, next),
      ...extra,
    },
    "Migrate to the sealed schema"
  );
  const release = await seal(fixture, 3);
  return {
    fixture: { ...fixture, firstSchema: fromSchema },
    store,
    release,
  };
};
