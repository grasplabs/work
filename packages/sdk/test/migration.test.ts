import { describe, expect, test } from "vite-plus/test";

import { inspectApp, readAppManifest } from "../src/host.ts";
import { app, migration } from "../src/index.ts";
import { runMigration } from "../src/runner.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

// How an App declares an explicit migration (spec 17.2), what its manifest
// records of it, and how the runner calls its handler: pure checks of a
// declaration and of the runner, so unit tests. That the host runs it in a
// capability-free sandbox and validates what it answers is tested through
// the host (apps/core/test/migration-transform.test.ts).

const fromSchema = "a".repeat(64);
const toSchema = "b".repeat(64);

const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
  category: v.string().default("general"),
};

const schema = defineSchema({ notes: defineTable(noteFields) });

const deriveCategory = migration({
  name: "derive-note-category",
  fromSchema,
  toSchema,
  table: "notes",
  input: v.object({ title: noteFields.title, body: noteFields.body }),
  output: v.object(noteFields),
  fixtures: [
    {
      row: { title: "Plan", body: "Launch day" },
      expect: { title: "Plan", body: "Launch day", category: "launch" },
    },
    { row: { title: "Idea" } },
  ],
  handler: (ctx, row) => ({
    ...row,
    category: row.body.toLowerCase().includes("launch")
      ? "launch"
      : `general:${ctx.id}`,
  }),
});

/** Notes registered with `migrations`. */
const notes = (migrations: readonly unknown[]): unknown =>
  // SAFETY: deliberately loose, for registrations the types refuse.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  (app as (definition: unknown) => unknown)({
    name: "Notes",
    schema,
    access: { tables: { notes: { read: "owner", write: "owner" } } },
    operations: {},
    screens: [],
    uses: [],
    migrations,
  });

// SAFETY: deliberately loose, for declarations the types refuse.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseMigration = migration as (definition: unknown) => unknown;

const declaration = {
  name: "derive-note-category",
  fromSchema,
  toSchema,
  table: "notes",
  output: v.object(noteFields),
  fixtures: [{ row: { title: "Note" } }],
  handler: (_ctx: unknown, row: unknown) => row,
};

/** A row whose own key is `__proto__`, as JSON text can make one. */
const prototypeRow: unknown = JSON.parse('{"__proto__": {"x": 1}}');

/** `count` fixtures of a note each. */
const manyFixtures = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    row: { title: `Note ${index}` },
  }));

describe("a migration's declaration", () => {
  test.each([
    ["a name that isn't kebab-case", { name: "Derive Category" }],
    ["a hash that isn't one", { fromSchema: "recorded-old-schema-hash" }],
    ["the same hash on both sides", { toSchema: fromSchema }],
    ["an output that isn't an object", { output: v.string() }],
    ["an input that isn't an object", { input: v.array(v.string()) }],
    ["a handler that isn't a function", { handler: "row => row" }],
    ["a key it doesn't have", { connector: "mail" }],
    ["no fixtures", { fixtures: undefined }],
    ["an empty list of fixtures", { fixtures: [] }],
    ["more fixtures than it may have", { fixtures: manyFixtures(17) }],
    ["a fixture that isn't `{ row, expect? }`", { fixtures: [{ title: "x" }] }],
    ["a fixture's row that isn't an object", { fixtures: [{ row: [1] }] }],
    [
      "a fixture's row that isn't JSON",
      { fixtures: [{ row: { at: new Date(0) } }] },
    ],
    [
      "a fixture's number that isn't finite",
      { fixtures: [{ row: { n: Number.NaN } }] },
    ],
    [
      "a fixture's key that reaches a prototype",
      { fixtures: [{ row: prototypeRow }] },
    ],
    [
      "fixtures past their bytes",
      { fixtures: [{ row: { body: "x".repeat(70 * 1024) } }] },
    ],
  ])("is refused with %s", (_case, change) => {
    expect(() => looseMigration({ ...declaration, ...change })).toThrow(
      expect.objectContaining({ code: "migration.invalid_definition" })
    );
  });

  test("is refused with a getter, which could answer differently each read", () => {
    const shifting = { ...declaration };
    Object.defineProperty(shifting, "table", {
      enumerable: true,
      get: () => "notes",
    });
    expect(() => looseMigration(shifting)).toThrow(/not a getter/u);
  });
});

describe("an App's migrations", () => {
  test("are recorded in its manifest, which reads back declared again", () => {
    const { manifest } = inspectApp(notes([deriveCategory]));
    const read = readAppManifest(JSON.stringify(manifest));

    expect(read.migrations).toStrictEqual(manifest.migrations);
    expect(read.migrations).toMatchObject({
      "derive-note-category": {
        name: "derive-note-category",
        table: "notes",
        fromSchema,
        toSchema,
        input: { kind: "object" },
        output: { kind: "object" },
        fixtures: [
          {
            row: { title: "Plan", body: "Launch day" },
            expect: { title: "Plan", body: "Launch day", category: "launch" },
          },
          { row: { title: "Idea" }, expect: null },
        ],
      },
    });
  });

  test.each([
    [
      "a table the schema doesn't have",
      [looseMigration({ ...declaration, table: "people" })],
      /a table the schema doesn't have/u,
    ],
    [
      "an output that isn't exactly the table's fields",
      [
        looseMigration({
          ...declaration,
          output: v.object({ ...noteFields, category: v.string() }),
        }),
      ],
      /exactly the fields/u,
    ],
    [
      "two of the same name",
      [deriveCategory, looseMigration(declaration)],
      /Two of the App's migrations are named/u,
    ],
    [
      "two of the same table",
      [deriveCategory, looseMigration({ ...declaration, name: "another" })],
      /Two of the App's migrations transform/u,
    ],
    [
      "something `migration` didn't declare",
      [{ "~migration": deriveCategory["~migration"] }],
      /`migration` declarations only/u,
    ],
  ])("are refused with %s", (_case, migrations, message) => {
    expect(() => notes(migrations)).toThrow(message);
  });

  test("can't be forged into a manifest a declaration doesn't make", () => {
    const { manifest } = inspectApp(notes([deriveCategory]));
    const declared = manifest.migrations["derive-note-category"];
    /** The manifest's text with the migration as `change` makes it. */
    const forged = (change: Record<string, unknown>): string =>
      JSON.stringify({
        ...manifest,
        migrations: { "derive-note-category": { ...declared, ...change } },
      });

    expect(() => readAppManifest(forged({ table: "people" }))).toThrow(
      /a table the schema doesn't have/u
    );
    expect(() => readAppManifest(forged({ uses: ["model"] }))).toThrow(
      /isn't a migration as a manifest holds one/u
    );
    expect(() => readAppManifest(forged({ fixtures: [] }))).toThrow(
      /between 1 and 16/u
    );
  });
});

describe("the runner", () => {
  const registered = notes([deriveCategory]);

  test("transforms each row with deterministic metadata only", () => {
    expect(
      runMigration(registered, {
        name: "derive-note-category",
        rows: [
          { id: "n1", fields: { title: "Plan", body: "Launch day" } },
          { id: "n2", fields: { title: "Idea", body: "" } },
        ],
      })
    ).toStrictEqual({
      ok: true,
      rows: [
        { title: "Plan", body: "Launch day", category: "launch" },
        { title: "Idea", body: "", category: "general:n2" },
      ],
    });
  });

  test.each([
    ["randomness", "randomness", () => Math.random()],
    ["random values", "randomness", () => crypto.randomUUID()],
    ["the clock", "the clock", () => Date.now()],
    ["the current date", "the clock", () => new Date().toISOString()],
  ])(
    "takes away %s while a handler runs, and gives it back after",
    (_case, refused, impurity) => {
      const impure = looseMigration({
        ...declaration,
        name: "impure",
        handler: (_ctx: unknown, row: object) => ({
          ...row,
          category: String(impurity()),
        }),
      });
      const answer = runMigration(notes([impure]), {
        name: "impure",
        rows: [{ id: "n1", fields: { title: "Plan" } }],
      });
      expect(answer).toMatchObject({ ok: false, index: 0 });
      expect(answer.ok ? "" : answer.message).toContain(refused);
      expect(() => [Math.random(), Date.now(), new Date()]).not.toThrow();
    }
  );

  test("names the row whose handler threw, or answered a promise", () => {
    const failing = looseMigration({
      ...declaration,
      name: "failing",
      handler: (ctx: { id: string }, row: unknown) => {
        if (ctx.id === "n2") {
          throw new Error("No category for this one");
        }
        return row;
      },
    });
    const waiting = looseMigration({
      ...declaration,
      name: "waiting",
      handler: async (_ctx: unknown, row: unknown) =>
        await Promise.resolve(row),
    });
    const rows = [
      { id: "n1", fields: { title: "One" } },
      { id: "n2", fields: { title: "Two" } },
    ];
    expect(
      runMigration(notes([failing]), { name: "failing", rows })
    ).toStrictEqual({
      ok: false,
      index: 1,
      message: "No category for this one",
    });
    const waited = runMigration(notes([waiting]), {
      name: "waiting",
      rows,
    });
    expect(waited).toMatchObject({ ok: false, index: 0 });
    expect(waited.ok ? "" : waited.message).toContain("not a promise");
  });

  test("refuses a migration the App doesn't register", () => {
    expect(() =>
      runMigration(registered, { name: "missing", rows: [] })
    ).toThrow(expect.objectContaining({ code: "migration.not_found" }));
  });
});
